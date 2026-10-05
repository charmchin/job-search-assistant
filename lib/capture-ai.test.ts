import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractJob } from '@/lib/capture';
import { readApiKey } from '@/lib/secrets';
import { AI_RESPONSE_MAX_BYTES } from '@/lib/extraction';

vi.mock('@/lib/db', () => ({
  db: { select: () => ({ from: async () => [] }) },
}));
vi.mock('@/lib/secrets', () => ({ readApiKey: vi.fn() }));
const text =
  '星河科技｜研发岗\n工作地点：上海\n网申截止：2026年12月20日\n申请材料：简历';
const answer = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }));
beforeEach(() => {
  vi.stubEnv('OPENAI_MODEL', 'fake-model');
  vi.stubEnv('OPENAI_BASE_URL', 'http://test-provider.invalid/v1');
  vi.mocked(readApiKey).mockResolvedValue('fake-key');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(readApiKey).mockReset();
});

describe('AI 失败自动回退到可用规则草稿', () => {
  it.each([
    ['2026-10-04T15:59:59.000Z', '2026-10-04'],
    ['2026-10-04T16:00:00.000Z', '2026-10-05'],
    ['2026-10-04T18:18:00.000Z', '2026-10-05'],
    ['2026-12-31T16:00:00.000Z', '2027-01-01'],
    ['2028-02-28T16:00:00.000Z', '2028-02-29'],
  ])('AI 请求在 %s 使用上海日期 %s', async (instant, expectedDay) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
    const fetcher = vi.fn().mockResolvedValue(answer('{"role":"研发岗"}'));
    vi.stubGlobal('fetch', fetcher);
    expect((await extractJob(text)).mode).toBe('ai');
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.messages[1].content).toContain(
      `当前时区 Asia/Shanghai，今天是 ${expectedDay}。`,
    );
  });
  it.each([
    [
      '数组类型错误',
      JSON.stringify({
        role: '研发岗',
        tasks: 'wrong-type',
        highlights: null,
        deadline: 'invalid-date',
        confidence: 10,
      }),
    ],
    ['数组为 null', JSON.stringify({ role: '研发岗', highlights: null })],
    ['日期不存在', JSON.stringify({ role: '研发岗', deadline: '2026-02-30' })],
    ['置信度越界', JSON.stringify({ role: '研发岗', confidence: 10 })],
    [
      '正文过长',
      JSON.stringify({ role: '研发岗', description: 'a'.repeat(8001) }),
    ],
    ['无有效字段', '{}'],
    ['顶层 null', 'null'],
    ['格式错误', 'not-json'],
    ['信封 content 类型错误', { role: '研发岗' }],
  ])('%s时不返回坏字段', async (_name, content) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(content)));
    const result = await extractJob(text);
    expect(result.mode).toBe('rules');
    expect(result.warning).toContain('格式不符合要求');
    expect(result.extraction.role).toBe('研发岗');
    expect(Array.isArray(result.extraction.tasks)).toBe(true);
    expect(result.extraction.deadline).toContain('2026-12-20');
  });
  it('下载超限回退', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('x'.repeat(AI_RESPONSE_MAX_BYTES + 1))),
    );
    expect((await extractJob(text)).mode).toBe('rules');
  });
  it('网络超时回退，不泄露内容到日志', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('secret-provider-message')),
    );
    expect((await extractJob(text)).mode).toBe('rules');
    expect(console.warn).toHaveBeenCalledWith(
      'AI extraction fallback',
      'Error',
    );
  });
  it('配置读取异常也回退', async () => {
    vi.mocked(readApiKey).mockRejectedValue(new Error('keychain failed'));
    expect((await extractJob(text)).mode).toBe('rules');
  });
  it('未配置时不发请求', async () => {
    vi.stubEnv('OPENAI_MODEL', '');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await extractJob(text)).mode).toBe('rules');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('有效草稿规范化日期并保留真实证据，丢弃伪证据', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          answer(
            JSON.stringify({
              organization: '星河科技',
              role: '研发岗',
              deadline: '2026-12-20',
              evidence: { organization: '星河科技', role: '伪造证据' },
              confidence: 0.8,
            }),
          ),
        ),
    );
    const result = await extractJob(text, 'https://jobs.example.com/1');
    expect(result.mode).toBe('ai');
    expect(result.extraction.deadline).toBe('2026-12-20T15:59:00.000Z');
    expect(result.extraction.evidence).toEqual({ organization: '星河科技' });
    expect(result.warning).toContain('已移除');
  });
  it('不支持 JSON 模式时仅重试一次，共用总超时信号', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('unsupported', { status: 400 }))
      .mockResolvedValueOnce(answer('```json\n{"role":"研发岗"}\n```'));
    vi.stubGlobal('fetch', fetcher);
    expect((await extractJob(text)).mode).toBe('ai');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].signal).toBe(
      fetcher.mock.calls[1][1].signal,
    );
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).not.toHaveProperty(
      'response_format',
    );
  });
  it('非兼容错误不重试', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('failure', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    expect((await extractJob(text)).mode).toBe('rules');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
