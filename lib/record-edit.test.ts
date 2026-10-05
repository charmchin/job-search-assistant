import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import * as schema from '@/db/schema';
import { createActionService } from './actions';
import { actionSchema } from './action-schema';
import { readWorkspaceState } from './workspace-repository';
import { buildRecordUpdate, buildRequirementUpdate } from './record-edit';
import type { WorkspaceState } from './client-types';

let client: Database.Database;
let service: ReturnType<typeof createActionService>;
let owner: string;
const run = (
  action: string,
  payload: Record<string, unknown>,
  requestId?: string,
) => service.execute({ action, payload, requestId });
const state = () =>
  JSON.parse(
    JSON.stringify(
      readWorkspaceState(drizzle(client, { schema }), new Date(), () => false),
    ),
  ) as WorkspaceState;
const snapshot = () =>
  [
    'opportunities',
    'tasks',
    'milestones',
    'materials',
    'material_requirements',
    'activities',
    'stage_history',
    'mutation_receipts',
  ].map((t) => client.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
beforeEach(async () => {
  client = new Database(':memory:');
  client.pragma('foreign_keys=ON');
  for (const name of fs
    .readdirSync('drizzle')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    client.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
  service = createActionService(client, async () => {});
  owner = (
    await run('createOpportunity', {
      organization: '并发实体',
      role: '研发',
      nextAction: '准备简历',
    })
  ).id as string;
  await run('createMilestone', {
    opportunityId: owner,
    title: '一面',
    result: '原节点说明',
    scheduledAt: '2026-10-20T09:00:00+08:00',
  });
  const materialId = (
    await run('createMaterial', {
      name: '简历',
      filePath: '/tmp/old.pdf',
      version: 'v1',
      notes: '原材料说明',
    })
  ).id;
  await run('createRequirement', {
    opportunityId: owner,
    name: '提交简历',
    materialId,
    notes: '原要求说明',
  });
});
afterEach(() => client.close());
const cases = [
  [
    'task',
    'updateTask',
    'tasks',
    { title: '窗口甲' },
    { estimatedMinutes: 60 },
  ],
  [
    'milestone',
    'updateMilestone',
    'milestones',
    { result: '窗口甲' },
    { reminderOffsets: [60] },
  ],
  [
    'material',
    'updateMaterial',
    'materials',
    { notes: '窗口甲' },
    { name: '新材料名称' },
  ],
  [
    'requirement',
    'updateRequirement',
    'requirements',
    { notes: '窗口甲' },
    { name: '新要求名称' },
  ],
] as const;
const first = (key: (typeof cases)[number][2]) => state()[key][0];
describe.each(cases)(
  '%s 字段级并发保护',
  (kind, action, key, same, different) => {
    it('同字段冲突后全部关联表及回执不变', async () => {
      const original = first(key);
      await run(action, buildRecordUpdate(kind, original, same)!);
      const before = snapshot();
      const changedKey = Object.keys(same)[0];
      await expect(
        run(
          action,
          buildRecordUpdate(kind, original, { [changedKey]: '窗口乙' })!,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'EDIT_CONFLICT' });
      expect(snapshot()).toEqual(before);
    });
    it('不同独立字段保存不重传旧值', async () => {
      const original = first(key);
      await run(action, buildRecordUpdate(kind, original, same)!);
      const payload = buildRecordUpdate(kind, original, different)!;
      expect(payload).not.toHaveProperty(Object.keys(same)[0]);
      await run(action, payload);
      expect(first(key)).toMatchObject({ ...same, ...different });
    });
    it('并发写同一字段仅一个成功', async () => {
      const original = first(key);
      const field = Object.keys(same)[0];
      const results = await Promise.allSettled([
        run(action, buildRecordUpdate(kind, original, { [field]: '甲' })!),
        run(action, buildRecordUpdate(kind, original, { [field]: '乙' })!),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });
    it('回执重放优先于原值冲突，不重写记录', async () => {
      const original = first(key);
      const requestId = randomUUID();
      const payload = buildRecordUpdate(kind, original, same)!;
      const result = await run(action, payload, requestId);
      await run(
        action,
        buildRecordUpdate(kind, first(key), {
          [Object.keys(same)[0]]: '后续新值',
        })!,
      );
      const before = snapshot();
      service = createActionService(client, async () => {});
      expect(await run(action, payload, requestId)).toEqual(result);
      expect(snapshot()).toEqual(before);
    });
    it('回执落盘失败时整个 guarded 写入回滚', async () => {
      const original = first(key);
      const before = snapshot();
      client.exec(
        "CREATE TRIGGER reject_receipt BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT,'fixture'); END",
      );
      await expect(
        run(action, buildRecordUpdate(kind, original, same)!, randomUUID()),
      ).rejects.toThrow();
      expect(snapshot()).toEqual(before);
    });
    it('没有修改不产生请求，展示字段永不写入', () => {
      const original = first(key);
      expect(
        buildRecordUpdate(kind, original, { ...original, fileExists: true }),
      ).toBeNull();
    });
  },
);

describe('关联语义与就绪保护', () => {
  it('旧状态不能完成已改名称或时间的任务，且不会清除新重点', async () => {
    const original = state().tasks[0];
    await run(
      'updateTask',
      buildRecordUpdate('task', original, {
        title: '新任务含义',
        dueAt: '2026-10-21T01:00:00.000Z',
      })!,
    );
    const before = snapshot();
    await expect(
      run(
        'updateTask',
        buildRecordUpdate('task', original, { status: 'done' })!,
      ),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    expect(snapshot()).toEqual(before);
    expect(state().opportunities[0]).toMatchObject({
      nextAction: '新任务含义',
      nextActionAt: '2026-10-21T01:00:00.000Z',
    });
  });
  it('节点改期后旧窗口不能标记完成', async () => {
    const original = state().milestones[0];
    await run(
      'updateMilestone',
      buildRecordUpdate('milestone', original, {
        scheduledAt: '2026-10-25T01:00:00.000Z',
      })!,
    );
    await expect(
      run(
        'updateMilestone',
        buildRecordUpdate('milestone', original, { status: 'done' })!,
      ),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
  });
  it('材料路径和版本不能来自两个旧表单交叉拼接', async () => {
    const original = state().materials[0];
    await run(
      'updateMaterial',
      buildRecordUpdate('material', original, { filePath: '/tmp/new.pdf' })!,
    );
    await expect(
      run(
        'updateMaterial',
        buildRecordUpdate('material', original, { version: 'v2' })!,
      ),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
  });
  it.each(['filePath', 'version'] as const)(
    '更换材料 %s 后，即使要求仍待准备，旧窗口也不能标记就绪',
    async (field) => {
      const original = state();
      const requirement = original.requirements[0];
      const ready = buildRequirementUpdate(
        requirement,
        { completed: true },
        original.materials,
      )!;
      await run(
        'updateMaterial',
        buildRecordUpdate('material', original.materials[0], {
          [field]: field === 'filePath' ? '/tmp/replaced.pdf' : 'v2',
        })!,
      );
      expect(state().requirements[0].completed).toBe(false);
      const before = snapshot();
      await expect(run('updateRequirement', ready)).rejects.toMatchObject({
        code: 'EDIT_CONFLICT',
      });
      expect(snapshot()).toEqual(before);
      const latest = state();
      await run(
        'updateRequirement',
        buildRequirementUpdate(
          latest.requirements[0],
          { completed: true },
          latest.materials,
        )!,
      );
      expect(state().requirements[0].completed).toBe(true);
    },
  );
  it('就绪后更换材料仍恢复待准备；无关备注不阻止就绪', async () => {
    const original = state();
    const ready = buildRequirementUpdate(
      original.requirements[0],
      { completed: true },
      original.materials,
    )!;
    await run(
      'updateMaterial',
      buildRecordUpdate('material', original.materials[0], {
        notes: '无关备注',
      })!,
    );
    await run('updateRequirement', ready);
    expect(state().requirements[0].completed).toBe(true);
    await run(
      'updateMaterial',
      buildRecordUpdate('material', state().materials[0], { version: 'v2' })!,
    );
    expect(state().requirements[0].completed).toBe(false);
  });
  it('未关联本机文件的材料要求仍可按实际情况手动就绪', async () => {
    const row = state().requirements[0];
    await run(
      'updateRequirement',
      buildRecordUpdate('requirement', row, { materialId: null })!,
    );
    await run(
      'updateRequirement',
      buildRequirementUpdate(
        state().requirements[0],
        { completed: true },
        state().materials,
      )!,
    );
    expect(state().requirements[0].completed).toBe(true);
  });
  it('旧窗口不能取消或替换新选中的重点任务', async () => {
    const original = state().tasks[0];
    const other = (
      await run('createTask', { opportunityId: owner, title: '新的重点' })
    ).id;
    await run('setNextTask', { opportunityId: owner, taskId: other });
    const before = snapshot();
    await expect(
      run('setNextTask', {
        opportunityId: owner,
        taskId: null,
        expectedTaskId: original.id,
      }),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    expect(snapshot()).toEqual(before);
  });
  it('选择重点也要核对目标任务内容和状态', async () => {
    const original = state().tasks[0];
    await run(
      'updateTask',
      buildRecordUpdate('task', original, { title: '改名后任务' })!,
    );
    await expect(
      run('setNextTask', {
        opportunityId: owner,
        taskId: original.id,
        expectedTaskId: original.id,
        expectedTask: {
          title: original.title,
          dueAt: original.dueAt,
          status: original.status,
        },
      }),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
  });
  it.each([
    ['updateTask', { title: '新', expected: { title: '旧' } }],
    ['updateMilestone', { status: 'done', expected: { status: 'pending' } }],
    ['updateMaterial', { version: 'v2', expected: { version: 'v1' } }],
    ['updateRequirement', { completed: true, expected: { completed: false } }],
    [
      'updateRequirement',
      { completed: true, expected: { completed: false, materialId: 'mat' } },
    ],
    [
      'updateRequirement',
      {
        completed: true,
        expected: { completed: false, materialId: 'mat' },
        expectedMaterial: { id: 'other', filePath: '', version: '' },
      },
    ],
    ['updateTask', { expected: { title: '旧', dueAt: null, status: 'todo' } }],
    [
      'updateMaterial',
      { notes: '新', expected: { notes: '旧', secret: '私密' } },
    ],
  ])('不完整或坏基线被拒绝（%s）', (action, payload) => {
    expect(
      actionSchema.safeParse({ action, payload: { id: 'row', ...payload } })
        .success,
    ).toBe(false);
  });
});
