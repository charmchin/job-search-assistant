import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

// Business DDL lives only in drizzle/*.sql. The launcher and Next share this runner.
const legacyNames = new Set([
  '0000_sharp_next_avengers.sql',
  '0001_pale_the_order.sql',
  '0002_deep_jackpot.sql',
  '0003_mutation_receipts.sql',
  '0004_workable_pepper_potts.sql',
  '0005_nostalgic_arclight.sql',
]);
const legacyNullablePrimaryKeys = new Set([
  'activities',
  'extraction_drafts',
  'material_requirements',
  'materials',
  'milestones',
  'opportunities',
  'reminder_deliveries',
  'settings',
  'tasks',
  'mutation_receipts',
]);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

function catalogue(directory) {
  const names = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (!names.length || names[0] !== '0000_sharp_next_avengers.sql')
    throw new Error(
      '迁移目录缺少完整的起始迁移，请恢复项目文件，不要删除数据库。',
    );
  for (const name of legacyNames)
    if (!names.includes(name))
      throw new Error(
        `迁移目录不完整：缺少 ${name}，请恢复项目文件，不要删除数据库。`,
      );
  return names.map((name) => {
    if (!/^\d{4}_[\w-]+\.sql$/.test(name))
      throw new Error(`迁移文件名无效：${name}`);
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile())
      throw new Error(`迁移文件不是普通文件：${name}`);
    const sql = fs.readFileSync(file, 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!statements.length) throw new Error(`迁移文件为空：${name}`);
    return {
      name,
      statements,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

const columns = (db, name) =>
  db.prepare('SELECT * FROM pragma_table_info(?)').all(name);
const exists = (db, type, name) =>
  Boolean(
    db
      .prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?')
      .get(type, name),
  );
const defaultValue = (value) => {
  if (value === null) return null;
  const text = String(value).trim();
  return /^(true|false)$/i.test(text)
    ? text.toLowerCase() === 'true'
      ? '1'
      : '0'
    : text;
};
const foreignKeys = (db, table) =>
  db
    .prepare('SELECT * FROM pragma_foreign_key_list(?)')
    .all(table)
    .map((row) =>
      JSON.stringify([
        row.from,
        row.table,
        row.to,
        row.on_update,
        row.on_delete,
        row.match,
      ]),
    )
    .sort();
const predicate = (sql) =>
  (sql?.match(/\bWHERE\b([\s\S]*)/i)?.[1] ?? '')
    .replace(/;\s*$/, '')
    .trim()
    .replace(/\s+/g, ' ');

function verifySchema(actual, expected) {
  const tables = expected
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  for (const { name } of tables) {
    if (!exists(actual, 'table', name))
      throw new Error(`数据库结构不完整：缺少 ${name} 表。`);
    const actualColumns = new Map(
      columns(actual, name).map((column) => [column.name, column]),
    );
    for (const column of columns(expected, name)) {
      const found = actualColumns.get(column.name);
      if (
        !found ||
        found.type.toUpperCase() !== column.type.toUpperCase() ||
        found.pk !== column.pk ||
        // Early runtime DDL omitted explicit NOT NULL on these primary keys only.
        (!(column.pk && legacyNullablePrimaryKeys.has(name)) &&
          found.notnull !== column.notnull) ||
        defaultValue(found.dflt_value) !== defaultValue(column.dflt_value)
      )
        throw new Error(
          `数据库结构不兼容：${name}.${column.name}，请保留数据库与备份后检查，不能跳过迁移。`,
        );
    }
    const primaryKeys = columns(expected, name).filter((column) => column.pk);
    if (
      primaryKeys.length &&
      actual
        .prepare(
          `SELECT 1 FROM ${quote(name)} WHERE ${primaryKeys.map((column) => `${quote(column.name)} IS NULL`).join(' OR ')} LIMIT 1`,
        )
        .get()
    )
      throw new Error(
        `数据库主键数据不兼容：${name} 存在空标识，不能安全接管。`,
      );
    const knownForeignKeys = new Set(foreignKeys(actual, name));
    if (foreignKeys(expected, name).some((key) => !knownForeignKeys.has(key)))
      throw new Error(`数据库关联约束不兼容：${name}。`);
    const actualIndexes = new Map(
      actual
        .prepare('SELECT * FROM pragma_index_list(?)')
        .all(name)
        .map((index) => [index.name, index]),
    );
    for (const index of expected
      .prepare('SELECT * FROM pragma_index_list(?)')
      .all(name)) {
      if (index.origin === 'pk') continue;
      const found = actualIndexes.get(index.name);
      const info = (db, indexName = index.name) =>
        db
          .prepare(
            'SELECT name,desc,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno',
          )
          .all(indexName);
      const definition = (db) =>
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
          )
          .get(index.name)?.sql;
      if (index.origin === 'u') {
        if (
          ![...actualIndexes.values()].some(
            (candidate) =>
              candidate.unique &&
              !candidate.partial &&
              JSON.stringify(info(actual, candidate.name)) ===
                JSON.stringify(info(expected)),
          )
        )
          throw new Error(`数据库唯一约束不兼容：${name}。`);
        continue;
      }
      if (
        !found ||
        found.unique !== index.unique ||
        found.partial !== index.partial ||
        JSON.stringify(info(actual)) !== JSON.stringify(info(expected)) ||
        predicate(definition(actual)) !== predicate(definition(expected))
      )
        throw new Error(`数据库索引不兼容：${index.name}。`);
    }
  }
  if (actual.pragma('foreign_key_check').length)
    throw new Error('数据库存在孤立关联，迁移未提交；请保留数据并检查备份。');
}

const stripComments = (statement) =>
  statement.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '').trim();
const createdIndex = (statement) =>
  stripComments(statement).match(
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([\w-]+)[`"]?/i,
  );

function legacyStatementAlreadyApplied(db, statement) {
  const sql = stripComments(statement);
  const table = sql.match(
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([\w-]+)[`"]?/i,
  );
  if (table) return exists(db, 'table', table[1]);
  const index = createdIndex(statement);
  if (index) return exists(db, 'index', index[1]);
  const added = sql.match(
    /^ALTER\s+TABLE\s+[`"]?([\w-]+)[`"]?\s+ADD(?:\s+COLUMN)?\s+[`"]?([\w-]+)[`"]?/i,
  );
  return Boolean(
    added && columns(db, added[1]).some((column) => column.name === added[2]),
  );
}

/**
 * Apply and record the pending batch under SQLite's cross-process write lock.
 * @param {import('better-sqlite3').Database} database
 * @param {{ directory: string }} options
 * @returns {string[]} Newly applied migration names, only after successful commit.
 */
export function migrateDatabase(database, { directory }) {
  if (database.inTransaction)
    throw new Error('迁移必须在独立数据库连接上执行，不能嵌套业务事务。');
  const migrations = catalogue(directory);
  const expected = new Database(':memory:');
  let current = '初始化';
  try {
    expected.pragma('foreign_keys = ON');
    for (const migration of migrations) {
      current = migration.name;
      for (const statement of migration.statements) expected.exec(statement);
    }
    database.pragma('busy_timeout = 10000');
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    const applied = database
      .transaction(() => {
        current = '迁移记录';
        database.exec(
          'CREATE TABLE IF NOT EXISTS __zhaopin_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, checksum TEXT)',
        );
        if (
          !columns(database, '__zhaopin_migrations').some(
            (column) => column.name === 'checksum',
          )
        )
          database.exec(
            'ALTER TABLE __zhaopin_migrations ADD COLUMN checksum TEXT',
          );
        const history = database
          .prepare('SELECT name, checksum FROM __zhaopin_migrations')
          .all();
        const known = new Map(
          migrations.map((migration) => [migration.name, migration]),
        );
        for (const row of history) {
          if (!known.has(row.name))
            throw new Error(
              `数据库包含当前程序不认识的迁移 ${row.name}；请使用匹配版本，不能降级启动。`,
            );
          if (
            row.checksum !== null &&
            row.checksum !== known.get(row.name).checksum
          )
            throw new Error(
              `已应用迁移文件被改动：${row.name}；请恢复原文件，新增变更应另建迁移。`,
            );
        }
        const recorded = new Set(history.map((row) => row.name));
        const mark = database.prepare(
          'INSERT INTO __zhaopin_migrations (name, applied_at, checksum) VALUES (?, ?, ?)',
        );
        const names = [];
        for (const migration of migrations) {
          if (recorded.has(migration.name)) continue;
          current = migration.name;
          for (const statement of migration.statements)
            if (
              !legacyNames.has(migration.name) ||
              !legacyStatementAlreadyApplied(database, statement)
            )
              database.exec(statement);
          mark.run(migration.name, Date.now(), migration.checksum);
          names.push(migration.name);
        }
        current = '旧运行时索引兼容';
        // The original runtime used an unnamed inline UNIQUE for delivery_key.
        // Old ledgers marked baseline complete despite the missing SQL index.
        // Reuse the original CREATE INDEX statements only during checksum adoption.
        for (const row of history.filter(
          (row) => row.checksum === null && legacyNames.has(row.name),
        )) {
          for (const statement of known.get(row.name).statements) {
            const index = createdIndex(statement);
            if (index && !exists(database, 'index', index[1]))
              database.exec(statement);
          }
        }
        current = '结构与关联核对';
        verifySchema(database, expected);
        // Old ledgers have no checksum. Adopt only after the complete schema passes verification.
        const adopt = database.prepare(
          'UPDATE __zhaopin_migrations SET checksum=? WHERE name=? AND checksum IS NULL',
        );
        for (const migration of migrations)
          adopt.run(migration.checksum, migration.name);
        return names;
      })
      .immediate();
    return applied;
  } catch (error) {
    throw new Error(
      `数据库迁移失败（${current}）：${error instanceof Error ? error.message : String(error)}。本批迁移未提交，请勿删除数据库。`,
      { cause: error },
    );
  } finally {
    expected.close();
  }
}
