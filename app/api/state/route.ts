import { NextResponse } from 'next/server';
import { guardLocalRequest } from '@/lib/local-request';
import { getWorkspaceState } from '@/lib/repository';
import { db } from '@/lib/db';
import { parseWorkspaceQuery, readWorkspacePage } from '@/lib/workspace-pages';
import { ActionError } from '@/lib/actions';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  try {
    const query = parseWorkspaceQuery(request.url);
    return NextResponse.json(
      query ? readWorkspacePage(db, query) : await getWorkspaceState(),
      {
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (error) {
    const status =
      error instanceof ActionError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 500;
    if (status === 500) console.error('工作区读取失败');
    return NextResponse.json(
      {
        error:
          error instanceof ActionError
            ? error.message
            : status === 400
              ? '分页参数不合法，请刷新列表后重试。'
              : '无法读取本地数据',
      },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
