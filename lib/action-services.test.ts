import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError, createActionService } from './actions';
import { ActionError as ServiceError } from './services/errors';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { extractionDrafts } from '@/db/schema';
import { deleteVersion } from './delete-version';

let client: Database.Database;
let service: ReturnType<typeof createActionService>;
const keychain = vi.fn<(_key: string) => Promise<void>>();
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

// Include internal receipts and settings: every entity must still share the
// coordinator's transaction, including a failure after all domain writes.
const snapshot = () =>
  Object.fromEntries(
    client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => {
        const name = (row as { name: string }).name;
        return [
          name,
          client.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
        ];
      }),
  );
async function fixture() {
  const run = async (action: string, payload: Record<string, unknown>) =>
    (await service.execute({ action, payload })).id as string;
  const opportunityId = await run('createOpportunity', {
    organization: '隔离服务测试',
    role: '开发工程师',
    nextAction: '准备简历',
    tasks: [{ title: '准备简历' }],
    requirements: [{ name: '简历' }],
  });
  const materialId = await run('createMaterial', {
    name: '简历 v1',
    version: 'v1',
  });
  const taskId = (
    client.prepare('SELECT id FROM tasks').get() as { id: string }
  ).id;
  const requirementId = (
    client.prepare('SELECT id FROM material_requirements').get() as {
      id: string;
    }
  ).id;
  await service.execute({
    action: 'updateRequirement',
    payload: { id: requirementId, materialId },
  });
  await service.execute({
    action: 'updateRequirement',
    payload: { id: requirementId, completed: true },
  });
  const milestoneId = await run('createMilestone', {
    opportunityId,
    title: '面试',
  });
  const historyId = (
    client.prepare('SELECT id FROM stage_history').get() as { id: string }
  ).id;
  client
    .prepare(
      "INSERT INTO extraction_drafts (id, source_url, source_text, extracted_json, status, created_at) VALUES (?, '', '隔离原文', '{}', 'pending', ?)",
    )
    .run('draft-service-test', Date.now());
  return {
    draftRevision: deleteVersion(
      drizzle(client).select().from(extractionDrafts).get(),
    ),
    opportunityId,
    taskId,
    materialId,
    requirementId,
    milestoneId,
    historyId,
  };
}

const commands = [
  'createOpportunity',
  'updateOpportunity',
  'deleteOpportunity',
  'addStageHistory',
  'invalidateStageHistory',
  'createTask',
  'updateTask',
  'setNextTask',
  'createMilestone',
  'updateMilestone',
  'createMaterial',
  'updateMaterial',
  'deleteMaterial',
  'createRequirement',
  'updateRequirement',
  'deleteRequirement',
  'addActivity',
  'discardDraft',
  'saveSettings',
] as const;

describe('实体服务保持统一写入边界', () => {
  it('路由和实体服务使用相同错误类，不破坏状态码处理', async () => {
    expect(ActionError).toBe(ServiceError);
    await expect(
      service.execute({ action: 'deleteMaterial', payload: { id: 'missing' } }),
    ).rejects.toBeInstanceOf(ActionError);
    expect(snapshot().materials).toEqual([]);
  });
  it.each(commands)(
    '%s：回执落盘失败整体回滚，同 ID 修正后重试并可跨服务重放',
    async (action) => {
      const f = await fixture();
      const payloads: Record<
        (typeof commands)[number],
        Record<string, unknown>
      > = {
        createOpportunity: {
          organization: '新组织',
          role: '新岗位',
          draftId: 'draft-service-test',
          nextAction: '准备网申',
          tasks: [{ title: '准备网申' }],
          requirements: [{ name: '成绩单' }],
        },
        updateOpportunity: {
          id: f.opportunityId,
          stage: 'interview',
          nextAction: '准备面试',
        },
        deleteOpportunity: { id: f.opportunityId },
        addStageHistory: {
          opportunityId: f.opportunityId,
          stage: 'applied',
          notes: '已投递',
        },
        invalidateStageHistory: { id: f.historyId, notes: '误录修正' },
        createTask: { opportunityId: f.opportunityId, title: '网申' },
        updateTask: { id: f.taskId, status: 'done' },
        setNextTask: { opportunityId: f.opportunityId, taskId: null },
        createMilestone: { opportunityId: f.opportunityId, title: '笔试' },
        updateMilestone: { id: f.milestoneId, status: 'done', result: '通过' },
        createMaterial: { name: '成绩单' },
        updateMaterial: { id: f.materialId, version: 'v2' },
        deleteMaterial: { id: f.materialId },
        createRequirement: {
          opportunityId: f.opportunityId,
          name: '作品集',
          materialId: f.materialId,
        },
        updateRequirement: { id: f.requirementId, materialId: null },
        deleteRequirement: { id: f.requirementId },
        addActivity: { opportunityId: f.opportunityId, content: '跟进招聘' },
        discardDraft: {
          id: 'draft-service-test',
          draftRevision: f.draftRevision,
        },
        saveSettings: { model: 'local-test-model', staleDays: 6 },
      };
      const input = {
        action,
        payload: payloads[action],
        requestId: randomUUID(),
      };
      const before = snapshot();
      client.exec(
        "CREATE TRIGGER reject_receipt BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT, 'receipt-fixture'); END;",
      );
      await expect(service.execute(input)).rejects.toThrow();
      expect(snapshot()).toEqual(before);
      expect(client.pragma('foreign_key_check')).toEqual([]);
      client.exec('DROP TRIGGER reject_receipt');
      const result = await service.execute(input);
      expect(result).toEqual(
        action === 'addActivity'
          ? { ok: true }
          : action === 'saveSettings'
            ? { saved: true }
            : { id: expect.any(String) },
      );
      const committed = snapshot();
      service = createActionService(client, keychain);
      expect(await service.execute(input)).toEqual(result);
      expect(snapshot()).toEqual(committed);
      expect(client.pragma('foreign_key_check')).toEqual([]);
      expect(keychain).not.toHaveBeenCalled();
    },
  );
});
