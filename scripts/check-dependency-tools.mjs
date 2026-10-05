import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import {
  createTestRun,
  cloneTestProject,
  cleanupTestRun,
  runTestProcess,
  testEnvironment,
} from './test-sandbox.mjs';

// Verify the out-of-range override against the actual consumer, not audit alone.
process.env.ESBK_DISABLE_CACHE = '1';
const require = createRequire(import.meta.url);
const consumer = require.resolve('@esbuild-kit/core-utils');
const compiler = createRequire(consumer)('esbuild');
assert.equal(compiler.version, '0.25.12');
const { transformSync, transform } = require(consumer);
const source = 'const answer: number = 42; export { answer };';
const context = { module: { exports: {} } };
vm.runInNewContext(transformSync(source, '/fixture/check.ts').code, context);
assert.equal(context.module.exports.answer, 42);
const esm = await transform(source, '/fixture/check.mts');
assert.equal(
  (
    await import(
      `data:text/javascript;base64,${Buffer.from(esm.code).toString('base64')}`
    )
  ).answer,
  42,
);
console.log('PASS 编译器替换：实际消费方的同步 CJS / 异步 ESM 转换可执行');

const sourceProject = path.resolve(import.meta.dirname, '..');
const run = createTestRun('e2e');
console.log(`依赖工具验证隔离目录：${run.root}`);
try {
  const project = cloneTestProject(sourceProject, run);
  const data = path.join(run.root, 'database');
  fs.mkdirSync(data);
  const env = {
    ...process.env,
    ...testEnvironment(data),
    ESBK_DISABLE_CACHE: '1',
  };
  const execute = (args) =>
    runTestProcess(process.execPath, args, { cwd: project, env });
  const cli = path.join(project, 'node_modules/drizzle-kit/bin.cjs');
  const migrations = () =>
    fs
      .readdirSync(path.join(project, 'drizzle'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
  const before = migrations();
  await execute([cli, 'generate']);
  assert.deepEqual(migrations(), before, '未改变 schema 不应生成意外迁移');
  // Generated fixture exists only in the owned clone, never in the source tree.
  fs.appendFileSync(
    path.join(project, 'db/schema.ts'),
    '\nexport const dependencyFixture = sqliteTable("dependency_fixture", { id: text("id").primaryKey() });\n',
  );
  await execute([cli, 'generate', '--name=dependency_fixture']);
  const added = migrations().filter((name) => !before.includes(name));
  assert.equal(added.length, 1, 'schema 改变应生成一份迁移');
  assert.match(
    fs.readFileSync(path.join(project, 'drizzle', added[0]), 'utf8'),
    /CREATE TABLE.*dependency_fixture/,
  );
  await execute([path.join(project, 'scripts/migrate.mjs')]);
  await execute([path.join(project, 'scripts/migrate.mjs')]);
  const db = new Database(path.join(data, 'app.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM dependency_fixture').get().n,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM __zhaopin_migrations').get().n,
      before.length + 1,
    );
  } finally {
    db.close();
  }
  console.log(
    'PASS Drizzle CLI：现有 schema 无差异、夹具迁移生成、真实 SQLite 应用及重复迁移',
  );
} finally {
  cleanupTestRun(run);
}
