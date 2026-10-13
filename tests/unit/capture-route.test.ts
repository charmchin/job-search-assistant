import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { extractionDrafts, opportunities } from '@/db/schema';
import { db } from '@/lib/db';
import { POST } from '@/app/api/capture/route';
import { extractJob, fetchJobText } from '@/lib/capture';
import { readWorkspacePage } from '@/lib/workspace-pages';
import { createActionService } from '@/lib/actions';
import { sqlite } from '@/lib/db';
import { PublicFetchError } from '@/lib/public-fetch';

vi.mock('@/lib/capture', async (original) => ({
  ...(await original<typeof import('@/lib/capture')>()),
  extractJob: vi.fn(),
  fetchJobText: vi.fn(),
}));
const source = '星河科技｜研发岗\n工作地点：上海\n任职要求：硕士学历';
async function call(body: Record<string, unknown>) {
  const response = await POST(
    new Request('http://127.0.0.1:3000/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, ...(await response.json()) };
}
beforeEach(async () => {
  db.delete(extractionDrafts).run();
  db.delete(opportunities).run();
  vi.mocked(fetchJobText).mockReset().mockResolvedValue({
    text: source,
    sourceName: '测试站',
    adapter: 'browser',
  });
  const { heuristicExtract } =
    await vi.importActual<typeof import('@/lib/capture')>('@/lib/capture');
  vi.mocked(extractJob)
    .mockReset()
    .mockImplementation(async (text, url) => ({
      extraction: heuristicExtract(text, url),
      mode: 'rules',
    }));
});
describe('机会库去重前移到提取，保存时再次核对', () => {
  it('刚确认的草稿再次提取或保存，明确提示已在机会库中', async () => {
    const draft = await call({ text: source });
    const command = {
      action: 'createOpportunity',
      payload: {
        ...draft.extraction,
        draftId: draft.id,
        draftRevision: draft.draftRevision,
      },
    };
    const service = createActionService(sqlite, vi.fn());
    const saved = await service.execute(command);
    expect(
      await call({
        text: source,
        draftId: draft.id,
        draftRevision: draft.draftRevision,
      }),
    ).toMatchObject({
      status: 409,
      code: 'DUPLICATE_OPPORTUNITY',
      duplicateId: saved.id,
    });
    await expect(service.execute(command)).rejects.toMatchObject({
      code: 'DUPLICATE_OPPORTUNITY',
      details: { duplicateId: saved.id },
    });
    expect(extractJob).toHaveBeenCalledTimes(1);
  });
  const create = (fields: Record<string, unknown> = {}) =>
    createActionService(sqlite, vi.fn()).execute({
      action: 'createOpportunity',
      payload: { organization: '星河科技', role: '研发岗', ...fields },
    });
  it('已有相同链接直接提示，不抓网页、不调用 AI、不创建草稿', async () => {
    const existing = await create({
      sourceUrl: 'https://jobs.example.com/detail?id=123',
    });
    expect(
      await call({
        url: 'https://jobs.example.com/detail?utm_source=share&id=123#detail',
      }),
    ).toMatchObject({
      status: 409,
      code: 'DUPLICATE_OPPORTUNITY',
      error: '该机会已在机会库中，请勿重复添加。',
      duplicateId: existing.id,
      duplicateOrganization: '星河科技',
      duplicateRole: '研发岗',
    });
    expect(fetchJobText).not.toHaveBeenCalled();
    expect(extractJob).not.toHaveBeenCalled();
    expect(db.select().from(extractionDrafts).all()).toHaveLength(0);
  });
  it('不同 Hash 岗位正常提取和保存，同一路由分享链接仍被拦截', async () => {
    await create({ sourceUrl: 'https://jobs.example.com/#/job?id=1001' });
    const draft = await call({
      url: 'https://jobs.example.com/#/job?id=1002',
      text: '天河科技｜安全工程师\n工作地点：北京\n任职要求：硕士学历',
    });
    expect(draft.status).toBe(200);
    const saved = await createActionService(sqlite, vi.fn()).execute({
      action: 'createOpportunity',
      payload: {
        ...draft.extraction,
        draftId: draft.id,
        draftRevision: draft.draftRevision,
      },
    });
    expect(
      await call({
        url: 'https://jobs.example.com/#/job?utm_source=share&id=1002',
      }),
    ).toMatchObject({
      status: 409,
      code: 'DUPLICATE_OPPORTUNITY',
      duplicateId: saved.id,
    });
    expect(extractJob).toHaveBeenCalledTimes(1);
  });
  it('粘贴同一公司岗位或换来源链接仍提示已存在', async () => {
    const existing = await create();
    for (const input of [
      { text: source },
      { url: 'https://jobs.example.com/new', text: source },
    ])
      expect(await call(input)).toMatchObject({
        status: 409,
        duplicateId: existing.id,
      });
    expect(extractJob).not.toHaveBeenCalled();
  });
  it('只有 AI 识别出公司与岗位时也会在创建草稿前去重', async () => {
    const existing = await create();
    const { heuristicExtract } =
      await vi.importActual<typeof import('@/lib/capture')>('@/lib/capture');
    vi.mocked(extractJob).mockResolvedValueOnce({
      extraction: heuristicExtract(source, ''),
      mode: 'ai',
    });
    expect(
      await call({ text: '招聘公告，欢迎应聘，詳见正文。' }),
    ).toMatchObject({ status: 409, duplicateId: existing.id });
    expect(extractJob).toHaveBeenCalledOnce();
    expect(db.select().from(extractionDrafts).all()).toHaveLength(0);
  });
  it('等待 AI 时其他窗口已添加，返回后仍拦截重复草稿', async () => {
    vi.mocked(extractJob).mockImplementationOnce(async () => {
      await create();
      const { heuristicExtract } =
        await vi.importActual<typeof import('@/lib/capture')>('@/lib/capture');
      return { extraction: heuristicExtract(source, ''), mode: 'ai' };
    });
    expect(await call({ text: source })).toMatchObject({
      status: 409,
      code: 'DUPLICATE_OPPORTUNITY',
    });
    expect(db.select().from(extractionDrafts).all()).toHaveLength(0);
  });
  it('保存时同样拦截规范化后的身份，但允许同公司不同岗位', async () => {
    const existing = await create();
    await expect(
      create({
        organization: '星河 科技',
        role: '研发 岗',
        sourceUrl: 'https://jobs.example.com/new',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'DUPLICATE_OPPORTUNITY',
      details: { duplicateId: existing.id },
    });
    await create({ role: '不同岗位' });
    expect(db.select().from(opportunities).all()).toHaveLength(2);
  });
});
describe('收集原文、草稿复用和冲突保护', () => {
  it('列表版本保护移除：同名草稿正文更新也拒绝旧版本，刷新后才能移除', async () => {
    const first = await call({ text: source });
    const list = readWorkspacePage(db, { section: 'drafts' }) as {
      items: { id: string; draftRevision: string }[];
    };
    expect(list.items[0].draftRevision).toBe(first.draftRevision);
    const updated = await call({
      text: source + '\n新增截止说明',
      draftId: first.id,
      draftRevision: first.draftRevision,
    });
    const service = createActionService(sqlite, vi.fn());
    const before = db.select().from(extractionDrafts).all();
    await expect(
      service.execute({
        action: 'discardDraft',
        payload: { id: first.id, draftRevision: list.items[0].draftRevision },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'DRAFT_CONFLICT' });
    expect(db.select().from(extractionDrafts).all()).toEqual(before);
    await expect(
      service.execute({ action: 'discardDraft', payload: { id: first.id } }),
    ).rejects.toThrow();
    const latest = readWorkspacePage(db, { section: 'drafts' }) as typeof list;
    expect(latest.items[0].draftRevision).toBe(updated.draftRevision);
    await service.execute({
      action: 'discardDraft',
      payload: { id: first.id, draftRevision: latest.items[0].draftRevision },
    });
    expect(db.select().from(extractionDrafts).get()?.status).toBe('discarded');
    await expect(
      service.execute({
        action: 'discardDraft',
        payload: { id: first.id, draftRevision: latest.items[0].draftRevision },
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' });
  });
  it('已确认草稿不能被旧列表移除', async () => {
    const first = await call({ text: source });
    const service = createActionService(sqlite, vi.fn());
    await service.execute({
      action: 'createOpportunity',
      payload: {
        ...first.extraction,
        draftId: first.id,
        draftRevision: first.draftRevision,
      },
    });
    await expect(
      service.execute({
        action: 'discardDraft',
        payload: { id: first.id, draftRevision: first.draftRevision },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.select().from(extractionDrafts).get()?.status).toBe('confirmed');
    expect(db.select().from(opportunities).all()).toHaveLength(1);
  });
  it('返回真实抓取正文，返回和修改原文不会创建第二份草稿', async () => {
    const first = await call({ url: 'https://jobs.example.com/1' });
    expect(first.status).toBe(200);
    expect(first.sourceText).toBe(source);
    expect(first.draftRevision).toMatch(/^[a-f0-9]{64}$/);
    const second = await call({
      url: 'https://jobs.example.com/1',
      text: source + '\n补充说明',
      draftId: first.id,
      draftRevision: first.draftRevision,
    });
    expect(second.id).toBe(first.id);
    expect(second.draftRevision).not.toBe(first.draftRevision);
    expect(db.select().from(extractionDrafts).all()).toHaveLength(1);
    expect(
      readWorkspacePage(db, { section: 'draft', id: first.id }),
    ).toMatchObject({
      draftRevision: second.draftRevision,
      sourceText: second.sourceText,
    });
    expect(fetchJobText).toHaveBeenCalledTimes(1);
  });
  it.each(['confirmed', 'discarded'] as const)(
    '不重新打开 %s 草稿',
    async (status) => {
      const first = await call({ text: source });
      db.update(extractionDrafts)
        .set({ status })
        .where(eq(extractionDrafts.id, first.id))
        .run();
      expect(
        (
          await call({
            text: source,
            draftId: first.id,
            draftRevision: first.draftRevision,
          })
        ).status,
      ).toBe(409);
      expect(extractJob).toHaveBeenCalledTimes(1);
    },
  );
  it('其他窗口重新整理后拒绝旧版本确认和覆盖', async () => {
    const first = await call({ text: source });
    await call({
      text: source + '\n补充说明',
      draftId: first.id,
      draftRevision: first.draftRevision,
    });
    expect(
      (
        await call({
          text: source,
          draftId: first.id,
          draftRevision: first.draftRevision,
        })
      ).status,
    ).toBe(409);
    const service = createActionService(sqlite, vi.fn());
    await expect(
      service.execute({
        action: 'createOpportunity',
        payload: {
          ...first.extraction,
          draftId: first.id,
          draftRevision: first.draftRevision,
        },
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_CONFLICT' });
  });
  it('AI 等待期间草稿已确认，不得在返回后覆盖', async () => {
    const first = await call({ text: source });
    vi.mocked(extractJob).mockImplementationOnce(async () => {
      db.update(extractionDrafts)
        .set({ status: 'confirmed' })
        .where(eq(extractionDrafts.id, first.id))
        .run();
      return { extraction: first.extraction, mode: 'ai' };
    });
    const result = await call({
      text: source + '\n新输入',
      draftId: first.id,
      draftRevision: first.draftRevision,
    });
    expect(result.status).toBe(409);
    expect(db.select().from(extractionDrafts).get()).toMatchObject({
      status: 'confirmed',
      sourceText: source,
    });
  });
  it('重新抓取失败仍保留原草稿和正文', async () => {
    const first = await call({ text: source });
    vi.mocked(fetchJobText).mockRejectedValueOnce(
      new PublicFetchError('PAGE_REQUIRES_TEXT', '暂时无法读取'),
    );
    const result = await call({
      url: 'https://jobs.example.com/1',
      draftId: first.id,
      draftRevision: first.draftRevision,
    });
    expect(result.status).toBe(422);
    expect(db.select().from(extractionDrafts).get()).toMatchObject({
      sourceText: source,
      status: 'pending',
    });
  });
});
