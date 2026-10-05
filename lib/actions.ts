import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { actionSchema } from './action-schema';
import { withWriteLock } from './write-lock';
import { ActionError } from './services/errors';
import { applyCommand } from './services/dispatch';
import { assertSettingsEdit } from './services/settings-guard';

// Preserve the public error identity used by route handlers and callers.
export { ActionError } from './services/errors';

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function createActionService(
  client: Database.Database,
  saveApiKey: (value: string) => Promise<void>,
) {
  const db = drizzle(client, { schema });
  const inFlight = new Map<
    string,
    { hash: string; promise: Promise<Record<string, unknown>> }
  >();
  function cached(requestId: string | undefined, hash: string) {
    if (!requestId) return;
    const receipt = db
      .select()
      .from(schema.mutationReceipts)
      .where(eq(schema.mutationReceipts.requestId, requestId))
      .get();
    if (!receipt) return;
    if (receipt.invalidated)
      throw new ActionError(
        '备份恢复后，旧请求已失效。请刷新核对后重新操作。',
        409,
        'REQUEST_INVALIDATED',
      );
    if (receipt.requestHash !== hash)
      throw new ActionError(
        '同一请求标识不能用于不同内容。',
        409,
        'REQUEST_CONFLICT',
      );
    return JSON.parse(receipt.responseJson) as Record<string, unknown>;
  }
  return {
    async execute(input: unknown) {
      const command = actionSchema.parse(input);
      const { requestId } = command;
      const hash = createHash('sha256')
        .update(canonical({ action: command.action, payload: command.payload }))
        .digest('hex');
      const existing = cached(requestId, hash);
      if (existing) return existing;
      if (requestId && inFlight.has(requestId)) {
        const running = inFlight.get(requestId)!;
        if (running.hash !== hash)
          throw new ActionError(
            '同一请求标识不能用于不同内容。',
            409,
            'REQUEST_CONFLICT',
          );
        return running.promise;
      }
      const promise = withWriteLock(async () => {
        const previous = cached(requestId, hash);
        if (previous) return previous;
        let keySaved = false;
        // Reject an already-stale settings form before touching the Keychain.
        // The transaction repeats this check after an asynchronous native write.
        if (command.action === 'saveSettings')
          assertSettingsEdit(db, command.payload.expected);
        if (command.action === 'saveSettings' && command.payload.apiKey) {
          try {
            await saveApiKey(command.payload.apiKey);
            keySaved = true;
          } catch {
            throw new ActionError(
              '钥匙串保存失败，数据库设置未修改。请检查系统权限后重试。',
              500,
              'KEYCHAIN_FAILED',
            );
          }
        }
        try {
          return db.transaction(
            (tx) => {
              const previous = cached(requestId, hash);
              if (previous) return previous;
              const timestamp = new Date();
              const result = applyCommand(tx, command, timestamp);
              if (requestId)
                tx.insert(schema.mutationReceipts)
                  .values({
                    requestId,
                    requestHash: hash,
                    responseJson: JSON.stringify(result),
                    createdAt: timestamp,
                  })
                  .run();
              return result;
            },
            { behavior: 'immediate' },
          );
        } catch (error) {
          if (keySaved)
            throw new ActionError(
              '密钥已保存到钥匙串，但数据库设置保存失败。请核对后重试；数据库设置已回滚。',
              500,
              'SETTINGS_PARTIAL',
            );
          throw error;
        }
      });
      if (requestId) inFlight.set(requestId, { hash, promise });
      try {
        return await promise;
      } finally {
        if (requestId) inFlight.delete(requestId);
      }
    },
  };
}
