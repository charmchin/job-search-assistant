import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionService } from './actions';
import { createJsonBackup, parseBackup, restoreBackup } from './backup';
import { createReminderEngine } from './reminder-engine';
import { buildTodayPlan } from './today';
import type { Opportunity, Task, WorkspaceState } from './client-types';

let client: Database.Database;
let service: ReturnType<typeof createActionService>;
const migrations = fs
  .readdirSync('drizzle')
  .filter((n) => n.endsWith('.sql'))
  .sort();
const sql = (name: string) =>
  fs.readFileSync(path.join('drizzle', name), 'utf8');
const execute = async (
  action: string,
  payload: Record<string, unknown>,
  requestId?: string,
) => service.execute({ action, payload, ...(requestId ? { requestId } : {}) });
const row = (table: string, id: string) =>
  client.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<
    string,
    unknown
  >;
const count = (table: string) =>
  (client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
    .n;
const owner = async (extra = {}) =>
  (
    await execute('createOpportunity', {
      organization: randomUUID(),
      role: '研发岗',
      ...extra,
    })
  ).id as string;
const material = async (extra = {}) =>
  (await execute('createMaterial', { name: '中文简历', ...extra }))
    .id as string;
const requirement = async (
  opportunityId: string,
  materialId: string | null = null,
) =>
  (
    await execute('createRequirement', {
      opportunityId,
      materialId,
      name: '盖章简历',
      notes: 'PDF 格式',
    })
  ).id as string;
const focus = (opportunityId: string) =>
  client
    .prepare('SELECT * FROM tasks WHERE opportunity_id=? AND is_next_action=1')
    .get(opportunityId) as
    | { id: string; title: string; due_at: number | null }
    | undefined;
const time = '2026-12-10T09:00:00+08:00';
beforeEach(() => {
  client = new Database(':memory:');
  client.pragma('foreign_keys=ON');
  for (const name of migrations) client.exec(sql(name));
  service = createActionService(client, async () => {});
});
afterEach(() => client.close());

describe('下一步与真实任务的单一执行来源', () => {
  it('创建计划时复用同名建议任务，保留建议任务的日期和来源', async () => {
    const id = await owner({
      nextAction: '准备简历',
      tasks: [{ title: '准备简历', dueAt: time, source: 'ai' }],
    });
    expect(count('tasks')).toBe(1);
    expect(focus(id)).toMatchObject({
      title: '准备简历',
      due_at: Date.parse(time),
    });
    expect(row('opportunities', id).next_action_at).toBe(Date.parse(time));
    expect(row('tasks', focus(id)!.id).source).toBe('ai');
  });
  it('不同时间的同名任务不会被无声覆盖', async () => {
    await owner({
      nextAction: '准备简历',
      nextActionAt: time,
      tasks: [{ title: '准备简历', dueAt: '2026-12-11T09:00:00+08:00' }],
    });
    expect(count('tasks')).toBe(2);
  });
  it('修改计划和任务均同步另一侧，不新增重复任务', async () => {
    const id = await owner({ nextAction: '初稿', nextActionAt: time });
    const taskId = focus(id)!.id;
    await execute('updateOpportunity', {
      id,
      nextAction: '定稿',
      nextActionAt: null,
    });
    expect(count('tasks')).toBe(1);
    expect(focus(id)).toMatchObject({
      id: taskId,
      title: '定稿',
      due_at: null,
    });
    await execute('updateTask', {
      id: taskId,
      title: '复核',
      dueAt: time,
      status: 'doing',
    });
    expect(row('opportunities', id)).toMatchObject({
      next_action: '复核',
      next_action_at: Date.parse(time),
    });
  });
  it.each(['done', 'skipped'])(
    '%s 会清除计划，恢复任务不悄悄恢复焦点',
    async (status) => {
      const id = await owner({ nextAction: '待办', nextActionAt: time });
      const taskId = focus(id)!.id;
      await execute('updateTask', { id: taskId, status });
      expect(focus(id)).toBeUndefined();
      expect(row('opportunities', id)).toMatchObject({
        next_action: '',
        next_action_at: null,
      });
      expect(row('tasks', taskId).status).toBe(status);
      await execute('updateTask', { id: taskId, status: 'todo' });
      expect(focus(id)).toBeUndefined();
    },
  );
  it('选择已有任务、切换及清除重点都不删除任务，禁止跨岗位和完成任务', async () => {
    const a = await owner({ nextAction: 'A' }),
      b = await owner({ nextAction: 'B' });
    const original = focus(a)!.id;
    const next = (await execute('createTask', { opportunityId: a, title: 'C' }))
      .id as string;
    await execute('setNextTask', { opportunityId: a, taskId: next });
    expect(row('tasks', original).is_next_action).toBe(0);
    expect(focus(a)!.id).toBe(next);
    await expect(
      execute('setNextTask', { opportunityId: a, taskId: focus(b)!.id }),
    ).rejects.toThrow('当前机会');
    await execute('setNextTask', { opportunityId: a, taskId: null });
    expect(count('tasks')).toBe(3);
    await execute('updateTask', { id: next, status: 'done' });
    await expect(
      execute('setNextTask', { opportunityId: a, taskId: next }),
    ).rejects.toThrow('尚未完成');
  });
  it('清空文本仅取消重点；原任务留在行动清单', async () => {
    const id = await owner({ nextAction: '待办', nextActionAt: time });
    await execute('updateOpportunity', { id, nextAction: '' });
    expect(count('tasks')).toBe(1);
    expect(focus(id)).toBeUndefined();
  });
  it('今日清单只出现一次且 completion 使用真实任务 ID', async () => {
    const id = await owner({ nextAction: '待办', nextActionAt: time });
    const data = createJsonBackup(client).data;
    const opp = JSON.parse(
      JSON.stringify({
        ...data.opportunities[0],
        tasks: data.tasks,
        milestones: [],
        requirements: [],
        activities: [],
        stale: false,
      }),
    ) as Opportunity;
    const state: WorkspaceState = {
      now: time,
      opportunities: [opp],
      tasks: JSON.parse(JSON.stringify(data.tasks)) as Task[],
      milestones: [],
      materials: [],
      requirements: [],
      drafts: [],
      settings: {},
    };
    expect(buildTodayPlan(state).actions).toMatchObject([
      { kind: 'nextAction', entityId: focus(id)!.id, title: '待办' },
    ]);
    expect(buildTodayPlan(state).actions).toHaveLength(1);
  });
  it('只提醒一次，完成后不再提醒；通知使用真实 task 去重键', async () => {
    const id = await owner({ nextAction: '待办', nextActionAt: time });
    const send = vi.fn(async () => {});
    const engine = createReminderEngine(client, send);
    await engine.check(new Date(Date.parse(time) - 60_000));
    await engine.check(new Date(time));
    await engine.check(new Date(time));
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      client
        .prepare('SELECT entity_type,entity_id FROM reminder_deliveries')
        .all(),
    ).toEqual([{ entity_type: 'task', entity_id: focus(id)!.id }]);
    await execute('updateTask', { id: focus(id)!.id, status: 'done' });
    await engine.check(new Date(Date.parse(time) + 60_000));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('唯一索引拒绝同一机会两个焦点', async () => {
    const id = await owner({ nextAction: 'A' });
    const other = (
      await execute('createTask', { opportunityId: id, title: 'B' })
    ).id;
    expect(() =>
      client.prepare('UPDATE tasks SET is_next_action=1 WHERE id=?').run(other),
    ).toThrow();
  });
});

describe('材料与岗位要求完整维护', () => {
  it('新增、编辑要求及备注可持久化，移除要求不动共享材料', async () => {
    const id = await owner(),
      mat = await material(),
      req = await requirement(id, mat);
    await execute('updateRequirement', {
      id: req,
      name: '盖章成绩单',
      notes: '需要学院章',
    });
    expect(row('material_requirements', req)).toMatchObject({
      name: '盖章成绩单',
      notes: '需要学院章',
      material_id: mat,
      completed: 0,
    });
    await execute('deleteRequirement', { id: req });
    expect(count('material_requirements')).toBe(0);
    expect(count('materials')).toBe(1);
  });
  it('只修改材料说明不清除就绪；替换路径或版本后关联要求都待核对', async () => {
    const a = await owner(),
      b = await owner(),
      mat = await material({ filePath: '/old.pdf', version: 'v1' });
    const first = await requirement(a, mat),
      second = await requirement(b, mat);
    for (const id of [first, second])
      await execute('updateRequirement', { id, completed: true });
    await execute('updateMaterial', { id: mat, name: '新名称', notes: '说明' });
    expect(row('material_requirements', first).completed).toBe(1);
    await execute('updateMaterial', { id: mat, filePath: '/new.pdf' });
    for (const id of [first, second])
      expect(row('material_requirements', id)).toMatchObject({
        completed: 0,
        material_id: mat,
      });
    await execute('updateRequirement', { id: first, completed: true });
    await execute('updateMaterial', { id: mat, version: 'v2' });
    expect(row('material_requirements', first).completed).toBe(0);
  });
  it('切换/取消关联会重置完成，不允许在同次请求伪造已就绪', async () => {
    const id = await owner(),
      a = await material(),
      b = await material(),
      req = await requirement(id, a);
    await execute('updateRequirement', { id: req, completed: true });
    await execute('updateRequirement', {
      id: req,
      materialId: b,
      completed: true,
    });
    expect(row('material_requirements', req)).toMatchObject({
      completed: 0,
      material_id: b,
    });
    await execute('updateRequirement', { id: req, completed: true });
    await execute('updateRequirement', { id: req, materialId: null });
    expect(row('material_requirements', req)).toMatchObject({
      completed: 0,
      material_id: null,
    });
  });
  it('删除共享材料只解除引用，要求保留，真实文件内容不变，重试幂等', async () => {
    const directory = fs.mkdtempSync(
      path.join(process.env.ZHAOPIN_UNIT_RUN_ROOT!, 'material-'),
    );
    const filename = path.join(directory, 'resume.txt');
    fs.writeFileSync(filename, '真实文件夹具');
    const a = await owner(),
      b = await owner(),
      mat = await material({ filePath: filename });
    const req = await requirement(a, mat);
    await requirement(b, mat);
    await execute('updateRequirement', { id: req, completed: true });
    const requestId = randomUUID();
    const result = await execute('deleteMaterial', { id: mat }, requestId);
    expect(await execute('deleteMaterial', { id: mat }, requestId)).toEqual(
      result,
    );
    expect(count('materials')).toBe(0);
    expect(
      client
        .prepare('SELECT material_id,completed FROM material_requirements')
        .all(),
    ).toEqual([
      { material_id: null, completed: 0 },
      { material_id: null, completed: 0 },
    ]);
    expect(fs.readFileSync(filename, 'utf8')).toBe('真实文件夹具');
  });
  it('错误引用和不存在的记录不会产生孤儿要求', async () => {
    const id = await owner();
    await expect(requirement(id, 'missing')).rejects.toThrow('关联材料');
    await expect(requirement('missing')).rejects.toThrow('机会');
    await expect(execute('deleteMaterial', { id: 'missing' })).rejects.toThrow(
      '材料',
    );
    await expect(
      execute('deleteRequirement', { id: 'missing' }),
    ).rejects.toThrow('材料要求');
    expect(count('material_requirements')).toBe(0);
  });
  it.each([
    'deleteMaterial',
    'updateMaterial',
    'deleteRequirement',
    'createRequirement',
    'setNextTask',
  ])('%s 活动写入失败时整体回滚', async (action) => {
    const id = await owner({ nextAction: '待办' }),
      mat = await material(),
      req = await requirement(id, mat);
    await execute('updateRequirement', { id: req, completed: true });
    const before = createJsonBackup(client).data;
    client.exec(
      "CREATE TRIGGER reject_activity BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT,'rejected'); END",
    );
    const payload =
      action === 'setNextTask'
        ? { opportunityId: id, taskId: null }
        : action === 'createRequirement'
          ? { opportunityId: id, name: '新要求' }
          : {
              id: action === 'deleteRequirement' ? req : mat,
              ...(action === 'updateMaterial' ? { version: 'v2' } : {}),
            };
    await expect(execute(action, payload)).rejects.toThrow();
    expect(createJsonBackup(client).data).toEqual(before);
  });
});

describe('旧版本迁移与 JSON 兼容', () => {
  it('旧计划变成真实任务；原任务、普通文本及活动时间保留；原通知不重复', async () => {
    const id = await owner({ nextAction: ' 保留原文 ', nextActionAt: time });
    const backup = JSON.parse(JSON.stringify(createJsonBackup(client)));
    backup.data.tasks = [];
    backup.data.reminderDeliveries = [
      {
        id: 'old-delivery',
        entityType: 'nextAction',
        entityId: id,
        scheduledFor: time,
        deliveredAt: time,
        deliveryKey: `nextAction:${id}:${Date.parse(time)}`,
      },
    ];
    const parsed = parseBackup(backup);
    expect(parsed.data.tasks).toHaveLength(1);
    expect(parsed.data.tasks[0]).toMatchObject({
      title: ' 保留原文 ',
      isNextAction: true,
    });
    expect(parsed.data.opportunities[0].lastActivityAt.toISOString()).toBe(
      backup.data.opportunities[0].lastActivityAt,
    );
    expect(parsed.data.reminderDeliveries).toHaveLength(2);
    const snapshots = fs.mkdtempSync(
      path.join(process.env.ZHAOPIN_UNIT_RUN_ROOT!, 'restore-'),
    );
    restoreBackup(client, backup, snapshots);
    const send = vi.fn(async () => {});
    await createReminderEngine(client, send).check(new Date(time));
    expect(send).not.toHaveBeenCalled();
    expect(parseBackup(createJsonBackup(client)).data).toEqual(
      createJsonBackup(client).data,
    );
  });
  it('新版本损坏的双焦点、跨岗位及镜像不一致备份必须拒绝', async () => {
    await owner({ nextAction: '待办', nextActionAt: time });
    const backup = JSON.parse(JSON.stringify(createJsonBackup(client)));
    for (const patch of [
      { title: '不一致' },
      { dueAt: null },
      { status: 'done' },
      { opportunityId: null },
    ]) {
      const bad = structuredClone(backup);
      Object.assign(bad.data.tasks[0], patch);
      expect(() => parseBackup(bad)).toThrow('不一致');
    }
    backup.data.tasks.push({ ...backup.data.tasks[0], id: 'second-focus' });
    expect(() => parseBackup(backup)).toThrow('不一致');
  });
  it('SQL 一次性转换复用兼容旧任务，保留不同时间任务，并兼容随后正式迁移', () => {
    const legacy = new Database(':memory:');
    try {
      const focusMigration = migrations.find((name) =>
        name.startsWith('0004_'),
      )!;
      for (const name of migrations.filter((name) => name < focusMigration))
        legacy.exec(sql(name));
      legacy
        .prepare(
          "INSERT INTO opportunities (id,organization,role,next_action,next_action_at,created_at,updated_at,last_activity_at) VALUES ('legacy','组织','岗位','旧计划',?,1,2,3)",
        )
        .run(Date.parse(time));
      legacy.exec(
        "INSERT INTO tasks (id,opportunity_id,title,created_at,updated_at) VALUES ('existing','legacy','旧计划',1,2)",
      );
      legacy
        .prepare(
          "INSERT INTO reminder_deliveries VALUES ('old','nextAction','legacy',?,? ,?)",
        )
        .run(
          Date.parse(time),
          Date.parse(time),
          `nextAction:legacy:${Date.parse(time)}`,
        );
      legacy.exec(sql(focusMigration));
      expect(
        legacy
          .prepare('SELECT id,title,is_next_action,due_at FROM tasks')
          .all(),
      ).toEqual([
        {
          id: 'existing',
          title: '旧计划',
          is_next_action: 1,
          due_at: Date.parse(time),
        },
      ]);
      expect(
        legacy.prepare('SELECT last_activity_at FROM opportunities').get(),
      ).toEqual({ last_activity_at: 3 });
      expect(
        (
          legacy
            .prepare('SELECT count(*) AS n FROM reminder_deliveries')
            .get() as { n: number }
        ).n,
      ).toBe(2);
      // Runtime compatibility initialization can precede launcher migration.
      for (const statement of sql(focusMigration)
        .split('--> statement-breakpoint')
        .slice(1))
        legacy.exec(statement);
      expect(
        (
          legacy.prepare('SELECT count(*) AS n FROM tasks').get() as {
            n: number;
          }
        ).n,
      ).toBe(1);
    } finally {
      legacy.close();
    }
  });
});
