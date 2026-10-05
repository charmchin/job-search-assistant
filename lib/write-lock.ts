// Shared across Next route bundles. Do not hold a SQLite transaction across an
// await; serialize the Keychain + DB sequence with restore at process level.
const runtime = globalThis as typeof globalThis & {
  zhaopinWriteQueue?: { tail: Promise<void> };
};
const queue = (runtime.zhaopinWriteQueue ??= { tail: Promise.resolve() });
export function withWriteLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const result = queue.tail.then(operation);
  queue.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
