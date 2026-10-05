import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionService } from './actions';
import { createJsonBackup, parseBackup, restoreBackup } from './backup';
import { buildRecruitmentAnalytics, highestRecordedStage } from './analytics';
import type { Opportunity } from './client-types';

const migrations = fs
  .readdirSync('drizzle')
  .filter((name) => name.endsWith('.sql'))
  .sort();
const sql = (name: string) =>
  fs.readFileSync(path.join('drizzle', name), 'utf8');
let client: Database.Database;
let service: ReturnType<typeof createActionService>;
const execute = (
  action: string,
  payload: Record<string, unknown>,
  requestId?: string,
) => service.execute({ action, payload, ...(requestId ? { requestId } : {}) });
const create = async (fields = {}) =>
  (
    await execute('createOpportunity', {
      organization: randomUUID(),
      role: '研发岗',
      ...fields,
    })
  ).id as string;
const backup = () => JSON.parse(JSON.stringify(createJsonBackup(client)));
const owners = (): Opportunity[] => {
  const data = backup().data;
  return data.opportunities.map((owner: Opportunity) => ({
    ...owner,
    stageHistory: data.stageHistory.filter(
      (row: { opportunityId: string }) => row.opportunityId === owner.id,
    ),
  }));
};
const history = (id: string) =>
  owners().find((owner) => owner.id === id)!.stageHistory!;
const metrics = (includeWithdrawn = false) =>
  buildRecruitmentAnalytics(owners(), includeWithdrawn);
const metric = (stage: string, includeWithdrawn = false) =>
  metrics(includeWithdrawn).rows.find((row) => row.id === stage)!;
beforeEach(() => {
  client = new Database(':memory:');
  client.pragma('foreign_keys=ON');
  for (const name of migrations) client.exec(sql(name));
  service = createActionService(client, async () => {});
});
afterEach(() => {
  vi.useRealTimers();
  client.close();
});

describe('招聘经历与诚实的转化口径', () => {
  it('空库无分母显示 null 而不是伪造 0%', () => {
    expect(metrics().total).toBe(0);
    expect(metric('interview').conversion).toEqual({
      numerator: 0,
      denominator: 0,
      percent: null,
    });
  });
  it('投递直接进入面试，不凭顺序虚构笔试', async () => {
    const id = await create();
    for (const stage of ['applied', 'interview'])
      await execute('updateOpportunity', { id, stage });
    expect(metric('applied').count).toBe(1);
    expect(metric('assessment').count).toBe(0);
    expect(metric('interview').conversion).toEqual({
      numerator: 1,
      denominator: 1,
      percent: 100,
    });
    expect(history(id).map((row) => row.toStage)).toEqual([
      'evaluating',
      'applied',
      'interview',
    ]);
    expect(history(id)[2].fromStage).toBe('applied');
  });
  it('回退和再次进入同一阶段保留最高经历但人数不重复', async () => {
    const id = await create();
    for (const stage of ['applied', 'interview', 'preparing', 'interview'])
      await execute('updateOpportunity', { id, stage });
    expect(history(id)).toHaveLength(5);
    expect(metric('interview').count).toBe(1);
    expect(highestRecordedStage(owners()[0])).toBe('interview');
    await execute('updateOpportunity', { id, stage: 'preparing' });
    expect(metric('interview').count).toBe(1);
    expect(highestRecordedStage(owners()[0])).toBe('interview');
  });
  it('初始建档为 Offer 不虚构面试或投递，发生日期未知', async () => {
    const id = await create({ stage: 'offer' });
    expect(history(id)[0]).toMatchObject({
      toStage: 'offer',
      source: 'initial',
      occurredAt: null,
    });
    expect(metric('offer').count).toBe(1);
    expect(metric('applied').count).toBe(0);
    expect(metric('interview').count).toBe(0);
    expect(metric('offer').conversion!.percent).toBeNull();
    expect(metrics().partialHistory).toBe(1);
  });
  it('未知前史的面试者不进入已投递者的转化分子', async () => {
    await create({ stage: 'interview' });
    await create({ stage: 'applied' });
    expect(metric('interview').count).toBe(1);
    expect(metric('interview').conversion).toEqual({
      numerator: 0,
      denominator: 1,
      percent: 0,
    });
  });
  it('未通过保留、主动放弃默认排除，全部口径一致', async () => {
    const rejected = await create({ stage: 'applied' });
    const withdrawn = await create({ stage: 'offer' });
    const unknown = await create({ stage: 'interview' });
    await execute('updateOpportunity', {
      id: rejected,
      stage: 'closed',
      closedReason: 'rejected',
    });
    await execute('updateOpportunity', { id: withdrawn, decision: 'skip' });
    await execute('updateOpportunity', { id: unknown, stage: 'closed' });
    expect(metrics()).toMatchObject({
      total: 2,
      excluded: 1,
      rejected: 1,
      withdrawn: 0,
      unknownClosed: 1,
    });
    expect(metric('applied').count).toBe(1);
    expect(metric('offer').count).toBe(0);
    expect(metrics(true)).toMatchObject({
      total: 3,
      excluded: 0,
      rejected: 1,
      withdrawn: 1,
    });
    expect(metric('offer', true).count).toBe(1);
  });
  it('结束原因可修正，重新开启清除结束原因但保留经历', async () => {
    const id = await create({ stage: 'applied' });
    await execute('updateOpportunity', {
      id,
      stage: 'closed',
      closedReason: 'withdrawn',
    });
    expect(metrics().total).toBe(0);
    await execute('updateOpportunity', { id, closedReason: 'rejected' });
    expect(metrics().total).toBe(1);
    await execute('updateOpportunity', {
      id,
      stage: 'preparing',
      closedReason: 'withdrawn',
    });
    expect(owners()[0].closedReason).toBe('unknown');
    expect(metric('applied').count).toBe(1);
  });
  it('相同阶段和无关编辑不制造阶段经历', async () => {
    const id = await create({ stage: 'applied' });
    await execute('updateOpportunity', { id, stage: 'applied' });
    await execute('updateOpportunity', { id, notes: '备注' });
    expect(history(id)).toHaveLength(1);
  });
  it('阶段变更、历史、活动原子提交且请求重放不重复', async () => {
    const id = await create();
    const requestId = randomUUID();
    await execute('updateOpportunity', { id, stage: 'applied' }, requestId);
    await execute('updateOpportunity', { id, stage: 'applied' }, requestId);
    expect(history(id)).toHaveLength(2);
    expect(
      backup().data.activities.filter((row: { content: string }) =>
        row.content.includes('招聘阶段：待评估 → 已投递'),
      ),
    ).toHaveLength(1);
    client.exec(
      "CREATE TRIGGER fail_stage BEFORE INSERT ON stage_history BEGIN SELECT RAISE(ABORT, 'history write failed'); END;",
    );
    const before = backup().data;
    await expect(
      execute('updateOpportunity', { id, stage: 'interview' }),
    ).rejects.toThrow('history write failed');
    expect(backup().data).toEqual(before);
  });
  it('补录真实日期、未知时间，不改变当前阶段，更新推进时间', async () => {
    const id = await create({ stage: 'interview' });
    await execute('addStageHistory', {
      opportunityId: id,
      stage: 'applied',
      occurredAt: '2025-09-01T09:00:00+08:00',
      notes: '已在官网投递',
    });
    expect(owners()[0].stage).toBe('interview');
    expect(metric('interview').conversion!.percent).toBe(100);
    expect(history(id)[1]).toMatchObject({
      source: 'manual',
      occurredAt: '2025-09-01T01:00:00.000Z',
      notes: '已在官网投递',
    });
    await execute('addStageHistory', {
      opportunityId: id,
      stage: 'assessment',
    });
    expect(history(id)[2].occurredAt).toBeNull();
    expect(backup().data.activities.at(-1).type).toBe('stage-history');
  });
  it.each(['2099-01-01T00:00:00Z', '2026-02-30T00:00:00Z', 'no-date'])(
    '拒绝未来或无效补录时间 %s 且数据不变',
    async (occurredAt) => {
      const id = await create();
      const before = backup().data;
      await expect(
        execute('addStageHistory', {
          opportunityId: id,
          stage: 'applied',
          occurredAt,
        }),
      ).rejects.toThrow();
      expect(backup().data).toEqual(before);
    },
  );
  it('作废只排除误录，保留原字段和原因审计，幂等重放安全', async () => {
    const id = await create({ stage: 'offer' });
    const event = history(id)[0];
    const requestId = randomUUID();
    await execute(
      'invalidateStageHistory',
      { id: event.id, notes: '误选 Offer，实际尚未投递' },
      requestId,
    );
    await execute(
      'invalidateStageHistory',
      { id: event.id, notes: '误选 Offer，实际尚未投递' },
      requestId,
    );
    expect(history(id)[0]).toEqual({ ...event, valid: false });
    expect(owners()[0].stage).toBe('offer');
    expect(highestRecordedStage(owners()[0])).toBeNull();
    expect(metric('offer').count).toBe(0);
    expect(backup().data.activities.at(-1).content).toContain('误选 Offer');
    await expect(
      execute('invalidateStageHistory', { id: event.id, notes: '第二次作废' }),
    ).rejects.toThrow();
  });
  it('记录作废不影响同机会另一有效的相同阶段', async () => {
    const id = await create({ stage: 'interview' });
    await execute('addStageHistory', { opportunityId: id, stage: 'interview' });
    await execute('invalidateStageHistory', {
      id: history(id)[0].id,
      notes: '初始误录，补录为准',
    });
    expect(metric('interview').count).toBe(1);
  });
  it.each([
    ['addStageHistory', { opportunityId: 'missing', stage: 'applied' }],
    ['invalidateStageHistory', { id: 'missing', notes: '原因' }],
    ['invalidateStageHistory', { id: 'missing', notes: '   ' }],
  ])('拒绝孤立或无原因记录 %s', async (action, payload) => {
    await expect(execute(action, payload)).rejects.toThrow();
    expect(backup().data.stageHistory).toEqual([]);
  });
  it('删除机会级联删除历史，统计不留幽灵记录', async () => {
    const id = await create({ stage: 'applied' });
    await execute('deleteOpportunity', { id });
    expect(metrics().total).toBe(0);
    expect(backup().data.stageHistory).toEqual([]);
  });
});

describe('旧库与备份的阶段历史兼容', () => {
  it('旧库只记录明确当前阶段，日期未知，兼容运行时后再次迁移', () => {
    const old = new Database(':memory:');
    try {
      const migration = migrations.find((name) => name.startsWith('0005_'))!;
      for (const name of migrations.filter((name) => name < migration))
        old.exec(sql(name));
      old.exec(
        "INSERT INTO opportunities (id,organization,role,stage,decision,created_at,updated_at,last_activity_at) VALUES ('interview','旧组织','研发岗','interview','pursue',1,2,3),('skip','放弃组织','研发岗','closed','skip',1,2,3),('unknown','未知组织','研发岗','closed','undecided',1,2,3)",
      );
      const migrate = () => {
        for (const statement of sql(migration).split(
          '--> statement-breakpoint',
        )) {
          if (
            /ALTER TABLE/.test(statement) &&
            (
              old.pragma('table_info(opportunities)') as { name: string }[]
            ).some((col) => col.name === 'closed_reason')
          )
            continue;
          old.exec(statement);
        }
      };
      migrate();
      const snapshot = JSON.parse(JSON.stringify(createJsonBackup(old))).data;
      expect(snapshot.stageHistory).toHaveLength(3);
      expect(snapshot.stageHistory[0]).toMatchObject({
        opportunityId: 'interview',
        toStage: 'interview',
        occurredAt: null,
        source: 'legacy',
        recordedAt: new Date(2).toISOString(),
      });
      expect(
        snapshot.opportunities.map(
          (row: { closedReason: string }) => row.closedReason,
        ),
      ).toEqual(['unknown', 'withdrawn', 'unknown']);
      expect(snapshot.opportunities[0].lastActivityAt).toBe(
        new Date(3).toISOString(),
      );
      migrate();
      expect(JSON.parse(JSON.stringify(createJsonBackup(old))).data).toEqual(
        snapshot,
      );
    } finally {
      old.close();
    }
  });
  it('旧 JSON 缺历史会生成明确快照，不推断已投递；已有历史不重建', async () => {
    await create({ stage: 'interview' });
    const old = backup();
    delete old.data.stageHistory;
    delete old.data.opportunities[0].closedReason;
    const parsed = parseBackup(old);
    expect(parsed.data.stageHistory[0]).toMatchObject({
      source: 'legacy',
      toStage: 'interview',
      occurredAt: null,
    });
    expect(parsed.data.stageHistory).toHaveLength(1);
    expect(parseBackup(parsed).data).toEqual(parsed.data);
    const explicitEmpty = backup();
    explicitEmpty.data.stageHistory = [];
    expect(parseBackup(explicitEmpty).data.stageHistory).toEqual([]);
  });
  it.each([
    'opportunityId',
    'toStage',
    'source',
    'valid',
    'occurredAt',
    'recordedAt',
    'duplicate',
  ])('历史字段损坏 %s 在恢复前拒绝', async (field) => {
    await create();
    const bad = backup();
    if (field === 'duplicate')
      bad.data.stageHistory.push({ ...bad.data.stageHistory[0] });
    else bad.data.stageHistory[0][field] = field === 'valid' ? 1 : 'not-valid';
    expect(() => parseBackup(bad)).toThrow();
  });
  it('备份往返保留有效/无效历史、日期、原因活动和结束分类，恢复后统计一致', async () => {
    const id = await create({ stage: 'interview' });
    await execute('addStageHistory', {
      opportunityId: id,
      stage: 'applied',
      notes: '补录原始凭据',
    });
    await execute('addStageHistory', { opportunityId: id, stage: 'offer' });
    await execute('invalidateStageHistory', {
      id: history(id)[2].id,
      notes: '误录',
    });
    await execute('updateOpportunity', {
      id,
      stage: 'closed',
      closedReason: 'rejected',
    });
    const saved = backup();
    const stats = metrics();
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'zhaopin-history-backup-'),
    );
    try {
      await execute('deleteOpportunity', { id });
      restoreBackup(client, saved, dir);
      expect(backup().data).toEqual(saved.data);
      expect(metrics()).toEqual(stats);
      expect(client.pragma('foreign_key_check')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
