import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sqlite } from '@/lib/db';
import { ActionError, createActionService } from '@/lib/actions';
import { describeActionValidation } from '@/lib/action-schema';
import { saveApiKey } from '@/lib/secrets';
import { guardLocalRequest } from '@/lib/local-request';
import { readActionRequest } from '@/lib/action-request';

export const runtime = 'nodejs';
const service = createActionService(sqlite, saveApiKey);
export async function POST(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  try {
    return NextResponse.json(
      await service.execute(await readActionRequest(request)),
    );
  } catch (error) {
    if (error instanceof ActionError)
      return NextResponse.json(
        { error: error.message, code: error.code, ...error.details },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: describeActionValidation(error), code: 'INVALID_INPUT' },
        { status: 400 },
      );
    if (error instanceof SyntaxError)
      return NextResponse.json(
        { error: '请求不是有效 JSON，输入未保存。', code: 'INVALID_JSON' },
        { status: 400 },
      );
    // Never log input values, API keys or Keychain command arguments.
    console.error('本地写入事务失败', {
      code:
        (error as { code?: string; cause?: { code?: string } })?.code ||
        (error as { cause?: { code?: string } })?.cause?.code ||
        'INTERNAL',
    });
    return NextResponse.json(
      {
        error: '保存失败，数据库变更已回滚。请检查服务或磁盘后重试。',
        code: 'STORAGE_FAILED',
      },
      { status: 500 },
    );
  }
}
