import type { WorkspaceState } from './client-types';
export function createWorkspaceReader(options: {
  state: (state: WorkspaceState) => void;
  error: (message: string) => void;
  fetcher?: typeof fetch;
}) {
  let sequence = 0;
  let active:
    | {
        sequence: number;
        controller: AbortController;
        promise: Promise<WorkspaceState | undefined>;
      }
    | undefined;
  return {
    invalidate() {
      ++sequence;
      active?.controller.abort();
      active = undefined;
    },
    refresh({ background = false } = {}): Promise<WorkspaceState | undefined> {
      // A poll must never supersede a manual/post-save read.
      if (background && active) return active.promise;
      active?.controller.abort();
      const current = ++sequence;
      const controller = new AbortController();
      const promise = (async () => {
        try {
          const response = await (options.fetcher || fetch)('/api/state', {
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          });
          if (!response.ok) throw new Error('read failed');
          const data: WorkspaceState = await response.json();
          if (
            !data ||
            !Array.isArray(data.opportunities) ||
            !Array.isArray(data.tasks) ||
            !data.settings
          )
            throw new Error('invalid state');
          if (current !== sequence) return;
          options.state(data);
          options.error('');
          return data;
        } catch {
          if (current === sequence)
            options.error(
              '本地数据暂时无法读取。请确认服务仍在运行，然后重试。',
            );
        }
      })();
      active = { sequence: current, controller, promise };
      const clear = () => {
        if (active?.sequence === current) active = undefined;
      };
      void promise.then(clear, clear);
      return promise;
    },
  };
}
