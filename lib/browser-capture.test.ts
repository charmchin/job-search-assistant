import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Route } from 'playwright';
import { fetchRenderedJob } from '@/lib/browser-capture';
import { fetchPublicResource } from '@/lib/public-fetch';

vi.mock('@/lib/public-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/public-fetch')>()),
  fetchPublicResource: vi.fn(),
}));
const job = `<title>测试公司｜研发工程师</title><main>岗位职责：${'开发软件，维护系统。'.repeat(15)}\n任职要求：硕士。</main>`;

function fixture(
  html: string,
  extra: { url: string; method?: string; resource?: string }[] = [],
) {
  let handler: (route: Route) => Promise<void>;
  const routes: {
    abort: ReturnType<typeof vi.fn>;
    fulfill: ReturnType<typeof vi.fn>;
    request: () => unknown;
  }[] = [];
  const socketClose = vi.fn();
  const page = {
    content: vi.fn().mockResolvedValue(html),
    url: () => 'https://jobs.example.com/role',
    on: vi.fn(),
    goto: vi.fn(async () => {
      for (const input of [
        { url: 'https://jobs.example.com/role', resource: 'document' },
        ...extra,
      ]) {
        const route = {
          abort: vi.fn().mockResolvedValue(undefined),
          fulfill: vi.fn(),
          request: () => ({
            url: () => input.url,
            method: () => input.method || 'GET',
            resourceType: () => input.resource || 'fetch',
            redirectedFrom: () => null,
            postDataBuffer: () => null,
            headers: () => ({}),
          }),
        };
        routes.push(route);
        await handler(route as unknown as Route);
        if (input.resource === 'document' && route.abort.mock.calls.length)
          throw new Error('navigation aborted');
      }
    }),
  };
  const context = {
    route: vi.fn(async (_pattern: string, callback: typeof handler) => {
      handler = callback;
    }),
    routeWebSocket: vi.fn(
      async (
        _pattern: string,
        callback: (socket: { close: typeof socketClose }) => void,
      ) => callback({ close: socketClose }),
    ),
    newPage: vi.fn().mockResolvedValue(page),
    on: vi.fn(),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const launch = vi
    .spyOn(chromium, 'launch')
    .mockResolvedValue(browser as unknown as Browser);
  return { page, browser, context, routes, socketClose, launch };
}

beforeEach(() => {
  vi.mocked(fetchPublicResource).mockResolvedValue({
    body: Buffer.from('fixture'),
    headers: { 'content-type': 'text/html' },
    status: 200,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fetchPublicResource).mockReset();
});

describe('动态网页隔离读取', () => {
  it('等正文稳定后返回，并关闭浏览器、禁止旁路流量与持久登录状态', async () => {
    const test = fixture(job);
    const result = await fetchRenderedJob('https://jobs.example.com/role');
    expect(result.adapter).toBe('browser');
    expect(result.text).toContain('任职要求');
    expect(test.browser.close).toHaveBeenCalledOnce();
    expect(test.launch).toHaveBeenCalledWith(
      expect.objectContaining({ proxy: { server: 'http://127.0.0.1:9' } }),
    );
    expect(test.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceWorkers: 'block',
        acceptDownloads: false,
      }),
    );
    expect(test.socketClose).toHaveBeenCalledOnce();
    expect(test.routes[0].fulfill).toHaveBeenCalled();
  });

  it('私网子请求、写入方法和图片不会经过网络读取器', async () => {
    const test = fixture(job, [
      { url: 'http://127.0.0.1/private' },
      { url: 'https://jobs.example.com/delete', method: 'DELETE' },
      { url: 'https://jobs.example.com/photo.png', resource: 'image' },
    ]);
    await fetchRenderedJob('https://jobs.example.com/role');
    expect(fetchPublicResource).toHaveBeenCalledTimes(1);
    expect(
      test.routes
        .slice(1)
        .every((route) => route.abort.mock.calls.length === 1),
    ).toBe(true);
  });

  it.each([
    ['<title>用户登录</title><body>请先登录</body>', 'PAGE_REQUIRES_LOGIN'],
    ['<title>安全验证</title><body>请输入验证码</body>', 'PAGE_CAPTCHA'],
    ['<title>岗位</title><body>职位不存在</body>', 'PAGE_NOT_FOUND'],
  ])('阻挡页面返回具体错误 %s', async (html, code) => {
    const test = fixture(html);
    await expect(
      fetchRenderedJob('https://jobs.example.com/role'),
    ).rejects.toMatchObject({ code });
    expect(test.browser.close).toHaveBeenCalledOnce();
  });

  it('危险入口在启动浏览器前拒绝', async () => {
    const test = fixture(job);
    await expect(fetchRenderedJob('http://127.0.0.1/')).rejects.toMatchObject({
      code: 'PAGE_UNSAFE_URL',
    });
    expect(test.launch).not.toHaveBeenCalled();
  });

  it('组件启动失败返回可理解提示，随后可以重试', async () => {
    const test = fixture(job);
    test.launch.mockRejectedValue(new Error('private executable path'));
    await expect(
      fetchRenderedJob('https://jobs.example.com/role'),
    ).rejects.toMatchObject({ code: 'PAGE_BROWSER_UNAVAILABLE' });
    fixture(job);
    expect(
      (await fetchRenderedJob('https://jobs.example.com/role')).adapter,
    ).toBe('browser');
  });
});
