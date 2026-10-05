import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getReminderStatus, testReminderNotification } from '@/lib/reminders';
import { guardLocalRequest } from '@/lib/local-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  try {
    return NextResponse.json(getReminderStatus());
  } catch {
    return NextResponse.json(
      { error: '无法读取本地提醒状态，请稍后重试。' },
      { status: 500 },
    );
  }
}
export async function POST(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  try {
    z.object({ action: z.literal('test') }).parse(await request.json());
    await testReminderNotification();
    return NextResponse.json({
      submitted: true,
      message:
        '测试已交给 macOS。若没有看到，请检查系统通知设置与专注模式；这不代表系统已实际显示。',
      status: getReminderStatus(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError
            ? '测试请求不正确'
            : error instanceof Error
              ? error.message
              : '测试失败',
        status: getReminderStatus(),
      },
      { status: 400 },
    );
  }
}
