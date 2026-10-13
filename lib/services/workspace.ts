import { eq } from 'drizzle-orm';
import { extractionDrafts, settings } from '@/db/schema';
import {
  required,
  makeId,
  unreachable,
  type ActionContext,
  type ActionResult,
  type CommandFor,
} from './context';
import { ActionError } from './errors';
import { assertSettingsEdit, readEditableSettings } from './settings-guard';
import { deleteVersion } from '../delete-version';
import { applyOpportunityCommand } from './opportunities';

export type WorkspaceCommand = CommandFor<
  'addActivity' | 'discardDraft' | 'saveSettings'
>;

export function applyWorkspaceCommand(
  context: ActionContext,
  command: WorkspaceCommand,
): ActionResult {
  const { tx, timestamp, activity } = context;
  switch (command.action) {
    case 'addActivity':
      if (command.payload.stage)
        applyOpportunityCommand(context, {
          action: 'updateOpportunity',
          payload: {
            id: command.payload.opportunityId,
            stage: command.payload.stage,
            expected: command.payload.expectedStatus,
          },
        });
      activity(
        command.payload.opportunityId,
        command.payload.type,
        command.payload.content,
      );
      return { ok: true };
    case 'discardDraft': {
      const { id, draftRevision } = command.payload;
      const current = required(
        tx
          .select()
          .from(extractionDrafts)
          .where(eq(extractionDrafts.id, id))
          .get(),
        '草稿',
      );
      if (current.status === 'confirmed')
        throw new ActionError(
          '已确认的草稿不能取消，请在机会库处理正式记录。',
          409,
        );
      if (
        current.status !== 'pending' ||
        deleteVersion(current) !== draftRevision
      )
        throw new ActionError(
          '未移除：草稿已被其他操作更新或移除。请刷新草稿列表，核对最新内容后重新确认。',
          409,
          'DRAFT_CONFLICT',
        );
      tx.update(extractionDrafts)
        .set({ status: 'discarded' })
        .where(eq(extractionDrafts.id, id))
        .run();
      return { id };
    }
    case 'saveSettings': {
      const { baseUrl, model, staleDays, expected, apiKey } = command.payload;
      assertSettingsEdit(tx, expected);
      for (const [key, value] of [
        ['aiBaseUrl', baseUrl],
        ['aiModel', model],
        ['staleDays', staleDays === undefined ? undefined : String(staleDays)],
        ['aiKeyRevision', apiKey ? makeId('key') : undefined],
      ] as const)
        if (value !== undefined)
          tx.insert(settings)
            .values({ key, value, updatedAt: timestamp })
            .onConflictDoUpdate({
              target: settings.key,
              set: { value, updatedAt: timestamp },
            })
            .run();
      return expected
        ? { saved: true, keyRevision: readEditableSettings(tx).keyRevision }
        : { saved: true };
    }
  }
  return unreachable(command);
}
