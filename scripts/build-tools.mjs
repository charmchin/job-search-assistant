import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const APP_ID = 'com.local.zhaopin-assistant';
const heldLocks = new Map();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};
export function trackChildProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return () => {};
  const update = (add) => {
    for (const [file, owner] of heldLocks) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.token !== owner.token)
        throw new Error('启动锁已改变，不能继续执行构建。');
      owner.children = add
        ? [...new Set([...owner.children, pid])]
        : owner.children.filter((value) => value !== pid);
      const temporary = `${file}.${owner.token}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
  };
  update(true);
  return () => update(false);
}
const roots = [
  'app',
  'components',
  'lib',
  'db',
  'drizzle',
  'hooks',
  'public',
  'scripts',
];
const files = [
  'package.json',
  'package-lock.json',
  'next.config.ts',
  'tsconfig.json',
  'postcss.config.mjs',
  'instrumentation.ts',
  'start.command',
  'stop.command',
  'run-server.command',
];
export function sourceFingerprint(root) {
  const hash = createHash('sha256');
  const visit = (relative) => {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) return;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink())
      throw new Error(`构建输入不能是符号链接：${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort())
        visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const content = fs.readFileSync(full);
      hash.update(JSON.stringify([relative, content.length]));
      hash.update(content);
    }
  };
  for (const relative of [...roots, ...files].sort()) visit(relative);
  // A native module built by a different Node ABI must not silently reuse a build.
  hash.update(
    JSON.stringify([
      process.versions.node,
      process.versions.modules,
      process.platform,
      process.arch,
    ]),
  );
  return hash.digest('hex');
}
export function installationId(root, dataDir) {
  return createHash('sha256')
    .update(JSON.stringify([fs.realpathSync(root), path.resolve(dataDir)]))
    .digest('hex');
}
export function readBuild(root) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.next/zhaopin-build.json'), 'utf8'),
    );
    const buildId = fs
      .readFileSync(path.join(root, '.next/BUILD_ID'), 'utf8')
      .trim();
    return manifest.appId === APP_ID &&
      manifest.buildId === buildId &&
      /^[a-f0-9]{64}$/.test(manifest.fingerprint)
      ? manifest
      : null;
  } catch {
    return null;
  }
}
export async function buildProject(root, run) {
  const before = sourceFingerprint(root);
  // Remove the receipt first: a failed/partial build must never be considered valid.
  fs.rmSync(path.join(root, '.next/zhaopin-build.json'), { force: true });
  await run(process.execPath, [
    path.join(root, 'node_modules/next/dist/bin/next'),
    'build',
  ]);
  if (sourceFingerprint(root) !== before)
    throw new Error(
      '构建期间源文件发生变化，未标记版本完成。请保存修改后重新启动。',
    );
  const buildId = fs
    .readFileSync(path.join(root, '.next/BUILD_ID'), 'utf8')
    .trim();
  const manifest = {
    appId: APP_ID,
    fingerprint: before,
    buildId,
    builtAt: new Date().toISOString(),
  };
  const temporary = path.join(root, `.next/zhaopin-build.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(manifest), {
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temporary, path.join(root, '.next/zhaopin-build.json'));
  return manifest;
}

export async function acquireLock(
  directory,
  { timeout = 180000, poll = 100 } = {},
) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, '.zhaopin-launch.lock');
  const token = randomUUID();
  const deadline = Date.now() + timeout;
  while (true) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (fd !== undefined) {
      const owner = { pid: process.pid, token, children: [] };
      try {
        fs.writeFileSync(fd, JSON.stringify(owner));
      } finally {
        fs.closeSync(fd);
      }
      heldLocks.set(file, owner);
      return () => {
        heldLocks.delete(file);
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token)
            fs.unlinkSync(file);
        } catch {}
      };
    }
    try {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 1 &&
        typeof owner.token === 'string' &&
        (owner.children === undefined ||
          (Array.isArray(owner.children) &&
            owner.children.every(
              (pid) => Number.isSafeInteger(pid) && pid > 1,
            )))
      ) {
        if (
          !alive(owner.pid) &&
          !(owner.children || []).some(alive) &&
          fs.readFileSync(file, 'utf8') === JSON.stringify(owner)
        ) {
          fs.unlinkSync(file);
          continue;
        }
      }
    } catch {}
    if (Date.now() >= deadline)
      throw new Error(
        `另一个启动、停止或构建操作尚未完成。请稍后重试；锁文件：${file}`,
      );
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}
