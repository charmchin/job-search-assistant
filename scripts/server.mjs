import path from 'node:path';
import { spawn } from 'node:child_process';
import { readBuild } from './build-tools.mjs';
import { configuration, serverExitCode } from './launcher-platform.mjs';
const root = path.resolve(import.meta.dirname, '..');
const [, , port, dataDir, test, installHome] = process.argv;
const config = configuration(root, {
  ...process.env,
  ...(port ? { ZHAOPIN_PORT: port } : {}),
  ...(dataDir ? { ZHAOPIN_DATA_DIR: dataDir } : {}),
  ...(test === '--test'
    ? { ZHAOPIN_LAUNCHER_TEST: '1', ZHAOPIN_INSTALL_HOME: installHome }
    : {}),
});
const build = readBuild(root);
if (!build)
  throw new Error(
    '未找到已完成的生产构建，请打开求职助手或运行 start.command 完成更新。',
  );
const child = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/next/dist/bin/next'),
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(config.port),
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      ZHAOPIN_DATA_DIR: config.dataDir,
      ZHAOPIN_RUNNING_FINGERPRINT: build.fingerprint,
      ZHAOPIN_RUNNING_BUILD_ID: build.buildId,
      ...(config.test
        ? {
            ZHAOPIN_DISABLE_NOTIFICATIONS: '1',
            ZHAOPIN_DISABLE_FILE_OPERATIONS: '1',
            OPENAI_API_KEY: 'fake-test-key',
            OPENAI_MODEL: '',
          }
        : {}),
    },
  },
);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stopping = true;
    child.kill(signal);
  });
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = serverExitCode(code, stopping);
});
