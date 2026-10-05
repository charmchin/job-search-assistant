import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const directory = process.env.ZHAOPIN_TEST_DATA_DIR;
assert.ok(directory, '必须指定全新临时目录');
const resolved = fs.realpathSync(directory);
assert.ok(
  [os.tmpdir(), '/tmp'].some((root) =>
    resolved.startsWith(`${fs.realpathSync(root)}${path.sep}`),
  ) && path.basename(resolved).startsWith('zhaopin-'),
);
assert.ok(!fs.existsSync(path.join(resolved, 'app.db')));
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3115);
assert.ok(Number.isInteger(port) && port >= 3100 && port <= 3199);
const checker = http.createServer();
await new Promise((resolve, reject) =>
  checker.once('error', reject).listen(port, '127.0.0.1', resolve),
);
await new Promise((resolve) => checker.close(resolve));
const server = spawn(
  process.execPath,
  [
    'node_modules/next/dist/bin/next',
    'start',
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
const base = `http://127.0.0.1:${port}`;
const post = (endpoint, body) =>
  fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const action = async (action, payload, requestId) => {
  const response = await post('action', {
    action,
    payload,
    ...(requestId ? { requestId } : {}),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};
const exported = async () => (await fetch(`${base}/api/export`)).json();
try {
  let ready = false;
  for (let i = 0; i < 160; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try {
      ready = (await fetch(`${base}/api/state`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, logs);
  disk = new Database(path.join(resolved, 'app.db'), { fileMustExist: true });
  original = await exported();
  assert.ok(Object.values(original.data).every((rows) => rows.length === 0));
  const id = (
    await action('createOpportunity', {
      organization: '保存回归组织',
      role: '研发工程师',
      tasks: [{ title: '既有任务' }],
      requirements: [{ name: '简历' }],
    })
  ).id;
  assert.ok(
    disk.prepare('SELECT id FROM opportunities WHERE id=?').get(id),
    '服务必须使用已验证的临时库',
  );
  const materialId = (await action('createMaterial', { name: '回归简历' })).id;
  const nonce = randomUUID(),
    body = {
      action: 'createTask',
      payload: { opportunityId: id, title: 'API只创建一次' },
      requestId: nonce,
    };
  const repeated = await Promise.all([
    post('action', body),
    post('action', body),
    post('action', body),
  ]);
  assert.deepEqual(await repeated[0].json(), await repeated[1].json());
  assert.equal(repeated[2].status, 200);
  assert.equal(
    disk
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE title=?')
      .get('API只创建一次').n,
    1,
  );
  for (const [action, payload, status] of [
    ['updateOpportunity', { id, organization: ' ' }, 400],
    ['updateOpportunity', { id, stage: 'wrong' }, 400],
    ['updateOpportunity', { id, deadline: '2026-02-30T09:00:00+08:00' }, 400],
    ['updateTask', { id: 'missing', status: 'done' }, 404],
    ['updateMaterial', { id: materialId, name: '' }, 400],
    ['createTask', { opportunityId: 'missing', title: '孤儿任务' }, 404],
    ['saveSettings', { staleDays: 0 }, 400],
  ])
    assert.equal((await post('action', { action, payload })).status, status);
  const before = (await exported()).data;
  disk.exec(
    "CREATE TRIGGER reject_activity BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  assert.equal(
    (
      await post('action', {
        action: 'createTask',
        payload: { opportunityId: id, title: '不应保留' },
        requestId: randomUUID(),
      })
    ).status,
    500,
  );
  disk.exec('DROP TRIGGER reject_activity');
  assert.deepEqual((await exported()).data, before);
  console.log(
    'PASS 真实 API 校验/404/请求去重；活动写入故障使数据与活跃时间全量回滚',
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
  await page.goto(base);
  await page.getByRole('button', { name: /^机会库/ }).click();
  const open = async () => {
    await page
      .getByRole('button')
      .filter({ hasText: /保存(?:回归|成功)组织/ })
      .first()
      .click();
    await page.getByRole('dialog').waitFor();
  };
  await open();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: '编辑', exact: true }).click();
  await sheet.getByLabel('公司 / 组织', { exact: true }).fill('');
  await sheet
    .getByRole('button', { name: '保存全部修改', exact: true })
    .click();
  await sheet
    .getByRole('alert')
    .filter({ hasText: '公司/组织不合法' })
    .waitFor();
  assert.equal(
    await sheet.getByLabel('公司 / 组织', { exact: true }).inputValue(),
    '',
  );
  await sheet.getByLabel('公司 / 组织', { exact: true }).fill('保存成功组织');
  let updates = 0;
  await page.route('**/api/action', async (route) => {
    updates++;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await sheet
    .getByRole('button', { name: '保存全部修改', exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  assert.ok(
    await sheet
      .getByRole('button', { name: '保存全部修改', exact: true })
      .isDisabled(),
  );
  await sheet.getByText('保存成功组织', { exact: true }).waitFor();
  await sheet.getByRole('button', { name: '编辑', exact: true }).waitFor();
  assert.equal(updates, 1);
  await page.unroute('**/api/action');
  console.log(
    'PASS Chrome 空名称错误可见且输入保留；保存成功退出编辑，同帧双击只发送一次',
  );

  const input = sheet.getByPlaceholder('新增一个明确行动');
  const add = sheet.getByRole('button', { name: '添加', exact: true });
  await input.fill('失败保留的任务');
  await page.route('**/api/action', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '模拟保存失败' }),
    }),
  );
  await add.click();
  await sheet.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
  assert.equal(await input.inputValue(), '失败保留的任务');
  await page.unroute('**/api/action');
  let lose = true;
  const requestIds = [];
  await page.route('**/api/action', async (route) => {
    requestIds.push(route.request().postDataJSON().requestId);
    if (lose) {
      lose = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort('failed');
    } else await route.continue();
  });
  await add.click();
  await sheet
    .getByRole('alert')
    .filter({ hasText: '无法确认保存结果' })
    .waitFor();
  assert.equal(
    disk
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE title=?')
      .get('失败保留的任务').n,
    1,
  );
  assert.equal(await input.inputValue(), '失败保留的任务');
  await add.click();
  await sheet.getByText('失败保留的任务', { exact: true }).waitFor();
  assert.equal(requestIds[0], requestIds[1]);
  assert.equal(
    disk
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE title=?')
      .get('失败保留的任务').n,
    1,
  );
  await page.unroute('**/api/action');
  console.log(
    'PASS Chrome 服务失败不清空输入；真实写入后丢失响应，沿用标识重试只保留一条任务',
  );

  let readingFails = true,
    creates = 0;
  await page.route('**/api/state', (route) =>
    readingFails
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{}',
        })
      : route.continue(),
  );
  await page.route('**/api/action', async (route) => {
    creates++;
    await route.continue();
  });
  await input.fill('已保存但刷新失败');
  await add.click();
  await sheet
    .getByRole('status')
    .filter({ hasText: '已保存，但列表尚未更新' })
    .waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(
    disk
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE title=?')
      .get('已保存但刷新失败').n,
    1,
  );
  await input.fill('已保存但刷新失败');
  await add.click();
  await sheet
    .getByRole('alert')
    .filter({ hasText: '上一操作已保存' })
    .waitFor();
  assert.equal(creates, 1);
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  readingFails = false;
  await page
    .getByTestId('workspace-save-status')
    .getByRole('button', { name: '重试刷新', exact: true })
    .click();
  await page.getByTestId('workspace-save-status').waitFor({ state: 'hidden' });
  await page.unroute('**/api/state');
  await page.unroute('**/api/action');
  await open();
  await sheet.getByText('已保存但刷新失败', { exact: true }).waitFor();
  console.log(
    'PASS Chrome 已提交/刷新失败准确区分；后续写入受阻，重试只发 GET，刷新后恢复操作',
  );

  const requirement = disk
    .prepare('SELECT id FROM material_requirements WHERE opportunity_id=?')
    .get(id).id;
  await sheet
    .getByRole('combobox', { name: '关联材料 简历', exact: true })
    .selectOption(materialId);
  assert.equal(
    disk
      .prepare('SELECT material_id FROM material_requirements WHERE id=?')
      .get(requirement).material_id,
    null,
  );
  await page.route('**/api/action', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '模拟关联失败' }),
    }),
  );
  await sheet
    .getByRole('button', { name: '保存关联 简历', exact: true })
    .click();
  await sheet.getByRole('alert').filter({ hasText: '模拟关联失败' }).waitFor();
  assert.equal(
    await sheet
      .getByRole('combobox', { name: '关联材料 简历', exact: true })
      .inputValue(),
    materialId,
  );
  await page.unroute('**/api/action');
  await sheet
    .getByRole('button', { name: '保存关联 简历', exact: true })
    .click();
  await sheet
    .getByRole('button', { name: '保存关联 简历', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(
    disk
      .prepare('SELECT material_id FROM material_requirements WHERE id=?')
      .get(requirement).material_id,
    materialId,
  );
  await sheet.getByRole('button', { name: '节点与记录', exact: true }).click();
  const activity = sheet.getByPlaceholder('记录沟通、反馈或下一步…');
  await activity.fill('只记录一次沟通');
  await sheet
    .getByRole('button', { name: '记录', exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await sheet.getByText('只记录一次沟通', { exact: true }).waitFor();
  assert.equal(
    disk
      .prepare('SELECT COUNT(*) AS n FROM activities WHERE content=?')
      .get('只记录一次沟通').n,
    1,
  );
  await page.screenshot({
    path: path.join(resolved, 'mutation-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(resolved, 'mutation-mobile.png'),
    fullPage: true,
  });
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '设置与数据', exact: true }).click();
  await page.getByLabel('停滞复查天数', { exact: true }).fill('0');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: '停滞复查天数不合法' })
    .waitFor();
  assert.equal(
    await page.getByLabel('停滞复查天数', { exact: true }).inputValue(),
    '0',
  );
  await page.getByLabel('停滞复查天数', { exact: true }).fill('6');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor();
  assert.equal(
    disk.prepare("SELECT value FROM settings WHERE key='staleDays'").get()
      .value,
    '6',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS Chrome 材料关联失败保留选择并可重试；记录双击仅一次；设置校验与成功反馈；桌面/窄屏无 JS 异常或横向溢出',
  );
  await page.getByRole('button', { name: /^材料库/ }).click();
  await page.getByRole('button', { name: '添加材料', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog
    .getByPlaceholder('例如：算法岗中文简历')
    .fill('只保存一次的材料');
  await page.route('**/api/action', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: '模拟材料保存失败' }),
    }),
  );
  await dialog.getByRole('button', { name: '保存材料', exact: true }).click();
  await dialog
    .getByRole('alert')
    .filter({ hasText: '模拟材料保存失败' })
    .waitFor();
  assert.equal(
    await dialog.getByPlaceholder('例如：算法岗中文简历').inputValue(),
    '只保存一次的材料',
  );
  await page.unroute('**/api/action');
  await dialog
    .getByRole('button', { name: '保存材料', exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    disk
      .prepare('SELECT COUNT(*) AS n FROM materials WHERE name=?')
      .get('只保存一次的材料').n,
    1,
  );
  await page.getByRole('button', { name: '收集岗位', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByLabel(/招聘正文/)
    .fill(
      '新星招聘公司\n岗位：算法工程师\n工作地点：上海\n任职要求：硕士\n材料要求：简历',
    );
  await dialog
    .getByRole('button', { name: '整理岗位信息', exact: true })
    .click();
  await dialog
    .getByRole('textbox', { name: '公司 / 组织 *', exact: true })
    .waitFor();
  await dialog
    .getByRole('textbox', { name: '公司 / 组织 *', exact: true })
    .fill('草稿确认回归公司');
  await dialog
    .getByRole('textbox', { name: '岗位 *', exact: true })
    .fill('算法工程师');
  await dialog
    .getByRole('button', { name: '保存到机会库', exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await page
    .getByRole('heading', { name: '算法工程师', exact: true })
    .waitFor();
  assert.equal(
    disk
      .prepare('SELECT COUNT(*) AS n FROM opportunities WHERE organization=?')
      .get('草稿确认回归公司').n,
    1,
  );
  assert.equal(
    disk
      .prepare(
        "SELECT COUNT(*) AS n FROM extraction_drafts WHERE status='confirmed'",
      )
      .get().n,
    1,
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.getByRole('button', { name: /^机会库/ }).click();
  await open();
  const existingTask = disk
    .prepare('SELECT id FROM tasks WHERE title=?')
    .get('既有任务').id;
  disk.prepare('DELETE FROM tasks WHERE id=?').run(existingTask); // Only the verified temporary fixture.
  await sheet
    .getByText('既有任务', { exact: true })
    .locator('../..')
    .getByRole('button', { name: '完成任务', exact: true })
    .click();
  await sheet.getByRole('alert').filter({ hasText: '任务已不存在' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS Chrome 材料失败保留输入、重复保存仅一次；真实规则草稿确认仅一次；删除中的旧任务明确 404，不声称成功',
  );
  assert.equal((await post('import', original)).status, 200);
  assert.deepEqual((await exported()).data, original.data);
  console.log(`PASS 测试库恢复清空；截图：${resolved}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (browser) await browser.close();
  if (disk) disk.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
}
