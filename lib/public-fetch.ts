import dns from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { PassThrough, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_MAX_REDIRECTS = 5;
export const PAGE_TIMEOUT_MS = 12_000;

type FailureCode = 'PAGE_UNSAFE_URL' | 'PAGE_TOO_LARGE' | 'PAGE_TIMEOUT' | 'PAGE_UNAVAILABLE' | 'PAGE_REDIRECT_LIMIT' | 'PAGE_UNSUPPORTED_CONTENT' | 'PAGE_REQUIRES_LOGIN' | 'PAGE_CAPTCHA' | 'PAGE_NOT_FOUND' | 'PAGE_REQUIRES_TEXT' | 'PAGE_BROWSER_UNAVAILABLE' | 'PAGE_BROWSER_BUSY';
export class PublicFetchError extends Error {
  constructor(public readonly code: FailureCode, message: string) { super(message); }
}
const unsafe = () => new PublicFetchError('PAGE_UNSAFE_URL', '为保护本机安全，不能读取这个地址');
const tooLarge = () => new PublicFetchError('PAGE_TOO_LARGE', '页面超过 2 MB，已停止自动读取');
const timeout = () => new PublicFetchError('PAGE_TIMEOUT', '读取页面超时，请粘贴招聘正文继续');

// Conservative web-capture policy, based on the IANA special-purpose registries.
// Special-purpose/tunnelling ranges are not appropriate recruitment destinations.
const blocked4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(network, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string) {
  if (address.includes('%')) return false; // Never accept scoped addresses.
  const family = isIP(address);
  if (family === 4) return !blocked4.check(address, 'ipv4');
  // This also rejects mapped IPv4, NAT64, loopback, ULA, link-local and multicast.
  return family === 6 && global6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6');
}

function hostname(url: URL) { return url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase(); }

export function validatePublicUrl(rawUrl: string | URL) {
  let url: URL;
  try { url = new URL(String(rawUrl)); } catch { throw unsafe(); }
  const host = hostname(url);
  const allowedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.href.length > 4096 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== allowedPort) || !host || host.includes('%')) throw unsafe();
  const family = isIP(host);
  if (family ? !isPublicAddress(host) : !host.includes('.') || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|onion)$/.test(host)) throw unsafe();
  url.hash = '';
  return url;
}

type Address = { address: string; family: number };
type Target = { url: URL; address: string; family: 4 | 6 };
type ResourceRequest = { method?: 'GET' | 'POST'; body?: Buffer; headers?: Record<string, string> };
type Transport = (target: Target, signal: AbortSignal, accept: string, options?: ResourceRequest) => Promise<IncomingMessage>;
type Lookup = (host: string) => Promise<Address[]>;

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(timeout()); };
    // Consume a late rejection even if the signal was already aborted.
    promise.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); }, (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function resolveTarget(url: URL, lookup: Lookup, signal: AbortSignal): Promise<Target> {
  const host = hostname(url);
  const literalFamily = isIP(host);
  const addresses = literalFamily ? [{ address: host, family: literalFamily }] : await abortable(lookup(host), signal);
  // Reject mixed public/private DNS answers, rather than picking just the safe one.
  if (!addresses.length || addresses.length > 64 || addresses.some((item) => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) throw unsafe();
  const chosen = addresses.find((item) => item.family === 4) || addresses[0];
  return { url, address: chosen.address, family: chosen.family as 4 | 6 };
}

export const requestPinnedUrl: Transport = (target, signal, accept, resource = {}) => new Promise((resolve, reject) => {
  const options: https.RequestOptions & { autoSelectFamily: boolean } = {
    method: resource.method || 'GET', agent: false, signal, family: target.family, autoSelectFamily: false, maxHeaderSize: 16 * 1024,
    // Retain the real hostname for HTTP Host, TLS SNI and certificate verification.
    servername: isIP(hostname(target.url)) ? '' : hostname(target.url), rejectUnauthorized: true,
    headers: { ...resource.headers, 'User-Agent': 'Mozilla/5.0 JobSearchWorkbench/1.0', Accept: accept, 'Accept-Encoding': 'gzip, deflate, br', ...(resource.body ? { 'Content-Length': String(resource.body.length) } : {}) },
    // No second DNS lookup and no reused connection can bypass the validated IP.
    lookup: (_host, _options, callback) => callback(null, target.address, target.family),
  };
  const request = (target.url.protocol === 'https:' ? https : http).request(target.url, options, resolve);
  request.on('error', reject);
  request.end(resource.body);
});

async function readBoundedBody(response: IncomingMessage, signal: AbortSignal, maxBytes = PAGE_MAX_BYTES) {
  const limitError = () => maxBytes === PAGE_MAX_BYTES ? tooLarge() : new PublicFetchError('PAGE_TOO_LARGE', '动态网页单个资源超过 12 MB，请粘贴岗位正文');
  if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); throw limitError(); }
  const encoding = String(response.headers['content-encoding'] || 'identity').trim().toLowerCase();
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : encoding === 'identity' ? new PassThrough() : null;
  if (!decoder) { response.destroy(); throw new PublicFetchError('PAGE_UNSUPPORTED_CONTENT', '页面采用了暂不支持的压缩方式，请粘贴正文'); }
  const chunks: Buffer[] = [];
  let wireBytes = 0;
  let decodedBytes = 0;
  const wireLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      wireBytes += chunk.length;
      callback(wireBytes > maxBytes ? limitError() : null, chunk);
    },
  });
  const collect = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      decodedBytes += chunk.length;
      if (decodedBytes > maxBytes) { callback(limitError()); return; }
      chunks.push(Buffer.from(chunk)); callback();
    },
  });
  await pipeline(response, wireLimit, decoder, collect, { signal });
  return Buffer.concat(chunks);
}

// Dependency injection exists only for deterministic tests, never as a request setting
// or environment flag that could disable the public-address policy.
export function createPublicPageFetcher(dependencies: { lookup?: Lookup; transport?: Transport; timeoutMs?: number } = {}) {
  const lookup = dependencies.lookup || ((host) => dns.lookup(host, { all: true, order: 'verbatim' }));
  const transport = dependencies.transport || requestPinnedUrl;
  return async (rawUrl: string | URL, kind: 'html' | 'json' = 'html') => {
    let url = validatePublicUrl(rawUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? PAGE_TIMEOUT_MS);
    const signal = controller.signal;
    const visited = new Set<string>();
    try {
      for (let redirects = 0; ; redirects++) {
        if (signal.aborted) throw timeout();
        if (visited.has(url.href)) throw new PublicFetchError('PAGE_REDIRECT_LIMIT', '页面反复跳转，请粘贴招聘正文');
        visited.add(url.href);
        const target = await resolveTarget(url, lookup, signal);
        const response = await abortable(transport(target, signal, kind === 'json' ? 'application/json' : 'text/html,application/xhtml+xml'), signal);
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy(); // Do not download redirect bodies or leave their sockets open.
          if (!location) throw new PublicFetchError('PAGE_UNAVAILABLE', '页面跳转信息不完整，请粘贴正文');
          if (redirects >= PAGE_MAX_REDIRECTS) throw new PublicFetchError('PAGE_REDIRECT_LIMIT', '页面跳转次数过多，请粘贴正文');
          let next: URL;
          try { next = new URL(location, url); } catch { throw unsafe(); }
          next = validatePublicUrl(next);
          if (url.protocol === 'https:' && next.protocol === 'http:') throw unsafe();
          url = next;
          continue;
        }
        if (status < 200 || status >= 300) { response.destroy(); throw new PublicFetchError('PAGE_UNAVAILABLE', '招聘网站暂时未返回可读取的页面'); }
        const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const supported = kind === 'html' ? ['text/html', 'application/xhtml+xml'].includes(contentType) : contentType === 'application/json' || contentType.endsWith('+json');
        if (!supported) { response.destroy(); throw new PublicFetchError('PAGE_UNSUPPORTED_CONTENT', '这个链接没有返回招聘页面，请粘贴正文'); }
        return { body: (await readBoundedBody(response, signal)).toString('utf8'), url };
      }
    } catch (error) {
      if (signal.aborted) throw timeout();
      if (error instanceof PublicFetchError) throw error;
      throw new PublicFetchError('PAGE_UNAVAILABLE', '暂时无法连接招聘网站，请粘贴正文继续');
    } finally { clearTimeout(timer); }
  };
}

export const fetchPublicPage = createPublicPageFetcher();

// Browser requests are fulfilled by Node, never continued through Chromium's DNS.
// A script bundle has a separate bound; ordinary HTML/JSON capture keeps its 2 MB bound.
export const BROWSER_RESOURCE_MAX_BYTES = 12 * 1024 * 1024;
export function createPublicResourceFetcher(
  dependencies: { lookup?: Lookup; transport?: Transport } = {},
) {
  const lookup =
    dependencies.lookup ||
    ((host) => dns.lookup(host, { all: true, order: 'verbatim' }));
  const transport = dependencies.transport || requestPinnedUrl;
  return async (
    rawUrl: string,
    request: ResourceRequest,
    parentSignal: AbortSignal,
  ) => {
    const url = validatePublicUrl(rawUrl);
    if (request.body && request.body.length > 64 * 1024)
      throw new PublicFetchError(
        'PAGE_TOO_LARGE',
        '动态网页查询请求过大，请粘贴岗位正文',
      );
    const signal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(PAGE_TIMEOUT_MS),
    ]);
    const headers: Record<string, string> = {};
    for (const name of [
      'content-type',
      'origin',
      'referer',
      'x-requested-with',
    ]) {
      const value = request.headers?.[name];
      if (value && value.length <= 4096) headers[name] = value;
    }
    try {
      const target = await resolveTarget(url, lookup, signal);
      const response = await abortable(
        transport(target, signal, '*/*', {
          method: request.method,
          body: request.body,
          headers,
        }),
        signal,
      );
      const status = response.statusCode || 502;
      const responseHeaders: Record<string, string> = {};
      for (const name of [
        'content-type',
        'access-control-allow-origin',
        'access-control-allow-credentials',
        'vary',
      ]) {
        const value = response.headers[name];
        if (typeof value === 'string') responseHeaders[name] = value;
      }
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (!response.headers.location)
          throw new PublicFetchError(
            'PAGE_UNAVAILABLE',
            '页面跳转信息不完整，请粘贴正文',
          );
        const next = validatePublicUrl(new URL(response.headers.location, url));
        if (url.protocol === 'https:' && next.protocol === 'http:')
          throw unsafe();
        responseHeaders.location = next.href;
        return { status, headers: responseHeaders, body: Buffer.alloc(0) };
      }
      return {
        status,
        headers: responseHeaders,
        body: await readBoundedBody(
          response,
          signal,
          BROWSER_RESOURCE_MAX_BYTES,
        ),
      };
    } catch (error) {
      if (signal.aborted) throw timeout();
      if (error instanceof PublicFetchError) throw error;
      throw new PublicFetchError(
        'PAGE_UNAVAILABLE',
        '暂时无法连接招聘网站，请粘贴正文继续',
      );
    }
  };
}

export const fetchPublicResource = createPublicResourceFetcher();
