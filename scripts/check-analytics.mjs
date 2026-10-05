import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { chromium, expect } from '@playwright/test';

const directory = process.env.ZHAOPIN_TEST_DATA_DIR;
assert.ok(directory, '必须提供隔离测试目录');
const resolved = fs.realpathSync(directory);
assert.ok(
  resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) &&
    path.basename(resolved).startsWith('zhaopin-'),
);
assert.ok(!fs.existsSync(path.join(resolved, 'app.db')), '只允许新建临时库');
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3118);
assert.ok(Number.isInteger(port) && port >= 3100 && port <= 3199);
const checker = http.createServer();
await new Promise((resolve, reject) =>
  checker.once('error', reject).listen(port, '127.0.0.1', resolve),
);
await new Promise((resolve) => checker.close(resolve));
const base = `http://127.0.0.1:${port}`;
let server,
  browser,
  page,
  logs = '';
const stop = async () => {
  if (server && server.exitCode === null) {
    const ended = once(server, 'exit');
    server.kill('SIGTERM');
    await ended;
  }
};
const start = async () => {
  server = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      process.env.ZHAOPIN_TEST_SERVER_MODE || 'start',
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
        ZHAOPIN_DISABLE_KEYCHAIN: '1',
        OPENAI_API_KEY: 'fake-test-key',
        OPENAI_MODEL: '',
        OPENAI_BASE_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const stream of [server.stdout, server.stderr])
    stream.on('data', (chunk) => {
      logs = (logs + chunk).slice(-12000);
    });
  for (let attempt = 0; attempt < 180; attempt++) {
    if (server.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(`${base}/api/state`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`服务启动超时：${logs}`);
};
const state = async () => (await fetch(`${base}/api/state`)).json();
const action = async (action, payload) => {
  const response = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};
const create = async (organization, stage = 'evaluating') =>
  (
    await action('createOpportunity', {
      organization,
      role: '研发工程师',
      stage,
    })
  ).id;
const nav = (name) =>
  page.getByRole('button', { name, exact: false }).first().click();
const openOwner = async (organization) => {
  await nav('机会库');
  await page
    .getByRole('button')
    .filter({ hasText: organization })
    .first()
    .click();
};
const metricCount = async (stage, count) =>
  expect(
    page.getByTestId(`metric-${stage}`).getByTestId('metric-count'),
  ).toHaveText(String(count));
try {
  const legacy = new Database(path.join(resolved, 'app.db'));
  for (const name of fs
    .readdirSync('drizzle')
    .filter((name) => name.endsWith('.sql') && Number.parseInt(name, 10) < 5)
    .sort())
    legacy.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
  legacy.exec(
    "INSERT INTO opportunities (id,organization,role,stage,decision,created_at,updated_at,last_activity_at) VALUES ('legacy','旧库面试组织','研发岗','interview','pursue',1,2,3),('withdrawn','已放弃组织','研发岗','closed','skip',1,2,3)",
  );
  legacy.close();
  await start();
  let data = await state();
  assert.equal(
    data.opportunities.find((owner) => owner.id === 'legacy').stageHistory[0]
      .occurredAt,
    null,
  );
  assert.equal(
    data.opportunities.find((owner) => owner.id === 'withdrawn').closedReason,
    'withdrawn',
  );
  assert.equal(
    data.opportunities.find((owner) => owner.id === 'legacy').lastActivityAt,
    new Date(3).toISOString(),
  );
  const modern = await create('星河招聘');
  for (const stage of ['applied', 'interview', 'applied'])
    await action('updateOpportunity', { id: modern, stage });
  const rejected = await create('未通过招聘', 'applied');
  await action('updateOpportunity', {
    id: rejected,
    stage: 'closed',
    closedReason: 'rejected',
  });
  await create('中途 Offer 建档', 'offer');
  browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    )
      ? { channel: 'chrome' }
      : {}),
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'America/New_York',
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await nav('复盘');
  await metricCount('collection', 4);
  await metricCount('applied', 2);
  await metricCount('assessment', 0);
  await metricCount('interview', 2);
  await metricCount('offer', 1);
  await expect(page.getByTestId('metric-interview')).toContainText('50%');
  await expect(page.getByTestId('metric-offer')).toContainText('0%');
  await page
    .getByRole('combobox', { name: '统计范围', exact: true })
    .selectOption('all');
  await metricCount('collection', 5);
  await page
    .getByRole('combobox', { name: '统计范围', exact: true })
    .selectOption('active');
  await metricCount('collection', 4);
  console.log(
    'PASS 旧库快照、跳过笔试、阶段回退、失败保留、放弃过滤、交集转化率',
  );
  await openOwner('星河招聘');
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: '节点与记录', exact: false }).click();
  const panel = sheet.getByRole('region', { name: '阶段历史' });
  await expect(panel).toContainText('最高记录：面试');
  await panel.getByRole('button', { name: '补录经历', exact: true }).click();
  await panel
    .getByRole('combobox', { name: '补录阶段', exact: true })
    .selectOption('offer');
  await panel
    .getByRole('textbox', { name: '阶段经历说明', exact: true })
    .fill('补录测试记录');
  await panel
    .getByLabel('阶段发生时间', { exact: true })
    .fill('2099-01-01T09:00');
  await panel.getByRole('button', { name: '保存经历', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('未来');
  await expect(
    panel.getByRole('textbox', { name: '阶段经历说明' }),
  ).toHaveValue('补录测试记录');
  await panel
    .getByLabel('阶段发生时间', { exact: true })
    .fill('2025-09-01T09:00');
  await page.route('**/api/action', async (route) =>
    route.request().postDataJSON().action === 'addStageHistory'
      ? route.fulfill({ status: 503, json: { error: '模拟经历保存失败' } })
      : route.continue(),
  );
  await panel.getByRole('button', { name: '保存经历', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('模拟经历保存失败');
  await expect(panel.getByLabel('阶段发生时间', { exact: true })).toHaveValue(
    '2025-09-01T09:00',
  );
  await page.unroute('**/api/action');
  await panel.getByRole('button', { name: '保存经历', exact: true }).click();
  await expect(panel).toContainText('最高记录：Offer');
  data = await state();
  const owner = data.opportunities.find((owner) => owner.id === modern);
  assert.equal(owner.stage, 'applied');
  const event = owner.stageHistory.find((row) => row.toStage === 'offer');
  assert.equal(event.occurredAt, '2025-09-01T01:00:00.000Z');
  const record = panel.getByTestId(`stage-record-${event.id}`);
  await record
    .getByRole('button', { name: '作废Offer记录', exact: true })
    .click();
  await record.getByRole('button', { name: '保留记录', exact: true }).click();
  assert.equal(
    (await state()).opportunities
      .find((owner) => owner.id === modern)
      .stageHistory.find((row) => row.id === event.id).valid,
    true,
  );
  await record
    .getByRole('button', { name: '作废Offer记录', exact: true })
    .click();
  await expect(
    record.getByRole('button', { name: '确认作废记录' }),
  ).toBeDisabled();
  await record
    .getByRole('textbox', { name: '作废原因', exact: true })
    .fill('并非真实 Offer，误记作废');
  await record
    .getByRole('button', { name: '确认作废记录', exact: true })
    .click();
  await expect(record).toContainText('已作废');
  await expect(panel).toContainText('最高记录：面试');
  await sheet.screenshot({ path: path.join(resolved, 'history-desktop.png') });
  // Reopen at the target viewport instead of photographing a resized composited popup.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button')
    .filter({ hasText: '星河招聘' })
    .first()
    .click();
  await sheet.getByRole('button', { name: '记录', exact: true }).click();
  await expect(sheet).toHaveCount(1);
  await expect(
    sheet.getByRole('heading', { name: '研发工程师', exact: true }),
  ).toHaveCount(1);
  await expect(sheet.getByRole('region', { name: '阶段历史' })).toContainText(
    '最高记录：面试',
  );
  await page.screenshot({
    path: path.join(resolved, 'history-mobile.png'),
    animations: 'disabled',
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(
    'PASS 浏览器补录/失败保留/未来拒绝/上海时区/取消与作废，当前阶段保持不变',
  );
  await openOwner('未通过招聘');
  await sheet.getByRole('button', { name: '编辑', exact: true }).click();
  await sheet
    .getByRole('combobox', { name: '结束原因', exact: true })
    .selectOption('withdrawn');
  await sheet
    .getByRole('button', { name: '保存全部修改', exact: true })
    .click();
  await expect(sheet.getByText('主动放弃', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await nav('复盘');
  await metricCount('collection', 3);
  await metricCount('applied', 1);
  await metricCount('interview', 2);
  await expect(page.getByTestId('metric-interview')).toContainText('100%');
  await page.screenshot({ path: path.join(resolved, 'analytics-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(resolved, 'analytics-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const exported = async () =>
    (await fetch(`${base}/api/export?format=json`)).json();
  const saved = await exported();
  await action('deleteOpportunity', { id: modern });
  assert.ok(
    !(await exported()).data.stageHistory.some(
      (row) => row.opportunityId === modern,
    ),
  );
  const restored = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(saved),
  });
  assert.equal(restored.status, 200, JSON.stringify(await restored.json()));
  assert.deepEqual((await exported()).data, saved.data);
  const before = (await state()).opportunities;
  await stop();
  await start();
  assert.deepEqual((await state()).opportunities, before);
  await page.reload();
  await nav('复盘');
  await metricCount('collection', 3);
  await metricCount('offer', 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS 结束分类修改、删除级联、全部历史 JSON 往返与服务重启完整保留',
  );
} catch (error) {
  console.error(logs);
  if (page) {
    console.error(await page.locator('body').ariaSnapshot());
    await page.screenshot({
      path: path.join(resolved, 'analytics-failure.png'),
    });
  }
  throw error;
} finally {
  await browser?.close();
  await stop();
}
