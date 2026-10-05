import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_ID,
  acquireLock,
  buildProject,
  installationId,
  readBuild,
  sourceFingerprint,
  trackChildProcess,
} from '../scripts/build-tools.mjs';
import { launchWorkspace } from '../scripts/launcher-core.mjs';
import {
  configuration,
  showFailure,
  serverExitCode,
} from '../scripts/launcher-platform.mjs';

let root: string, dataDir: string;
let platform: ReturnType<typeof fixture>['platform'];
function manifest() {
  return {
    appId: APP_ID,
    buildId: 'fixture-build',
    fingerprint: sourceFingerprint(root),
    builtAt: '2026-10-03T00:00:00Z',
  };
}
function markBuild() {
  fs.mkdirSync(path.join(root, '.next'), { recursive: true });
  fs.writeFileSync(path.join(root, '.next/BUILD_ID'), 'fixture-build');
  const build = manifest();
  fs.writeFileSync(
    path.join(root, '.next/zhaopin-build.json'),
    JSON.stringify(build),
  );
  return build;
}
function health() {
  return {
    installationId: installationId(root, dataDir),
    mode: 'production',
    ...markBuild(),
  };
}
function fixture() {
  const calls: string[] = [];
  const step = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  return {
    calls,
    platform: {
      probe: vi.fn(
        async (): Promise<{
          occupied: boolean;
          pids: number[];
          health: ReturnType<typeof health> | null;
        }> => ({ occupied: false, pids: [], health: null }),
      ),
      owned: vi.fn(async () => false),
      stateReady: vi.fn(async () => true),
      dependencies: step('dependencies'),
      stop: step('stop'),
      waitStopped: step('waitStopped'),
      assertBuildIdle: step('idle'),
      migrate: step('migrate'),
      start: step('start'),
      open: step('open'),
      waitReady: step('ready'),
      run: vi.fn(async () => {
        calls.push('build');
        fs.mkdirSync(path.join(root, '.next'), { recursive: true });
        fs.writeFileSync(path.join(root, '.next/BUILD_ID'), 'fixture-build');
      }),
    },
  };
}
const launch = (mode = 'start') =>
  launchWorkspace({ root, dataDir, mode, platform, log: () => {} });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaopin-launch-unit-'));
  dataDir = path.join(root, 'zhaopin-data');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(root, 'public'));
  fs.mkdirSync(path.join(root, 'drizzle'));
  fs.writeFileSync(path.join(root, 'public/input.txt'), 'original');
  fs.writeFileSync(path.join(root, 'drizzle/0000.sql'), 'migration');
  platform = fixture().platform;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('启动与版本协议（不访问真实数据库或 launchd）', () => {
  it.each([
    [null, false, 1],
    [null, true, 0],
    [0, false, 0],
    [1, false, 1],
  ] as const)(
    '子服务退出码 %s/主动关闭 %s 映射为 %s',
    (code, stopping, expected) => {
      expect(serverExitCode(code, stopping)).toBe(expected);
    },
  );
  it('内容未变只打开，不迁移、不构建、不停止进程', async () => {
    platform.probe.mockResolvedValue({
      occupied: true,
      pids: [123],
      health: health(),
    });
    const result = await launch();
    expect(result.reused).toBe(true);
    expect(platform.open).toHaveBeenCalledTimes(1);
    for (const operation of ['stop', 'migrate', 'run', 'start'] as const)
      expect(platform[operation]).not.toHaveBeenCalled();
  });
  it.each(['public/input.txt', 'drizzle/0000.sql'])(
    '即使保留旧 mtime，%s 内容变更也会重建',
    async (file) => {
      const previous = health();
      fs.writeFileSync(path.join(root, file), 'updated');
      fs.utimesSync(path.join(root, file), 0, 0);
      platform.probe.mockResolvedValue({
        occupied: true,
        pids: [123],
        health: previous,
      });
      platform.owned.mockResolvedValue(true);
      await launch();
      expect(platform.run).toHaveBeenCalledOnce();
      expect(readBuild(root)?.fingerprint).not.toBe(previous.fingerprint);
      const stopOrder = platform.stop.mock.invocationCallOrder[0];
      expect(stopOrder).toBeLessThan(
        platform.migrate.mock.invocationCallOrder[0],
      );
      expect(platform.waitStopped.mock.invocationCallOrder[0]).toBeLessThan(
        platform.run.mock.invocationCallOrder[0],
      );
    },
  );
  it('删除文件会改变内容指纹；触碰时间不改变指纹', () => {
    const before = sourceFingerprint(root);
    fs.utimesSync(path.join(root, 'public/input.txt'), new Date(), new Date());
    expect(sourceFingerprint(root)).toBe(before);
    fs.unlinkSync(path.join(root, 'public/input.txt'));
    expect(sourceFingerprint(root)).not.toBe(before);
  });
  it('不把同样返回 state 的陌生程序当作本软件', async () => {
    markBuild();
    platform.probe.mockResolvedValue({
      occupied: true,
      pids: [123],
      health: null,
    });
    await expect(launch()).rejects.toThrow('其他程序');
    for (const operation of [
      'dependencies',
      'stop',
      'migrate',
      'run',
      'start',
      'open',
    ] as const)
      expect(platform[operation]).not.toHaveBeenCalled();
  });
  it('另一项目/数据库的健康身份不能被重启或误打开', async () => {
    platform.probe.mockResolvedValue({
      occupied: true,
      pids: [123],
      health: { ...health(), installationId: 'other' },
    });
    await expect(launch()).rejects.toThrow('其他程序');
    expect(platform.stop).not.toHaveBeenCalled();
  });
  it('已核实的旧 launchd 服务没有 health 接口也能升级', async () => {
    platform.probe.mockResolvedValue({
      occupied: true,
      pids: [123],
      health: null,
    });
    platform.owned.mockResolvedValue(true);
    await launch();
    expect(platform.run).toHaveBeenCalledOnce();
    expect(platform.start).toHaveBeenCalledOnce();
  });
  it('明确重启会停止服务并迁移，但不重建未变化的版本', async () => {
    platform.probe.mockResolvedValue({
      occupied: true,
      pids: [123],
      health: health(),
    });
    platform.owned.mockResolvedValue(true);
    await launch('restart');
    expect(platform.stop).toHaveBeenCalledOnce();
    expect(platform.migrate).toHaveBeenCalledOnce();
    expect(platform.run).not.toHaveBeenCalled();
  });
  it('数据库读取失败不能仅凭健康接口误报就绪', async () => {
    platform.probe.mockResolvedValue({
      occupied: true,
      pids: [123],
      health: health(),
    });
    platform.owned.mockResolvedValue(true);
    platform.stateReady.mockResolvedValue(false);
    await launch();
    expect(platform.start).toHaveBeenCalledOnce();
    expect(platform.run).not.toHaveBeenCalled();
  });
  it('未受管理的旧版/开发服务要求手动停止，不终止它', async () => {
    platform.probe.mockResolvedValue({
      occupied: true,
      pids: [123],
      health: { ...health(), mode: 'development' },
    });
    await expect(launch()).rejects.toThrow('不是当前启动器管理');
    expect(platform.stop).not.toHaveBeenCalled();
  });
  it.each(['waitStopped', 'assertBuildIdle', 'migrate'] as const)(
    '%s 失败时不构建、不启动，并释放两把锁',
    async (operation) => {
      platform[operation].mockRejectedValue(new Error('fixture failure'));
      await expect(launch()).rejects.toThrow('fixture failure');
      expect(platform.run).not.toHaveBeenCalled();
      expect(platform.start).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, '.zhaopin-launch.lock'))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(dataDir, '.zhaopin-launch.lock'))).toBe(
        false,
      );
    },
  );
  it('构建失败不写成功指纹，不打开页面', async () => {
    markBuild();
    fs.writeFileSync(path.join(root, 'public/input.txt'), 'new');
    platform.run.mockRejectedValue(new Error('build failure'));
    await expect(launch()).rejects.toThrow('build failure');
    expect(readBuild(root)).toBeNull();
    expect(platform.start).not.toHaveBeenCalled();
    expect(platform.open).not.toHaveBeenCalled();
  });
  it('构建中源文件改变，不标记为成功', async () => {
    markBuild();
    await expect(
      buildProject(root, async () =>
        fs.writeFileSync(path.join(root, 'public/input.txt'), 'racing edit'),
      ),
    ).rejects.toThrow('源文件发生变化');
    expect(readBuild(root)).toBeNull();
  });
  it('损坏指纹或不匹配 BUILD_ID 不能复用', () => {
    markBuild();
    fs.writeFileSync(path.join(root, '.next/BUILD_ID'), 'other');
    expect(readBuild(root)).toBeNull();
  });
  it('启动就绪失败会停止自身服务，不打开错误版本', async () => {
    platform.waitReady.mockRejectedValue(new Error('bad version'));
    await expect(launch()).rejects.toThrow('bad version');
    expect(platform.stop).toHaveBeenCalledTimes(2);
    expect(platform.open).not.toHaveBeenCalled();
  });
  it('停止也受锁保护，保留数据库文件', async () => {
    fs.writeFileSync(path.join(dataDir, 'app.db'), 'untouched');
    await launch('stop');
    expect(platform.migrate).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dataDir, 'app.db'), 'utf8')).toBe(
      'untouched',
    );
  });
  it('两个并发启动串行，后一个复用第一个新进程', async () => {
    let running = false;
    platform.probe.mockImplementation(async () => ({
      occupied: running,
      pids: running ? [123] : [],
      health: running
        ? ({
            ...readBuild(root),
            appId: APP_ID,
            installationId: installationId(root, dataDir),
            mode: 'production',
          } as ReturnType<typeof health>)
        : null,
    }));
    platform.start.mockImplementation(async () => {
      running = true;
    });
    platform.owned.mockImplementation(async () => running);
    const results = await Promise.all([launch(), launch()]);
    expect(results.map((r) => r.reused)).toEqual([false, true]);
    expect(platform.run).toHaveBeenCalledOnce();
    expect(platform.start).toHaveBeenCalledOnce();
  });
  it('活动锁超时不删除他人锁；释放仅删除自身 token', async () => {
    const unlock = await acquireLock(root);
    await expect(acquireLock(root, { timeout: 5, poll: 2 })).rejects.toThrow(
      '尚未完成',
    );
    fs.writeFileSync(
      path.join(root, '.zhaopin-launch.lock'),
      JSON.stringify({ pid: process.pid, token: 'someone-else' }),
    );
    unlock();
    expect(fs.existsSync(path.join(root, '.zhaopin-launch.lock'))).toBe(true);
  });
  it('子构建仍活着时，不能回收已退出启动器的锁；全部退出后可回收', async () => {
    const exited = spawnSync(process.execPath, ['-e', '']).pid;
    const file = path.join(root, '.zhaopin-launch.lock');
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: exited,
        token: 'fixture',
        children: [process.pid],
      }),
    );
    await expect(acquireLock(root, { timeout: 5, poll: 2 })).rejects.toThrow(
      '尚未完成',
    );
    fs.writeFileSync(
      file,
      JSON.stringify({ pid: exited, token: 'fixture', children: [] }),
    );
    const unlock = await acquireLock(root, { timeout: 5, poll: 2 });
    const untrack = trackChildProcess(process.pid);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).children).toEqual([
      process.pid,
    ]);
    untrack();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).children).toEqual([]);
    unlock();
    expect(fs.existsSync(file)).toBe(false);
  });
  it('图形失败信息用 argv 传递，查看日志按钮打开准确路径', () => {
    const invoke = vi.fn((_file: string, _args: string[]) => ({
      stdout: '查看日志\n',
      stderr: '',
      pid: 0,
      output: [],
      status: 0,
      signal: null,
    }));
    showFailure('路径含"引号"与中文', '/tmp/zhaopin-test/launcher.log', {
      invoke,
    });
    expect(invoke.mock.calls[0][1].slice(-2)).toEqual([
      '路径含"引号"与中文',
      '/tmp/zhaopin-test/launcher.log',
    ]);
    expect(invoke.mock.calls[1]).toEqual([
      '/usr/bin/open',
      ['/tmp/zhaopin-test/launcher.log'],
    ]);
    if (process.platform === 'darwin') {
      const compiled = spawnSync(
        '/usr/bin/osacompile',
        ['-o', path.join(root, 'failure.scpt'), '-'],
        { input: invoke.mock.calls[0][1][1], encoding: 'utf8' },
      );
      expect(compiled.status, compiled.stderr).toBe(0);
    }
  });
  it.each(['3000', '99999', '3116.5'])('测试配置拒绝端口 %s', (port) => {
    expect(() =>
      configuration(root, {
        NODE_ENV: 'test',
        ZHAOPIN_LAUNCHER_TEST: '1',
        ZHAOPIN_INSTALL_HOME: root,
        ZHAOPIN_DATA_DIR: dataDir,
        ZHAOPIN_PORT: port,
      }),
    ).toThrow();
  });
});
