import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as schema from '@/db/schema';
import { extractionSchema } from './extraction';
import { ActionError } from './actions';

export const WORKSPACE_PAGE_SIZE = 20;
const id = z.string().min(1).max(200);
const cursorSchema = z
  .object({
    section: z.enum(['activities', 'drafts']),
    owner: z.string().max(200),
    at: z.number().int().min(-8640000000000000).max(8640000000000000),
    id,
  })
  .strict();
const querySchema = z.discriminatedUnion('section', [
  z
    .object({
      section: z.literal('activities'),
      opportunityId: id,
      cursor: z.string().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      section: z.literal('drafts'),
      cursor: z.string().max(1000).optional(),
    })
    .strict(),
  z.object({ section: z.literal('draft'), id }).strict(),
]);
export function parseWorkspaceQuery(url: string) {
  const params = new URL(url).searchParams;
  if (!params.size) return null;
  if (new Set(params.keys()).size !== params.size)
    throw new ActionError('分页参数不能重复。');
  return querySchema.parse(Object.fromEntries(params));
}
type Query = z.output<typeof querySchema>;
function decode(query: Exclude<Query, { section: 'draft' }>) {
  if (query.cursor === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
    );
    if (
      cursor.section !== query.section ||
      cursor.owner !==
        (query.section === 'activities' ? query.opportunityId : '')
    )
      throw new Error();
    return cursor;
  } catch {
    throw new ActionError('分页位置无效，请刷新列表后重试。');
  }
}
function page<T extends { id: string; createdAt: Date }>(
  rows: T[],
  section: 'activities' | 'drafts',
  owner = '',
) {
  const items = rows.slice(0, WORKSPACE_PAGE_SIZE);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > WORKSPACE_PAGE_SIZE && last
        ? Buffer.from(
            JSON.stringify({
              section,
              owner,
              at: last.createdAt.getTime(),
              id: last.id,
            }),
          ).toString('base64url')
        : null,
  };
}
export function readWorkspacePage(
  db: BetterSQLite3Database<typeof schema>,
  query: Query,
) {
  const { activities, opportunities, extractionDrafts } = schema;
  if (query.section === 'draft') {
    const row = db
      .select()
      .from(extractionDrafts)
      .where(eq(extractionDrafts.id, query.id))
      .get();
    if (!row) throw new ActionError('草稿已不存在，请刷新列表。', 404);
    if (row.status !== 'pending')
      throw new ActionError('草稿已确认或取消，请刷新列表。', 409);
    const parsed = extractionSchema.safeParse(row.extractedJson);
    return {
      id: row.id,
      sourceUrl: row.sourceUrl,
      sourceText: row.sourceText,
      extraction: parsed.success ? parsed.data : null,
      warning: parsed.success
        ? '已恢复保存的草稿，请重新核对后确认。'
        : '旧草稿格式无法直接恢复，原文已保留；请重新整理。原草稿仍可从草稿列表移除。',
    };
  }
  const cursor = decode(query);
  if (query.section === 'activities') {
    return db.transaction((tx) => {
      if (
        !tx
          .select({ id: opportunities.id })
          .from(opportunities)
          .where(eq(opportunities.id, query.opportunityId))
          .get()
      )
        throw new ActionError('机会已不存在，请刷新列表。', 404);
      const rows = tx
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.opportunityId, query.opportunityId),
            cursor
              ? or(
                  lt(activities.createdAt, new Date(cursor.at)),
                  and(
                    eq(activities.createdAt, new Date(cursor.at)),
                    lt(activities.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(activities.createdAt), desc(activities.id))
        .limit(WORKSPACE_PAGE_SIZE + 1)
        .all();
      return page(rows, 'activities', query.opportunityId);
    });
  }
  // Do not read extracted_json/source_text into JS for a list or periodic poll.
  const rows = db
    .select({
      id: extractionDrafts.id,
      createdAt: extractionDrafts.createdAt,
      organization: sql<string>`coalesce(substr(cast(json_extract(${extractionDrafts.extractedJson}, '$.organization') as text), 1, 300), '')`,
      role: sql<string>`coalesce(substr(cast(json_extract(${extractionDrafts.extractedJson}, '$.role') as text), 1, 300), '')`,
    })
    .from(extractionDrafts)
    .where(
      and(
        eq(extractionDrafts.status, 'pending'),
        cursor
          ? or(
              lt(extractionDrafts.createdAt, new Date(cursor.at)),
              and(
                eq(extractionDrafts.createdAt, new Date(cursor.at)),
                lt(extractionDrafts.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(extractionDrafts.createdAt), desc(extractionDrafts.id))
    .limit(WORKSPACE_PAGE_SIZE + 1)
    .all();
  return page(rows, 'drafts');
}
