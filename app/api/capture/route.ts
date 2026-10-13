import { NextResponse } from 'next/server';
import { guardLocalRequest } from '@/lib/local-request';
import { z } from 'zod';
import { extractionDrafts, opportunities } from '@/db/schema';
import { extractJob, fetchJobText, heuristicExtract } from '@/lib/capture';
import { db } from '@/lib/db';
import { makeId } from '@/lib/repository';
import { PublicFetchError } from '@/lib/public-fetch';
import { eq } from 'drizzle-orm';
import { deleteVersion } from '@/lib/delete-version';
import { ActionError } from '@/lib/services/errors';
import {
  findDuplicateOpportunity,
  duplicateOpportunityDetails,
  DUPLICATE_OPPORTUNITY_MESSAGE,
} from '@/lib/opportunity-duplicate';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  try {
    const input = z
      .object({
        url: z.string().trim().default(''),
        text: z.string().trim().default(''),
        draftId: z.string().min(1).max(200).optional(),
        draftRevision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .refine(
        (value) => Boolean(value.draftId) === Boolean(value.draftRevision),
      )
      .parse(await request.json());
    const currentDraft = () => {
      if (!input.draftId) return null;
      const row = db
        .select()
        .from(extractionDrafts)
        .where(eq(extractionDrafts.id, input.draftId))
        .get();
      if (
        !row ||
        row.status !== 'pending' ||
        deleteVersion(row) !== input.draftRevision
      )
        throw new ActionError(
          '草稿已被其他操作修改、确认或移除。输入已保留，请从草稿列表载入最新内容。',
          409,
          'DRAFT_CONFLICT',
        );
      return row;
    };
    if (!input.url && !input.text)
      return NextResponse.json(
        { error: '请粘贴链接或招聘正文' },
        { status: 400 },
      );
    const ensureNotDuplicate = (candidate: {
      sourceUrl?: string;
      organization?: string;
      role?: string;
    }) => {
      const rows = db
        .select({
          id: opportunities.id,
          organization: opportunities.organization,
          role: opportunities.role,
          sourceUrl: opportunities.sourceUrl,
        })
        .from(opportunities)
        .all();
      const duplicate = findDuplicateOpportunity(rows, candidate);
      if (duplicate)
        throw new ActionError(
          DUPLICATE_OPPORTUNITY_MESSAGE,
          409,
          'DUPLICATE_OPPORTUNITY',
          duplicateOpportunityDetails(duplicate),
        );
    };
    ensureNotDuplicate({ sourceUrl: input.url });
    if (input.text) ensureNotDuplicate(heuristicExtract(input.text, input.url));
    currentDraft();
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
    if (!input.text)
      ensureNotDuplicate(heuristicExtract(sourceText, input.url));
    const { extraction, mode, warning } = await extractJob(
      sourceText,
      input.url,
    );
    if (sourceName) extraction.sourceName = sourceName;
    const values = {
      sourceUrl: input.url,
      sourceText,
      extractedJson: extraction,
      evidenceJson: extraction.evidence,
      confidence: extraction.confidence,
    };
    const saved = db.transaction((tx) => {
      // Recheck after asynchronous fetching/AI: another window may have saved it.
      const current = currentDraft();
      ensureNotDuplicate(extraction);
      const id = current?.id ?? makeId('draft');
      if (current)
        tx.update(extractionDrafts)
          .set(values)
          .where(eq(extractionDrafts.id, id))
          .run();
      else
        tx.insert(extractionDrafts)
          .values({ ...values, id, status: 'pending', createdAt: new Date() })
          .run();
      return tx
        .select()
        .from(extractionDrafts)
        .where(eq(extractionDrafts.id, id))
        .get()!;
    });
    return NextResponse.json({
      id: saved.id,
      draftRevision: deleteVersion(saved),
      sourceText,
      extraction,
      mode,
      adapter,
      warning: [
        adapter === 'tencent' ? '已从腾讯招聘官方岗位接口读取。' : '',
        adapter === 'browser'
          ? '已加载动态网页并读取正文，请核对岗位信息。'
          : '',
        fetchWarning,
        warning,
      ]
        .filter(Boolean)
        .join(' '),
    });
  } catch (error) {
    if (error instanceof ActionError)
      return NextResponse.json(
        { error: error.message, code: error.code, ...error.details },
        { status: error.status },
      );
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
