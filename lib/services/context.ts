import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { opportunities, activities } from '@/db/schema';
import type * as schema from '@/db/schema';
import type { ActionCommand } from '../action-schema';
import { ActionError } from './errors';

// Only the coordinator owns a connection and transaction. Entity services get
// the same synchronous writer, never the global database or native adapters.
export type Writer = Pick<
  BetterSQLite3Database<typeof schema>,
  'select' | 'insert' | 'update' | 'delete'
>;
export type CommandFor<A extends ActionCommand['action']> = Extract<
  ActionCommand,
  { action: A }
>;
export type ActionResult = Record<string, unknown>;
export const makeId = (prefix: string) => `${prefix}_${randomUUID()}`;
export const required = <T>(record: T | undefined, label: string): T => {
  if (!record)
    throw new ActionError(
      `${label}已不存在，请刷新后核对。`,
      404,
      'RECORD_NOT_FOUND',
    );
  return record;
};

export function unreachable(_command: never): never {
  throw new Error('未分派的业务命令');
}
export function createActionContext(tx: Writer, timestamp: Date) {
  const opportunity = (id: string) =>
    required(
      tx.select().from(opportunities).where(eq(opportunities.id, id)).get(),
      '机会',
    );
  const activity = (opportunityId: string, type: string, content: string) => {
    opportunity(opportunityId);
    tx.update(opportunities)
      .set({ updatedAt: timestamp, lastActivityAt: timestamp })
      .where(eq(opportunities.id, opportunityId))
      .run();
    tx.insert(activities)
      .values({
        id: makeId('act'),
        opportunityId,
        type,
        content,
        createdAt: timestamp,
      })
      .run();
  };
  return { tx, timestamp, opportunity, activity };
}
export type ActionContext = ReturnType<typeof createActionContext>;
