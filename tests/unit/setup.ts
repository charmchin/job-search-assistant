import fs from 'node:fs';
import path from 'node:path';
import { inject, vi } from 'vitest';
import {
  testEnvironment,
  validateTestRun,
} from '../../scripts/test-sandbox.mjs';

// The patched AI client follows the same network-free baseline and explicit
// fetch mocks as existing tests. Never reach a real provider from a unit test.
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: (...args: Parameters<typeof globalThis.fetch>) =>
    globalThis.fetch(...args),
}));

const run = inject('zhaopinUnitRun');
validateTestRun(run);
const directory = fs.mkdtempSync(path.join(run.root, 'database-'));
// Before test imports: ignore even an inherited path to the real application DB.
Object.assign(process.env, testEnvironment(directory), {
  ZHAOPIN_UNIT_RUN_ROOT: run.root,
});
// Explicit mocks can replace this baseline, but unstubbing restores a network-free default.
globalThis.fetch = async () => {
  throw new Error('单元测试禁止未模拟的 fetch；请注入或模拟网络响应');
};
