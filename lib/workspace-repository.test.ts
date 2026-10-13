import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { groupByOpportunity, readWorkspaceState } from './workspace-repository';
import { buildTodayPlan } from './today';
import type { WorkspaceState } from './client-types';
let client: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
function migrate(connection: Database.Database) {
  connection.pragma('foreign_keys=ON');
  for (const name of fs
    .readdirSync('drizzle')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    connection.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
}
beforeEach(() => {
  client = new Database(':memory:');
  migrate(client);
  db = drizzle(client, { schema });
});
afterEach(() => client.close());
const now = new Date('2026-10-05T00:00:00+08:00');
function owner(id: string, fields = {}) {
  db.insert(schema.opportunities)
    .values({
      id,
      organization: id,
      role: '岗位',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: new Date(now.getTime() - 5 * 86400000),
      ...fields,
    })
    .run();
}
describe('一次分组的工作区快照', () => {
  it('空数据库仍提供完整可用状态', () => {
    const state = readWorkspaceState(db, now, () => false);
    expect(state).toMatchObject({
      now: now.toISOString(),
      opportunities: [],
      tasks: [],
      drafts: [],
      pendingDraftCount: 0,
      settings: {},
    });
  });
  it('两万条关联只读取一次归属，保持组内顺序与独立任务', () => {
    let lookups = 0;
    const rows = Array.from({ length: 20000 }, (_, i) => ({
      id: i,
      get opportunityId() {
        lookups++;
        return i % 2 ? 'b' : 'a';
      },
    }));
    const groups = groupByOpportunity(rows);
    expect(lookups).toBe(rows.length);
    expect(groups.get('a')?.map((r) => r.id)).toEqual(
      rows.filter((r) => r.id % 2 === 0).map((r) => r.id),
    );
    expect(
      groupByOpportunity([{ opportunityId: null }, { opportunityId: 'a' }]).get(
        'a',
      ),
    ).toHaveLength(1);
  });
  it('关联、历史顺序、任务排序和材料引用保持，文件路径按次去重检查', () => {
    owner('a');
    owner('b', { stage: 'closed' });
    for (const [id, opportunityId, dueAt] of [
      ['late', 'a', new Date('2026-10-04T23:59:00+08:00')],
      ['later', 'a', new Date('2026-10-08T09:00:00+08:00')],
      ['solo', null, null],
    ] as const)
      db.insert(schema.tasks)
        .values({
          id,
          opportunityId,
          title: id,
          dueAt,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    db.insert(schema.milestones)
      .values({ id: 'm', opportunityId: 'a', title: '面试', createdAt: now })
      .run();
    db.insert(schema.materialRequirements)
      .values({ id: 'r', opportunityId: 'b', name: '简历' })
      .run();
    for (const id of ['history-1', 'history-2'])
      db.insert(schema.stageHistory)
        .values({
          id,
          opportunityId: 'a',
          toStage: 'applied',
          source: 'manual',
          recordedAt: now,
        })
        .run();
    for (const id of ['file1', 'file2'])
      db.insert(schema.materials)
        .values({
          id,
          name: id,
          filePath: '/isolated-reference',
          createdAt: now,
          updatedAt: now,
        })
        .run();
    const check = vi.fn().mockReturnValue(false);
    const state = readWorkspaceState(db, now, check);
    const a = state.opportunities.find((r) => r.id === 'a')!,
      b = state.opportunities.find((r) => r.id === 'b')!;
    expect(a.tasks.map((r) => r.id)).toEqual(['late', 'later']);
    expect(a.milestones.map((r) => r.id)).toEqual(['m']);
    expect(a.stageHistory.map((r) => r.id)).toEqual(['history-2', 'history-1']);
    expect(a.requirements).toEqual([]);
    expect(b.requirements[0].id).toBe('r');
    expect(b.stale).toBe(false);
    expect(a.stale).toBe(true);
    expect(state.tasks.map((r) => r.id)).toEqual(['late', 'later', 'solo']);
    expect(state.tasks.find((r) => r.id === 'solo')!.opportunity).toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
    expect(state.materials.every((m) => !m.fileExists)).toBe(true);
  });
  it('活动只返回限长预览，完整活动和草稿正文不进入响应，备份内容不变', () => {
    owner('a');
    const body = 'private-body-sentinel'.repeat(1000);
    const insert = client.prepare(
      "INSERT INTO extraction_drafts (id,source_text,extracted_json,created_at) VALUES (?,?,'{}',1)",
    );
    client.transaction(() => {
      for (let i = 0; i < 100; i++) insert.run('d' + i, body);
    })();
    db.insert(schema.activities)
      .values({
        id: 'a',
        opportunityId: 'a',
        content: body,
        type: 'note',
        createdAt: now,
      })
      .run();
    const before = client.serialize();
    const state = readWorkspaceState(db, now);
    expect(state.pendingDraftCount).toBe(100);
    expect(state.opportunities[0].latestNote?.content).toBe(body.slice(0, 240));
    expect(JSON.stringify(state)).not.toContain(body);
    expect(JSON.stringify(state).length).toBeLessThan(3000);
    expect(client.serialize()).toEqual(before);
  });
  it('每个机会只取最新备注，其他操作不会遮掉进展，同时间按 ID 稳定排序', () => {
    owner('a');
    owner('b');
    owner('empty');
    for (const [id, opportunityId, type, content, createdAt] of [
      ['a1', 'a', 'note', '先投递', now],
      ['a2', 'a', 'note', '收到面试邀请', now],
      ['a3', 'a', 'updated', '更新了机会信息', new Date(now.getTime() + 1000)],
      ['b1', 'b', 'note', '另一公司的进展', now],
    ] as const)
      db.insert(schema.activities)
        .values({ id, opportunityId, type, content, createdAt })
        .run();
    const state = readWorkspaceState(db, now);
    expect(
      state.opportunities.find((o) => o.id === 'a')?.latestNote,
    ).toMatchObject({ id: 'a2', content: '收到面试邀请' });
    expect(
      state.opportunities.find((o) => o.id === 'b')?.latestNote?.content,
    ).toBe('另一公司的进展');
    expect(
      state.opportunities.find((o) => o.id === 'empty')?.latestNote,
    ).toBeNull();
  });
  it('上海跨日后逾期排序与五天停滞重新计算', () => {
    owner('a');
    db.insert(schema.tasks)
      .values({
        id: 't',
        opportunityId: 'a',
        title: '投递',
        dueAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const before = JSON.parse(
      JSON.stringify(readWorkspaceState(db, new Date(now.getTime() - 60000))),
    ) as WorkspaceState;
    const after = JSON.parse(
      JSON.stringify(readWorkspaceState(db, new Date(now.getTime() + 60000))),
    ) as WorkspaceState;
    expect(before.opportunities[0].stale).toBe(false);
    expect(after.opportunities[0].stale).toBe(true);
    expect(
      buildTodayPlan(before).actions.find((a) => a.entityId === 't')!.bucket,
    ).toBe(1);
    expect(
      buildTodayPlan(after).actions.find((a) => a.entityId === 't')!.bucket,
    ).toBe(0);
  });
  it('并发进程在读取中提交时，机会与任务不混用新旧快照', () => {
    client.close();
    const file = path.join(
      process.env.ZHAOPIN_DATA_DIR!,
      'snapshot-read-test.db',
    );
    client = new Database(file);
    migrate(client);
    client.pragma('journal_mode=WAL');
    const writer = new Database(file);
    try {
      db = drizzle(client, { schema });
      owner('a');
      let committed = false;
      const observed = drizzle(client, {
        schema,
        logger: {
          logQuery(query) {
            if (!committed && query.includes('from "tasks"')) {
              committed = true;
              writer.transaction(() => {
                writer
                  .prepare(
                    "UPDATE opportunities SET organization='新组织' WHERE id='a'",
                  )
                  .run();
                writer
                  .prepare(
                    "INSERT INTO tasks (id,opportunity_id,title,created_at,updated_at) VALUES ('new','a','新任务',1,1)",
                  )
                  .run();
              })();
            }
          },
        },
      });
      const snapshot = readWorkspaceState(observed, now);
      expect(committed).toBe(true);
      expect(snapshot.opportunities[0].organization).toBe('a');
      expect(snapshot.tasks).toEqual([]);
      const next = readWorkspaceState(observed, now);
      expect(next.opportunities[0].organization).toBe('新组织');
      expect(next.tasks[0].title).toBe('新任务');
    } finally {
      writer.close();
    }
  });
});
