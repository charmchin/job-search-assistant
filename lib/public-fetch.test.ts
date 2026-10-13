import { EventEmitter } from 'node:events';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicPageFetcher, createPublicResourceFetcher, BROWSER_RESOURCE_MAX_BYTES, isPublicAddress, PAGE_MAX_BYTES, PAGE_MAX_REDIRECTS, requestPinnedUrl, validatePublicUrl } from '@/lib/public-fetch';

afterEach(() => vi.restoreAllMocks());

const html = '<html><title>示例招聘</title><main>示例组织｜研发工程师\n任职要求：硕士学历，熟悉 TypeScript。工作地点：上海。</main></html>';
function response(body: string | Buffer | Buffer[] = html, status = 200, headers: http.IncomingHttpHeaders = {}) {
  const stream = Readable.from(Array.isArray(body) ? body : [Buffer.from(body)]) as IncomingMessage;
  stream.statusCode = status;
  stream.headers = { 'content-type': 'text/html; charset=utf-8', ...headers };
  return stream;
}
function harness() {
  const lookup = vi.fn(async (_host: string) => [{ address: '1.1.1.1', family: 4 }]);
  const transport = vi.fn(async (_target: Parameters<typeof requestPinnedUrl>[0], _signal: AbortSignal, _accept: string) => response());
  return { lookup, transport, fetchPage: createPublicPageFetcher({ lookup, transport }) };
}

describe('公开地址分类与 URL 规范化（不访问任何网络）', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '127.0.0.1', '127.255.255.255', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255',
    '192.0.0.9', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:1.1.1.1',
    '::127.0.0.1', 'fc00::1', 'fd12::1', 'fe80::1', 'fe80::1%lo0', 'ff02::1',
    '64:ff9b::7f00:1', '64:ff9b:1::1', '100::1', '2001::7f00:1', '2001:2::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1',
    'not-an-address', '127.1', '1.1.1.1%anything',
  ])('拒绝非普通公网地址 %s', (address) => { expect(isPublicAddress(address)).toBe(false); });
  it.each(['1.1.1.1', '8.8.8.8', '119.147.4.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('允许普通公网地址 %s', (address) => { expect(isPublicAddress(address)).toBe(true); });
  it.each([
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fc00::1]/',
    'http://localhost/', 'http://localhost./', 'http://jobs.LOCAL./', 'http://intranet/', 'http://foo.internal/',
    'http://127.0.0.1.nip.io:3109/', 'https://jobs.example.com:8443/', 'http://jobs.example.com:443/',
    'https://user:secret@jobs.example.com/', 'file:///etc/passwd', 'ftp://jobs.example.com/', 'data:text/html,jobs', 'not-a-url',
  ])('URL 预检拒绝 %s', (url) => { expect(() => validatePublicUrl(url)).toThrow(); });
  it('规范化编码 IP、默认端口和片段；普通域名及公网 IPv6 可用', () => {
    expect(validatePublicUrl('https://jobs.example.com:443/role#section').href).toBe('https://jobs.example.com/role');
    expect(validatePublicUrl('http://jobs.example.com:80/role').port).toBe('');
    expect(validatePublicUrl('https://[2606:4700:4700::1111]/role').hostname).toContain('2606:4700');
    expect(() => validatePublicUrl(`https://jobs.example.com/${'a'.repeat(4096)}`)).toThrow();
  });
});

describe('DNS 校验、逐跳重定向及时间边界', () => {
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:7f00:1', 'fd00::1'])('DNS 返回 %s 时不建立连接', async (address) => {
    const { lookup, transport } = harness();
    lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    await expect(createPublicPageFetcher({ lookup, transport })('https://jobs.example.com/role')).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('混合公网/私网 DNS 记录也被拒绝', async () => {
    const { lookup, transport } = harness();
    lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    await expect(createPublicPageFetcher({ lookup, transport })('https://jobs.example.com')).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([{ addresses: [] }, { addresses: [{ address: '1.1.1.1', family: 6 }] }, { addresses: [{ address: 'malformed', family: 4 }] }])('拒绝空或无效 DNS 记录 %#', async ({ addresses }) => {
    const { lookup, transport } = harness(); lookup.mockResolvedValue(addresses);
    await expect(createPublicPageFetcher({ lookup, transport })('https://jobs.example.com')).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('只解析一次，连接目标是校验后的 IP，不会再次使用可变 DNS', async () => {
    const { lookup, transport, fetchPage } = harness();
    lookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect((await fetchPage('https://jobs.example.com/role')).body).toBe(html);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toMatchObject({ address: '1.1.1.1', family: 4 });
  });
  it('公网 IPv6 字面量不进入 DNS 解析', async () => {
    const { lookup, transport, fetchPage } = harness();
    await fetchPage('https://[2606:4700:4700::1111]/role');
    expect(lookup).not.toHaveBeenCalled();
    expect(transport.mock.calls[0][0]).toMatchObject({ address: '2606:4700:4700::1111', family: 6 });
  });
  it.each(['http://127.0.0.1/', 'https://[::1]/', 'https://[::ffff:7f00:1]/', 'https://10.0.0.1/', 'file:///etc/passwd', 'https://user:secret@jobs.example.com/'])('公网页面跳转至 %s 时阻止下一次请求', async (location) => {
    const { transport, fetchPage } = harness(); const redirect = response('', 302, { location });
    transport.mockResolvedValue(redirect);
    await expect(fetchPage('https://jobs.example.com/role')).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
    expect(transport).toHaveBeenCalledTimes(1); expect(redirect.destroyed).toBe(true);
  });
  it('跳转后重新校验域名 DNS；下一跳解析为私网时不连接', async () => {
    const { lookup, transport, fetchPage } = harness();
    lookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]).mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
    transport.mockResolvedValueOnce(response('', 302, { location: 'https://other.example.com/role' }));
    await expect(fetchPage('https://jobs.example.com/role')).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
    expect(lookup).toHaveBeenCalledTimes(2); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('同域不同路径的下一跳也重新校验，阻止 DNS 重绑定', async () => {
    const { lookup, transport, fetchPage } = harness();
    lookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    transport.mockResolvedValueOnce(response('', 301, { location: '/next' }));
    await expect(fetchPage('https://jobs.example.com/role')).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([301, 302, 303, 307, 308])('正确处理 %i 公开相对跳转', async (status) => {
    const { lookup, transport, fetchPage } = harness();
    transport.mockResolvedValueOnce(response('', status, { location: '../next?job=1#details' })).mockResolvedValueOnce(response());
    const result = await fetchPage('https://jobs.example.com/path/role');
    expect(result.url.href).toBe('https://jobs.example.com/next?job=1');
    expect(result.body).toBe(html); expect(lookup).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0][1]).toBe(transport.mock.calls[1][1]);
  });
  it('HTTP 到 HTTPS 的公开跳转可用，HTTPS 降级到 HTTP 被拒绝', async () => {
    const { transport, fetchPage } = harness();
    transport.mockResolvedValueOnce(response('', 302, { location: 'https://jobs.example.com/role' })).mockResolvedValueOnce(response());
    expect((await fetchPage('http://jobs.example.com/role')).body).toBe(html);
    transport.mockResolvedValueOnce(response('', 302, { location: 'http://jobs.example.com/next' }));
    await expect(fetchPage('https://jobs.example.com/role')).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
  });
  it('跳转上限和循环均停止，不下载跳转正文', async () => {
    const { transport, fetchPage } = harness();
    transport.mockImplementation(async (target) => response(Buffer.alloc(PAGE_MAX_BYTES + 1), 302, { location: `/hop${Number(target.url.pathname.slice(4) || 0) + 1}` }));
    await expect(fetchPage('https://jobs.example.com/hop0')).rejects.toMatchObject({ code: 'PAGE_REDIRECT_LIMIT' });
    expect(transport).toHaveBeenCalledTimes(PAGE_MAX_REDIRECTS + 1);
    transport.mockClear().mockResolvedValue(response('', 302, { location: '/role' }));
    await expect(fetchPage('https://jobs.example.com/role')).rejects.toMatchObject({ code: 'PAGE_REDIRECT_LIMIT' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('DNS 超时不会开始 HTTP 连接', async () => {
    const { transport } = harness();
    const lookup = vi.fn(() => new Promise<{ address: string; family: number }[]>(() => {}));
    await expect(createPublicPageFetcher({ lookup, transport, timeoutMs: 10 })('https://jobs.example.com')).rejects.toMatchObject({ code: 'PAGE_TIMEOUT' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('请求超时和响应正文停滞都有同一个总时限', async () => {
    const { lookup } = harness();
    await expect(createPublicPageFetcher({ lookup, timeoutMs: 10, transport: () => new Promise(() => {}) })('https://jobs.example.com')).rejects.toMatchObject({ code: 'PAGE_TIMEOUT' });
    const stalled = new Readable({ read() {} }) as IncomingMessage;
    stalled.statusCode = 200; stalled.headers = { 'content-type': 'text/html' };
    await expect(createPublicPageFetcher({ lookup, timeoutMs: 10, transport: async () => stalled })('https://jobs.example.com')).rejects.toMatchObject({ code: 'PAGE_TIMEOUT' });
    expect(stalled.destroyed).toBe(true);
  });
});

describe('解析前下载与解压限制', () => {
  it('拒绝声明超限的响应并关闭流', async () => {
    const { transport, fetchPage } = harness();
    const oversized = response('', 200, { 'content-length': String(PAGE_MAX_BYTES + 1) });
    transport.mockResolvedValue(oversized);
    await expect(fetchPage('https://jobs.example.com')).rejects.toMatchObject({ code: 'PAGE_TOO_LARGE' });
    expect(oversized.destroyed).toBe(true);
  });
  it('无 Content-Length 时仍累计限制下载量', async () => {
    const { transport, fetchPage } = harness();
    const oversized = response([Buffer.alloc(PAGE_MAX_BYTES), Buffer.from('x')]);
    transport.mockResolvedValue(oversized);
    await expect(fetchPage('https://jobs.example.com')).rejects.toMatchObject({ code: 'PAGE_TOO_LARGE' });
    expect(oversized.destroyed).toBe(true);
  });
  it.each([['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const)('%s 正常页面可用，解压炸弹受 2 MB 限制', async (encoding, compress) => {
    const { transport, fetchPage } = harness();
    transport.mockResolvedValueOnce(response(compress(Buffer.from(html)), 200, { 'content-encoding': encoding }));
    expect((await fetchPage('https://jobs.example.com')).body).toBe(html);
    transport.mockResolvedValueOnce(response(compress(Buffer.alloc(PAGE_MAX_BYTES + 1)), 200, { 'content-encoding': encoding }));
    await expect(fetchPage('https://jobs.example.com')).rejects.toMatchObject({ code: 'PAGE_TOO_LARGE' });
  });
  it('JSON 接口共用下载限制和 DNS 安全策略', async () => {
    const { lookup, transport, fetchPage } = harness();
    transport.mockResolvedValueOnce(response('{"Code":200}', 200, { 'content-type': 'application/json' }));
    expect((await fetchPage('https://careers.tencent.com/api', 'json')).body).toBe('{"Code":200}');
    expect(transport.mock.calls[0][2]).toBe('application/json');
    transport.mockResolvedValueOnce(response(Buffer.alloc(PAGE_MAX_BYTES + 1), 200, { 'content-type': 'application/json' }));
    await expect(fetchPage('https://careers.tencent.com/api', 'json')).rejects.toMatchObject({ code: 'PAGE_TOO_LARGE' });
    lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(fetchPage('https://careers.tencent.com/api', 'json')).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
  });
  it('XHTML 和 +json 可用；二进制、失败响应和未知压缩均关闭流', async () => {
    const { transport, fetchPage } = harness();
    transport.mockResolvedValueOnce(response(html, 200, { 'content-type': 'application/xhtml+xml' }));
    expect((await fetchPage('https://jobs.example.com')).body).toBe(html);
    transport.mockResolvedValueOnce(response('{}', 200, { 'content-type': 'application/problem+json' }));
    expect((await fetchPage('https://jobs.example.com', 'json')).body).toBe('{}');
    for (const stream of [response('binary', 200, { 'content-type': 'application/octet-stream' }), response('', 403), response('', 200, { 'content-encoding': 'unknown' })]) {
      transport.mockResolvedValueOnce(stream);
      await expect(fetchPage('https://jobs.example.com')).rejects.toThrow();
      expect(stream.destroyed).toBe(true);
    }
  });
});

describe('Node HTTP/TLS 连接固定（模拟 transport，不发出网络请求）', () => {
  it.each(['http:', 'https:'] as const)('%s 保留域名、固定 IP、关闭连接复用且没有认证头', async (protocol) => {
    let captured: https.RequestOptions & { autoSelectFamily?: boolean } = {};
    const reply = response();
    const fakeRequest = Object.assign(new EventEmitter(), { end: vi.fn() });
    const implementation = (url: URL, options: https.RequestOptions, callback: (message: IncomingMessage) => void) => {
      expect(url.hostname).toBe('jobs.example.com'); captured = options;
      queueMicrotask(() => callback(reply)); return fakeRequest;
    };
    vi.spyOn(protocol === 'https:' ? https : http, 'request').mockImplementation(implementation as unknown as typeof https.request);
    const signal = new AbortController().signal;
    await expect(requestPinnedUrl({ url: new URL(`${protocol}//jobs.example.com/role`), address: '1.1.1.1', family: 4 }, signal, 'text/html')).resolves.toBe(reply);
    expect(captured.agent).toBe(false); expect(captured.autoSelectFamily).toBe(false);
    expect(captured.signal).toBe(signal); expect(captured.servername).toBe('jobs.example.com');
    expect(captured.rejectUnauthorized).toBe(true);
    expect(captured.headers).not.toHaveProperty('Authorization'); expect(captured.headers).not.toHaveProperty('Cookie');
    const pinned = await new Promise((resolve, reject) => captured.lookup!('jobs.example.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
    expect(pinned).toEqual({ address: '1.1.1.1', family: 4 }); expect(fakeRequest.end).toHaveBeenCalledTimes(1);
    reply.destroy();
  });
});

describe('浏览器资源仍走固定公网 IP 的受限读取', () => {
  it('支持公开 JSON POST 查询，但不传 Cookie、Authorization 或任意认证头', async () => {
    const { lookup, transport } = harness();
    const read = createPublicResourceFetcher({ lookup, transport });
    const body = Buffer.from('{"id":"123"}');
    const result = await read(
      'https://jobs.example.com/detail',
      {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          cookie: 'private',
          authorization: 'private',
          'x-api-key': 'private',
        },
      },
      new AbortController().signal,
    );
    expect(result.body.toString()).toBe(html);
    const options = (
      transport.mock.calls[0] as unknown as Parameters<typeof requestPinnedUrl>
    )[3];
    expect(options).toEqual({
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });
  });

  it('DNS 混合私网解析在浏览器资源连接前拒绝', async () => {
    const { lookup, transport } = harness();
    lookup.mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(
      createPublicResourceFetcher({ lookup, transport })(
        'https://jobs.example.com/app.js',
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('拒绝跳转到内网与 HTTPS 降级，公开跳转只返回下一跳供再次校验', async () => {
    const { lookup, transport } = harness();
    const read = createPublicResourceFetcher({ lookup, transport });
    for (const location of [
      'http://127.0.0.1/private',
      'http://jobs.example.com/next',
    ]) {
      transport.mockResolvedValueOnce(response('', 302, { location }));
      await expect(
        read('https://jobs.example.com/role', {}, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'PAGE_UNSAFE_URL' });
    }
    transport.mockResolvedValueOnce(response('', 302, { location: '/next' }));
    const result = await read(
      'https://jobs.example.com/role',
      {},
      new AbortController().signal,
    );
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe('https://jobs.example.com/next');
    expect(result.body.length).toBe(0);
  });

  it('较大的脚本有独立限制，HTML 原来的大小限制没有放宽', async () => {
    const { lookup, transport } = harness();
    const read = createPublicResourceFetcher({ lookup, transport });
    transport.mockResolvedValueOnce(
      response(Buffer.alloc(PAGE_MAX_BYTES + 1), 200, {
        'content-type': 'application/javascript',
      }),
    );
    expect(
      (
        await read(
          'https://jobs.example.com/app.js',
          {},
          new AbortController().signal,
        )
      ).body.length,
    ).toBe(PAGE_MAX_BYTES + 1);
    transport.mockResolvedValueOnce(
      response(gzipSync(Buffer.alloc(BROWSER_RESOURCE_MAX_BYTES + 1)), 200, {
        'content-encoding': 'gzip',
      }),
    );
    await expect(
      read('https://jobs.example.com/app.js', {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'PAGE_TOO_LARGE' });
    await expect(
      read(
        'https://jobs.example.com/query',
        { method: 'POST', body: Buffer.alloc(64 * 1024 + 1) },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PAGE_TOO_LARGE' });
  });

  it('超时关闭资源请求，服务端登录错误原样保留状态供页面识别', async () => {
    const { lookup, transport } = harness();
    const read = createPublicResourceFetcher({ lookup, transport });
    const controller = new AbortController();
    controller.abort();
    await expect(
      read('https://jobs.example.com/app.js', {}, controller.signal),
    ).rejects.toMatchObject({ code: 'PAGE_TIMEOUT' });
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValueOnce(response('login required', 401));
    expect(
      (
        await read(
          'https://jobs.example.com/detail',
          {},
          new AbortController().signal,
        )
      ).status,
    ).toBe(401);
  });
});
