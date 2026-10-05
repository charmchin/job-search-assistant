import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  createTestRun,
  cleanupTestRun,
  runTestProcess,
} from './test-sandbox.mjs';

const project = path.resolve(import.meta.dirname, '..');
const run = createTestRun('unit');
const inherited = path.join(run.root, 'inherited-data');
fs.mkdirSync(inherited);
const sentinel = path.join(inherited, 'app.db');
const database = new Database(sentinel);
database.exec(
  "CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('existing data must not change')",
);
database.close();
const fingerprint = () =>
  createHash('sha256').update(fs.readFileSync(sentinel)).digest('hex');
const before = fingerprint();
try {
  for (const variant of ['defaults', 'unsafe-inherited-environment']) {
    const environment = { ...process.env };
    delete environment.ZHAOPIN_UNIT_RUN_ROOT;
    if (variant === 'defaults') {
      delete environment.ZHAOPIN_DATA_DIR;
      delete environment.OPENAI_API_KEY;
      delete environment.OPENAI_MODEL;
    } else
      Object.assign(environment, {
        ZHAOPIN_DATA_DIR: inherited,
        OPENAI_API_KEY: 'inherited-key-must-not-be-used',
        OPENAI_MODEL: 'inherited-model-must-not-be-used',
        ZHAOPIN_DISABLE_NOTIFICATIONS: '0',
        ZHAOPIN_DISABLE_FILE_OPERATIONS: '0',
        ZHAOPIN_DISABLE_KEYCHAIN: '0',
      });
    const output = await runTestProcess(
      process.execPath,
      [path.join(project, 'node_modules/vitest/vitest.mjs'), 'run'],
      { cwd: project, env: environment, timeout: 60000 },
    );
    const created = output.match(/单元测试隔离目录：([^\r\n]+)/)?.[1];
    assert.ok(created, output);
    assert.notEqual(created, run.root);
    assert.ok(!fs.existsSync(created), 'Vitest 退出后应清理自己的测试目录');
    assert.equal(fingerprint(), before, '继承目录数据库不得改写');
    assert.deepEqual(
      fs.readdirSync(inherited),
      ['app.db'],
      '继承目录不能产生 WAL 或其他测试文件',
    );
    console.log(
      `PASS ${variant}：独立目录自动创建/清理，所有单元测试通过，既有数据库未变`,
    );
  }
} finally {
  cleanupTestRun(run);
}
