import { describe, expect, it } from 'vitest';
import { guardLocalRequest } from './local-request';

const request = (
  headers: Record<string, string> = {},
  method = 'POST',
  url = 'http://127.0.0.1:3113/api/action',
) =>
  new Request(url, {
    method,
    headers: {
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  });

describe('本机 API 来源边界', () => {
  it.each([
    {},
    { Origin: 'http://127.0.0.1:3113', 'Sec-Fetch-Site': 'same-origin' },
    { Referer: 'http://127.0.0.1:3113/?view=settings' },
    { 'Content-Type': 'application/json; charset=utf-8' },
    { 'Content-Type': 'APPLICATION/JSON' },
  ] as Record<string, string>[])(
    '允许正常页面、旧浏览器同源来源与明确的 CLI JSON（%#）',
    (headers) => {
      expect(guardLocalRequest(request(headers))).toBeNull();
    },
  );
  it('兼容 Next 内部 hostname 归一化，但不接受浏览器的 hostname 别名来源', () => {
    expect(
      guardLocalRequest(
        request(
          { Host: '127.0.0.1:3113', Origin: 'http://127.0.0.1:3113' },
          'POST',
          'http://localhost:3113/api/action',
        ),
      ),
    ).toBeNull();
    expect(
      guardLocalRequest(request({ Origin: 'http://localhost:3113' }))?.status,
    ).toBe(403);
    expect(
      guardLocalRequest(
        request({ Host: 'localhost:3113', Origin: 'http://localhost:3113' }),
      ),
    ).toBeNull();
  });
  it.each([
    'evil.example',
    '127.0.0.1.evil.example:3113',
    '127.1:3113',
    '[::1]:3113',
    '127.0.0.1.:3113',
    '127.0.0.1:99999',
    'localhost@evil.example',
    'localhost/path',
    '127.0.0.1:3114',
    'localhost:3114',
    'localhost:3113,evil.example',
  ])('Host 必须是监听端口的明确本机地址：%s', (Host) => {
    expect(guardLocalRequest(request({ Host }))?.status).toBe(403);
  });
  it.each([
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { Origin: 'http://127.0.0.1:3114' },
    { Origin: 'https://127.0.0.1:3113' },
    { Origin: 'http://127.0.0.1:3113/' },
    { Origin: 'http://127.0.0.1:3113.evil.example' },
    { Origin: 'http://127.0.0.1:3113, https://evil.example' },
    { Referer: 'http://127.0.0.1:3114/' },
    { Referer: 'bad-url' },
    { Referer: 'http://user:password@127.0.0.1:3113/' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { Origin: 'http://127.0.0.1:3113', 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'unknown' },
    { 'Sec-Fetch-Site': 'none' },
    { 'Sec-Fetch-Mode': 'no-cors' },
    { 'Sec-Fetch-Dest': 'iframe' },
    { 'Content-Type': 'text/plain' },
    { 'Content-Type': 'application/jsonp' },
    { 'Content-Type': 'application/json-evil' },
    { 'Content-Type': 'application/problem+json' },
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    { 'Content-Type': 'multipart/form-data' },
    { 'Content-Type': '' },
    { 'Content-Type': 'application/json, text/plain' },
  ] as Record<string, string>[])(
    '拒绝其他来源、简单写入和伪装 JSON（%#）',
    async (headers) => {
      const response = guardLocalRequest(request(headers));
      expect(response?.status).toBe(403);
      expect((await response!.json()).code).toBe('LOCAL_REQUEST_BLOCKED');
      expect(response!.headers.has('Access-Control-Allow-Origin')).toBe(false);
    },
  );
  it('请求体尚未读取时已拒绝', () => {
    const input = new Request('http://127.0.0.1:3113/api/import', {
      method: 'POST',
      headers: { Origin: 'null' },
      body: 'bad-json',
    });
    expect(guardLocalRequest(input)?.status).toBe(403);
    expect(input.bodyUsed).toBe(false);
  });
  it('不使用转发头授权另一个来源，也不接受 HTTPS 内部 URL', () => {
    expect(
      guardLocalRequest(
        request({ Host: 'evil.example', 'X-Forwarded-Host': '127.0.0.1:3113' }),
      )?.status,
    ).toBe(403);
    expect(
      guardLocalRequest(
        request({
          Origin: 'http://evil.example',
          'X-Forwarded-Host': 'evil.example',
        }),
      )?.status,
    ).toBe(403);
    expect(
      guardLocalRequest(
        request({}, 'POST', 'https://127.0.0.1:3113/api/action'),
      )?.status,
    ).toBe(403);
  });
  it('读取和下载允许同源或直接导航/CLI，但拒绝外部页面导航', () => {
    expect(guardLocalRequest(request({}, 'GET'))).toBeNull();
    expect(
      guardLocalRequest(
        request(
          { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' },
          'GET',
        ),
      ),
    ).toBeNull();
    expect(
      guardLocalRequest(request({ 'Sec-Fetch-Site': 'same-origin' }, 'GET')),
    ).toBeNull();
    expect(
      guardLocalRequest(request({ 'Sec-Fetch-Site': 'same-site' }, 'GET'))
        ?.status,
    ).toBe(403);
    expect(
      guardLocalRequest(request({ Origin: 'https://evil.example' }, 'GET'))
        ?.status,
    ).toBe(403);
  });
});
