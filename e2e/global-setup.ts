import fs from 'node:fs';
import path from 'node:path';
import {
  createTestRun,
  cloneTestProject,
  cleanupTestRun,
  runTestProcess,
  testEnvironment,
} from '../scripts/test-sandbox.mjs';

export default async function setup() {
  const run = createTestRun('e2e');
  console.log(`端到端测试隔离目录：${run.root}`);
  try {
    const project = cloneTestProject(
      path.resolve(import.meta.dirname, '..'),
      run,
    );
    const buildData = path.join(run.root, 'zhaopin-build-data');
    fs.mkdirSync(buildData);
    let logs = '';
    const environment = {
      ...process.env,
      ...testEnvironment(buildData),
      NODE_ENV: 'production' as const,
      ZHAOPIN_LAUNCHER_TEST: '0',
      ZHAOPIN_PORT: '3000',
    };
    await runTestProcess(
      process.execPath,
      [path.join(project, 'scripts/migrate.mjs')],
      {
        cwd: project,
        env: environment,
        log: (value: string) => {
          logs += value;
        },
      },
    );
    await runTestProcess(
      process.execPath,
      [path.join(project, 'scripts/build.mjs')],
      {
        cwd: project,
        env: environment,
        log: (value: string) => {
          logs += value;
        },
      },
    ).catch((error: Error) => {
      console.error(logs);
      throw error;
    });
    process.env.ZHAOPIN_E2E_RUN = JSON.stringify({ ...run, project });
    return () => {
      delete process.env.ZHAOPIN_E2E_RUN;
      cleanupTestRun(run);
    };
  } catch (error) {
    cleanupTestRun(run);
    throw error;
  }
}
