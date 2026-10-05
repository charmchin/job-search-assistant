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
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3117);
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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (chunk) => {
    logs = (logs + chunk).slice(-12000);
  });
  server.stderr.on('data', (chunk) => {
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
const state = async () => (await fetch(`${base}/api/state`)).json();
try {
  // Exercise direct startup of a previous-version DB, not only fresh installations.
  const legacy = new Database(path.join(resolved, 'app.db'));
  for (const name of fs
    .readdirSync('drizzle')
    .filter((n) => n.endsWith('.sql') && Number.parseInt(n, 10) < 4)
    .sort())
    legacy.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
  legacy.exec(
    "INSERT INTO opportunities (id,organization,role,next_action,created_at,updated_at,last_activity_at) VALUES ('legacy','旧数据组织','研发岗','保留旧计划',1,2,3)",
  );
  legacy.exec(
    "INSERT INTO tasks (id,opportunity_id,title,created_at,updated_at) VALUES ('legacy-task','legacy','保留旧计划',1,2)",
  );
  legacy.close();
  await start();
  let data = await state();
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].isNextAction, true);
  assert.equal(data.opportunities[0].lastActivityAt, new Date(3).toISOString());
  console.log('PASS 真实旧库直接启动：旧计划复用原任务，无重复、不改推进时间');
  const dueAt = new Date(Date.now() + 3600000).toISOString();
  const id = (
    await action('createOpportunity', {
      organization: '星河科技',
      role: '算法研发工程师',
      decision: 'pursue',
      priority: 'high',
      nextAction: '确认简历定稿',
      nextActionAt: dueAt,
      tasks: [{ title: '确认简历定稿', dueAt }, { title: '准备一面作品集' }],
    })
  ).id;
  const filename = path.join(resolved, 'resume-v1.txt');
  fs.writeFileSync(filename, '简历内容，测试只引用不删除');
  const mat = (
    await action('createMaterial', {
      name: '算法岗中文简历',
      filePath: filename,
      version: 'v1',
      category: '简历',
    })
  ).id;
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
  const focus = page.getByTestId('today-focus');
  await expect(
    focus.getByRole('heading', { name: '确认简历定稿', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId('today-queue').getByText('确认简历定稿', { exact: true }),
  ).toHaveCount(1);
  await focus.getByRole('button', { name: '完成这一步', exact: true }).click();
  await expect(
    focus.getByRole('heading', { name: '确认简历定稿', exact: true }),
  ).toHaveCount(0);
  data = await state();
  assert.equal(data.opportunities.find((o) => o.id === id).nextAction, '');
  assert.equal(data.tasks.filter((t) => t.opportunityId === id).length, 2);
  // Select existing task instead of making the user type its title again.
  await page
    .getByRole('button', { name: '机会库', exact: false })
    .first()
    .click();
  await page
    .getByRole('button')
    .filter({ hasText: '星河科技' })
    .first()
    .click();
  const sheet = page.getByRole('dialog');
  await sheet
    .getByRole('button', { name: '设为下一步 准备一面作品集', exact: true })
    .click();
  await expect(
    sheet.getByRole('heading', { name: '准备一面作品集', exact: true }),
  ).toBeVisible();
  await sheet
    .getByRole('button', { name: '跳过任务 准备一面作品集', exact: true })
    .click();
  await expect(
    sheet.getByRole('button', { name: '完成下一步', exact: true }),
  ).toHaveCount(0);
  console.log(
    'PASS 浏览器下一步闭环：今日不重复、完成清除镜像、已有任务可设为重点/跳过',
  );
  // Requirement creation failure preserves input; success stores notes and links.
  await sheet
    .getByRole('textbox', { name: '新增材料要求名称', exact: true })
    .fill('盖章中文简历');
  await sheet
    .getByRole('textbox', { name: '新增材料要求说明', exact: true })
    .fill('PDF 格式，文件名包含姓名');
  await page.route('**/api/action', async (route) => {
    if (route.request().postDataJSON().action === 'createRequirement')
      await route.fulfill({ status: 503, json: { error: '模拟要求保存失败' } });
    else await route.continue();
  });
  await sheet.getByRole('button', { name: '添加要求', exact: true }).click();
  await expect(
    sheet.getByRole('alert').filter({ hasText: '模拟要求保存失败' }),
  ).toBeVisible();
  await expect(
    sheet.getByRole('textbox', { name: '新增材料要求名称', exact: true }),
  ).toHaveValue('盖章中文简历');
  await page.unroute('**/api/action');
  await sheet.getByRole('button', { name: '添加要求', exact: true }).click();
  await expect(
    sheet.getByRole('combobox', { name: '关联材料 盖章中文简历', exact: true }),
  ).toBeVisible();
  await sheet
    .getByRole('combobox', { name: '关联材料 盖章中文简历', exact: true })
    .selectOption(mat);
  await sheet
    .getByRole('button', { name: '保存关联 盖章中文简历', exact: true })
    .click();
  await sheet
    .getByRole('button', { name: '材料标记就绪 盖章中文简历', exact: true })
    .click();
  await expect(
    sheet.getByRole('button', {
      name: '材料重新待准备 盖章中文简历',
      exact: true,
    }),
  ).toBeVisible();
  await sheet
    .getByRole('button', { name: '编辑要求 盖章中文简历', exact: true })
    .click();
  await sheet
    .getByRole('textbox', { name: '要求名称', exact: true })
    .fill('提交中文简历');
  await sheet
    .getByRole('textbox', { name: '要求说明', exact: true })
    .fill('PDF，最终版');
  await sheet.getByRole('button', { name: '保存要求', exact: true }).click();
  await expect(
    sheet.getByRole('button', { name: '编辑要求 提交中文简历', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(resolved, 'workflow-opportunity.png'),
  });
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: '材料库', exact: false })
    .first()
    .click();
  const editButton = page.getByRole('button', {
    name: '编辑材料 算法岗中文简历',
    exact: true,
  });
  await editButton.click();
  const editor = page.getByRole('dialog');
  await expect(
    editor.getByRole('textbox', { name: '本机文件路径', exact: true }),
  ).toHaveValue(filename);
  await editor
    .getByRole('textbox', { name: '材料版本', exact: true })
    .fill('不保存');
  await page.keyboard.press('Escape');
  await editButton.click();
  await expect(
    editor.getByRole('textbox', { name: '材料版本', exact: true }),
  ).toHaveValue('v1');
  // Picker cancellation must preserve a path already entered in the editor.
  await page.route('**/api/files', (route) =>
    route.fulfill({ status: 200, json: { cancelled: true } }),
  );
  await editor.getByRole('button', { name: '选择', exact: true }).click();
  await expect(
    editor.getByRole('textbox', { name: '本机文件路径', exact: true }),
  ).toBeEnabled();
  await expect(
    editor.getByRole('textbox', { name: '本机文件路径', exact: true }),
  ).toHaveValue(filename);
  await page.unroute('**/api/files');
  await editor
    .getByRole('textbox', { name: '材料版本', exact: true })
    .fill('v2');
  await page.route('**/api/action', async (route) => {
    if (route.request().postDataJSON().action === 'updateMaterial')
      await route.fulfill({ status: 503, json: { error: '模拟材料保存失败' } });
    else await route.continue();
  });
  await editor.getByRole('button', { name: '保存材料', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('模拟材料保存失败');
  await expect(
    editor.getByRole('textbox', { name: '材料版本', exact: true }),
  ).toHaveValue('v2');
  await page.unroute('**/api/action');
  await editor.getByRole('button', { name: '保存材料', exact: true }).click();
  await expect(editor).toHaveCount(0);
  data = await state();
  assert.equal(
    data.requirements.find((r) => r.opportunityId === id).completed,
    false,
  );
  assert.equal(data.materials.find((m) => m.id === mat).version, 'v2');
  // Missing-file repair keeps the same material ID and linkage.
  await editButton.click();
  await editor
    .getByRole('textbox', { name: '本机文件路径', exact: true })
    .fill(path.join(resolved, 'missing.pdf'));
  await editor.getByRole('button', { name: '保存材料', exact: true }).click();
  await expect(editButton).toContainText('修复文件引用');
  await editButton.click();
  await editor
    .getByRole('textbox', { name: '本机文件路径', exact: true })
    .fill(filename);
  await editor.getByRole('button', { name: '保存材料', exact: true }).click();
  await expect(editButton).toContainText('编辑 / 替换');
  await page.screenshot({
    path: path.join(resolved, 'workflow-material-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await editButton.click();
  await page.screenshot({
    path: path.join(resolved, 'workflow-material-mobile.png'),
    animations: 'disabled',
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole('button', { name: '删除材料 算法岗中文简历', exact: true })
    .click();
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await state()).materials.length, 1);
  await page
    .getByRole('button', { name: '删除材料 算法岗中文简历', exact: true })
    .click();
  await page.route('**/api/action', async (route) => {
    if (route.request().postDataJSON().action === 'deleteMaterial')
      await route.fulfill({ status: 503, json: { error: '模拟移除失败' } });
    else await route.continue();
  });
  await editor
    .getByRole('button', { name: '确认移除引用', exact: true })
    .click();
  await expect(editor.getByRole('alert')).toContainText('模拟移除失败');
  await page.unroute('**/api/action');
  await editor
    .getByRole('button', { name: '确认移除引用', exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  data = await state();
  assert.equal(data.materials.length, 0);
  assert.equal(
    data.requirements.find((r) => r.opportunityId === id).materialId,
    null,
  );
  assert.equal(fs.readFileSync(filename, 'utf8'), '简历内容，测试只引用不删除');
  console.log(
    'PASS 材料维护：取消不保存、失败保留、选择取消保留、版本/路径替换、缺失修复、删除只解除引用',
  );
  await page
    .getByRole('button', { name: '机会库', exact: false })
    .first()
    .click();
  await page
    .getByRole('button')
    .filter({ hasText: '星河科技' })
    .first()
    .click();
  await sheet
    .getByRole('button', { name: '编辑要求 提交中文简历', exact: true })
    .click();
  await sheet
    .getByRole('button', { name: '移除这项要求', exact: true })
    .click();
  await sheet.getByRole('button', { name: '保留要求', exact: true }).click();
  assert.equal((await state()).requirements.length, 1);
  await sheet
    .getByRole('button', { name: '移除这项要求', exact: true })
    .click();
  await sheet
    .getByRole('button', { name: '确认移除要求', exact: true })
    .click();
  await expect(
    sheet.getByRole('button', { name: '编辑要求 提交中文简历', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  const before = await state();
  await stop();
  await start();
  const after = await state();
  for (const key of ['opportunities', 'tasks', 'materials', 'requirements'])
    assert.deepEqual(after[key], before[key], `重启后 ${key} 不变`);
  assert.deepEqual(errors, []);
  await page.reload();
  await page.getByTestId('today-focus').waitFor();
  console.log(
    'PASS 岗位要求增改删、取消删除、中文说明持久化；服务重启后完整保留，无浏览器错误',
  );
} catch (error) {
  console.error(logs);
  if (page) {
    console.error(await page.locator('main').ariaSnapshot());
    await page.screenshot({
      path: path.join(resolved, 'workflow-failure.png'),
    });
  }
  throw error;
} finally {
  await browser?.close();
  await stop();
}
