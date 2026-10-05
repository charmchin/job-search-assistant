import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, inject, it, vi } from 'vitest';
import { databasePath, sqlite } from './db';
import { readApiKey, saveApiKey } from './secrets';
import {
  createTestRun,
  cleanupTestRun,
  validateTestRun,
  runTestProcess,
  testEnvironment,
  cloneTestProject,
} from '../scripts/test-sandbox.mjs';

afterAll(() => sqlite.close());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('默认测试隔离与安全边界', () => {
  it('macOS 已退出且无活动成员的进程组不因 EPERM 误报失败', async () => {
    if (process.platform !== 'darwin') return;
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 'SIGTERM')
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    await expect(
      runTestProcess(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: process.cwd(),
        env: process.env,
        timeout: 5000,
      }),
    ).resolves.toBe('');
  });
  it('macOS 仍有活动子进程时不能吞掉进程组权限失败', async () => {
    if (process.platform !== 'darwin') return;
    const kill = process.kill.bind(process);
    let cleanupError: unknown;
    let group = 0,
      member = 0;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 'SIGTERM') {
        group = pid;
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      return kill(pid, signal);
    });
    try {
      await expect(
        runTestProcess(
          process.execPath,
          [
            '-e',
            'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(child.pid);process.exit(0)',
          ],
          {
            cwd: process.cwd(),
            env: process.env,
            timeout: 5000,
            log: (value: string) => {
              member = Number(value.trim());
            },
          },
        ),
      ).rejects.toThrow('kill EPERM');
    } finally {
      if (group) {
        try {
          kill(group, 'SIGKILL');
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (cleanupError) expect(cleanupError).toMatchObject({ code: 'ESRCH' });
    expect(member).toBeGreaterThan(1);
    await vi.waitFor(() => expect(() => kill(member, 0)).toThrow(), {
      timeout: 2000,
    });
  });
  it('导入业务模块前已选择独立临时库，能写入但不接触正式库', () => {
    const run = inject('zhaopinUnitRun');
    expect(fs.realpathSync(path.dirname(databasePath))).toMatch(
      `${run.root}${path.sep}database-`,
    );
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM opportunities').get(),
    ).toEqual({ n: 0 });
    const check = sqlite.transaction(() => {
      sqlite
        .prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)')
        .run('isolation.fixture', 'only in temporary DB', 0);
      expect(
        sqlite
          .prepare('SELECT value FROM settings WHERE key=?')
          .get('isolation.fixture'),
      ).toEqual({ value: 'only in temporary DB' });
      throw new Error('fixture rollback');
    });
    expect(check).toThrow('fixture rollback');
    expect(sqlite.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({
      n: 0,
    });
  });
  it('缺少隔离上下文时数据库初始化失败，不回退到真实目录', async () => {
    vi.stubEnv('ZHAOPIN_UNIT_RUN_ROOT', '');
    vi.resetModules();
    await expect(import('./db')).rejects.toThrow('测试数据库未隔离');
  });
  it('默认关闭通知、文件及钥匙串，真实模型和密钥被覆盖', async () => {
    for (const key of [
      'ZHAOPIN_DISABLE_NOTIFICATIONS',
      'ZHAOPIN_DISABLE_FILE_OPERATIONS',
      'ZHAOPIN_DISABLE_KEYCHAIN',
    ])
      expect(process.env[key]).toBe('1');
    expect(process.env.OPENAI_MODEL).toBe('');
    expect(await readApiKey()).toBe('fake-test-key');
    await expect(saveApiKey('never-write')).rejects.toThrow('禁用钥匙串');
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(await readApiKey()).toBe('');
  });
  it('未模拟的 fetch 默认拒绝，显式模拟后恢复到安全基线', async () => {
    await expect(fetch('https://provider.invalid')).rejects.toThrow(
      '禁止未模拟',
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('mock')));
    expect(await (await fetch('https://provider.invalid')).text()).toBe('mock');
    vi.unstubAllGlobals();
    await expect(fetch('https://provider.invalid')).rejects.toThrow(
      '禁止未模拟',
    );
  });
  it('清理只接受自身临时根和正确 token，错误凭证不删除', () => {
    const run = createTestRun('unit');
    expect(() => cleanupTestRun({ ...run, token: 'wrong' })).toThrow('所有权');
    expect(fs.existsSync(run.root)).toBe(true);
    validateTestRun(run);
    cleanupTestRun(run);
    expect(fs.existsSync(run.root)).toBe(false);
  });
  it.each([null, {}, { root: '/', kind: 'unit', token: 'x' }])(
    '拒绝无效或广泛清理目标（%#）',
    (run) => {
      expect(() => validateTestRun(run)).toThrow();
    },
  );
  it('独立进程失败和超时可见，不被标为成功', async () => {
    await expect(
      runTestProcess(process.execPath, ['-e', 'process.exit(2)'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...testEnvironment(process.env.ZHAOPIN_DATA_DIR!),
        },
        timeout: 5000,
      }),
    ).rejects.toThrow('退出 2');
    await expect(
      runTestProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd: process.cwd(),
        env: process.env,
        timeout: 100,
      }),
    ).rejects.toThrow('超时');
  });
  it('已取消的进程不启动', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runTestProcess(process.execPath, ['-e', 'throw Error("must not run")'], {
        cwd: process.cwd(),
        env: process.env,
        signal: controller.signal,
      }),
    ).rejects.toThrow('已取消');
  });
  it('项目副本不包含 .env、共享构建、数据库或日志', () => {
    const run = createTestRun('e2e');
    try {
      const source = path.join(run.root, 'source');
      fs.mkdirSync(path.join(source, 'app'), { recursive: true });
      fs.mkdirSync(path.join(source, '.next'));
      fs.writeFileSync(path.join(source, 'app/page.tsx'), 'fixture code');
      for (const name of ['.env.local', 'app.db', 'server.log'])
        fs.writeFileSync(path.join(source, name), 'must not copy');
      const project = cloneTestProject(source, run);
      expect(fs.readFileSync(path.join(project, 'app/page.tsx'), 'utf8')).toBe(
        'fixture code',
      );
      for (const name of ['.env.local', 'app.db', 'server.log', '.next'])
        expect(fs.existsSync(path.join(project, name))).toBe(false);
    } finally {
      cleanupTestRun(run);
    }
  });
  it('运行中取消会终止自身进程及其子进程', async () => {
    const controller = new AbortController();
    let childPid = 0;
    await expect(
      runTestProcess(
        process.execPath,
        [
          '-e',
          'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(child.pid);setInterval(()=>{},1000)',
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          timeout: 5000,
          signal: controller.signal,
          log: (value: string) => {
            childPid = Number(value.trim());
            controller.abort();
          },
        },
      ),
    ).rejects.toThrow('已取消');
    expect(childPid).toBeGreaterThan(1);
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), {
      timeout: 2000,
    });
  });
});
