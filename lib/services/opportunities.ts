import { eq, count } from 'drizzle-orm';
import {
  opportunities,
  tasks,
  materialRequirements,
  extractionDrafts,
  stageHistory,
  milestones,
  activities,
} from '@/db/schema';
import {
  makeId,
  required,
  unreachable,
  type ActionContext,
  type ActionResult,
  type CommandFor,
} from './context';
import { STAGES } from '../domain';
import { createTaskPlan } from './task-plan';
import { ActionError } from './errors';
import { opportunityConflicts, opportunityFields } from '../opportunity-edit';
import { opportunityDeleteVersion } from '../delete-version';

export type OpportunitiesCommand = CommandFor<
  | 'createOpportunity'
  | 'updateOpportunity'
  | 'deleteOpportunity'
  | 'addStageHistory'
  | 'invalidateStageHistory'
>;

export function applyOpportunityCommand(
  context: ActionContext,
  command: OpportunitiesCommand,
): ActionResult {
  const { tx, timestamp, opportunity, activity } = context;
  const stageLabel = (stage: string) =>
    STAGES.find((s) => s.id === stage)?.label ?? stage;
  const recordStage = (
    opportunityId: string,
    fromStage: string | null,
    toStage: string,
    source: 'initial' | 'transition' | 'manual',
    occurredAt: Date | null,
    notes = '',
  ) => {
    tx.insert(stageHistory)
      .values({
        id: makeId('stage'),
        opportunityId,
        fromStage,
        toStage,
        source,
        occurredAt,
        recordedAt: timestamp,
        valid: true,
        notes,
      })
      .run();
  };
  const { syncPlan } = createTaskPlan(context);
  switch (command.action) {
    case 'createOpportunity': {
      const {
        tasks: children,
        requirements,
        draftId,
        evidence: _evidence,
        confidence: _confidence,
        ...fields
      } = command.payload;
      if (draftId) {
        const draft = required(
          tx
            .select()
            .from(extractionDrafts)
            .where(eq(extractionDrafts.id, draftId))
            .get(),
          '草稿',
        );
        if (draft.status !== 'pending')
          throw new ActionError(
            '草稿已确认或取消，请刷新后核对机会库。',
            409,
            'DRAFT_NOT_PENDING',
          );
      }
      const duplicate = tx
        .select()
        .from(opportunities)
        .all()
        .find(
          (row) =>
            (fields.sourceUrl && row.sourceUrl === fields.sourceUrl) ||
            (row.organization.trim().toLowerCase() ===
              fields.organization.toLowerCase() &&
              row.role.trim().toLowerCase() === fields.role.toLowerCase()),
        );
      if (duplicate)
        throw new ActionError(
          '发现疑似重复机会',
          409,
          'DUPLICATE_OPPORTUNITY',
          { duplicateId: duplicate.id },
        );
      const id = makeId('opp');
      const stage = fields.decision === 'skip' ? 'closed' : fields.stage;
      tx.insert(opportunities)
        .values({
          ...fields,
          id,
          stage,
          closedReason:
            fields.decision === 'skip'
              ? 'withdrawn'
              : stage === 'closed'
                ? fields.closedReason
                : 'unknown',
          createdAt: timestamp,
          updatedAt: timestamp,
          lastActivityAt: timestamp,
        })
        .run();
      recordStage(
        id,
        null,
        stage,
        'initial',
        stage === 'evaluating' ? timestamp : null,
      );
      for (const row of children)
        tx.insert(tasks)
          .values({
            ...row,
            id: makeId('task'),
            opportunityId: id,
            status: 'todo',
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .run();
      for (const row of requirements)
        tx.insert(materialRequirements)
          .values({
            ...row,
            id: makeId('req'),
            opportunityId: id,
            completed: false,
          })
          .run();
      syncPlan(id, fields.nextAction, fields.nextActionAt);
      activity(id, 'created', '创建了机会');
      if (draftId)
        tx.update(extractionDrafts)
          .set({ status: 'confirmed' })
          .where(eq(extractionDrafts.id, draftId))
          .run();
      return { id };
    }
    case 'updateOpportunity': {
      const { id, expected, ...changes } = command.payload;
      const current = opportunity(id);
      const conflicts = expected ? opportunityConflicts(expected, current) : [];
      if (conflicts.length)
        throw new ActionError(
          `未保存：${conflicts.map((key) => opportunityFields[key]).join('、')}已被其他操作修改。输入已保留，请核对最新内容；不会覆盖已有修改。`,
          409,
          'EDIT_CONFLICT',
          { fields: conflicts },
        );
      if ((changes.decision ?? current.decision) === 'skip')
        changes.stage = 'closed';
      const nextStage = changes.stage ?? current.stage;
      changes.closedReason =
        nextStage !== 'closed'
          ? 'unknown'
          : (changes.decision ?? current.decision) === 'skip'
            ? 'withdrawn'
            : (changes.closedReason ??
              (current.stage === 'closed' ? current.closedReason : 'unknown'));
      tx.update(opportunities)
        .set(changes)
        .where(eq(opportunities.id, id))
        .run();
      if (nextStage !== current.stage)
        recordStage(id, current.stage, nextStage, 'transition', timestamp);
      if (
        changes.nextAction !== undefined ||
        changes.nextActionAt !== undefined
      )
        syncPlan(
          id,
          changes.nextAction ?? current.nextAction,
          changes.nextActionAt === undefined
            ? current.nextActionAt
            : changes.nextActionAt,
        );
      activity(
        id,
        'updated',
        changes.stage && changes.stage !== current.stage
          ? `招聘阶段：${stageLabel(current.stage)} → ${stageLabel(nextStage)}`
          : '更新了机会信息',
      );
      return { id };
    }
    case 'deleteOpportunity': {
      const { id, expectedVersion } = command.payload;
      const current = opportunity(id);
      if (expectedVersion) {
        const version = opportunityDeleteVersion(
          current,
          tx.select().from(tasks).where(eq(tasks.opportunityId, id)).all(),
          tx
            .select()
            .from(milestones)
            .where(eq(milestones.opportunityId, id))
            .all(),
          tx
            .select()
            .from(materialRequirements)
            .where(eq(materialRequirements.opportunityId, id))
            .all(),
          tx
            .select()
            .from(stageHistory)
            .where(eq(stageHistory.opportunityId, id))
            .all(),
          tx
            .select({ value: count() })
            .from(activities)
            .where(eq(activities.opportunityId, id))
            .get()!.value,
        );
        if (version !== expectedVersion)
          throw new ActionError(
            '未删除：机会或关联记录已变化，请核对最新内容后重新确认删除。',
            409,
            'EDIT_CONFLICT',
          );
      }
      tx.delete(opportunities).where(eq(opportunities.id, id)).run();
      return { id };
    }
    case 'addStageHistory': {
      const { opportunityId, stage, occurredAt, notes } = command.payload;
      opportunity(opportunityId);
      if (occurredAt && occurredAt.getTime() > timestamp.getTime())
        throw new ActionError(
          '经历补记不能填写未来时间；未来安排请添加招聘节点。',
        );
      recordStage(opportunityId, null, stage, 'manual', occurredAt, notes);
      activity(
        opportunityId,
        'stage-history',
        `补记招聘经历：${stageLabel(stage)}${notes ? ` · ${notes}` : ''}`,
      );
      return { id: opportunityId };
    }
    case 'invalidateStageHistory': {
      const { id, notes } = command.payload;
      const current = required(
        tx.select().from(stageHistory).where(eq(stageHistory.id, id)).get(),
        '阶段记录',
      );
      if (!current.valid)
        throw new ActionError('该阶段记录已作废，请刷新核对。', 409);
      tx.update(stageHistory)
        .set({ valid: false })
        .where(eq(stageHistory.id, id))
        .run();
      activity(
        current.opportunityId,
        'stage-history',
        `作废误记经历：${stageLabel(current.toStage)} · ${notes}`,
      );
      return { id };
    }
  }
  return unreachable(command);
}
