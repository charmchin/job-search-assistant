import type { TestProject } from 'vitest/node';
import { createTestRun, cleanupTestRun } from '../../scripts/test-sandbox.mjs';

declare module 'vitest' {
  interface ProvidedContext {
    zhaopinUnitRun: { root: string; token: string; kind: string };
  }
}
export default function setup(project: TestProject) {
  const run = createTestRun('unit');
  project.provide('zhaopinUnitRun', run);
  console.log(`单元测试隔离目录：${run.root}`);
  return () => cleanupTestRun(run);
}
