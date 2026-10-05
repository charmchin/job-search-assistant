import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, afterEach, it, expect, describe } from 'vitest';
import * as schema from '@/db/schema';
import { createActionService } from './actions';
import { actionSchema } from './action-schema';
import { readWorkspaceState } from './workspace-repository';
import { deleteVersion, opportunityDeleteVersion } from './delete-version';
let client: Database.Database;
let service: ReturnType<typeof createActionService>;
let owner: string, materialId: string, requirementId: string;
const run = (
  action: string,
  payload: Record<string, unknown>,
  requestId?: string,
) => service.execute({ action, payload, requestId });
const state = () =>
  readWorkspaceState(drizzle(client, { schema }), new Date(), () => false);
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
  for (const f of fs
    .readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    client.exec(fs.readFileSync(path.join('drizzle', f), 'utf8'));
  service = createActionService(client, async () => {});
  owner = (
    await run('createOpportunity', {
      organization: '删除竞态',
      role: '研发',
      nextAction: '准备简历',
    })
  ).id as string;
  materialId = (await run('createMaterial', { name: '简历' })).id as string;
  requirementId = (
    await run('createRequirement', {
      opportunityId: owner,
      name: '提交简历',
      materialId,
    })
  ).id as string;
});
afterEach(() => client.close());
describe('删除确认版本保护', () => {
  it('规范化键顺序、日期对象与关联行排序', () => {
    expect(deleteVersion({ a: 1, b: new Date('2026-10-01T00:00:00Z') })).toBe(
      deleteVersion({ b: '2026-10-01T00:00:00.000Z', a: 1 }),
    );
    expect(
      opportunityDeleteVersion(
        { id: 'a' },
        [{ id: '2' }, { id: '1' }],
        [],
        [],
        [],
        1,
      ),
    ).toBe(
      opportunityDeleteVersion(
        { id: 'a' },
        [{ id: '1' }, { id: '2' }],
        [],
        [],
        [],
        1,
      ),
    );
  });
  it.each(['task', 'milestone', 'requirement', 'history', 'activity'] as const)(
    '机会关联 %s 改变后，旧确认不能级联删除',
    async (kind) => {
      const original = state().opportunities[0];
      if (kind === 'task')
        await run('updateTask', { id: state().tasks[0].id, title: '更新行动' });
      if (kind === 'milestone')
        await run('createMilestone', {
          opportunityId: owner,
          title: '新增面试',
        });
      if (kind === 'requirement')
        await run('updateRequirement', {
          id: requirementId,
          notes: '新要求说明',
        });
      if (kind === 'history')
        await run('addStageHistory', {
          opportunityId: owner,
          stage: 'applied',
        });
      if (kind === 'activity')
        await run('addActivity', { opportunityId: owner, content: '新活动' });
      const before = snapshot();
      await expect(
        run('deleteOpportunity', {
          id: owner,
          expectedVersion: original.deleteVersion,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'EDIT_CONFLICT' });
      expect(snapshot()).toEqual(before);
    },
  );
  it('其他机会的改变不影响当前删除确认', async () => {
    const original = state().opportunities[0];
    await run('createOpportunity', { organization: '其他组织', role: '岗位' });
    await run('deleteOpportunity', {
      id: owner,
      expectedVersion: original.deleteVersion,
    });
    expect(state().opportunities.some((o) => o.id === owner)).toBe(false);
    expect(client.pragma('foreign_key_check')).toEqual([]);
  });
  it.each(['record', 'link', 'ready'] as const)(
    '材料 %s 改变后旧确认不能清除关联',
    async (kind) => {
      const original = state().materials[0];
      if (kind === 'record')
        await run('updateMaterial', { id: materialId, version: 'v2' });
      if (kind === 'link')
        await run('createRequirement', {
          opportunityId: owner,
          name: '新关联',
          materialId,
        });
      if (kind === 'ready')
        await run('updateRequirement', { id: requirementId, completed: true });
      const before = snapshot();
      await expect(
        run('deleteMaterial', {
          id: materialId,
          expectedVersion: original.deleteVersion,
        }),
      ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
      expect(snapshot()).toEqual(before);
    },
  );
  it('要求已改动后不能从旧编辑会话中删除', async () => {
    const original = state().requirements[0];
    await run('updateRequirement', { id: requirementId, notes: '新的说明' });
    const before = snapshot();
    await expect(
      run('deleteRequirement', {
        id: requirementId,
        expectedVersion: original.deleteVersion,
      }),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    expect(snapshot()).toEqual(before);
  });
  it.each(['opportunity', 'material', 'requirement'] as const)(
    '最新 %s 确认可成功，响应丢失可重放而不报 404',
    async (kind) => {
      const data = state();
      const record =
        kind === 'opportunity'
          ? data.opportunities[0]
          : kind === 'material'
            ? data.materials[0]
            : data.requirements[0];
      const action =
        kind === 'opportunity'
          ? 'deleteOpportunity'
          : kind === 'material'
            ? 'deleteMaterial'
            : 'deleteRequirement';
      const payload = { id: record.id, expectedVersion: record.deleteVersion };
      const requestId = randomUUID();
      const result = await run(action, payload, requestId);
      const before = snapshot();
      service = createActionService(client, async () => {});
      expect(await run(action, payload, requestId)).toEqual(result);
      expect(snapshot()).toEqual(before);
      expect(client.pragma('foreign_key_check')).toEqual([]);
    },
  );
  it.each(['bad', 'a'.repeat(63), 'z'.repeat(64), null])(
    '非法令牌拒绝（%#）',
    (token) => {
      expect(
        actionSchema.safeParse({
          action: 'deleteMaterial',
          payload: { id: 'a', expectedVersion: token },
        }).success,
      ).toBe(false);
    },
  );
});
