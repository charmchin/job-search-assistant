/** Browser boundary, not authentication against programs running on this Mac. */
export function guardLocalRequest(request: Request): Response | null {
  const blocked = () =>
    Response.json(
      {
        code: 'LOCAL_REQUEST_BLOCKED',
        error:
          '请求来源不受信任。请从本机工作台页面操作；写入请求必须使用 JSON。',
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return blocked();
  }
  const host = request.headers.get('host') ?? url.host;
  if (
    url.protocol !== 'http:' ||
    !/^(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/.test(host)
  )
    return blocked();
  let expected: URL;
  try {
    expected = new URL(`http://${host}`);
  } catch {
    return blocked();
  }
  // Next can normalize the internal hostname to localhost. The incoming Host
  // chooses the browser origin, but cannot choose a different listening port.
  if ((expected.port || '80') !== (url.port || '80')) return blocked();
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  if (origin !== null && origin !== expected.origin) return blocked();
  if (origin === null && referer !== null) {
    try {
      const source = new URL(referer);
      if (
        source.origin !== expected.origin ||
        source.username ||
        source.password
      )
        return blocked();
    } catch {
      return blocked();
    }
  }
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none')
    return blocked();
  if (request.headers.get('sec-fetch-mode') === 'no-cors') return blocked();
  if (
    ['iframe', 'frame', 'embed', 'object'].includes(
      request.headers.get('sec-fetch-dest') || '',
    )
  )
    return blocked();
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (write) {
    if (site === 'none' && origin === null && referer === null)
      return blocked();
    const mediaType = request.headers
      .get('content-type')
      ?.split(';')[0]
      .trim()
      .toLowerCase();
    if (mediaType !== 'application/json') return blocked();
  }
  // No Origin/Referer/Fetch Metadata: allow local CLI diagnostics explicitly.
  // Never use Forwarded or X-Forwarded-* to grant authority.
  return null;
}
