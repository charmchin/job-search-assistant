import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { materials } from '@/db/schema';
import { db } from '@/lib/db';
import { guardLocalRequest } from '@/lib/local-request';
import { MaterialFileError, validateMaterialFile } from '@/lib/material-files';

export const runtime = 'nodejs';
const execFileAsync = promisify(execFile);
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pick') }).strict(),
  z
    .object({
      action: z.literal('open'),
      materialId: z.string().trim().min(1).max(200),
    })
    .strict(),
]);
const disabledResponse = () =>
  NextResponse.json({ error: '当前环境已禁用系统文件操作。' }, { status: 503 });

export async function POST(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  try {
    const input = inputSchema.parse(await request.json());
    if (process.platform !== 'darwin')
      return NextResponse.json(
        { error: '文件选择功能当前仅支持 macOS' },
        { status: 400 },
      );
    if (input.action === 'pick') {
      if (process.env.ZHAOPIN_DISABLE_FILE_OPERATIONS === '1')
        return disabledResponse();
      const { stdout } = await execFileAsync(
        'osascript',
        ['-e', 'POSIX path of (choose file with prompt "选择申请材料")'],
        { timeout: 60000, maxBuffer: 8192 },
      );
      const filePath = validateMaterialFile(stdout.replace(/\r?\n$/, ''));
      return NextResponse.json({ path: filePath });
    }
    const material = db
      .select()
      .from(materials)
      .where(eq(materials.id, input.materialId))
      .get();
    if (!material || !material.filePath)
      return NextResponse.json(
        { error: '材料不存在或尚未关联文件，请刷新材料库。' },
        { status: 404 },
      );
    const filePath = validateMaterialFile(material.filePath);
    if (process.env.ZHAOPIN_DISABLE_FILE_OPERATIONS === '1')
      return disabledResponse();
    await execFileAsync('open', [filePath], {
      timeout: 10000,
      maxBuffer: 8192,
    });
    return NextResponse.json({ opened: true });
  } catch (error) {
    if (error instanceof Error && /User canceled/.test(error.message))
      return NextResponse.json({ canceled: true });
    if (error instanceof MaterialFileError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return NextResponse.json(
        { error: '文件请求不正确，请从材料库重新操作。' },
        { status: 400 },
      );
    return NextResponse.json(
      { error: '系统文件操作失败或超时，请检查权限后重试。' },
      { status: 400 },
    );
  }
}
