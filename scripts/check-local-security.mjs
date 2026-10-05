import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';

const directory = process.env.ZHAOPIN_TEST_DATA_DIR;
assert.ok(directory, '必须指定全新 ZHAOPIN_TEST_DATA_DIR');
const resolved = fs.realpathSync(directory);
assert.ok(
  [os.tmpdir(), '/tmp'].some((root) =>
    resolved.startsWith(`${fs.realpathSync(root)}${path.sep}`),
  ) && path.basename(resolved).startsWith('zhaopin-'),
);
assert.ok(!fs.existsSync(path.join(resolved, 'app.db')), '只允许全新临时库');
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3113),
  attackPort = port + 1;
assert.ok(Number.isInteger(port) && port >= 3100 && port < 3199);
const checker = http.createServer();
await new Promise((resolve, reject) =>
  checker.once('error', reject).listen(port, '127.0.0.1', resolve),
);
await new Promise((resolve) => checker.close(resolve));
const attacker = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><title>隔离的其他来源</title><p>只用于本机安全回归</p>',
  );
});
await new Promise((resolve, reject) =>
  attacker.once('error', reject).listen(attackPort, '127.0.0.1', resolve),
);
const mode = process.env.ZHAOPIN_TEST_SERVER_MODE || 'start';
assert.ok(['dev', 'start'].includes(mode));
const server = spawn(
  process.execPath,
  [
    'node_modules/next/dist/bin/next',
    mode,
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  {
    env: {
      ...process.env,
      ZHAOPIN_DATA_DIR: resolved,
      ZHAOPIN_DISABLE_NOTIFICATIONS: '1',
      ZHAOPIN_DISABLE_FILE_OPERATIONS: '1',
      OPENAI_API_KEY: 'fake-test-key',
      OPENAI_MODEL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let logs = '',
  browser,
  disk,
  original;
server.stdout.on('data', (chunk) => {
  logs = (logs + chunk).slice(-15000);
});
server.stderr.on('data', (chunk) => {
  logs = (logs + chunk).slice(-15000);
});
const base = `http://127.0.0.1:${port}`,
  other = `http://127.0.0.1:${attackPort}`;
const jsonHeaders = { 'Content-Type': 'application/json' };
// Node's fetch ignores a supplied Host header. Use raw HTTP so this test
// actually exercises the authority on the wire, not only the Origin check.
const rawRequest = (endpoint, method, headers, body) =>
  new Promise((resolve, reject) => {
    const input = http.request(
      `${base}/api/${endpoint}`,
      { method, headers },
      (output) => {
        const chunks = [];
        output.on('data', (chunk) => chunks.push(chunk));
        output.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), { status: output.statusCode }),
          ),
        );
      },
    );
    input.on('error', reject);
    input.end(body === undefined ? undefined : JSON.stringify(body));
  });
const request = async (endpoint, body, headers = jsonHeaders) =>
  fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
const exported = async () => {
  const response = await fetch(`${base}/api/export`);
  assert.equal(response.status, 200);
  return response.json();
};
const action = async (name, payload) => {
  const response = await request('action', { action: name, payload });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
};
try {
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try {
      ready = (await fetch(`${base}/api/state`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, logs);
  disk = new Database(path.join(resolved, 'app.db'), {
    readonly: true,
    fileMustExist: true,
  });
  original = await exported();
  assert.ok(Object.values(original.data).every((rows) => rows.length === 0));
  const backupFiles = () =>
    fs.existsSync(path.join(resolved, 'backups'))
      ? fs.readdirSync(path.join(resolved, 'backups'))
      : [];
  const blockedWrites = [
    [
      'action',
      {
        action: 'createOpportunity',
        payload: { organization: '恶意来源', role: '不得保存' },
      },
    ],
    [
      'action',
      {
        action: 'saveSettings',
        payload: {
          baseUrl: 'https://evil.invalid',
          model: 'evil',
          apiKey: 'must-not-save-to-keychain',
        },
      },
    ],
    ['import', original],
    [
      'capture',
      { text: '隔离招聘组织\n岗位：工程师\n任职要求：计算机相关专业' },
    ],
    ['files', { action: 'pick' }],
    ['reminders', { action: 'test' }],
  ];
  for (const headers of [
    {
      Origin: other,
      'Content-Type': 'text/plain',
      'Sec-Fetch-Site': 'same-site',
    },
    {
      Origin: 'https://audit-untrusted.example',
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'cross-site',
    },
    { Origin: 'null', 'Content-Type': 'application/json' },
    {
      Host: `evil.example:${port}`,
      Origin: `http://evil.example:${port}`,
      'Content-Type': 'application/json',
    },
    { 'Content-Type': 'application/jsonp' },
  ]) {
    for (const [endpoint, body] of blockedWrites) {
      const response = await rawRequest(endpoint, 'POST', headers, body);
      assert.equal(
        response.status,
        403,
        `${endpoint}: ${JSON.stringify(headers)}`,
      );
      assert.equal((await response.json()).code, 'LOCAL_REQUEST_BLOCKED');
    }
  }
  for (const endpoint of [
    'health',
    'state',
    'export?format=json',
    'export?format=csv',
    'reminders',
  ]) {
    assert.equal(
      (
        await fetch(`${base}/api/${endpoint}`, {
          headers: { Origin: other, 'Sec-Fetch-Site': 'same-site' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await rawRequest(endpoint, 'GET', { Host: `evil.example:${port}` }))
        .status,
      403,
    );
  }
  assert.deepEqual((await exported()).data, original.data);
  assert.deepEqual(backupFiles(), []);
  console.log(
    'PASS 所有读写接口统一拒绝恶意 Host/Origin、跨端口与伪装 JSON；数据库与备份目录无变更',
  );

  const safe = path.join(resolved, '中文简历.pdf'),
    disguised = path.join(resolved, '伪装文档.pdf');
  fs.writeFileSync(safe, '%PDF-1.4\nfixture', { mode: 0o600 });
  fs.writeFileSync(disguised, '#!/bin/sh\nexit 0', { mode: 0o600 });
  const material = async (name, filePath) =>
    (await action('createMaterial', { name, filePath })).id;
  const safeId = await material('普通中文简历', safe),
    unsafeId = await material('伪装文档', disguised);
  const missingId = await material(
    '缺失简历',
    path.join(resolved, 'missing.pdf'),
  );
  const open = (body) => request('files', { action: 'open', ...body });
  assert.equal((await open({ path: safe })).status, 400);
  assert.equal((await open({ materialId: safeId, path: safe })).status, 400);
  assert.equal((await open({ materialId: 'unregistered' })).status, 404);
  assert.equal((await open({ materialId: missingId })).status, 404);
  assert.equal((await open({ materialId: unsafeId })).status, 422);
  assert.equal(
    (await open({ materialId: safeId })).status,
    503,
    '普通文件到达显式禁用的系统操作边界',
  );
  console.log(
    'PASS 真实文件 API 只接受已登记材料 ID；缺失文件及伪装脚本明确拒绝；原生操作禁用',
  );

  browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    )
      ? { channel: 'chrome' }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const pageResponse = await page.goto(base);
  assert.equal(pageResponse.headers()['x-frame-options'], 'DENY');
  assert.equal(
    pageResponse.headers()['content-security-policy'],
    "frame-ancestors 'none'",
  );
  assert.equal(pageResponse.headers()['x-content-type-options'], 'nosniff');
  assert.equal(pageResponse.headers()['referrer-policy'], 'no-referrer');
  assert.equal(
    pageResponse.headers()['cross-origin-resource-policy'],
    'same-origin',
  );
  const sameOrigin = await page.evaluate(async () => {
    const saved = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'createOpportunity',
        payload: { organization: '同源正常岗位', role: '工程师' },
      }),
    });
    const draft = await fetch('/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '同源招聘组织\n岗位：研发工程师\n工作地点：上海\n任职要求：计算机专业硕士\n材料要求：简历',
      }),
    });
    return [
      saved.status,
      draft.status,
      (await fetch('/api/state')).status,
      (await fetch('/api/reminders')).status,
    ];
  });
  assert.deepEqual(sameOrigin, [200, 200, 200, 200]);
  await page.reload();
  await page.getByRole('button', { name: /^材料库/ }).click();
  let openRequests = 0;
  page.on('request', (input) => {
    if (
      input.url().endsWith('/api/files') &&
      input.postDataJSON()?.action === 'open'
    ) {
      openRequests++;
      assert.ok(input.postDataJSON().materialId);
      assert.ok(!Object.hasOwn(input.postDataJSON(), 'path'));
    }
  });
  const card = (name) =>
    page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByText(name, { exact: true }) });
  await page.route('**/api/files', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await card('伪装文档')
    .getByRole('button', { name: '打开文件', exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  const busyOpen = card('伪装文档').getByRole('button', {
    name: '正在打开…',
    exact: true,
  });
  await busyOpen.waitFor();
  assert.ok(await busyOpen.isDisabled());
  await card('伪装文档')
    .getByRole('alert')
    .filter({ hasText: '程序或脚本' })
    .waitFor();
  await page.unroute('**/api/files');
  assert.ok(
    await card('缺失简历')
      .getByRole('button', { name: '打开文件', exact: true })
      .isDisabled(),
  );
  await card('普通中文简历')
    .getByRole('button', { name: '打开文件', exact: true })
    .click();
  await card('普通中文简历')
    .getByRole('alert')
    .filter({ hasText: '禁用系统文件操作' })
    .waitFor();
  assert.equal(openRequests, 2);
  await page.screenshot({
    path: path.join(resolved, 'materials-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(resolved, 'materials-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '添加材料', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('选择或粘贴路径').fill(safe);
  await dialog.getByRole('button', { name: '选择', exact: true }).click();
  await dialog
    .getByRole('alert')
    .filter({ hasText: '禁用系统文件操作' })
    .waitFor();
  assert.equal(
    await dialog.getByPlaceholder('选择或粘贴路径').inputValue(),
    safe,
  );
  await page.route('**/api/files', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ canceled: true }),
    }),
  );
  await dialog.getByRole('button', { name: '选择', exact: true }).click();
  await dialog.getByRole('button', { name: '选择', exact: true }).waitFor();
  assert.equal(
    await dialog.getByPlaceholder('选择或粘贴路径').inputValue(),
    safe,
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.unroute('**/api/files');
  await page.getByRole('button', { name: '设置与数据', exact: true }).click();
  const download = async (name) => {
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: new RegExp(name) }).click(),
    ]);
    assert.equal(await file.failure(), null);
    return file.suggestedFilename();
  };
  assert.match(await download('导出完整 JSON'), /\.json$/);
  assert.match(await download('导出机会 CSV'), /\.csv$/);
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: path.join(resolved, 'security-desktop.png'),
    fullPage: true,
  });
  console.log(
    'PASS Chrome 正常同源保存/采集/读取/备份下载；材料错误可见、取消保留路径，无 JS 异常',
  );

  const baseline = (await exported()).data;
  const attackerPage = await browser.newPage();
  attackerPage.setDefaultTimeout(10000);
  // CORP intentionally hides no-cors responses from Playwright's page API.
  // CDP extra info records the real HTTP status, even when Chrome then blocks
  // access to the response body. This distinguishes server rejection from a
  // browser-only failure before any request reached the service.
  const network = await attackerPage.context().newCDPSession(attackerPage);
  await network.send('Network.enable');
  const wire = [];
  network.on('Network.responseReceivedExtraInfo', (event) =>
    wire.push(event.statusCode),
  );
  await attackerPage.goto(other);
  for (const [endpoint, body] of blockedWrites) {
    wire.length = 0;
    await attackerPage.evaluate(
      async ({ url, body }) => {
        await fetch(url, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(body),
        }).catch(() => {});
      },
      { url: `${base}/api/${endpoint}`, body },
    );
    // ExtraInfo can arrive after fetch has already rejected due to CORP.
    // Wait for the observed server response, without repeating the request.
    await expect
      .poll(() => wire.includes(403), {
        timeout: 5000,
        message: `等待服务端 403: ${endpoint}`,
      })
      .toBe(true);
    assert.ok(
      wire.includes(403),
      `没有观察到服务端 403: ${endpoint}; ${JSON.stringify(wire)}`,
    );
  }
  // page.goto is a direct user navigation (Fetch Site: none), intentionally
  // allowed. Trigger navigation from the other page to test its real source.
  const exportResponse = attackerPage.waitForResponse(
    (response) => response.url() === `${base}/api/export?format=json`,
  );
  await attackerPage.evaluate(
    (url) => location.assign(url),
    `${base}/api/export?format=json`,
  );
  const deniedExport = await exportResponse;
  assert.equal(deniedExport.status(), 403);
  assert.deepEqual((await exported()).data, baseline);
  assert.deepEqual(backupFiles(), []);
  console.log(
    'PASS Chrome 其他本地端口 no-cors/text/plain 实际请求全部 403，外部导航备份拒绝，数据库未改变',
  );
  const restored = await request('import', original);
  assert.equal(restored.status, 200);
  assert.deepEqual((await exported()).data, original.data);
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n,
    0,
  );
  console.log(
    'PASS 可信本机 CLI JSON 恢复可用；全部测试夹具已从临时库恢复清空',
  );
  if (process.env.ZHAOPIN_TEST_BACKUP_REGRESSION === '1') {
    const check = spawn(
      process.execPath,
      ['scripts/check-backup-restore.mjs'],
      {
        env: {
          ...process.env,
          ZHAOPIN_TEST_BASE_URL: base,
          ZHAOPIN_TEST_DATA_DIR: resolved,
        },
        stdio: 'inherit',
      },
    );
    const [code] = await once(check, 'exit');
    assert.equal(code, 0, '备份恢复回归失败');
    assert.deepEqual((await exported()).data, original.data);
  }
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (browser) await browser.close();
  if (disk) disk.close();
  await new Promise((resolve) => attacker.close(resolve));
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
}
