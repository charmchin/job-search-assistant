import { NextResponse } from 'next/server';
import { guardLocalRequest } from '@/lib/local-request';
import { z } from 'zod';
import { extractionDrafts, opportunities } from '@/db/schema';
import { extractJob, fetchJobText } from '@/lib/capture';
import { db } from '@/lib/db';
import { makeId } from '@/lib/repository';
import { PublicFetchError } from '@/lib/public-fetch';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  try {
    const input = z
      .object({
        url: z.string().trim().default(''),
        text: z.string().trim().default(''),
      })
      .parse(await request.json());
    if (!input.url && !input.text)
      return NextResponse.json(
        { error: '请粘贴链接或招聘正文' },
        { status: 400 },
      );
    if (input.url) {
      const all = await db.select().from(opportunities);
      const duplicate = all.find(
        (item) => item.sourceUrl && item.sourceUrl === input.url,
      );
      if (duplicate)
        return NextResponse.json(
          { error: '这个链接已经收集过了', duplicateId: duplicate.id },
          { status: 409 },
        );
    }
    let sourceText = input.text;
    let fetchWarning = '';
    let sourceName = '';
    let adapter = 'text';
    if (!sourceText && input.url) {
      try {
        const fetched = await fetchJobText(input.url);
        sourceText = fetched.text;
        sourceName = fetched.sourceName;
        adapter = fetched.adapter;
      } catch (error) {
        console.warn('capture fetch fallback', error);
        if (error instanceof PublicFetchError) {
          return NextResponse.json(
            {
              needsText: true,
              code: error.code,
              error: error.message,
              guidance:
                '自动读取已停止，链接仍然保留。请直接粘贴岗位职责和任职要求后继续；正文不会触发对这个链接的网络访问。',
            },
            { status: 422 },
          );
        }
        return NextResponse.json(
          {
            needsText: true,
            code: 'PAGE_REQUIRES_TEXT',
            error: '这个页面暂时无法自动读取',
            guidance:
              '招聘网站可能需要登录或使用动态加载。链接已经保留，请复制岗位职责和任职要求，粘贴到下方即可继续。',
          },
          { status: 422 },
        );
      }
    } else if (input.url && input.text)
      fetchWarning = '已优先使用你粘贴的正文。';
    const { extraction, mode, warning } = await extractJob(
      sourceText,
      input.url,
    );
    if (sourceName) extraction.sourceName = sourceName;
    const id = makeId('draft');
    await db
      .insert(extractionDrafts)
      .values({
        id,
        sourceUrl: input.url,
        sourceText,
        extractedJson: extraction,
        evidenceJson: extraction.evidence,
        confidence: extraction.confidence,
        status: 'pending',
        createdAt: new Date(),
      });
    return NextResponse.json({
      id,
      extraction,
      mode,
      adapter,
      warning: [
        adapter === 'tencent' ? '已从腾讯招聘官方岗位接口读取。' : '',
        fetchWarning,
        warning,
      ]
        .filter(Boolean)
        .join(' '),
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError
            ? '链接或正文格式不正确'
            : '暂时无法整理这段内容',
        guidance:
          '输入内容仍然保留。请检查链接格式，或直接粘贴招聘正文后重试。',
      },
      { status: 400 },
    );
  }
}
