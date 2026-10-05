import { eq } from 'drizzle-orm';
import { milestones } from '@/db/schema';
import {
  makeId,
  required,
  unreachable,
  type ActionContext,
  type ActionResult,
  type CommandFor,
} from './context';
import { assertRecordEdit } from './edit-guard';

export type MilestonesCommand = CommandFor<
  'createMilestone' | 'updateMilestone'
>;

export function applyMilestoneCommand(
  context: ActionContext,
  command: MilestonesCommand,
): ActionResult {
  const { tx, timestamp, opportunity, activity } = context;
  switch (command.action) {
    case 'createMilestone': {
      const fields = command.payload;
      opportunity(fields.opportunityId);
      const id = makeId('mile');
      tx.insert(milestones)
        .values({ ...fields, id, status: 'pending', createdAt: timestamp })
        .run();
      activity(
        fields.opportunityId,
        'milestone',
        `添加招聘节点：${fields.title}`,
      );
      return { id };
    }
    case 'updateMilestone': {
      const { id, expected, ...changes } = command.payload;
      const current = required(
        tx.select().from(milestones).where(eq(milestones.id, id)).get(),
        '节点',
      );
      assertRecordEdit('milestone', expected, current);
      tx.update(milestones).set(changes).where(eq(milestones.id, id)).run();
      activity(
        current.opportunityId,
        'milestone',
        changes.status === 'done' && current.status !== 'done'
          ? `完成招聘节点：${changes.title ?? current.title}`
          : `更新招聘节点：${changes.title ?? current.title}`,
      );
      return { id };
    }
  }
  return unreachable(command);
}
