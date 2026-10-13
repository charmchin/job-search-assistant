import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');
const { testEnvironment } = await import(
  path.join(root, 'scripts/test-sandbox.mjs')
);
const supplied = process.env.ZHAOPIN_TEST_DATA_DIR;
assert.ok(supplied, '必须提供全新测试目录');
const directory = fs.realpathSync(supplied);
assert.ok(
  directory.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) &&
    path.basename(directory).startsWith('zhaopin-'),
);
assert.ok(
  !fs.existsSync(path.join(directory, 'app.db')),
  '只允许全新临时数据库',
);
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3114);
assert.ok(Number.isInteger(port) && port >= 3100 && port <= 3199);
const mode = process.env.ZHAOPIN_TEST_SERVER_MODE || 'start';
assert.ok(['start', 'dev'].includes(mode));
const probe = http.createServer();
await new Promise((resolve, reject) =>
  probe.once('error', reject).listen(port, '127.0.0.1', resolve),
);
await new Promise((resolve) => probe.close(resolve));
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
    cwd: root,
    env: {
      ...process.env,
      ...testEnvironment(directory),
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let logs = '',
  browser,
  page;
for (const stream of [server.stdout, server.stderr])
  stream.on('data', (chunk) => {
    logs = (logs + chunk).slice(-12000);
  });
const base = `http://127.0.0.1:${port}`;
const errors = [];
async function action(action, payload) {
  const response = await fetch(base + '/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function owner(id) {
  return (await (await fetch(base + '/api/state')).json()).opportunities.find(
    (o) => o.id === id,
  );
}
try {
  for (let n = 0; n < 150; n++) {
    if (server.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(base + '/api/health')).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stages = [
    ['evaluating', '待评估'],
    ['preparing', '准备中'],
    ['applied', '已投递'],
    ['assessment', '测评/笔试'],
    ['interview', '面试'],
    ['waiting', '结果待定'],
    ['offer', 'Offer'],
    ['closed', '未通过/放弃'],
  ];
  for (const [stage, label] of stages)
    await action('createOpportunity', {
      organization: '阶段展示-' + label,
      role: '环境工程师',
      stage,
      location: '上海',
    });
  const quick = await action('createOpportunity', {
    organization: '上海建科环境技术有限公司',
    role: '土壤调查工程师',
    stage: 'preparing',
    location: '上海市徐汇区宛平南路75号',
    notes: '今天已经完成岗位申请',
    nextAction: '准备并投递简历',
    tasks: [
      { title: '准备并投递简历' },
      { title: '确认渠道，完成网申或邮件投递' },
      { title: '准备面试案例' },
    ],
    deadline: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  const record = await action('createOpportunity', {
    organization: '上海中远海运环境科技股份有限公司',
    role: '助理双碳研发工程师',
    location: '上海',
  });
  const notes = await action('createOpportunity', {
    organization: '上海天伟生物制药有限公司',
    role: 'EHS专员（安全方向）',
    stage: 'preparing',
    location: '上海',
  });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page
    .getByRole('button', { name: '机会库', exact: false })
    .first()
    .click();
  const card = (name) => page.getByRole('article').filter({ hasText: name });
  for (const [, label] of stages)
    await expect(
      card('阶段展示-' + label).getByText(label, { exact: true }),
    ).toBeVisible();
  await expect(
    card('上海建科').getByText('今天已经完成岗位申请', { exact: true }),
  ).toBeVisible();
  const progressDialog = page.getByRole('dialog');
  const shanghaiInput = (date) =>
    new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16);
  await card('上海建科')
    .getByRole('button', { name: '记录投递', exact: true })
    .click();
  await progressDialog
    .getByRole('button', { name: '昨天', exact: true })
    .click();
  const actualInput = await progressDialog
    .getByLabel('实际投递时间（上海）', { exact: true })
    .inputValue();
  const actualIso = new Date(actualInput + ':00+08:00').toISOString();
  assert.equal(
    actualInput.slice(0, 10),
    shanghaiInput(new Date(Date.now() - 86400000)).slice(0, 10),
  );
  await progressDialog.getByLabel('准备并投递简历', { exact: true }).check();
  await progressDialog.getByLabel('安排下一步', { exact: true }).check();
  await progressDialog
    .getByLabel('下一步内容', { exact: true })
    .fill('跟进投递反馈');
  await progressDialog
    .getByLabel('跟进时间（上海，可留空）', { exact: true })
    .fill(shanghaiInput(new Date(Date.now() + 2 * 86400000)));
  await page.screenshot({
    path: path.join(directory, 'progress-application-dialog.png'),
  });
  // Failed requests keep all inputs and selections for a safe retry.
  await page.route('**/api/action', (route) =>
    route.request().postDataJSON().action === 'recordProgress'
      ? route.fulfill({ status: 503, json: { error: '模拟保存失败' } })
      : route.continue(),
  );
  await progressDialog
    .getByRole('button', { name: '保存并完成 1 项任务', exact: true })
    .click();
  await expect(progressDialog.getByRole('alert')).toContainText('模拟保存失败');
  await expect(
    progressDialog.getByLabel('准备并投递简历', { exact: true }),
  ).toBeChecked();
  await expect(
    progressDialog.getByLabel('实际投递时间（上海）', { exact: true }),
  ).toHaveValue(actualInput);
  assert.equal((await owner(quick.id)).stage, 'preparing');
  await page.unroute('**/api/action');
  await progressDialog
    .getByRole('button', { name: '保存并完成 1 项任务', exact: true })
    .click();
  await expect(progressDialog).toHaveCount(0);
  await expect(
    card('上海建科').getByText('已投递', { exact: true }),
  ).toBeVisible();
  let updated = await owner(quick.id);
  assert.equal(
    updated.stageHistory.find((h) => h.toStage === 'applied').occurredAt,
    actualIso,
  );
  assert.equal(updated.nextAction, '跟进投递反馈');
  assert.equal(
    updated.tasks.find((t) => t.title === '准备面试案例').status,
    'todo',
  );
  assert.equal(
    updated.tasks.find((t) => t.title === '确认渠道，完成网申或邮件投递')
      .status,
    'todo',
  );
  await card('上海建科')
    .getByRole('button', { name: '核对投递任务（1）', exact: true })
    .click();
  await progressDialog
    .getByRole('button', { name: '全选', exact: true })
    .click();
  await progressDialog
    .getByRole('button', { name: '保存并完成 1 项任务', exact: true })
    .click();
  await expect(progressDialog).toHaveCount(0);
  updated = await owner(quick.id);
  assert.equal(
    updated.tasks.find((t) => t.title === '确认渠道，完成网申或邮件投递')
      .status,
    'done',
  );
  assert.equal(updated.nextAction, '跟进投递反馈');

  const dialog = page.getByRole('dialog');
  await card('上海中远').getByRole('button').first().click();
  await dialog.getByRole('button', { name: '节点与记录', exact: true }).click();
  await dialog
    .getByLabel('推进记录内容', { exact: true })
    .fill('我今天已经投递了');
  await expect(
    dialog.getByRole('button', { name: '同时标记为已投递', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '记录', exact: true }).click();
  await expect(
    dialog.getByRole('status').filter({ hasText: '已保存。' }),
  ).toBeVisible();
  assert.equal((await owner(record.id)).stage, 'evaluating');
  await page.keyboard.press('Escape');
  await expect(
    card('上海中远').getByText('我今天已经投递了', { exact: true }),
  ).toBeVisible();
  await card('上海中远').getByRole('button').first().click();
  await dialog.getByRole('button', { name: '节点与记录', exact: true }).click();
  await dialog
    .getByLabel('推进记录内容', { exact: true })
    .fill('已投递，等待HR反馈');
  await dialog
    .getByRole('button', { name: '同时标记为已投递', exact: true })
    .click();
  await expect(
    dialog.getByLabel('记录时同步阶段', { exact: true }),
  ).toHaveValue('applied');
  await dialog.getByRole('button', { name: '记录', exact: true }).click();
  await expect(
    dialog.getByText('已投递', { exact: true }).first(),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    card('上海中远').getByText('已投递，等待HR反馈', { exact: true }),
  ).toBeVisible();

  await card('上海天伟').getByRole('button').first().click();
  await dialog.getByRole('button', { name: '岗位原文', exact: true }).click();
  await dialog
    .getByLabel('个人备注', { exact: true })
    .fill('已投递，简历突出了安全工程专业背景');
  await dialog
    .getByRole('button', { name: '同时标记为已投递', exact: true })
    .click();
  await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
  await expect(
    dialog.getByText('已投递', { exact: true }).first(),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    card('上海天伟').getByText('已投递，简历突出了安全工程专业背景', {
      exact: true,
    }),
  ).toBeVisible();
  assert.equal((await owner(notes.id)).stage, 'applied');
  await page.reload();
  await page
    .getByRole('button', { name: '机会库', exact: false })
    .first()
    .click();
  for (const name of ['上海建科', '上海中远', '上海天伟'])
    await expect(card(name).getByText('已投递', { exact: true })).toBeVisible();
  await card('上海建科')
    .getByRole('button', { name: '记录进展', exact: true })
    .click();
  await progressDialog
    .getByLabel('本次进展', { exact: true })
    .selectOption('interview');
  await progressDialog.getByLabel('同时安排招聘节点', { exact: true }).check();
  await progressDialog.getByLabel('节点名称', { exact: true }).fill('技术一面');
  const interviewTime = shanghaiInput(new Date(Date.now() + 3 * 86400000));
  await progressDialog
    .getByLabel('节点时间（上海）', { exact: true })
    .fill(interviewTime);
  await progressDialog
    .getByRole('button', { name: '保存进展', exact: true })
    .click();
  await expect(progressDialog).toHaveCount(0);
  await expect(
    card('上海建科').getByText('面试', { exact: true }),
  ).toBeVisible();
  assert.equal(
    (await owner(quick.id)).milestones.find((m) => m.title === '技术一面')
      .scheduledAt,
    new Date(interviewTime + ':00+08:00').toISOString(),
  );
  await card('上海中远')
    .getByRole('button', { name: '安排跟进', exact: true })
    .click();
  await progressDialog
    .getByLabel('下一步内容', { exact: true })
    .fill('跟进HR反馈');
  await progressDialog
    .getByRole('button', { name: '保存进展', exact: true })
    .click();
  await expect(progressDialog).toHaveCount(0);
  await expect(
    card('上海中远').getByText('跟进HR反馈', { exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder('搜索公司、岗位、方向或标签').fill('上海');
  await page.screenshot({
    path: path.join(directory, 'opportunity-progress-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    card('上海中远').getByText('已投递', { exact: true }),
  ).toBeVisible();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    '移动端不能出现横向溢出',
  );
  await page.screenshot({
    path: path.join(directory, 'opportunity-progress-mobile.png'),
    fullPage: true,
  });
  await card('上海中远')
    .getByRole('button', { name: '安排跟进', exact: true })
    .click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await expect(
    progressDialog.getByRole('button', { name: '保存进展', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(directory, 'progress-dialog-mobile.png'),
  });
  await progressDialog
    .getByRole('button', { name: '取消', exact: true })
    .click();
  assert.deepEqual(errors, []);
  console.log(
    '通过：8种状态、补记投递日期、选定任务批量完成、失败重试、安排跟进与面试节点、备注同步、刷新保留、手机布局。',
  );
} catch (error) {
  console.error(logs);
  if (page) {
    console.error((await page.locator('body').ariaSnapshot()).slice(-7000));
    await page.screenshot({
      path: path.join(directory, 'opportunity-progress-failure.png'),
      fullPage: true,
    });
  }
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const done = once(server, 'exit');
    server.kill('SIGTERM');
    await done;
  }
}
