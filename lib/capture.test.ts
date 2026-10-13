import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJobText, heuristicExtract } from '@/lib/capture';
import { fetchPublicPage } from '@/lib/public-fetch';
import { fetchRenderedJob } from '@/lib/browser-capture';

vi.mock('@/lib/public-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/public-fetch')>()),
  fetchPublicPage: vi.fn(),
}));
vi.mock('@/lib/browser-capture', () => ({ fetchRenderedJob: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fetchPublicPage).mockReset();
  vi.mocked(fetchRenderedJob).mockReset();
});

describe('规则提取兜底', () => {
  it.each([
    ['2026年9月15日', '2026-09-15T15:59:00.000Z'],
    ['2026/9/15 9:05', '2026-09-15T01:05:00.000Z'],
    ['2026.9.15 00:00', '2026-09-14T16:00:00.000Z'],
    ['2028年2月29日', '2028-02-29T15:59:00.000Z'],
    ['2026年2月30日', null],
    ['2026年2月29日', null],
    ['2026年9月15日 24:00', null],
    ['2026年9月15日 12:60', null],
  ])('按上海时间解析 %s，拒绝非法日历与时间', (date, expected) => {
    const result = heuristicExtract(`星河科技｜研发岗\n网申截止：${date}`);
    expect(result.deadline).toBe(expected);
    if (expected) {
      expect(result.tasks[0].dueAt).toBe(
        new Date(Date.parse(expected) - 5 * 86400_000).toISOString(),
      );
    }
  });

  it('上海已跨年而 UTC 尚未跨年时，省略年份采用上海年份', () => {
    const result = heuristicExtract(
      '星河科技｜研发岗\n网申截止：1月8日',
      '',
      new Date('2026-12-31T16:00:00.000Z'),
    );
    expect(result.deadline).toBe('2027-01-08T15:59:00.000Z');
  });

  it('无年份的闰日滚到非闰年时留空，不伪造三月截止', () => {
    const result = heuristicExtract(
      '星河科技｜研发岗\n网申截止：2月29日',
      '',
      new Date('2028-12-20T10:00:00+08:00'),
    );
    expect(result.deadline).toBeNull();
  });

  it('提取标题、截止日期、材料和注意事项', () => {
    const result = heuristicExtract(
      `星河科技｜后端研发工程师
招聘 2027 届毕业生，工作地点上海。
网申截止：2026年9月15日
申请材料须包含简历、成绩单和在读证明。
注意：英语六级优先。`,
      'https://jobs.example.com/123',
    );
    expect(result.organization).toBe('星河科技');
    expect(result.role).toBe('后端研发工程师');
    expect(result.deadline).toContain('2026-09-15');
    expect(result.requirements.map((item) => item.name)).toEqual(
      expect.arrayContaining(['简历', '成绩单', '在读证明']),
    );
    expect(result.tasks).toHaveLength(3);
    expect(result.decision).toBe('undecided');
    expect(result.nextAction).not.toBe('');
  });

  it('通过腾讯官方岗位接口读取动态详情页', async () => {
    const mockedFetch = vi
      .mocked(fetchPublicPage)
      .mockResolvedValue({
        body: JSON.stringify({
          Code: 200,
          Data: {
            RecruitPostName: '强化学习算法研究员',
            LocationName: '深圳',
            BGName: 'CSIG',
            Responsibility: '负责 Agentic Workflow 研究',
            Requirement: '硕士以上学历，五年以上编码经验',
            ImportantItem: '腾讯云认证优先',
          },
        }),
        url: new URL(
          'https://careers.tencent.com/tencentcareer/api/post/ByPostId',
        ),
      });
    const result = await fetchJobText(
      'https://careers.tencent.com/jobdesc.html?postId=1670301957484453888',
    );
    expect(result.adapter).toBe('tencent');
    expect(result.sourceName).toBe('腾讯招聘');
    expect(result.text).toContain('强化学习算法研究员');
    expect(result.text).toContain('硕士以上学历');
    const requested = mockedFetch.mock.calls[0][0];
    const requestedUrl = String(requested);
    expect(requestedUrl).toContain('/tencentcareer/api/post/ByPostId');
    expect(mockedFetch.mock.calls[0][1]).toBe('json');
  });

  it('跨年时把未写年份的未来截止日期归到下一年', () => {
    const result = heuristicExtract(
      '星河科技｜研发岗\n网申截止：1月8日',
      '',
      new Date('2026-12-20T10:00:00+08:00'),
    );
    expect(result.deadline).toContain('2027-01-08');
  });

  it('普通 HTML 同样使用安全读取路径，并保留正文、移除脚本与导航', async () => {
    vi.mocked(fetchPublicPage).mockResolvedValue({
      body: `<html><title>星河科技｜研发工程师</title><nav>导航不应进入正文</nav><main>${'研发职责、硕士要求、简历及成绩单。'.repeat(10)}<script>脚本不应进入正文</script></main></html>`,
      url: new URL('https://other.example.com/role'),
    });
    const result = await fetchJobText('https://jobs.example.com/role');
    expect(fetchPublicPage).toHaveBeenCalledWith(
      new URL('https://jobs.example.com/role'),
      'html',
    );
    expect(result.text).toContain('硕士要求');
    expect(result.text).not.toContain('脚本不应');
    expect(result.text).not.toContain('导航不应');
    expect(result.adapter).toBe('html');
    expect(result.sourceName).toBe('other.example.com');
  });

  it('腾讯 URL 的危险端口也在调用适配器之前拒绝', async () => {
    await expect(
      fetchJobText('https://careers.tencent.com:8443/jobdesc.html?postId=123'),
    ).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
    expect(fetchPublicPage).not.toHaveBeenCalled();
  });

  it('空的动态页面自动交给浏览器读取，并采用静态请求的最终地址', async () => {
    vi.mocked(fetchPublicPage).mockResolvedValue({
      body: '<title>国聘</title><div id="root"></div><script src="app.js"></script>',
      url: new URL('https://www.iguopin.com/job/detail?id=123'),
    });
    vi.mocked(fetchRenderedJob).mockResolvedValue({
      text: '研发工程师\n岗位职责：开发软件',
      adapter: 'browser',
      sourceName: 'iguopin.com',
    });
    expect(
      (await fetchJobText('https://iguopin.com/job/detail?id=123')).adapter,
    ).toBe('browser');
    expect(fetchRenderedJob).toHaveBeenCalledWith(
      'https://www.iguopin.com/job/detail?id=123',
    );
  });

  it('公网校验失败不启动浏览器兜底', async () => {
    await expect(fetchJobText('http://127.0.0.1/role')).rejects.toMatchObject({
      code: 'PAGE_UNSAFE_URL',
    });
    expect(fetchRenderedJob).not.toHaveBeenCalled();
  });

  it('登录页明确提示且不把长导航交给 AI', async () => {
    vi.mocked(fetchPublicPage).mockResolvedValue({
      body: `<title>用户登录</title><body>${'欢迎访问网站。'.repeat(20)}请先登录</body>`,
      url: new URL('https://jobs.example.com/login'),
    });
    await expect(
      fetchJobText('https://jobs.example.com/role'),
    ).rejects.toMatchObject({ code: 'PAGE_REQUIRES_LOGIN' });
    expect(fetchRenderedJob).not.toHaveBeenCalled();
  });
});
