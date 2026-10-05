type Events = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};
export const WORKSPACE_REFRESH_MS = 60_000;
export function startWorkspaceRefresh(options: {
  window: Events;
  document: Events & { visibilityState: string };
  refresh: () => Promise<unknown>;
  canRefresh: () => boolean;
  now?: () => number;
}) {
  let stopped = false;
  let lastAttempt = -Infinity;
  const now = options.now ?? Date.now;
  const tick = () => {
    const elapsed = now() - lastAttempt;
    if (
      stopped ||
      options.document.visibilityState !== 'visible' ||
      !options.canRefresh() ||
      (elapsed >= 0 && elapsed < 1000)
    )
      return;
    lastAttempt = now();
    void options.refresh().catch(() => {});
  };
  const timer = setInterval(tick, WORKSPACE_REFRESH_MS);
  options.window.addEventListener('focus', tick);
  options.document.addEventListener('visibilitychange', tick);
  return () => {
    stopped = true;
    clearInterval(timer);
    options.window.removeEventListener('focus', tick);
    options.document.removeEventListener('visibilitychange', tick);
  };
}
