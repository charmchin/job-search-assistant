import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { APP_ID, trackChildProcess } from './build-tools.mjs';

export function configuration(root, env = process.env) {
  const test = env.ZHAOPIN_LAUNCHER_TEST === '1';
  const home = test ? env.ZHAOPIN_INSTALL_HOME : os.homedir();
  const dataDir = path.resolve(
    env.ZHAOPIN_DATA_DIR ||
      path.join(home, 'Library/Application Support/ZhaopinAssistant'),
  );
  const port = Number(env.ZHAOPIN_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('启动端口无效。');
  if (test) {
    const temporaryRoots = [os.tmpdir(), '/tmp'].map(
      (directory) => fs.realpathSync(directory) + path.sep,
    );
    for (const directory of [home, dataDir]) {
      if (
        !directory ||
        !temporaryRoots.some((temporary) =>
          path.resolve(directory).startsWith(temporary),
        ) ||
        !path.basename(directory).startsWith('zhaopin-')
      )
        throw new Error('启动测试必须使用 zhaopin- 临时目录。');
    }
    if (port < 3100 || port > 3199)
      throw new Error('启动测试不能占用正式端口。');
  } else if (port !== 3000)
    throw new Error('正式启动器仅使用 3000 端口；开发服务请使用 npm run dev。');
  return {
    root: fs.realpathSync(root),
    home,
    dataDir,
    port,
    test,
    label: test ? `${APP_ID}.test.${port}` : APP_ID,
    domain: `gui/${process.getuid()}`,
    url: `http://127.0.0.1:${port}`,
  };
}
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
export const serverExitCode = (code, stopping) => code ?? (stopping ? 0 : 1);
function native(file, args) {
  return spawnSync(file, args, {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
}
function jobArguments(text) {
  return (text.match(/\n\s*arguments = \{\n([\s\S]*?)\n\s*\}/)?.[1] || '')
    .split('\n')
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
}
export function projectServers(root) {
  const result = native('/bin/ps', ['-ax', '-o', 'pid=,command=']);
  if (result.status !== 0) throw new Error('无法检查构建占用进程。');
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+next-server(?:\s|$)/);
    if (!match) return [];
    const cwd = native('/usr/sbin/lsof', [
      '-a',
      '-p',
      match[1],
      '-d',
      'cwd',
      '-Fn',
    ])
      .stdout?.split('\n')
      .find((s) => s.startsWith('n'))
      ?.slice(1);
    return cwd === root ? [Number(match[1])] : [];
  });
}
export function createPlatform(config, log) {
  const { root, dataDir, label, domain, url, port, test } = config;
  const serviceFile = path.join(dataDir, 'service.label');
  const plist = path.join(
    config.home,
    'Library/LaunchAgents',
    `${label}.plist`,
  );
  const allowedLabel = (value) =>
    value === label ||
    (value.startsWith(`${label}.transient.`) && /^[a-zA-Z0-9.-]+$/.test(value));
  function jobs() {
    const labels = new Set([label]);
    if (fs.existsSync(serviceFile)) {
      const recorded = fs.readFileSync(serviceFile, 'utf8').trim();
      if (!allowedLabel(recorded))
        throw new Error('服务标识文件无效，未执行停止命令。');
      labels.add(recorded);
    }
    return [...labels].flatMap((value) => {
      const printed = native('/bin/launchctl', ['print', `${domain}/${value}`]);
      if (printed.status !== 0) return [];
      const args = jobArguments(printed.stdout);
      const cwd = printed.stdout
        .match(/\n\s*working directory = (.*)/)?.[1]
        ?.trim()
        .replace(/^"(.*)"$/, '$1');
      if (
        !args.includes(path.join(root, 'run-server.command')) ||
        (cwd && cwd !== root)
      )
        throw new Error('已注册服务指向其他项目，未自动停止或替换。');
      return [
        {
          label: value,
          pid: Number(printed.stdout.match(/\n\s*pid = (\d+)/)?.[1]),
        },
      ];
    });
  }
  const listeners = () => {
    const result = native('/usr/sbin/lsof', [
      '-nP',
      '-t',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
    ]);
    if (result.error || (result.status !== 0 && result.status !== 1))
      throw new Error('无法检查端口占用。');
    return [
      ...new Set(
        (result.stdout || '').trim().split(/\s+/).filter(Boolean).map(Number),
      ),
    ];
  };
  const isDescendant = (pid, parent) => {
    for (let i = 0; i < 8 && pid > 1; i++) {
      if (pid === parent) return true;
      pid = Number(
        native('/bin/ps', ['-p', String(pid), '-o', 'ppid=']).stdout?.trim(),
      );
    }
    return false;
  };
  const get = async (endpoint) => {
    const response = await fetch(`${url}${endpoint}`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!response.ok) return null;
    // Local identity is tiny. Do not parse an unbounded unrelated service response.
    const reader = response.body.getReader();
    let count = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.length;
        if (count > (endpoint === '/api/health' ? 8192 : 32 * 1024 * 1024)) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      reader.releaseLock();
    }
  };
  const probe = async () => {
    const pids = listeners();
    let health = null;
    if (pids.length) {
      try {
        health = await get('/api/health');
      } catch {}
    }
    return { occupied: pids.length > 0, pids, health };
  };
  const run = (file, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd: root,
        env: {
          ...process.env,
          ZHAOPIN_DATA_DIR: dataDir,
          ...(test
            ? {
                ZHAOPIN_DISABLE_NOTIFICATIONS: '1',
                ZHAOPIN_DISABLE_FILE_OPERATIONS: '1',
                OPENAI_API_KEY: 'fake-test-key',
                OPENAI_MODEL: '',
              }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let untrack;
      try {
        untrack = trackChildProcess(child.pid);
      } catch (error) {
        child.kill('SIGTERM');
        reject(error);
        return;
      }
      child.stdout.on('data', (chunk) => log(chunk.toString().trimEnd()));
      child.stderr.on('data', (chunk) => log(chunk.toString().trimEnd()));
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, 300000);
      child.once('error', (error) => {
        clearTimeout(timer);
        try {
          untrack();
        } catch {}
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        try {
          untrack();
        } catch (error) {
          reject(error);
          return;
        }
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `执行失败：${path.basename(file)} ${args[0] || ''}（退出码 ${code ?? '超时/中止'}）。请查看启动日志。`,
            ),
          );
      });
    });
  const platform = {
    run,
    probe,
    async owned(value) {
      const registered = jobs();
      return (
        value.occupied &&
        value.pids.every((pid) =>
          registered.some((job) => job.pid && isDescendant(pid, job.pid)),
        )
      );
    },
    async stateReady() {
      try {
        const state = await get('/api/state');
        return (
          !!state &&
          Array.isArray(state.opportunities) &&
          Array.isArray(state.tasks) &&
          !!state.settings
        );
      } catch {
        return false;
      }
    },
    async dependencies() {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 13))
        throw new Error('需要 Node.js 22.13 或更新版本。');
      if (!fs.existsSync(path.join(root, 'node_modules/next/package.json'))) {
        log('首次运行，正在安装依赖…');
        await run(path.join(path.dirname(process.execPath), 'npm'), [
          'install',
        ]);
      }
    },
    async stop() {
      for (const job of jobs()) {
        const result = native(
          '/bin/launchctl',
          job.label === label
            ? ['bootout', `${domain}/${job.label}`]
            : ['remove', job.label],
        );
        if (result.status !== 0)
          throw new Error('无法停止已确认的后台服务，请查看启动日志。');
      }
      fs.rmSync(serviceFile, { force: true });
    },
    async waitStopped() {
      for (let i = 0; i < 100; i++) {
        if (!listeners().length) return;
        await delay(100);
      }
      throw new Error('旧进程未完全退出，未执行迁移或覆盖构建。');
    },
    async assertBuildIdle() {
      if (projectServers(root).length)
        throw new Error(
          '此项目仍有开发或测试服务运行。请先停止这些服务，避免更新共享构建。',
        );
      // Detect a listener without visibility to lsof (e.g. another user).
      await new Promise((resolve, reject) => {
        const check = net.createServer();
        check.once('error', () =>
          reject(new Error('端口仍被占用，未启动服务。')),
        );
        check.listen(port, '127.0.0.1', () => check.close(resolve));
      });
    },
    async migrate() {
      await run(process.execPath, [path.join(root, 'scripts/migrate.mjs')]);
    },
    async start() {
      fs.mkdirSync(dataDir, { recursive: true });
      if (fs.existsSync(plist)) {
        const parsed = native('/usr/bin/plutil', [
          '-convert',
          'json',
          '-o',
          '-',
          plist,
        ]);
        let settings;
        try {
          settings = JSON.parse(parsed.stdout);
        } catch {
          throw new Error('登录启动项无法读取，请重新安装应用入口。');
        }
        if (
          !settings.ProgramArguments?.includes(
            path.join(root, 'run-server.command'),
          ) ||
          settings.WorkingDirectory !== root
        )
          throw new Error('登录启动项指向其他项目，未覆盖它。');
        const result = native('/bin/launchctl', ['bootstrap', domain, plist]);
        if (result.status !== 0)
          throw new Error('无法注册登录启动项，请查看启动日志。');
        fs.writeFileSync(serviceFile, label, { mode: 0o600 });
      } else {
        const value = `${label}.transient.${randomUUID()}`;
        const serviceLog = path.join(dataDir, 'server.log');
        const result = native('/bin/launchctl', [
          'submit',
          '-l',
          value,
          '-o',
          serviceLog,
          '-e',
          serviceLog,
          '--',
          '/bin/zsh',
          path.join(root, 'run-server.command'),
          process.execPath,
          String(port),
          dataDir,
          ...(test ? ['--test', config.home] : []),
        ]);
        if (result.status !== 0) throw new Error('无法向 macOS 注册本地服务。');
        fs.writeFileSync(serviceFile, value, { mode: 0o600 });
      }
    },
    async waitReady({ identity, build }) {
      for (let i = 0; i < 120; i++) {
        const status = await probe();
        if (status.occupied && !(await platform.owned(status)))
          throw new Error('启动期间端口被其他进程占用，未打开它的页面。');
        const h = status.health;
        if (
          h?.appId === APP_ID &&
          h.installationId === identity &&
          h.fingerprint === build.fingerprint &&
          h.buildId === build.buildId &&
          h.mode === 'production' &&
          (await platform.stateReady())
        )
          return;
        if (!jobs().length)
          throw new Error('后台进程提前退出，请查看 server.log。');
        await delay(250);
      }
      throw new Error('服务未能按预期版本启动，请查看 server.log。');
    },
    async open() {
      if (test || process.env.ZHAOPIN_NO_OPEN === '1') {
        log(`工作台地址：${url}`);
        return;
      }
      if (native('/usr/bin/open', [url]).status !== 0)
        throw new Error(`服务已运行，但浏览器未打开。请访问 ${url}`);
    },
  };
  return platform;
}

export function showFailure(message, logPath, { invoke = native } = {}) {
  const result = invoke('/usr/bin/osascript', [
    '-e',
    'on run argv\nset answer to display dialog ((item 1 of argv) & return & return & "诊断日志：" & (item 2 of argv)) with title "求职助手启动失败" buttons {"关闭", "查看日志"} default button "查看日志" with icon caution\nreturn button returned of answer\nend run',
    message,
    logPath,
  ]);
  if (result.stdout?.includes('查看日志')) invoke('/usr/bin/open', [logPath]);
}
