import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { migrateDatabase } from '@/scripts/database-migrations.mjs';

const dataDir =
  process.env.ZHAOPIN_DATA_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'ZhaopinAssistant');
if (process.env.NODE_ENV === 'test') {
  const unitRoot = process.env.ZHAOPIN_UNIT_RUN_ROOT;
  if (
    !unitRoot ||
    !fs
      .realpathSync(dataDir)
      .startsWith(fs.realpathSync(unitRoot) + path.sep) ||
    !path.basename(unitRoot).startsWith('zhaopin-unit-run-') ||
    !fs
      .realpathSync(unitRoot)
      .startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
  ) {
    throw new Error(
      '测试数据库未隔离，拒绝初始化。请使用项目的 npm test 配置。',
    );
  }
}
fs.mkdirSync(dataDir, { recursive: true });
export const databasePath = path.join(dataDir, 'app.db');
const client = new Database(databasePath);
try {
  migrateDatabase(client, { directory: path.join(process.cwd(), 'drizzle') });
} catch (error) {
  client.close();
  throw error;
}
export const db = drizzle(client, { schema });
export const sqlite = client;
