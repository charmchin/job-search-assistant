import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readBuild } from './build-tools.mjs';

// Real launchd/Next tests use a cloned checkout, a private test label and an empty
// database. No formal source, build, database, GUI, notifications or AI is used.
assert.equal(process.platform, 'darwin');
const input = process.env.ZHAOPIN_TEST_DATA_DIR;
assert.ok(input, '请指定全新 zhaopin- 临时目录');
const directory = fs.realpathSync(input);
assert.ok(
  [os.tmpdir(), '/tmp'].some((root) =>
    directory.startsWith(fs.realpathSync(root) + path.sep),
  ),
);
assert.ok(path.basename(directory).startsWith('zhaopin-'));
assert.equal(fs.readdirSync(directory).length, 0);
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3116);
assert.ok(Number.isInteger(port) && port >= 3100 && port <= 3199);
const check = http.createServer();
await new Promise((resolve, reject) =>
  check.once('error', reject).listen(port, '127.0.0.1', resolve),
);
await new Promise((resolve) => check.close(resolve));
const original = path.resolve(import.meta.dirname, '..');
const root = path.join(directory, 'zhaopin-project 中文');
const home = path.join(directory, 'zhaopin-home');
const dataDir = path.join(directory, 'zhaopin-data');
for (const name of [root, home, dataDir]) fs.mkdirSync(name);
const ignored = new Set([
  'node_modules',
  '.next',
  '.git',
  '.zhaopin-launch.lock',
]);
fs.cpSync(original, root, {
  recursive: true,
  mode: fs.constants.COPYFILE_FICLONE,
  filter: (file) =>
    file === original ||
    !ignored.has(path.relative(original, file).split(path.sep)[0]),
});
for (const name of ['node_modules', '.next'])
  fs.cpSync(path.join(original, name), path.join(root, name), {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });
const env = {
  ...process.env,
  ZHAOPIN_LAUNCHER_TEST: '1',
  ZHAOPIN_PORT: String(port),
  ZHAOPIN_DATA_DIR: dataDir,
  ZHAOPIN_INSTALL_HOME: home,
  ZHAOPIN_NO_OPEN: '1',
  ZHAOPIN_DISABLE_NOTIFICATIONS: '1',
  ZHAOPIN_DISABLE_FILE_OPERATIONS: '1',
  OPENAI_API_KEY: 'fake-test-key',
  OPENAI_MODEL: '',
};
const base = `http://127.0.0.1:${port}`;
let fake;
const run = (file, args = [], expected = 0) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (value) => {
      output += value;
    });
    child.stderr.on('data', (value) => {
      output += value;
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      fs.appendFileSync(path.join(directory, 'test-output.log'), output);
      if (code !== expected)
        reject(new Error(`期望退出 ${expected}，实际 ${code}\n${output}`));
      else resolve(output);
    });
  });
const launch = (args = [], expected = 0) =>
  run('/bin/zsh', [path.join(root, 'start.command'), ...args], expected);
const stop = () => run('/bin/zsh', [path.join(root, 'stop.command')]);
const health = async () => (await fetch(`${base}/api/health`)).json();
const backup = async () => (await fetch(`${base}/api/export`)).json();
const appEntry = path.join(
  home,
  'Applications/求职助手.app/Contents/MacOS/求职助手',
);
try {
  await launch();
  const first = await health();
  assert.equal(first.appId, 'com.local.zhaopin-assistant');
  assert.equal(first.fingerprint, readBuild(root).fingerprint);
  const originalData = (await backup()).data;
  assert.ok(Object.values(originalData).every((rows) => rows.length === 0));
  await Promise.all([launch(), launch(), launch()]);
  assert.equal((await health()).pid, first.pid);
  console.log('PASS 真正 launchd 启动；重复/并发启动复用同一 Next PID');

  fs.writeFileSync(
    path.join(root, 'public/zhaopin-launcher-fixture.txt'),
    'version-two',
  );
  fs.utimesSync(path.join(root, 'public/zhaopin-launcher-fixture.txt'), 0, 0);
  assert.equal(
    (await health()).fingerprint,
    first.fingerprint,
    '运行版本不得随磁盘修改而伪装更新',
  );
  await launch();
  const updated = await health();
  assert.notEqual(updated.pid, first.pid);
  assert.notEqual(updated.fingerprint, first.fingerprint);
  assert.equal(
    await (await fetch(`${base}/zhaopin-launcher-fixture.txt`)).text(),
    'version-two',
  );
  assert.deepEqual((await backup()).data, originalData);
  console.log(
    'PASS 旧版本运行期间内容变更（旧 mtime）触发停止、构建、迁移和重启；数据不变',
  );

  await run(process.execPath, [
    path.join(root, 'scripts/macos-app.mjs'),
    'install',
  ]);
  const newBundle = path.join(home, 'Applications/求职助手.app');
  const legacyBundle = path.join(home, 'Applications/求职工作台.app');
  // Reproduce a previously installed, valid old-name launcher in the private
  // test home, then run the actual installer twice. Never touch the user's app.
  fs.renameSync(newBundle, legacyBundle);
  fs.renameSync(
    path.join(legacyBundle, 'Contents/MacOS/求职助手'),
    path.join(legacyBundle, 'Contents/MacOS/求职工作台'),
  );
  const legacyPlist = path.join(legacyBundle, 'Contents/Info.plist');
  fs.writeFileSync(
    legacyPlist,
    fs.readFileSync(legacyPlist, 'utf8').replaceAll('求职助手', '求职工作台'),
  );
  for (let attempt = 0; attempt < 2; attempt++)
    await run(process.execPath, [
      path.join(root, 'scripts/macos-app.mjs'),
      'install',
    ]);
  assert.ok(!fs.existsSync(legacyBundle));
  assert.ok(fs.existsSync(appEntry));
  assert.match(
    fs.readFileSync(path.join(newBundle, 'Contents/Info.plist'), 'utf8'),
    /<key>CFBundleDisplayName<\/key><string>求职助手<\/string>/,
  );
  assert.deepEqual((await backup()).data, originalData);
  console.log(
    'PASS 旧名字 .app 原位迁移为求职助手；重复安装幂等、内部标识及数据不变',
  );
  await run('/bin/zsh', [appEntry]);
  assert.equal(
    (await health()).pid,
    updated.pid,
    '.app 不得绕过版本检查，也不重复创建进程',
  );
  fs.writeFileSync(
    path.join(root, 'public/zhaopin-launcher-fixture.txt'),
    'version-three',
  );
  await run('/bin/zsh', [appEntry]);
  const third = await health();
  assert.notEqual(third.fingerprint, updated.fingerprint);
  // Only terminate the verified Next child of this isolated test installation.
  assert.equal(third.appId, first.appId);
  assert.equal(third.installationId, first.installationId);
  process.kill(third.pid, 'SIGKILL');
  let recovered;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const value = await health();
      if (value.pid !== third.pid && value.fingerprint === third.fingerprint) {
        recovered = value;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(recovered, '异常退出必须经 launchd 恢复');
  console.log('PASS 安装式 Next 子进程异常退出后自动恢复，不误报正常关闭');
  assert.equal(
    await (await fetch(`${base}/zhaopin-launcher-fixture.txt`)).text(),
    'version-three',
  );
  await launch(['--restart']);
  const restarted = await health();
  assert.notEqual(restarted.pid, recovered.pid);
  assert.equal(restarted.buildId, third.buildId, '显式重启不应重建未变版本');
  console.log(
    'PASS 已生成 .app 入口执行真实更新；安装式 LaunchAgent 重启，不重复构建',
  );

  const buildFailureInput = path.join(
    root,
    'app/zhaopin-launcher-invalid/page.tsx',
  );
  fs.mkdirSync(path.dirname(buildFailureInput));
  fs.writeFileSync(buildFailureInput, 'export default function Broken( {');
  const output = await launch([], 1);
  assert.match(output, /执行失败|构建/);
  assert.equal(readBuild(root), null);
  await assert.rejects(fetch(`${base}/api/health`));
  assert.ok(!fs.existsSync(path.join(root, '.zhaopin-launch.lock')));
  fs.unlinkSync(buildFailureInput);
  fs.rmdirSync(path.dirname(buildFailureInput));
  await launch();
  assert.deepEqual((await backup()).data, originalData);
  console.log(
    'PASS 真实构建失败不启动损坏版本；锁释放，修正后可恢复，数据保持',
  );

  await stop();
  fake = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/api/state'
          ? { opportunities: [], tasks: [], settings: {} }
          : {},
      ),
    );
  });
  await new Promise((resolve) => fake.listen(port, '127.0.0.1', resolve));
  const conflict = await launch([], 1);
  assert.match(conflict, /其他程序占用/);
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
  console.log('PASS 其他程序伪装 state 200 不被误打开、停止或迁移');
  await new Promise((resolve) => fake.close(resolve));
  fake = undefined;
  await launch();
  await stop();
  const registered = spawnSync('/bin/launchctl', [
    'print',
    `gui/${process.getuid()}/com.local.zhaopin-assistant.test.${port}`,
  ]);
  assert.notEqual(registered.status, 0);
  console.log(`PASS 停止后服务退出，测试数据只在隔离目录；证据：${directory}`);
} finally {
  if (fake) await new Promise((resolve) => fake.close(resolve));
  // Never use broad/fixed production labels; stop via the cloned launcher's guarded test config.
  try {
    await stop();
  } catch (error) {
    console.error(error.message);
  }
}
