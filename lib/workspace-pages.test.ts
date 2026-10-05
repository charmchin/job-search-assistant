import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { parseWorkspaceQuery, readWorkspacePage } from './workspace-pages';
let client: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(() => {
  client = new Database(':memory:');
  client.pragma('foreign_keys=ON');
  for (const name of fs
    .readdirSync('drizzle')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    client.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
  db = drizzle(client, { schema });
  client.exec(
    "INSERT INTO opportunities (id,organization,role,created_at,updated_at,last_activity_at) VALUES ('a','甲','岗',1,1,1),('b','乙','岗',1,1,1)",
  );
});
afterEach(() => client.close());
const read = (query: string) =>
  readWorkspacePage(
    db,
    parseWorkspaceQuery('http://127.0.0.1:3000/api/state?' + query)!,
  );
function activities(owner = 'a', size = 45) {
  const insert = client.prepare(
    'INSERT INTO activities (id,opportunity_id,type,content,created_at) VALUES (?,?,?,?,?)',
  );
  for (let i = 0; i < size; i++)
    insert.run(
      owner + i.toString().padStart(3, '0'),
      owner,
      'note',
      '记录' + i,
      1000,
    );
}
describe('有界 keyset 分页与草稿读取', () => {
  it('同一时间多页排序稳定、不重复不遗漏且不混入其他机会', () => {
    activities();
    activities('b');
    const first = read('section=activities&opportunityId=a') as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(20);
    const second = read(
      'section=activities&opportunityId=a&cursor=' + first.nextCursor,
    ) as typeof first;
    const third = read(
      'section=activities&opportunityId=a&cursor=' + second.nextCursor,
    ) as typeof first;
    const ids = [...first.items, ...second.items, ...third.items].map(
      (r) => r.id,
    );
    expect(ids).toEqual(
      Array.from(
        { length: 45 },
        (_, i) => 'a' + (44 - i).toString().padStart(3, '0'),
      ),
    );
    expect(new Set(ids).size).toBe(45);
    expect(third.nextCursor).toBeNull();
  });
  it('分页中新增头部和删除记录不产生 offset 跳页，删除游标行仍可继续', () => {
    activities();
    const first = read('section=activities&opportunityId=a') as {
      items: { id: string }[];
      nextCursor: string;
    };
    client
      .prepare('DELETE FROM activities WHERE id=?')
      .run(first.items.at(-1)!.id);
    client.exec(
      "INSERT INTO activities VALUES ('new','a','note','新记录',2000)",
    );
    const next = read(
      'section=activities&opportunityId=a&cursor=' + first.nextCursor,
    ) as typeof first;
    expect(next.items[0].id).toBe('a024');
    expect(next.items.map((r) => r.id)).not.toContain('new');
    expect(
      (read('section=activities&opportunityId=a') as typeof first).items[0].id,
    ).toBe('new');
  });
  it('跨机会/跨列表游标和坏游标拒绝，不存在机会返回404', () => {
    activities();
    const first = read('section=activities&opportunityId=a') as {
      nextCursor: string;
    };
    for (const query of [
      'section=activities&opportunityId=b&cursor=' + first.nextCursor,
      'section=drafts&cursor=' + first.nextCursor,
      'section=drafts&cursor=garbage',
      'section=drafts&cursor=%25',
      'section=drafts&cursor=',
    ])
      expect(() => read(query)).toThrow();
    expect(() => read('section=activities&opportunityId=missing')).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
  it.each([
    'section=unknown',
    'section=activities',
    'section=draft',
    'section=drafts&limit=999',
    'section=drafts&cursor=a&cursor=b',
    'foo=bar',
  ])('非法查询拒绝：%s', (query) => {
    expect(() =>
      parseWorkspaceQuery('http://127.0.0.1:3000/api/state?' + query),
    ).toThrow();
  });
  it('空列表与正好20条不产生虚假下一页', () => {
    expect(read('section=drafts')).toEqual({ items: [], nextCursor: null });
    activities('a', 20);
    expect(
      (read('section=activities&opportunityId=a') as { nextCursor: unknown })
        .nextCursor,
    ).toBeNull();
  });
  it('草稿摘要不含原文及提取体，仅返回pending且分页完整', () => {
    const insert = client.prepare(
      'INSERT INTO extraction_drafts (id,source_text,extracted_json,status,created_at) VALUES (?,? ,?, ?,1000)',
    );
    for (let i = 0; i < 45; i++)
      insert.run(
        'd' + i.toString().padStart(3, '0'),
        '原文保密',
        JSON.stringify({
          organization: '组织',
          role: '岗位',
          description: '提取正文保密',
        }),
        'pending',
      );
    insert.run('confirmed', '原文保密', '{}', 'confirmed');
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const page = read(
        'section=drafts' + (cursor ? '&cursor=' + cursor : ''),
      ) as { items: { id: string }[]; nextCursor: string | null };
      expect(JSON.stringify(page)).not.toMatch(
        /原文保密|提取正文保密|sourceText|extractedJson/,
      );
      ids.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(45);
    expect(new Set(ids).size).toBe(45);
  });
  it('旧格式草稿不伪造完整提取结果，保留原文并可移除', () => {
    client.exec(
      "INSERT INTO extraction_drafts (id,source_text,extracted_json,created_at) VALUES ('old','旧原文','{}',1)",
    );
    expect(read('section=draft&id=old')).toMatchObject({
      id: 'old',
      sourceText: '旧原文',
      extraction: null,
    });
    client.exec(
      "UPDATE extraction_drafts SET status='confirmed' WHERE id='old'",
    );
    expect(() => read('section=draft&id=old')).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => read('section=draft&id=missing')).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});
