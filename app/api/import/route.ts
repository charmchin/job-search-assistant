import path from 'node:path';
import { guardLocalRequest } from '@/lib/local-request';
import { withWriteLock } from '@/lib/write-lock';
import { NextResponse } from 'next/server';
import { databasePath, sqlite } from '@/lib/db';
import {
  BackupValidationError,
  readBackupRequest,
  restoreBackup,
} from '@/lib/backup';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  try {
    const input = await readBackupRequest(request);
    const result = await withWriteLock(() =>
      restoreBackup(
        sqlite,
        input,
        path.join(path.dirname(databasePath), 'backups'),
      ),
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BackupValidationError)
      return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('备份恢复失败', error);
    return NextResponse.json(
      { error: '恢复失败，当前数据未修改。请检查磁盘空间或服务日志后重试。' },
      { status: 500 },
    );
  }
}
