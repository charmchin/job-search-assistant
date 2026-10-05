import { ActionError } from './actions';
export const MAX_ACTION_BYTES = 2 * 1024 * 1024;
export async function readActionRequest(request: Request) {
  if (Number(request.headers.get('content-length')) > MAX_ACTION_BYTES)
    throw new ActionError(
      '提交内容超过 2 MB，请减少正文或条目后重试。',
      413,
      'REQUEST_TOO_LARGE',
    );
  if (!request.body) throw new SyntaxError('empty body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ACTION_BYTES) {
        await reader.cancel();
        throw new ActionError(
          '提交内容超过 2 MB，请减少正文或条目后重试。',
          413,
          'REQUEST_TOO_LARGE',
        );
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    reader.releaseLock();
  }
}
