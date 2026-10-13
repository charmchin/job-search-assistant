import { and, eq } from 'drizzle-orm';
import { tasks } from '@/db/schema';
import { STAGES, formatDateTime } from '../domain';
import { opportunityConflicts } from '../opportunity-edit';
import { DEFAULT_MILESTONE_MINUTES } from '../reminder-policy';
import { type ActionContext, type CommandFor, required } from './context';
import { ActionError } from './errors';
import { assertRecordEdit } from './edit-guard';
import { applyOpportunityCommand } from './opportunities';
import { applyTaskCommand } from './tasks';
import { applyMilestoneCommand } from './milestones';
import { createTaskPlan } from './task-plan';

// Called inside the coordinator's transaction: stage, selected task completion,
// follow-up and appointment either all commit or all roll back.
export function applyProgressCommand(
  context: ActionContext,
  command: CommandFor<'recordProgress'>,
) {
  const { tx, timestamp, opportunity, activity } = context;
  const payload = command.payload;
  const current = opportunity(payload.opportunityId);
  if (opportunityConflicts(payload.expectedStatus, current).length)
    throw new ActionError(
      '岗位状态已变化，输入已保留。请关闭后重新打开，核对最新进展。',
      409,
      'EDIT_CONFLICT',
    );
  if (current.stage === 'closed' || current.decision === 'skip')
    throw new ActionError('请先在详情中恢复这个机会，再记录新的推进计划。');
  if (payload.occurredAt && payload.occurredAt > timestamp)
    throw new ActionError(
      '进展发生时间不能晚于现在；未来安排请填写招聘节点时间。',
    );
  for (const item of payload.completedTasks) {
    const task = required(
      tx.select().from(tasks).where(eq(tasks.id, item.id)).get(),
      '任务',
    );
    if (task.opportunityId !== current.id)
      throw new ActionError('所选任务不属于这个机会。');
    assertRecordEdit('task', item.expected, task);
  }
  if (payload.followUp) {
    const focused = tx
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.opportunityId, current.id), eq(tasks.isNextAction, true)),
      )
      .get();
    if ((focused?.id ?? null) !== payload.followUp.expectedNextTaskId)
      throw new ActionError(
        '下一步已被其他操作修改，请核对后重新安排。',
        409,
        'EDIT_CONFLICT',
      );
  }
  if (payload.stage) {
    if (payload.stage !== current.stage) {
      applyOpportunityCommand(
        context,
        {
          action: 'updateOpportunity',
          payload: {
            id: current.id,
            stage: payload.stage,
            expected: payload.expectedStatus,
          },
        },
        payload.occurredAt!,
      );
    } else {
      applyOpportunityCommand(context, {
        action: 'addStageHistory',
        payload: {
          opportunityId: current.id,
          stage: payload.stage,
          occurredAt: payload.occurredAt!,
          notes: payload.content,
        },
      });
    }
  }
  for (const item of payload.completedTasks)
    applyTaskCommand(context, {
      action: 'updateTask',
      payload: { id: item.id, status: 'done', expected: item.expected },
    });
  if (payload.followUp) {
    const created = applyTaskCommand(context, {
      action: 'createTask',
      payload: {
        opportunityId: current.id,
        title: payload.followUp.title,
        dueAt: payload.followUp.dueAt,
        source: 'manual',
        estimatedMinutes: 15,
      },
    });
    createTaskPlan(context).chooseTask(current.id, created.id as string);
  }
  if (payload.milestone)
    applyMilestoneCommand(context, {
      action: 'createMilestone',
      payload: {
        opportunityId: current.id,
        ...payload.milestone,
        result: '',
        reminderOffsets: [...DEFAULT_MILESTONE_MINUTES],
      },
    });
  const label = STAGES.find((s) => s.id === payload.stage)?.label;
  const summary = [
    label ? `${formatDateTime(payload.occurredAt)} · ${label}` : '',
    payload.content,
    payload.completedTasks.length
      ? `完成 ${payload.completedTasks.length} 项任务`
      : '',
    payload.followUp ? `下一步：${payload.followUp.title}` : '',
    payload.milestone
      ? `已安排：${payload.milestone.title}（${formatDateTime(payload.milestone.scheduledAt)}）`
      : '',
  ]
    .filter(Boolean)
    .join('；');
  activity(current.id, 'note', summary);
  return { id: current.id };
}
