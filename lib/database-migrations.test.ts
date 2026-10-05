import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../scripts/database-migrations.mjs';
import { runTestProcess, testEnvironment } from '../scripts/test-sandbox.mjs';
import { createJsonBackup } from './backup';

const source = path.resolve('drizzle');
const names = fs
  .readdirSync(source)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const sql = (name: string) => fs.readFileSync(path.join(source, name), 'utf8');
let database: Database.Database;
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(process.env.ZHAOPIN_DATA_DIR!, 'migrations-'),
  );
  database = new Database(':memory:');
});
afterEach(() => {
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const migrate = (target = database, catalogue = source) =>
  migrateDatabase(target, { directory: catalogue });
const ledger = () =>
  database
    .prepare('SELECT * FROM __zhaopin_migrations ORDER BY name')
    .all() as { name: string; applied_at: number; checksum: string }[];
const data = () => JSON.parse(JSON.stringify(createJsonBackup(database))).data;
const dump = () => ({
  schema: database
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all(),
  rows: (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map(({ name }) => ({
    name,
    rows: database
      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort(),
  })),
});
const applyRaw = (through = names.length) => {
  for (const name of names.slice(0, through)) database.exec(sql(name));
};
const oldLedger = (through = names.length) => {
  database.exec(
    'CREATE TABLE __zhaopin_migrations (name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)',
  );
  names
    .slice(0, through)
    .forEach((name, index) =>
      database
        .prepare('INSERT INTO __zhaopin_migrations VALUES (?,?)')
        .run(name, index + 1),
    );
};
const seed = () =>
  database.exec(
    "INSERT INTO opportunities (id,organization,role,description,notes,stage,created_at,updated_at,last_activity_at) VALUES ('owner','旧组织','研发岗','中文正文 😀','原备注','interview',1,2,3)",
  );
const copy = () => {
  const target = path.join(directory, 'drizzle');
  fs.cpSync(source, target, { recursive: true });
  return target;
};

describe('单一 SQL 迁移来源、旧库兼容与故障原子性', () => {
  it('全新数据库有完整表、索引、外键、带校验值的迁移记录', () => {
    expect(migrate()).toEqual(names);
    expect(ledger().map((row) => row.name)).toEqual(names);
    for (const row of ledger())
      expect(row.checksum).toBe(
        createHash('sha256').update(sql(row.name)).digest('hex'),
      );
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.pragma('busy_timeout', { simple: true })).toBe(10000);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(
      Object.values(data()).every((rows) => (rows as unknown[]).length === 0),
    ).toBe(true);
  });
  it('重复初始化不改业务数据、迁移时间或历史，已完成升级不重跑 DML', () => {
    migrate();
    seed();
    // An explicit empty history in a modern backup must not be backfilled on restart.
    const before = dump();
    expect(migrate()).toEqual([]);
    expect(migrate()).toEqual([]);
    expect(dump()).toEqual(before);
    expect(data().stageHistory).toEqual([]);
  });
  it('旧迁移记录无 checksum 时先验证结构再补齐，不改变原 applied_at', () => {
    applyRaw();
    seed();
    oldLedger();
    const before = data();
    expect(migrate()).toEqual([]);
    expect(data()).toEqual(before);
    expect(ledger().map((row) => row.applied_at)).toEqual(
      names.map((_, index) => index + 1),
    );
    expect(ledger().every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(
      true,
    );
  });
  it('接管真实旧运行时的无名唯一索引，补齐遗漏的 SQL 命名索引且不重建业务表', () => {
    applyRaw();
    oldLedger();
    seed();
    database.exec(
      'DROP INDEX idx_reminder_delivery_key; ALTER TABLE reminder_deliveries RENAME TO previous_deliveries',
    );
    database.exec(
      'CREATE TABLE reminder_deliveries (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,scheduled_for INTEGER NOT NULL,delivered_at INTEGER NOT NULL,delivery_key TEXT NOT NULL UNIQUE)',
    );
    database.exec(
      "INSERT INTO reminder_deliveries VALUES ('old','task','deleted',10,20,'task:deleted:10'); DROP TABLE previous_deliveries",
    );
    const before = data();
    const originalTable = database
      .prepare("SELECT sql FROM sqlite_master WHERE name='reminder_deliveries'")
      .get();
    expect(migrate()).toEqual([]);
    expect(data()).toEqual(before);
    expect(
      database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='reminder_deliveries'",
        )
        .get(),
    ).toEqual(originalTable);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='idx_reminder_delivery_key'",
        )
        .get(),
    ).toBeDefined();
    const after = dump();
    migrate();
    expect(dump()).toEqual(after);
  });
  it('旧运行时完成建表但未登记迁移时可接管，保留既有记录和已作废历史', () => {
    for (const [index, name] of names.entries())
      database.exec(
        index < 4
          ? sql(name).replaceAll(
              'text PRIMARY KEY NOT NULL',
              'TEXT PRIMARY KEY',
            )
          : sql(name),
      );
    seed();
    database.exec(
      "INSERT INTO stage_history VALUES ('invalid','owner',NULL,'interview',NULL,2,'legacy',0,'保留作废记录')",
    );
    database.exec(
      "INSERT INTO materials (id,name,file_path,created_at,updated_at) VALUES ('mat','旧简历','/tmp/引用不上传.pdf',1,2)",
    );
    const before = data();
    expect(migrate()).toEqual(names);
    expect(data()).toEqual(before);
    expect(ledger()).toHaveLength(names.length);
  });
  it('只有完整机会表但其余基础表缺失的未登记旧库，不跳过整个 baseline', () => {
    const statement = sql(names[0])
      .split('--> statement-breakpoint')
      .find((part) => /CREATE TABLE `opportunities`/.test(part))!;
    database.exec(statement);
    seed();
    const original = database
      .prepare('SELECT * FROM opportunities')
      .get() as Record<string, unknown>;
    migrate();
    expect(database.prepare('SELECT * FROM opportunities').get()).toMatchObject(
      original,
    );
    expect(data().stageHistory[0]).toMatchObject({
      opportunityId: 'owner',
      toStage: 'interview',
      occurredAt: null,
      source: 'legacy',
    });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name='materials'")
        .get(),
    ).toBeDefined();
  });
  it('旧基线的下一步转换与提醒映射只执行一次，保留内容和活动时间', () => {
    applyRaw(4);
    seed();
    database.exec(
      "UPDATE opportunities SET next_action='旧计划',next_action_at=10 WHERE id='owner'; INSERT INTO tasks (id,opportunity_id,title,created_at,updated_at) VALUES ('old-task','owner','旧计划',1,2); INSERT INTO reminder_deliveries VALUES ('old','nextAction','owner',10,20,'nextAction:owner:10')",
    );
    oldLedger(4);
    expect(migrate()).toEqual(names.slice(4));
    expect(data().tasks).toHaveLength(1);
    expect(data().tasks[0]).toMatchObject({
      id: 'old-task',
      isNextAction: true,
      title: '旧计划',
      dueAt: new Date(10).toISOString(),
    });
    expect(data().opportunities[0].lastActivityAt).toBe(
      new Date(3).toISOString(),
    );
    expect(data().reminderDeliveries).toHaveLength(2);
    const before = dump();
    migrate();
    expect(dump()).toEqual(before);
  });
  it('未来未知迁移记录阻止降级，拒绝后原数据及记录不变', () => {
    migrate();
    seed();
    database
      .prepare('INSERT INTO __zhaopin_migrations VALUES (?,?,?)')
      .run('9999_future.sql', 1, 'a'.repeat(64));
    const before = dump();
    expect(() => migrate()).toThrow('不能降级');
    expect(dump()).toEqual(before);
  });
  it('已应用文件内容改变会拒绝，恢复原文件后可重新启动', () => {
    migrate();
    seed();
    const target = copy();
    fs.appendFileSync(
      path.join(target, names[3]),
      '\n-- changed after application\n',
    );
    const before = dump();
    expect(() => migrate(database, target)).toThrow('已应用迁移文件被改动');
    expect(dump()).toEqual(before);
    fs.writeFileSync(path.join(target, names[3]), sql(names[3]));
    expect(migrate(database, target)).toEqual([]);
  });
  it('新迁移按顺序应用并记录，后续重复不再执行', () => {
    migrate();
    const target = copy();
    fs.writeFileSync(
      path.join(target, '0006_fixture.sql'),
      'CREATE TABLE migration_fixture (id TEXT PRIMARY KEY NOT NULL);',
    );
    expect(migrate(database, target)).toEqual(['0006_fixture.sql']);
    expect(ledger()).toHaveLength(names.length + 1);
    expect(migrate(database, target)).toEqual([]);
  });
  it('新迁移不静默跳过同名既存列；旧兼容规则不扩展到新版本', () => {
    migrate();
    const target = copy();
    database.exec(
      "ALTER TABLE opportunities ADD fixture TEXT NOT NULL DEFAULT ''",
    );
    fs.writeFileSync(
      path.join(target, '0006_fixture.sql'),
      "ALTER TABLE opportunities ADD fixture TEXT NOT NULL DEFAULT '';",
    );
    const before = dump();
    expect(() => migrate(database, target)).toThrow('duplicate column');
    expect(dump()).toEqual(before);
  });
  it('记录写入失败时整个待升级批次回滚，不留下半套结构或虚假成功记录', () => {
    applyRaw(4);
    seed();
    oldLedger(4);
    database.exec(
      "CREATE TRIGGER reject_mark BEFORE INSERT ON __zhaopin_migrations WHEN NEW.name LIKE '0005_%' BEGIN SELECT RAISE(ABORT,'模拟迁移登记失败'); END;",
    );
    const before = dump();
    expect(() => migrate()).toThrow('模拟迁移登记失败');
    expect(dump()).toEqual(before);
    database.exec('DROP TRIGGER reject_mark');
    expect(migrate()).toEqual(names.slice(4));
  });
  it('数据转换中途失败回滚此前 DDL 及记录，修复尚未应用的文件后可重试', () => {
    migrate();
    seed();
    const target = copy();
    fs.writeFileSync(
      path.join(target, '0006_fixture.sql'),
      'ALTER TABLE opportunities ADD fixture TEXT;',
    );
    fs.writeFileSync(
      path.join(target, '0007_fixture.sql'),
      'INSERT INTO materials (id,name,created_at,updated_at) SELECT id,NULL,1,2 FROM opportunities;',
    );
    const before = dump();
    expect(() => migrate(database, target)).toThrow('NOT NULL');
    expect(dump()).toEqual(before);
    fs.writeFileSync(
      path.join(target, '0007_fixture.sql'),
      "UPDATE opportunities SET fixture='已升级';",
    );
    expect(migrate(database, target)).toEqual([
      '0006_fixture.sql',
      '0007_fixture.sql',
    ]);
    expect(database.prepare('SELECT fixture FROM opportunities').get()).toEqual(
      { fixture: '已升级' },
    );
  });
  it.each(['missing-table', 'missing-column', 'wrong-index', 'orphan'])(
    '已登记但损坏的结构/关联 %s 不能伪装为成功',
    (kind) => {
      migrate();
      seed();
      if (kind === 'missing-table') database.exec('DROP TABLE materials');
      if (kind === 'missing-column')
        database.exec(
          'ALTER TABLE opportunities RENAME COLUMN next_action TO bad_column',
        );
      if (kind === 'wrong-index')
        database.exec(
          'DROP INDEX idx_tasks_next_action; CREATE INDEX idx_tasks_next_action ON tasks(opportunity_id)',
        );
      if (kind === 'orphan') {
        database.pragma('foreign_keys=OFF');
        database.exec(
          "INSERT INTO tasks (id,opportunity_id,title,created_at,updated_at) VALUES ('orphan','missing','孤立任务',1,2)",
        );
      }
      const before = dump();
      expect(() => migrate()).toThrow(/不完整|不兼容|孤立关联/);
      expect(dump()).toEqual(before);
    },
  );
  it('旧无 checksum 的损坏数据库验证失败时连元数据升级也回滚', () => {
    applyRaw();
    oldLedger();
    database.exec(
      'ALTER TABLE opportunities RENAME COLUMN next_action TO bad_column',
    );
    const before = dump();
    expect(() => migrate()).toThrow('不兼容');
    expect(dump()).toEqual(before);
    expect(
      (
        database.pragma('table_info(__zhaopin_migrations)') as {
          name: string;
        }[]
      ).some((row) => row.name === 'checksum'),
    ).toBe(false);
  });
  it.each([
    'empty',
    'invalid-sql',
    'invalid-name',
    'missing-baseline',
    'missing-history',
    'symlink',
  ])('无效目录 %s 在写数据库前拒绝', (kind) => {
    const target = copy();
    if (kind === 'empty')
      fs.writeFileSync(path.join(target, '0006_fixture.sql'), '');
    if (kind === 'invalid-sql')
      fs.writeFileSync(
        path.join(target, '0006_fixture.sql'),
        'THIS IS NOT SQL;',
      );
    if (kind === 'invalid-name')
      fs.writeFileSync(path.join(target, 'bad.sql'), 'SELECT 1;');
    if (kind === 'missing-baseline') fs.unlinkSync(path.join(target, names[0]));
    if (kind === 'missing-history') fs.unlinkSync(path.join(target, names[4]));
    if (kind === 'symlink')
      fs.symlinkSync(
        path.join(target, names[0]),
        path.join(target, '0006_fixture.sql'),
      );
    const before = dump();
    expect(() => migrate(database, target)).toThrow();
    expect(dump()).toEqual(before);
  });
  it('拒绝嵌套业务事务，调用者原事务仍由调用者管理', () => {
    database.exec('BEGIN');
    expect(() => migrate()).toThrow('不能嵌套');
    expect(database.inTransaction).toBe(true);
    database.exec('ROLLBACK');
  });
  it('同名但错误字段定义、外键或索引的未登记旧库不能仅凭存在跳过', () => {
    const baseline = sql(names[0]);
    for (const mutation of [
      (text: string) =>
        text.replace(
          "`notes` text DEFAULT '' NOT NULL",
          '`notes` integer DEFAULT 0 NOT NULL',
        ),
      (text: string) =>
        text.replaceAll('ON DELETE cascade', 'ON DELETE set null'),
      (text: string) =>
        text.replace(
          'CREATE INDEX `idx_tasks_status_due` ON `tasks` (`status`,`due_at`)',
          'CREATE INDEX `idx_tasks_status_due` ON `tasks` (`title`)',
        ),
    ]) {
      const old = new Database(':memory:');
      try {
        old.exec(mutation(baseline));
        expect(() => migrate(old)).toThrow('不兼容');
        expect(
          old
            .prepare(
              "SELECT name FROM sqlite_master WHERE name='__zhaopin_migrations'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        old.close();
      }
    }
  });
  it('旧 nullable 主键若已有空标识必须拒绝，不删除或重写旧记录', () => {
    database.exec(
      sql(names[0]).replaceAll('text PRIMARY KEY NOT NULL', 'TEXT PRIMARY KEY'),
    );
    database.exec(
      "INSERT INTO materials (id,name,created_at,updated_at) VALUES (NULL,'空标识旧材料',1,2)",
    );
    const before = dump();
    expect(() => migrate()).toThrow('空标识');
    expect(dump()).toEqual(before);
  });
  it('自动命名的列唯一约束缺失也会拒绝，不能只核对显式命名索引', () => {
    const target = copy();
    fs.writeFileSync(
      path.join(target, '0006_fixture.sql'),
      'CREATE TABLE migration_fixture (id TEXT PRIMARY KEY NOT NULL, name TEXT UNIQUE);',
    );
    migrate(database, target);
    database.exec(
      'DROP TABLE migration_fixture; CREATE TABLE migration_fixture (id TEXT PRIMARY KEY NOT NULL, name TEXT);',
    );
    const before = dump();
    expect(() => migrate(database, target)).toThrow('唯一约束不兼容');
    expect(dump()).toEqual(before);
  });
});

describe('真实多进程与磁盘迁移', () => {
  it('六个并发启动入口安全初始化同一新库，每份迁移只记录一次', async () => {
    const env = { ...process.env, ...testEnvironment(directory) };
    const outputs = await Promise.all(
      Array.from({ length: 6 }, () =>
        runTestProcess(
          process.execPath,
          [path.resolve('scripts/migrate.mjs')],
          { cwd: process.cwd(), env, timeout: 20000 },
        ),
      ),
    );
    expect(outputs.join('').match(/Applied /g)).toHaveLength(names.length);
    const disk = new Database(path.join(directory, 'app.db'));
    try {
      expect(
        disk.prepare('SELECT COUNT(*) AS n FROM __zhaopin_migrations').get(),
      ).toEqual({ n: names.length });
      expect(disk.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(migrate(disk)).toEqual([]);
    } finally {
      disk.close();
    }
  });
  it('磁盘关闭重开完整保留业务与校验记录，外键持续启用', () => {
    const file = path.join(directory, 'app.db');
    let disk = new Database(file);
    migrate(disk);
    disk.exec(
      "INSERT INTO opportunities (id,organization,role,created_at,updated_at,last_activity_at) VALUES ('persist','组织','岗位',1,2,3)",
    );
    const saved = disk.prepare('SELECT * FROM opportunities').all();
    const recorded = disk
      .prepare('SELECT * FROM __zhaopin_migrations ORDER BY name')
      .all();
    disk.close();
    disk = new Database(file);
    try {
      expect(migrate(disk)).toEqual([]);
      expect(disk.prepare('SELECT * FROM opportunities').all()).toEqual(saved);
      expect(
        disk.prepare('SELECT * FROM __zhaopin_migrations ORDER BY name').all(),
      ).toEqual(recorded);
      expect(disk.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      disk.close();
    }
  });
});
