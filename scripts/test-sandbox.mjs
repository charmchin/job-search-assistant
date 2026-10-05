import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const marker = '.zhaopin-test-owner.json';
export function createTestRun(kind) {
  if (!['unit', 'e2e'].includes(kind)) throw new Error('未知测试类型');
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `zhaopin-${kind}-run-`)),
  );
  const token = randomUUID();
  fs.writeFileSync(path.join(root, marker), JSON.stringify({ token, kind }), {
    mode: 0o600,
    flag: 'wx',
  });
  return { root, token, kind };
}
export function validateTestRun(run) {
  if (
    !run ||
    !['unit', 'e2e'].includes(run.kind) ||
    typeof run.root !== 'string' ||
    typeof run.token !== 'string'
  )
    throw new Error('无效测试目录凭证');
  const temporary = fs.realpathSync(os.tmpdir()) + path.sep;
  const actual = fs.realpathSync(run.root);
  if (
    actual !== run.root ||
    !actual.startsWith(temporary) ||
    !path.basename(actual).startsWith(`zhaopin-${run.kind}-run-`)
  )
    throw new Error('拒绝清理非测试目录');
  const owner = JSON.parse(fs.readFileSync(path.join(actual, marker), 'utf8'));
  if (owner.token !== run.token || owner.kind !== run.kind)
    throw new Error('测试目录所有权不匹配');
  return actual;
}
export function cleanupTestRun(run) {
  const target = validateTestRun(run);
  fs.rmSync(target, { recursive: true });
}
export function testEnvironment(dataDir) {
  return {
    ZHAOPIN_DATA_DIR: dataDir,
    ZHAOPIN_DISABLE_NOTIFICATIONS: '1',
    ZHAOPIN_DISABLE_FILE_OPERATIONS: '1',
    ZHAOPIN_DISABLE_KEYCHAIN: '1',
    OPENAI_API_KEY: 'fake-test-key',
    OPENAI_MODEL: '',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
  };
}
export function cloneTestProject(source, run) {
  validateTestRun(run);
  const project = path.join(run.root, 'project');
  fs.mkdirSync(project);
  // Allowlist: never copy .env*, real data, logs, credentials or the shared .next.
  const inputs = [
    'app',
    'components',
    'lib',
    'db',
    'drizzle',
    'drizzle.config.ts',
    'docs/licenses',
    'hooks',
    'public',
    'scripts',
    'tests',
    'e2e',
    'package.json',
    'package-lock.json',
    'next.config.ts',
    'vitest.config.ts',
    'playwright.config.ts',
    'tsconfig.json',
    'postcss.config.mjs',
    'instrumentation.ts',
    'next-env.d.ts',
    'AGENTS.md',
    'start.command',
    'stop.command',
    'run-server.command',
    'node_modules',
  ];
  for (const relative of inputs) {
    const input = path.join(source, relative);
    if (fs.existsSync(input))
      fs.cpSync(input, path.join(project, relative), {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
      });
  }
  return project;
}

// Each invocation owns a detached group: on timeout/interrupt stop only this
// script's descendants, not an unrelated listener found by port or process name.
/**
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv, timeout?: number, signal?: AbortSignal, log?: (value: string) => void}} options
 */
export async function runTestProcess(
  file,
  args,
  { cwd, env, timeout = 150000, signal, log = (_value) => {} },
) {
  if (signal?.aborted) throw new Error('测试已取消');
  let output = '';
  const child = spawn(file, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const kill = (name) => {
    try {
      if (process.platform === 'win32') child.kill(name);
      else if (child.pid) process.kill(-child.pid, name);
    } catch (error) {
      // Darwin can report EPERM during cleanup of an already reaped group.
      // Ignore it only after the child exited AND ps confirms no live members;
      // an active/unknown group must still surface a real permission failure.
      if (
        error.code === 'EPERM' &&
        process.platform === 'darwin' &&
        (child.exitCode !== null || child.signalCode !== null)
      ) {
        const snapshot = spawnSync('/bin/ps', ['-axo', 'pgid=,stat='], {
          encoding: 'utf8',
          timeout: 2000,
        });
        if (!snapshot.error && snapshot.status === 0) {
          const members = snapshot.stdout
            .trim()
            .split('\n')
            .map((line) => line.trim().split(/\s+/))
            .filter(([group]) => Number(group) === child.pid);
          if (members.every(([, state]) => state?.startsWith('Z'))) return;
        }
      }
      if (error.code !== 'ESRCH') throw error;
    }
  };
  let failure, escalation;
  const stop = (reason) => {
    if (failure) return;
    failure = reason;
    kill('SIGTERM');
    escalation = setTimeout(() => kill('SIGKILL'), 3000);
  };
  const abort = () => stop(new Error('测试已取消'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => stop(new Error('隔离测试超时，已终止自身进程组')),
    timeout,
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      const value = chunk.toString();
      output = (output + value).slice(-200000);
      log(value);
    });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        failure
          ? reject(failure)
          : code === 0
            ? resolve()
            : reject(new Error(`隔离测试退出 ${code}\n${output}`)),
      );
    });
    return output;
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    signal?.removeEventListener('abort', abort);
    kill('SIGTERM');
    // A script may crash before its own finally block; clean the remaining group.
    if (process.platform !== 'win32' && child.pid) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      kill('SIGKILL');
    }
  }
}
