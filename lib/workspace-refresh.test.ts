import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorkspaceRefresh } from './workspace-refresh';
import { createWorkspaceReader } from './workspace-reader';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T12:00:00+08:00'));
});
afterEach(() => vi.useRealTimers());
function scheduler() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
  });
  let busy = false;
  const refresh = vi.fn().mockResolvedValue(undefined);
  const stop = startWorkspaceRefresh({
    window,
    document,
    refresh,
    canRefresh: () => !busy,
  });
  return {
    window,
    document,
    refresh,
    stop,
    busy: (value: boolean) => {
      busy = value;
    },
  };
}
describe('前台刷新调度', () => {
  it('每分钟刷新，后台暂停，重新可见与窗口聚焦恢复', () => {
    const s = scheduler();
    vi.advanceTimersByTime(60000);
    expect(s.refresh).toHaveBeenCalledTimes(1);
    s.document.visibilityState = 'hidden';
    vi.advanceTimersByTime(180000);
    s.window.dispatchEvent(new Event('focus'));
    expect(s.refresh).toHaveBeenCalledTimes(1);
    s.document.visibilityState = 'visible';
    s.document.dispatchEvent(new Event('visibilitychange'));
    expect(s.refresh).toHaveBeenCalledTimes(2);
    s.window.dispatchEvent(new Event('focus'));
    expect(s.refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    s.window.dispatchEvent(new Event('focus'));
    expect(s.refresh).toHaveBeenCalledTimes(3);
    s.stop();
  });
  it('保存与待手动刷新期间不抢读；解除后下一分钟恢复', () => {
    const s = scheduler();
    s.busy(true);
    vi.advanceTimersByTime(60000);
    s.window.dispatchEvent(new Event('focus'));
    expect(s.refresh).not.toHaveBeenCalled();
    s.busy(false);
    vi.advanceTimersByTime(60000);
    expect(s.refresh).toHaveBeenCalledTimes(1);
    s.stop();
  });
  it('卸载移除定时器与监听，不再发请求', () => {
    const s = scheduler();
    s.stop();
    vi.advanceTimersByTime(300000);
    s.window.dispatchEvent(new Event('focus'));
    s.document.dispatchEvent(new Event('visibilitychange'));
    expect(s.refresh).not.toHaveBeenCalled();
  });
  it('宿主时钟回拨不永久阻止焦点刷新', () => {
    const s = scheduler();
    s.window.dispatchEvent(new Event('focus'));
    vi.setSystemTime(new Date('2026-10-03T12:00:00+08:00'));
    s.window.dispatchEvent(new Event('focus'));
    expect(s.refresh).toHaveBeenCalledTimes(2);
    s.stop();
  });
});
describe('后台读取与保存后读取的优先级', () => {
  it('后台读合并到正在进行的显式读，不废弃保存确认', async () => {
    let resolve!: (r: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const state = vi.fn(),
      error = vi.fn();
    const reader = createWorkspaceReader({ fetcher, state, error });
    const explicit = reader.refresh();
    expect(reader.refresh({ background: true })).toBe(explicit);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(Response.json({ opportunities: [], tasks: [], settings: {} }));
    expect(await explicit).toBeTruthy();
    expect(state).toHaveBeenCalledTimes(1);
  });
  it('写入开始取消旧读，旧响应和错误不再覆盖', async () => {
    let resolve!: (r: Response) => void;
    let signal: AbortSignal | null | undefined;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((_url, options) => {
        signal = options?.signal;
        return new Promise((r) => {
          resolve = r;
        });
      });
    const state = vi.fn(),
      error = vi.fn();
    const reader = createWorkspaceReader({ fetcher, state, error });
    const old = reader.refresh({ background: true });
    reader.invalidate();
    expect(signal?.aborted).toBe(true);
    resolve(Response.json({ opportunities: [], tasks: [], settings: {} }));
    expect(await old).toBeUndefined();
    expect(state).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it('同步读取异常也释放忙标记，后台可以继续重试', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        throw new Error('fixture');
      })
      .mockResolvedValue(
        Response.json({ opportunities: [], tasks: [], settings: {} }),
      );
    const reader = createWorkspaceReader({
      fetcher,
      state: vi.fn(),
      error: vi.fn(),
    });
    expect(await reader.refresh()).toBeUndefined();
    expect(await reader.refresh({ background: true })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('后台失败保留已有状态并呈现可重试提示', async () => {
    const state = vi.fn(),
      error = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ opportunities: [], tasks: [], settings: {} }),
      )
      .mockRejectedValueOnce(new Error('offline'));
    const reader = createWorkspaceReader({ fetcher, state, error });
    await reader.refresh();
    await reader.refresh({ background: true });
    expect(state).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining('暂时无法读取'),
    );
  });
});
