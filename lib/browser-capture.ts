import { chromium, type Browser } from 'playwright';
import fs from 'node:fs';
import {
  fetchPublicResource,
  PublicFetchError,
  validatePublicUrl,
  PAGE_MAX_REDIRECTS,
} from '@/lib/public-fetch';
import { hasJobContent, readJobPage } from '@/lib/job-page';

export const BROWSER_TIMEOUT_MS = 40_000;
const MAX_REQUESTS = 100;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
let busy = false;

export async function fetchRenderedJob(rawUrl: string) {
  const url = validatePublicUrl(rawUrl);
  if (busy)
    throw new PublicFetchError(
      'PAGE_BROWSER_BUSY',
      '正在读取另一个动态网页，请稍后重试',
    );
  busy = true;
  let browser: Browser | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    void browser?.close().catch(() => {});
  }, BROWSER_TIMEOUT_MS);
  let failure: PublicFetchError | undefined;
  try {
    try {
      const options = {
        timeout: 10_000,
        // Unhandled browser traffic has no network path. Every allowed request is
        // fulfilled below by the existing DNS-pinned public-address transport.
        proxy: { server: 'http://127.0.0.1:9' },
        args: [
          '--proxy-bypass-list=<-loopback>',
          '--host-resolver-rules=MAP * ~NOTFOUND',
          '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
      };
      const bundled = fs.existsSync(chromium.executablePath());
      try {
        browser = await chromium.launch({
          ...options,
          ...(bundled
            ? { executablePath: chromium.executablePath() }
            : { channel: 'chrome' }),
        });
      } catch (error) {
        if (!bundled) throw error;
        browser = await chromium.launch({ ...options, channel: 'chrome' });
      }
    } catch {
      throw new PublicFetchError(
        'PAGE_BROWSER_UNAVAILABLE',
        '动态网页读取组件未能启动，请安装浏览器组件或粘贴正文',
      );
    }
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      locale: 'zh-CN',
    });
    await context.routeWebSocket('**/*', (socket) => socket.close());
    let count = 0;
    let bytes = 0;
    let pending = 0;
    let active = 0;
    const waiters: (() => void)[] = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      const resource = request.resourceType();
      const critical = ['document', 'script', 'xhr', 'fetch'].includes(
        resource,
      );
      if (
        !['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(
          resource,
        ) ||
        !['GET', 'POST'].includes(request.method())
      ) {
        await route.abort().catch(() => {});
        return;
      }
      pending += critical ? 1 : 0;
      let acquired = false;
      try {
        validatePublicUrl(request.url());
        if (controller.signal.aborted)
          throw new PublicFetchError(
            'PAGE_TIMEOUT',
            '动态网页读取超时，请粘贴岗位正文继续',
          );
        if (++count > MAX_REQUESTS || bytes > MAX_TOTAL_BYTES)
          throw new PublicFetchError(
            'PAGE_TOO_LARGE',
            '动态网页请求或资源过多，请粘贴岗位正文继续',
          );
        if (active >= 6)
          await new Promise<void>((resolve) => waiters.push(resolve));
        else active++;
        acquired = true;
        if (controller.signal.aborted)
          throw new PublicFetchError(
            'PAGE_TIMEOUT',
            '动态网页读取超时，请粘贴正文',
          );
        let redirects = 0;
        for (
          let previous = request.redirectedFrom();
          previous;
          previous = previous.redirectedFrom()
        )
          redirects++;
        if (redirects > PAGE_MAX_REDIRECTS)
          throw new PublicFetchError(
            'PAGE_REDIRECT_LIMIT',
            '页面跳转次数过多，请粘贴招聘正文',
          );
        const response = await fetchPublicResource(
          request.url(),
          {
            method: request.method() as 'GET' | 'POST',
            body: request.postDataBuffer() || undefined,
            headers: request.headers(),
          },
          controller.signal,
        );
        bytes += response.body.length;
        if (bytes > MAX_TOTAL_BYTES)
          throw new PublicFetchError(
            'PAGE_TOO_LARGE',
            '动态网页资源超过读取限制，请粘贴正文',
          );
        if (resource === 'document' && response.status >= 400) {
          failure = new PublicFetchError(
            response.status === 404
              ? 'PAGE_NOT_FOUND'
              : response.status === 401
                ? 'PAGE_REQUIRES_LOGIN'
                : 'PAGE_UNAVAILABLE',
            response.status === 404
              ? '岗位页面不存在，请核对链接'
              : response.status === 401
                ? '岗位页面需要登录，请登录网站并粘贴正文'
                : '招聘网站拒绝或暂时无法提供这个页面',
          );
        }
        await route.fulfill(response);
      } catch (error) {
        if (critical && error instanceof PublicFetchError) failure ||= error;
        await route.abort().catch(() => {});
      } finally {
        pending -= critical ? 1 : 0;
        if (acquired) {
          const next = waiters.shift();
          if (next) next();
          else active--;
        }
      }
    });
    const page = await context.newPage();
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
    context.on('page', (popup) => {
      if (popup !== page) void popup.close().catch(() => {});
    });
    await page.goto(url.href, {
      waitUntil: 'domcontentloaded',
      timeout: 25_000,
    });
    let previous = '';
    let stable = 0;
    let last = readJobPage(await page.content(), page.url());
    while (!controller.signal.aborted) {
      last = readJobPage(await page.content(), page.url());
      if (last.blocked && pending === 0) throw last.blocked;
      if (last.usable && (last.structured || hasJobContent(last.text))) {
        stable = last.text === previous ? stable + 1 : 0;
        if (stable >= 2 && pending === 0)
          return {
            text: last.text,
            sourceName: new URL(page.url()).hostname.replace(/^www\./, ''),
            adapter: 'browser' as const,
          };
      }
      previous = last.text;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw (
      failure ||
      new PublicFetchError(
        'PAGE_TIMEOUT',
        '动态网页加载超时，请粘贴岗位正文继续',
      )
    );
  } catch (error) {
    if (error instanceof PublicFetchError) throw error;
    if (failure) throw failure;
    throw new PublicFetchError(
      controller.signal.aborted ? 'PAGE_TIMEOUT' : 'PAGE_REQUIRES_TEXT',
      controller.signal.aborted
        ? '动态网页加载超时，请粘贴岗位正文继续'
        : '动态网页未能提供可读取的岗位正文，请粘贴正文继续',
    );
  } finally {
    controller.abort();
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    busy = false;
  }
}
