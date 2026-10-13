type Notice = {
  kind: 'pending' | 'success' | 'error' | 'warning';
  message: string;
};
export type MutationNotice = Notice | null;
export class MutationError extends Error {
  constructor(
    message: string,
    public readonly code = 'SAVE_FAILED',
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function createMutationClient(options: {
  refresh: () => Promise<boolean>;
  notice: (notice: Notice) => void;
  fetcher?: typeof fetch;
  makeId?: () => string;
  starting?: () => void;
}) {
  const fetcher = options.fetcher || fetch;
  const retries = new Map<string, string>(); // Memory only: never persist form data or API keys.
  const inFlight = new Map<string, Promise<Record<string, unknown>>>();
  let needsRefresh = false;
  return {
    isBusy() {
      // Preserve the explicit refresh-required gate after a committed write.
      return inFlight.size > 0 || needsRefresh;
    },
    markRefreshed() {
      needsRefresh = false;
    },
    mutate(action: string, payload: Record<string, unknown>) {
      const key = JSON.stringify({ action, payload });
      const running = inFlight.get(key);
      if (running) return running;
      if (inFlight.size)
        return Promise.reject(
          new MutationError(
            '另一个操作正在保存，请等待完成后再操作。',
            'SAVE_BUSY',
          ),
        );
      if (needsRefresh)
        return Promise.reject(
          new MutationError(
            '上一操作已保存，但列表尚未刷新。请先点击页面提示中的“重试刷新”，不要重复提交。',
            'REFRESH_REQUIRED',
          ),
        );
      const requestId =
        retries.get(key) || (options.makeId || (() => crypto.randomUUID()))();
      retries.set(key, requestId);
      options.starting?.();
      options.notice({ kind: 'pending', message: '正在保存，请勿重复提交…' });
      const promise = (async () => {
        let result: Record<string, unknown>;
        try {
          const response = await fetcher('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, payload, requestId }),
            signal: AbortSignal.timeout(30000),
          });
          result = await response.json();
          if (!response.ok) {
            if (response.status < 500) retries.delete(key);
            throw new MutationError(
              typeof result?.error === 'string'
                ? result.error
                : '保存失败，请检查输入后重试。',
              typeof result?.code === 'string' ? result.code : 'SAVE_FAILED',
              result || {},
            );
          }
          const valid =
            result &&
            (action === 'saveSettings'
              ? result.saved === true
              : action === 'addActivity'
                ? result.ok === true
                : typeof result.id === 'string');
          if (!valid) throw new Error('invalid acknowledgement');
        } catch (error) {
          const failure =
            error instanceof MutationError
              ? error
              : new MutationError(
                  '无法确认保存结果，输入已保留。在当前窗口重试同一内容会沿用请求标识；刷新页面前请先核对，勿重复录入。',
                  'RESULT_UNKNOWN',
                );
          // A rejected stale edit has no committed writes. Refresh for comparison
          // without retrying it or replacing any component-owned draft.
          if (failure.code === 'EDIT_CONFLICT') {
            try {
              await options.refresh();
            } catch {}
          }
          options.notice({ kind: 'error', message: failure.message });
          throw failure;
        }
        retries.delete(key);
        let refreshed = false;
        try {
          refreshed = await options.refresh();
        } catch {}
        needsRefresh = !refreshed;
        options.notice(
          refreshed
            ? { kind: 'success', message: '已保存，列表已更新。' }
            : {
                kind: 'warning',
                message:
                  '数据已保存，但列表刷新失败。请重试刷新，不要再次提交。',
              },
        );
        return { ...result, refreshFailed: !refreshed };
      })();
      inFlight.set(key, promise);
      void promise.then(
        () => inFlight.delete(key),
        () => inFlight.delete(key),
      );
      return promise;
    },
  };
}
