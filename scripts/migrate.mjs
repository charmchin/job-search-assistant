import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateDatabase } from './database-migrations.mjs';

const taskRoot = path.resolve(import.meta.dirname, '..');
const dataDir =
  process.env.ZHAOPIN_DATA_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'ZhaopinAssistant');
fs.mkdirSync(dataDir, { recursive: true });
const database = new Database(path.join(dataDir, 'app.db'));
try {
  for (const name of migrateDatabase(database, {
    directory: path.join(taskRoot, 'drizzle'),
  }))
    process.stdout.write(`Applied ${name}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  database.close();
}
