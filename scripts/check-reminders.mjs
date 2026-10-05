import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const directory = process.env.ZHAOPIN_TEST_DATA_DIR;
assert.ok(directory, '必须指定全新 ZHAOPIN_TEST_DATA_DIR');
const resolved = fs.realpathSync(directory);
assert.ok(
  [os.tmpdir(), '/tmp'].some((root) =>
    resolved.startsWith(`${fs.realpathSync(root)}${path.sep}`),
  ) && path.basename(resolved).startsWith('zhaopin-'),
);
assert.ok(
  !fs.existsSync(path.join(resolved, 'app.db')),
  '只允许全新临时数据库',
);
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3111);
assert.ok(Number.isInteger(port) && port >= 3100 && port <= 3199);
const portCheck = http.createServer();
await new Promise((resolve, reject) =>
  portCheck.once('error', reject).listen(port, '127.0.0.1', resolve),
);
await new Promise((resolve) => portCheck.close(resolve));
const mode = process.env.ZHAOPIN_TEST_SERVER_MODE || 'dev';
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
      OPENAI_API_KEY: 'fake-test-key',
      OPENAI_MODEL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let logs = '';
server.stdout.on('data', (chunk) => {
  logs = (logs + chunk).slice(-12000);
});
server.stderr.on('data', (chunk) => {
  logs = (logs + chunk).slice(-12000);
});
const base = `http://127.0.0.1:${port}`;
let browser, disk;
async function action(action, payload, expected = 200) {
  const response = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
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
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n,
    0,
  );
  const opp = await action('createOpportunity', {
    organization: '提醒回归组织',
    role: '签约准备',
    stage: 'offer',
    decision: 'pursue',
    deadline: '2027-01-20T15:59:00Z',
    reminderDays: [3, 0, 3],
    nextAction: '核对签约材料',
    nextActionAt: '2027-01-18T02:00:00Z',
  });
  assert.equal(
    disk
      .prepare('SELECT reminder_days FROM opportunities WHERE id=?')
      .get(opp.id).reminder_days,
    '[3,0]',
  );
  await action('updateOpportunity', { id: opp.id, reminderDays: [-1] }, 400);
  const mile = await action('createMilestone', {
    opportunityId: opp.id,
    title: '签约',
    scheduledAt: '2027-01-20T06:00:00Z',
    reminderOffsets: [60, 30, 0],
  });
  await action('updateMilestone', {
    id: mile.id,
    reminderOffsets: [90, 0, 90],
  });
  await action('updateMilestone', { id: mile.id, reminderOffsets: [1.5] }, 400);
  await action(
    'updateMilestone',
    { id: mile.id, scheduledAt: '2027-02-30T10:00:00+08:00' },
    400,
  );
  await action(
    'updateMilestone',
    { id: 'nonexistent', reminderOffsets: [0] },
    404,
  );
  assert.equal(
    disk
      .prepare('SELECT reminder_offsets FROM milestones WHERE id=?')
      .get(mile.id).reminder_offsets,
    '[90,0]',
  );
  const actualStatus = await (await fetch(`${base}/api/reminders`)).json();
  assert.equal(actualStatus.mode, 'disabled');
  assert.equal(actualStatus.timeZone, 'Asia/Shanghai');
  const testResponse = await fetch(`${base}/api/reminders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: '{"action":"test"}',
  });
  assert.equal(testResponse.status, 400);
  assert.ok((await testResponse.json()).error.includes('禁用'));
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM reminder_deliveries').get().n,
    0,
  );
  console.log(
    'PASS 真实 API：截止/节点偏移校验、去重、编辑持久化；不存在节点拒绝；禁用通知不会误记送达',
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
    timezoneId: 'America/New_York',
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('button', { name: /机会库/ }).click();
  await page
    .getByRole('button')
    .filter({ hasText: '提醒回归组织' })
    .last()
    .click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(
    await sheet.getByLabel('截止时间', { exact: true }).inputValue(),
    '2027-01-20T23:59',
  );
  assert.equal(
    await sheet.getByLabel(/下一步时间/).inputValue(),
    '2027-01-18T10:00',
  );
  const days = sheet.getByRole('group', { name: '投递截止提醒', exact: true });
  await days.getByRole('button', { name: '关闭此项提醒', exact: true }).click();
  await days
    .getByRole('spinbutton', { name: '投递截止提醒自定义天数', exact: true })
    .fill('2');
  await days.getByRole('button', { name: '添加时间', exact: true }).click();
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/state')),
    sheet.getByRole('button', { name: '保存全部修改', exact: true }).click(),
  ]);
  assert.equal(
    disk
      .prepare('SELECT reminder_days FROM opportunities WHERE id=?')
      .get(opp.id).reminder_days,
    '[2]',
  );
  await sheet.getByRole('button', { name: '节点与记录', exact: true }).click();
  const card = sheet.getByTestId(`milestone-${mile.id}`);
  await card
    .getByRole('button', { name: '编辑节点 签约', exact: true })
    .click();
  assert.equal(
    await card.getByLabel('节点时间（上海时区）', { exact: true }).inputValue(),
    '2027-01-20T14:00',
  );
  await card
    .getByLabel('节点时间（上海时区）', { exact: true })
    .fill('2027-01-20T15:00');
  const offsets = card.getByRole('group', { name: '节点提醒', exact: true });
  await offsets
    .getByRole('button', { name: '关闭此项提醒', exact: true })
    .click();
  await offsets
    .getByRole('button', { name: '提前 1 小时', exact: true })
    .click();
  await offsets.getByRole('button', { name: '到点', exact: true }).click();
  await card
    .getByLabel('节点结果 / 注意事项', { exact: true })
    .fill('带身份证原件');
  let failedWrites = 0;
  await page.route('**/api/action', async (route) => {
    if (route.request().postDataJSON().action === 'updateMilestone') {
      failedWrites++;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({
        status: 503,
        json: { error: '模拟节点保存失败，稍后重试' },
      });
    } else await route.continue();
  });
  const saveNode = card.getByRole('button', { name: '保存节点', exact: true });
  await saveNode.click();
  assert.equal(await saveNode.isDisabled(), true);
  await saveNode.evaluate((element) => element.click());
  await card.getByText('模拟节点保存失败，稍后重试', { exact: true }).waitFor();
  assert.equal(failedWrites, 1);
  assert.equal(
    await card.getByLabel('节点结果 / 注意事项', { exact: true }).inputValue(),
    '带身份证原件',
  );
  await page.unroute('**/api/action');
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/state')),
    saveNode.click(),
  ]);
  const persisted = disk
    .prepare(
      'SELECT scheduled_at,reminder_offsets,result FROM milestones WHERE id=?',
    )
    .get(mile.id);
  assert.equal(
    new Date(persisted.scheduled_at).toISOString(),
    '2027-01-20T07:00:00.000Z',
  );
  assert.equal(persisted.reminder_offsets, '[60,0]');
  assert.equal(persisted.result, '带身份证原件');
  await card.getByRole('button', { name: '标记完成', exact: true }).click();
  await card
    .getByRole('button', { name: '已完成 · 恢复', exact: true })
    .waitFor();
  assert.equal(
    disk.prepare('SELECT status FROM milestones WHERE id=?').get(mile.id)
      .status,
    'done',
  );
  await card
    .getByRole('button', { name: '已完成 · 恢复', exact: true })
    .click();
  await card.getByRole('button', { name: '标记完成', exact: true }).waitFor();
  await sheet.getByLabel('新增节点名称', { exact: true }).fill('体检');
  await sheet
    .getByLabel('新增节点时间（上海时区）', { exact: true })
    .fill('2027-01-19T09:30');
  const newOffsets = sheet.getByRole('group', {
    name: '新节点提醒',
    exact: true,
  });
  await newOffsets
    .getByRole('button', { name: '关闭此项提醒', exact: true })
    .click();
  await newOffsets
    .getByRole('button', { name: '提前 30 分钟', exact: true })
    .click();
  await sheet.getByRole('button', { name: '添加', exact: true }).click();
  await sheet
    .getByRole('button', { name: '编辑节点 体检', exact: true })
    .waitFor();
  const exam = disk
    .prepare(
      'SELECT scheduled_at,reminder_offsets FROM milestones WHERE title=?',
    )
    .get('体检');
  assert.equal(exam.reminder_offsets, '[30]');
  assert.equal(
    new Date(exam.scheduled_at).toISOString(),
    '2027-01-19T01:30:00.000Z',
  );
  await page.screenshot({
    path: path.join(resolved, 'reminder-nodes-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(resolved, 'reminder-nodes-mobile.png'),
  });
  assert.ok(
    await sheet.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  );
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('button', { name: /机会库/ }).click();
  await page
    .getByRole('button')
    .filter({ hasText: '提醒回归组织' })
    .last()
    .click();
  await sheet.getByRole('button', { name: '节点与记录', exact: true }).click();
  await sheet.getByText('带身份证原件', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /时间线/ }).click();
  const examEvent = page.getByRole('button').filter({ hasText: '体检' });
  await examEvent.waitFor();
  assert.equal(await examEvent.locator('p').first().innerText(), '19');
  console.log(
    'PASS Chrome：纽约浏览器仍按上海时间编辑，截止/节点配置保存与刷新保留；节点失败可重试、重复点击受抑制，窄屏无横向溢出',
  );

  await page.getByRole('button', { name: '设置与数据', exact: true }).click();
  await page.getByText('当前环境已禁用系统通知', { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: '发送测试通知', exact: true })
      .isDisabled(),
    true,
  );
  let uiTests = 0;
  // Simulated UI results only; the actual server remains notification-disabled.
  const available = {
    ...actualStatus,
    mode: 'available',
    lastCheckedAt: new Date().toISOString(),
  };
  await page.route('**/api/reminders', async (route) => {
    if (route.request().method() === 'GET')
      await route.fulfill({ json: available });
    else {
      uiTests++;
      await new Promise((resolve) => setTimeout(resolve, 200));
      await route.fulfill(
        uiTests === 1
          ? {
              status: 400,
              json: { error: '模拟测试通知提交失败', status: available },
            }
          : {
              json: {
                submitted: true,
                message: '模拟测试已交给系统，不代表通知已实际显示。',
                status: available,
              },
            },
      );
    }
  });
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await page
    .getByText('通知通道可用 · 是否显示由 macOS 决定', { exact: true })
    .waitFor();
  const testButton = page.getByRole('button', {
    name: '发送测试通知',
    exact: true,
  });
  await testButton.click();
  await page.getByText('模拟测试通知提交失败', { exact: true }).waitFor();
  await testButton.click();
  await page
    .getByText('模拟测试已交给系统，不代表通知已实际显示。', { exact: true })
    .waitFor();
  assert.equal(uiTests, 2);
  await page.screenshot({
    path: path.join(resolved, 'reminder-settings-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(resolved, 'reminder-settings-mobile.png'),
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM reminder_deliveries').get().n,
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS 提醒状态真实可读；测试通知的成功/失败文案采用浏览器模拟验证，未发送实际通知；桌面和窄屏截图已保存',
  );
  const regression = spawn(
    process.execPath,
    ['scripts/check-opportunity-isolation.mjs'],
    { env: { ...process.env, ZHAOPIN_TEST_BASE_URL: base }, stdio: 'inherit' },
  );
  const [exitCode] = await once(regression, 'exit');
  assert.equal(exitCode, 0);
  console.log(`PASS 第 1 项详情隔离回归仍通过；截图位于 ${resolved}`);
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) {
    console.error(
      await failedPage
        .getByRole('dialog')
        .ariaSnapshot()
        .catch(() => '没有打开的详情'),
    );
    await failedPage.screenshot({
      path: path.join(resolved, 'reminder-failure.png'),
    });
  }
  throw error;
} finally {
  if (browser) await browser.close();
  try {
    if (disk)
      for (const row of disk.prepare('SELECT id FROM opportunities').all())
        await action('deleteOpportunity', { id: row.id });
  } finally {
    disk?.close();
    if (server.exitCode === null) {
      const ended = once(server, 'exit');
      server.kill('SIGTERM');
      await ended;
    }
  }
}
