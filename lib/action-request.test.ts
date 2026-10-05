import { describe, expect, it, vi } from 'vitest';
import { readActionRequest, MAX_ACTION_BYTES } from './action-request';
import { withWriteLock } from './write-lock';
const request = (body: string, headers: Record<string, string> = {}) =>
  new Request('http://127.0.0.1:3115/api/action', {
    method: 'POST',
    headers,
    body,
  });
describe('写请求容量与恢复串行化', () => {
  it('正常 JSON 读取，非法正文明确拒绝', async () => {
    expect(await readActionRequest(request('{"action":"test"}'))).toEqual({
      action: 'test',
    });
    await expect(readActionRequest(request('bad-json'))).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
  it('声明超限不读取正文；没有 Content-Length 的流也受限', async () => {
    const input = request('{}', {
      'Content-Length': String(MAX_ACTION_BYTES + 1),
    });
    await expect(readActionRequest(input)).rejects.toMatchObject({
      status: 413,
    });
    expect(input.bodyUsed).toBe(false);
    await expect(
      readActionRequest(request('x'.repeat(MAX_ACTION_BYTES + 1))),
    ).rejects.toMatchObject({ status: 413 });
  });
  it('等待钥匙串时，恢复不能插入写入序列；前一项失败也能释放', async () => {
    const events: string[] = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = withWriteLock(async () => {
      events.push('keychain');
      await waiting;
      events.push('commit');
    });
    const restore = withWriteLock(() => {
      events.push('restore');
    });
    await Promise.resolve();
    expect(events).toEqual(['keychain']);
    release();
    await Promise.all([save, restore]);
    expect(events).toEqual(['keychain', 'commit', 'restore']);
    await expect(
      withWriteLock(() => {
        throw new Error('fixture');
      }),
    ).rejects.toThrow('fixture');
    const next = vi.fn();
    await withWriteLock(next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
