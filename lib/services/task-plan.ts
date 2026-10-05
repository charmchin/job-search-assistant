import { and, eq } from 'drizzle-orm';
import { opportunities, tasks } from '@/db/schema';
import { ActionError } from './errors';
import { makeId, required, type ActionContext } from './context';

// Shared by opportunity and task commands, inside their existing transaction.
export function createTaskPlan({ tx, timestamp, opportunity }: ActionContext) {
  const focusedTask = (opportunityId: string) =>
    tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.opportunityId, opportunityId),
          eq(tasks.isNextAction, true),
        ),
      )
      .get();
  // The task owns execution state. Opportunity fields are compatibility mirrors only.
  const chooseTask = (opportunityId: string, taskId: string | null) => {
    opportunity(opportunityId);
    const selected = taskId
      ? required(
          tx.select().from(tasks).where(eq(tasks.id, taskId)).get(),
          '任务',
        )
      : null;
    if (
      selected &&
      (selected.opportunityId !== opportunityId ||
        !['todo', 'doing'].includes(selected.status))
    )
      throw new ActionError('下一步只能选择当前机会中尚未完成的任务。');
    tx.update(tasks)
      .set({ isNextAction: false })
      .where(eq(tasks.opportunityId, opportunityId))
      .run();
    if (selected)
      tx.update(tasks)
        .set({ isNextAction: true })
        .where(eq(tasks.id, selected.id))
        .run();
    tx.update(opportunities)
      .set({
        nextAction: selected?.title ?? '',
        nextActionAt: selected?.dueAt ?? null,
      })
      .where(eq(opportunities.id, opportunityId))
      .run();
  };
  const syncPlan = (
    opportunityId: string,
    title: string,
    dueAt: Date | null,
  ) => {
    const focused = focusedTask(opportunityId);
    if (!title.trim()) {
      if (focused) chooseTask(opportunityId, null); // Unpin, never erase a task.
      return;
    }
    const existing =
      focused ??
      tx
        .select()
        .from(tasks)
        .where(eq(tasks.opportunityId, opportunityId))
        .all()
        .filter(
          (t) =>
            t.title === title &&
            ['todo', 'doing'].includes(t.status) &&
            (!dueAt || !t.dueAt || dueAt.getTime() === t.dueAt.getTime()),
        )
        .sort(
          (a, b) =>
            Number(b.dueAt?.getTime() === dueAt?.getTime()) -
              Number(a.dueAt?.getTime() === dueAt?.getTime()) ||
            a.id.localeCompare(b.id),
        )[0];
    const taskId = existing?.id ?? makeId('task');
    if (existing)
      tx.update(tasks)
        .set({
          title,
          dueAt: focused ? dueAt : (dueAt ?? existing.dueAt),
          updatedAt: timestamp,
        })
        .where(eq(tasks.id, taskId))
        .run();
    else
      tx.insert(tasks)
        .values({
          id: taskId,
          opportunityId,
          title,
          dueAt,
          source: 'manual',
          status: 'todo',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    chooseTask(opportunityId, taskId);
  };
  return { chooseTask, syncPlan };
}
