import fs from 'node:fs';
import path from 'node:path';
import { launchWorkspace } from './launcher-core.mjs';
import {
  configuration,
  createPlatform,
  showFailure,
} from './launcher-platform.mjs';

const root = path.resolve(import.meta.dirname, '..');
const mode = process.argv.includes('--stop')
  ? 'stop'
  : process.argv.includes('--restart')
    ? 'restart'
    : 'start';
let logPath;
try {
  const config = configuration(root);
  fs.mkdirSync(config.dataDir, { recursive: true });
  logPath = path.join(config.dataDir, 'launcher.log');
  const log = (message) => {
    const line = `${message}\n`;
    process.stdout.write(line);
    fs.appendFileSync(logPath, line, { mode: 0o600 });
  };
  log(
    `[${new Date().toISOString()}] ${mode === 'stop' ? '停止' : '启动'}求职助手`,
  );
  const platform = createPlatform(config, log);
  await launchWorkspace({ ...config, mode, platform, log });
} catch (error) {
  const message = error instanceof Error ? error.message : '启动失败。';
  process.stderr.write(`${message}\n诊断日志：${logPath || '未能创建日志'}\n`);
  if (logPath) {
    try {
      fs.appendFileSync(logPath, `失败：${message}\n`);
    } catch {}
  }
  if (
    process.argv.includes('--gui') &&
    process.env.ZHAOPIN_LAUNCHER_TEST !== '1'
  )
    showFailure(message, logPath || path.join(root, 'docs/USER_GUIDE.md'));
  process.exitCode = 1;
}
