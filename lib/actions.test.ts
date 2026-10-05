import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionService } from './actions';
import { actionSchema } from './action-schema';
import { createJsonBackup, restoreBackup } from './backup';
import os from 'node:os';

let client: Database.Database;
let service: ReturnType<typeof createActionService>;
const keychain = vi.fn<(_key: string) => Promise<void>>();
const command = (
  action: string,
  payload: Record<string, unknown>,
  requestId?: string,
) => ({ action, payload, ...(requestId ? { requestId } : {}) });
beforeEach(() => {
  client = new Database(':memory:');
  client.pragma('foreign_keys=ON');
  for (const name of fs
    .readdirSync('drizzle')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    client.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
  keychain.mockReset().mockResolvedValue();
  service = createActionService(client, keychain);
});
afterEach(() => client.close());
const opp = async (fields = {}) =>
  (
    await service.execute(
      command('createOpportunity', {
        organization: '隔离组织',
        role: '工程师',
        ...fields,
      }),
    )
  ).id as string;
const rows = (table: string) => client.prepare(`SELECT * FROM ${table}`).all();
describe('统一写入校验、事务和请求回执', () => {
  it.each(['organization', 'role'])('创建和更新共用非空 %s', (field) => {
    for (const action of ['createOpportunity', 'updateOpportunity'])
      expect(() =>
        actionSchema.parse(
          command(action, {
            ...(action.startsWith('create')
              ? { organization: '公司', role: '岗位' }
              : { id: 'opp' }),
            [field]: '  ',
          }),
        ),
      ).toThrow();
  });
  it.each(['deadline', 'nextActionAt'])(
    '拒绝 %s 的滚动日期、无时区、非法数字',
    (field) => {
      for (const value of [
        '2026-02-30T12:00:00+08:00',
        '2026-10-03T12:00',
        'bad',
        NaN,
        Infinity,
        true,
      ])
        expect(() =>
          actionSchema.parse(
            command('updateOpportunity', { id: 'opp', [field]: value }),
          ),
        ).toThrow();
    },
  );
  it('日期允许清空与 epoch 0，省略字段不会清空已有日期或重置提醒', async () => {
    const id = await opp({
      deadline: '2026-10-20T09:00:00+08:00',
      nextActionAt: 0,
      reminderDays: [5],
    });
    const before = rows('opportunities')[0];
    await service.execute(
      command('updateOpportunity', { id, notes: '新备注' }),
    );
    expect(rows('opportunities')[0]).toMatchObject({
      deadline: (before as { deadline: number }).deadline,
      next_action_at: 0,
      reminder_days: '[5]',
    });
    await service.execute(command('updateOpportunity', { id, deadline: null }));
    expect(rows('opportunities')[0]).toMatchObject({ deadline: null });
  });
  it.each([
    ['updateOpportunity', { stage: 'not-a-stage' }],
    ['updateOpportunity', { fitScore: 6 }],
    ['updateTask', { title: ' ' }],
    ['updateTask', { estimatedMinutes: -1 }],
    ['updateTask', { estimatedMinutes: 1.5 }],
    ['updateTask', { estimatedMinutes: '30' }],
    ['updateTask', { status: 'bad' }],
    ['updateMilestone', { title: '' }],
    ['updateMaterial', { name: '' }],
    ['updateRequirement', { name: '' }],
    ['updateRequirement', { completed: 1 }],
  ])('拒绝更新的非法字段（%#）', (action, payload) =>
    expect(() =>
      actionSchema.parse(command(action, { id: 'missing', ...payload })),
    ).toThrow(),
  );
  it.each([
    'updateOpportunity',
    'updateTask',
    'updateMilestone',
    'updateMaterial',
    'updateRequirement',
  ])('拒绝 %s 空更新或额外字段', (action) => {
    expect(() =>
      actionSchema.parse(command(action, { id: 'missing' })),
    ).toThrow();
    expect(() =>
      actionSchema.parse(
        command(action, { id: 'missing', arbitraryColumn: 'bad' }),
      ),
    ).toThrow();
  });
  it.each([
    ['updateOpportunity', { organization: '新名' }],
    ['deleteOpportunity', {}],
    ['updateTask', { status: 'done' }],
    ['updateMilestone', { status: 'done' }],
    ['updateMaterial', { name: '新名' }],
    ['updateRequirement', { completed: true }],
    ['discardDraft', {}],
  ])('不存在的记录 %s 明确 404', async (action, fields) => {
    await expect(
      service.execute(command(action, { id: 'missing', ...fields })),
    ).rejects.toMatchObject({ status: 404 });
    expect(rows('activities')).toHaveLength(0);
  });
  it.each(['createTask', 'createMilestone', 'addActivity'])(
    '拒绝 %s 的不存在父机会，不写孤儿或活动',
    async (action) => {
      await expect(
        service.execute(
          command(action, {
            opportunityId: 'missing',
            ...(action === 'addActivity'
              ? { content: '记录' }
              : { title: '事项' }),
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(rows('tasks')).toHaveLength(0);
      expect(rows('milestones')).toHaveLength(0);
      expect(rows('activities')).toHaveLength(0);
    },
  );
  it('材料关联不存在时，完成状态和活跃时间不改变', async () => {
    const id = await opp({ requirements: [{ name: '简历' }] });
    const before = rows('opportunities')[0];
    const requirement = rows('material_requirements')[0] as { id: string };
    await expect(
      service.execute(
        command('updateRequirement', {
          id: requirement.id,
          completed: true,
          materialId: 'missing',
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(rows('opportunities')[0]).toEqual(before);
    expect(rows('material_requirements')[0]).toMatchObject({ completed: 0 });
    expect(id).toBeTruthy();
  });
  it.each([
    'createTask',
    'createMilestone',
    'updateOpportunity',
    'updateTask',
    'updateRequirement',
    'addActivity',
  ])('活动写入故障让 %s 的整个业务事务回滚', async (action) => {
    const id = await opp({
      tasks: [{ title: '初始任务' }],
      requirements: [{ name: '简历' }],
    });
    const before = createJsonBackup(client).data;
    client.exec(
      "CREATE TRIGGER reject_activity BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    const payloads: Record<string, Record<string, unknown>> = {
      createTask: { opportunityId: id, title: '新任务' },
      createMilestone: { opportunityId: id, title: '新节点' },
      updateOpportunity: { id, notes: '不应保留' },
      updateTask: { id: before.tasks[0].id, status: 'done' },
      updateRequirement: {
        id: before.materialRequirements[0].id,
        completed: true,
      },
      addActivity: { opportunityId: id, content: '失败记录' },
    };
    await expect(
      service.execute(command(action, payloads[action], randomUUID())),
    ).rejects.toThrow();
    expect(createJsonBackup(client).data).toEqual(before);
    expect(rows('mutation_receipts')).toHaveLength(0);
  });
  it('创建机会的任务、要求、活动及草稿确认作为一个事务', async () => {
    client.exec(
      "CREATE TRIGGER reject_activity BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    await expect(
      opp({ tasks: [{ title: '新任务' }], requirements: [{ name: '简历' }] }),
    ).rejects.toThrow();
    expect(rows('opportunities')).toHaveLength(0);
    expect(rows('tasks')).toHaveLength(0);
    expect(rows('material_requirements')).toHaveLength(0);
  });
  it('相同 requestId 只创建一次，重建服务后仍返回同一回执，改变内容则 409', async () => {
    const id = await opp(),
      requestId = randomUUID();
    const input = command(
      'createTask',
      { opportunityId: id, title: '一次行动' },
      requestId,
    );
    const [a, b] = await Promise.all([
      service.execute(input),
      service.execute(input),
    ]);
    expect(a).toEqual(b);
    service = createActionService(client, keychain);
    expect(await service.execute(input)).toEqual(a);
    expect(rows('tasks')).toHaveLength(1);
    expect(rows('activities')).toHaveLength(2);
    await expect(
      service.execute(command('createTask', { title: '其他内容' }, requestId)),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('删除的重试返回原成功，新的删除请求则 404', async () => {
    const id = await opp(),
      requestId = randomUUID();
    const input = command('deleteOpportunity', { id }, requestId);
    expect(await service.execute(input)).toEqual(await service.execute(input));
    await expect(
      service.execute(command('deleteOpportunity', { id }, randomUUID())),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('skip 无论携带何种合法阶段都进入 closed', async () => {
    const id = await opp();
    await service.execute(
      command('updateOpportunity', {
        id,
        decision: 'skip',
        stage: 'preparing',
      }),
    );
    expect(rows('opportunities')[0]).toMatchObject({
      stage: 'closed',
      decision: 'skip',
    });
  });
  it('钥匙串失败数据库不变；成功只保存摘要回执，不保存密钥', async () => {
    const input = command(
      'saveSettings',
      { model: 'test', apiKey: 'secret-mock-only' },
      randomUUID(),
    );
    keychain.mockRejectedValueOnce(new Error('secret command output'));
    await expect(service.execute(input)).rejects.toMatchObject({
      code: 'KEYCHAIN_FAILED',
    });
    expect(rows('settings')).toHaveLength(0);
    await service.execute(input);
    await service.execute(input);
    expect(keychain).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify(rows('settings')) +
        JSON.stringify(rows('mutation_receipts')),
    ).not.toContain('secret-mock-only');
  });
  it('钥匙串成功而设置表故障明确报告部分结果，DB 设置原子回滚', async () => {
    client.exec(
      "CREATE TRIGGER reject_setting BEFORE INSERT ON settings WHEN NEW.key='aiModel' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    await expect(
      service.execute(command('saveSettings', { apiKey: 'mock-only' })),
    ).rejects.toMatchObject({ code: 'SETTINGS_PARTIAL' });
    expect(rows('settings')).toHaveLength(0);
  });
  it('备份不含回执，恢复使旧请求失效，不能重试到恢复后的数据集', async () => {
    const requestId = randomUUID(),
      input = command('createTask', { title: '不可重放' }, requestId);
    const empty = createJsonBackup(client);
    await service.execute(input);
    expect(Object.keys(createJsonBackup(client).data)).not.toContain(
      'mutationReceipts',
    );
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'zhaopin-action-restore-'),
    );
    try {
      restoreBackup(client, empty, directory);
      await expect(service.execute(input)).rejects.toMatchObject({
        code: 'REQUEST_INVALIDATED',
      });
      expect(rows('tasks')).toHaveLength(0);
    } finally {
      fs.renameSync(
        directory,
        path.join(os.homedir(), '.Trash', path.basename(directory)),
      );
    }
  });
});
