import { and, eq } from 'drizzle-orm';
import { tasks } from '@/db/schema';
import {
  makeId,
  required,
  unreachable,
  type ActionContext,
  type ActionResult,
  type CommandFor,
} from './context';
import { createTaskPlan } from './task-plan';
import { assertRecordEdit } from './edit-guard';
import { ActionError } from './errors';

export type TasksCommand = CommandFor<
  'createTask' | 'updateTask' | 'setNextTask'
>;

export function applyTaskCommand(
  context: ActionContext,
  command: TasksCommand,
): ActionResult {
  const { tx, timestamp, opportunity, activity } = context;
  const { chooseTask } = createTaskPlan(context);
  switch (command.action) {
    case 'createTask': {
      const { opportunityId = null, ...fields } = command.payload;
      if (opportunityId) opportunity(opportunityId);
      const id = makeId('task');
      tx.insert(tasks)
        .values({
          ...fields,
          id,
          opportunityId,
          status: 'todo',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      if (opportunityId)
        activity(opportunityId, 'task', `添加行动：${fields.title}`);
      return { id };
    }
    case 'updateTask': {
      const { id, expected, ...changes } = command.payload;
      const current = required(
        tx.select().from(tasks).where(eq(tasks.id, id)).get(),
        '任务',
      );
      assertRecordEdit('task', expected, current);
      tx.update(tasks)
        .set({ ...changes, updatedAt: timestamp })
        .where(eq(tasks.id, id))
        .run();
      if (current.isNextAction && current.opportunityId) {
        if (['done', 'skipped'].includes(changes.status ?? current.status))
          chooseTask(current.opportunityId, null);
        else chooseTask(current.opportunityId, id);
      }
      if (current.opportunityId)
        activity(
          current.opportunityId,
          'task',
          changes.status === 'done' && current.status !== 'done'
            ? `完成行动：${changes.title ?? current.title}`
            : changes.status === 'skipped' && current.status !== 'skipped'
              ? `跳过行动：${changes.title ?? current.title}`
              : `更新行动：${changes.title ?? current.title}`,
        );
      return { id };
    }
    case 'setNextTask': {
      const { opportunityId, taskId, expectedTaskId, expectedTask } =
        command.payload;
      opportunity(opportunityId);
      if (expectedTaskId !== undefined) {
        const selected = tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.opportunityId, opportunityId),
              eq(tasks.isNextAction, true),
            ),
          )
          .get();
        if ((selected?.id ?? null) !== expectedTaskId)
          throw new ActionError(
            '未保存：下一步重点已被其他操作修改，请核对最新任务后重新选择。',
            409,
            'EDIT_CONFLICT',
          );
      }
      if (taskId && expectedTask) {
        const target = required(
          tx.select().from(tasks).where(eq(tasks.id, taskId)).get(),
          '任务',
        );
        assertRecordEdit('task', expectedTask, target);
      }
      chooseTask(opportunityId, taskId);
      activity(
        opportunityId,
        'task',
        taskId ? '设置了下一步行动' : '取消了下一步重点（任务仍保留）',
      );
      return { id: opportunityId };
    }
  }
  return unreachable(command);
}
