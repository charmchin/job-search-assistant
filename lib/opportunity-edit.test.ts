import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { createActionService } from './actions';
import { actionSchema } from './action-schema';
import { readWorkspaceState } from './workspace-repository';
import type { Opportunity } from './client-types';
import {
  buildOpportunityUpdate,
  opportunityConflicts,
} from './opportunity-edit';

let client: Database.Database;
let service: ReturnType<typeof createActionService>;
let id: string;
beforeEach(async () => {
  client = new Database(':memory:');
  client.pragma('foreign_keys=ON');
  for (const name of fs
    .readdirSync('drizzle')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    client.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
  service = createActionService(client, async () => {});
  id = (
    await service.execute({
      action: 'createOpportunity',
      payload: {
        organization: '原组织',
        role: '研发',
        deadline: '2026-10-20T09:00:00+08:00',
        nextAction: '准备简历',
        notes: '原备注',
      },
    })
  ).id as string;
});
afterEach(() => client.close());
const read = () =>
  JSON.parse(JSON.stringify(readWorkspaceState(drizzle(client, { schema }))))
    .opportunities[0] as Opportunity;
const update = (
  original: Opportunity,
  changes: Partial<Opportunity>,
  requestId = randomUUID(),
) => ({
  action: 'updateOpportunity',
  payload: buildOpportunityUpdate(original, changes),
  requestId,
});
const snapshot = () =>
  [
    'opportunities',
    'tasks',
    'activities',
    'stage_history',
    'mutation_receipts',
  ].map((table) =>
    client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );

describe('机会字段级并发保护', () => {
  it('机会被删除后返回 404，不重建记录或写成功回执', async () => {
    const original = read();
    await service.execute({ action: 'deleteOpportunity', payload: { id } });
    const before = snapshot();
    await expect(
      service.execute(update(original, { notes: '旧稿' })),
    ).rejects.toMatchObject({ status: 404, code: 'RECORD_NOT_FOUND' });
    expect(snapshot()).toEqual(before);
  });
  it('仅提交变化字段，忽略展示属性和未改动字段', () => {
    const original = read();
    expect(
      buildOpportunityUpdate(original, {
        ...original,
        organization: '新组织',
        stale: !original.stale,
      }),
    ).toEqual({
      id,
      organization: '新组织',
      expected: { organization: '原组织' },
    });
    expect(buildOpportunityUpdate(original, original)).toBeNull();
  });
  it('不同字段的旧表单可分别保存，不覆盖新值', async () => {
    const original = read();
    await service.execute(update(original, { organization: '窗口甲' }));
    await service.execute(update(original, { notes: '窗口乙' }));
    expect(read()).toMatchObject({ organization: '窗口甲', notes: '窗口乙' });
  });
  it('同字段冲突返回 409，任务、历史、活动及回执都不修改', async () => {
    const original = read();
    await service.execute(update(original, { role: '窗口甲' }));
    const before = snapshot();
    await expect(
      service.execute(
        update(original, { role: '窗口乙', nextAction: '不得写入' }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'EDIT_CONFLICT',
      details: { fields: ['role'] },
    });
    expect(snapshot()).toEqual(before);
  });
  it('同时保存同字段只允许一个成功', async () => {
    const original = read();
    const results = await Promise.allSettled([
      service.execute(update(original, { notes: '甲' })),
      service.execute(update(original, { notes: '乙' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(read().notes).toBe('甲');
  });
  it('阶段、结束原因与投入决策作为一组保护', async () => {
    const original = read();
    await service.execute(update(original, { stage: 'interview' }));
    await expect(
      service.execute(update(original, { decision: 'skip' })),
    ).rejects.toMatchObject({
      code: 'EDIT_CONFLICT',
      details: { fields: ['stage'] },
    });
    expect(read()).toMatchObject({ stage: 'interview', decision: 'undecided' });
  });
  it('下一步标题与时间一起核对，任务完成也能阻止旧表单复活', async () => {
    const original = read();
    const task = original.tasks.find((t) => t.isNextAction)!;
    await service.execute({
      action: 'updateTask',
      payload: { id: task.id, status: 'done' },
    });
    await expect(
      service.execute(
        update(original, { nextActionAt: '2026-10-25T01:00:00.000Z' }),
      ),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    expect(read().nextAction).toBe('');
  });
  it('日期基线转换为相同瞬间，数组按内容而非引用比较', async () => {
    const original = read();
    await service.execute(
      update(original, {
        deadline: '2026-10-22T01:00:00.000Z',
        reminderDays: [3, 0],
      }),
    );
    expect(read().deadline).toBe('2026-10-22T01:00:00.000Z');
    expect(
      opportunityConflicts(
        {
          deadline: new Date(original.deadline!),
          reminderDays: [...original.reminderDays],
        },
        original,
      ),
    ).toEqual([]);
  });
  it('检查字段内容而非时间戳，即使更新时间碰撞仍拒绝覆盖', async () => {
    const original = read();
    client
      .prepare('UPDATE opportunities SET notes=?, updated_at=? WHERE id=?')
      .run('真实新备注', new Date(original.updatedAt).getTime(), id);
    await expect(
      service.execute(update(original, { notes: '旧覆盖' })),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
  });
  it('不相关活动不造成编辑冲突', async () => {
    const original = read();
    await service.execute({
      action: 'addActivity',
      payload: { opportunityId: id, content: '沟通记录' },
    });
    await service.execute(update(original, { location: '杭州' }));
    expect(read().location).toBe('杭州');
  });
  it('提交成功响应丢失后，回执重放优先于冲突检查且不重复活动', async () => {
    const original = read();
    const input = update(original, { notes: '成功甲' });
    const result = await service.execute(input);
    await service.execute(update(read(), { notes: '成功乙' }));
    const before = snapshot();
    const restarted = createActionService(client, async () => {});
    expect(await restarted.execute(input)).toEqual(result);
    expect(snapshot()).toEqual(before);
  });
  it('明确放弃旧稿并以最新值重建后可重新保存', async () => {
    const original = read();
    await service.execute(update(original, { notes: '甲' }));
    await expect(
      service.execute(update(original, { notes: '乙' })),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    await service.execute(update(read(), { notes: '核对后的乙' }));
    expect(read().notes).toBe('核对后的乙');
  });
  it.each([
    { id: 'a', notes: '新', expected: {} },
    { id: 'a', decision: 'skip', expected: { decision: 'undecided' } },
    { id: 'a', nextAction: '新', expected: { nextAction: '旧' } },
    { id: 'a', expected: { notes: '旧' } },
    { id: 'a', notes: '新', expected: { notes: '旧', secret: '未知字段' } },
  ])('不完整、仅基线或未知字段的保护请求拒绝（%#）', (payload) => {
    expect(
      actionSchema.safeParse({ action: 'updateOpportunity', payload }).success,
    ).toBe(false);
  });
  it('保留旧内部调用兼容，不虚称旧客户端已受保护', async () => {
    await service.execute({
      action: 'updateOpportunity',
      payload: { id, notes: '旧内部调用' },
    });
    expect(read().notes).toBe('旧内部调用');
  });
});
