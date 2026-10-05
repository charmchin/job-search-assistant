import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, expect } from '@playwright/test';

const directory = process.env.ZHAOPIN_TEST_DATA_DIR;
assert.ok(directory, '必须提供隔离测试目录');
const resolved = fs.realpathSync(directory);
assert.ok(
  resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) &&
    path.basename(resolved).startsWith('zhaopin-'),
);
assert.ok(!fs.existsSync(path.join(resolved, 'app.db')), '只允许新建临时库');
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3116);
assert.ok(Number.isInteger(port) && port >= 3100 && port <= 3199);
const checker = http.createServer();
await new Promise((resolve, reject) =>
  checker.once('error', reject).listen(port, '127.0.0.1', resolve),
);
await new Promise((resolve) => checker.close(resolve));
const base = `http://127.0.0.1:${port}`;
let server,
  browser,
  a,
  b,
  logs = '';
const errors = [];
const state = async () => (await fetch(base + '/api/state')).json();
const send = async (action, payload, status = 200, requestId) => {
  const response = await fetch(base + '/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload, requestId }),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
};
const open = async (page) => {
  await page.goto(base);
  await page.getByTestId('today-focus').waitFor();
  await page
    .getByRole('button', { name: '机会库', exact: false })
    .first()
    .click();
  await page
    .getByRole('button')
    .filter({ hasText: '并发组织' })
    .first()
    .click();
};
const dialog = (page) => page.getByRole('dialog');
const edit = (page) =>
  dialog(page).getByRole('button', { name: '编辑', exact: true }).click();
const save = (page) =>
  dialog(page)
    .getByRole('button', { name: '保存全部修改', exact: true })
    .click();
const field = (page, name) =>
  dialog(page).getByRole('textbox', { name, exact: true });
try {
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
    stream.on('data', (c) => {
      logs = (logs + c).slice(-12000);
    });
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(base + '/api/state')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, logs);
  const { id: opportunityId } = await send('createOpportunity', {
    organization: '并发组织',
    role: '原岗位',
    notes: '原备注',
    nextAction: '准备简历',
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  a = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  b = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  for (const page of [a, b]) {
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.install({ time: Date.now() });
    await open(page);
    await edit(page);
    await expect(
      dialog(page).getByRole('button', { name: '保存全部修改', exact: true }),
    ).toBeDisabled();
  }
  await field(a, '岗位').fill('甲窗口新岗位');
  await field(b, '岗位').fill('乙窗口未保存岗位');
  let attempted;
  b.on('request', (request) => {
    if (request.url().endsWith('/api/action'))
      attempted = request.postDataJSON();
  });
  await save(a);
  await dialog(a).getByRole('button', { name: '编辑', exact: true }).waitFor();
  const before = (await state()).opportunities[0];
  await save(b);
  await expect(dialog(b).getByRole('alert')).toContainText('未保存：岗位');
  await expect(field(b, '岗位')).toHaveValue('乙窗口未保存岗位');
  await expect(dialog(b).getByLabel('编辑冲突提示')).toContainText(
    '甲窗口新岗位',
  );
  assert.equal(attempted.payload.expected.role, '原岗位');
  assert.equal((await state()).opportunities[0].updatedAt, before.updatedAt);
  assert.equal((await state()).opportunities[0].role, '甲窗口新岗位');
  // Polling a new snapshot must not silently bless the stale draft.
  await b.clock.fastForward(61000);
  await save(b);
  await expect(dialog(b).getByRole('alert')).toContainText('未保存：岗位');
  assert.equal(attempted.payload.expected.role, '原岗位');
  b.once('dialog', (d) => d.dismiss());
  await dialog(b)
    .getByRole('button', { name: '放弃编辑并载入最新', exact: true })
    .click();
  await expect(field(b, '岗位')).toHaveValue('乙窗口未保存岗位');
  b.once('dialog', (d) => d.accept());
  await dialog(b)
    .getByRole('button', { name: '放弃编辑并载入最新', exact: true })
    .click();
  await expect(field(b, '岗位')).toHaveValue('甲窗口新岗位');
  await field(b, '岗位').fill('已核对的最终岗位');
  await save(b);
  await dialog(b).getByRole('button', { name: '编辑', exact: true }).waitFor();
  assert.equal((await state()).opportunities[0].role, '已核对的最终岗位');
  console.log(
    'PASS 两个真实窗口同字段冲突、刷新不改基线、输入保留、取消放弃、核对后重建',
  );

  // Both begin from the same snapshot; an unrelated changed field is not resent.
  for (const page of [a, b]) {
    await page.reload();
    await open(page);
    await edit(page);
  }
  await field(a, '地点').fill('杭州');
  await field(b, '方向').fill('算法研发');
  await save(a);
  await dialog(a).getByRole('button', { name: '编辑', exact: true }).waitFor();
  await save(b);
  await dialog(b).getByRole('button', { name: '编辑', exact: true }).waitFor();
  assert.deepEqual(Object.keys(attempted.payload).sort(), [
    'direction',
    'expected',
    'id',
  ]);
  assert.equal((await state()).opportunities[0].location, '杭州');
  assert.equal((await state()).opportunities[0].direction, '算法研发');
  console.log('PASS 不同字段旧表单保存不互相覆盖，仅提交变化字段');

  for (const page of [a, b]) {
    await page.reload();
    await open(page);
    await dialog(page)
      .getByRole('button', { name: '岗位原文', exact: true })
      .click();
  }
  await field(a, '个人备注').fill('甲的新备注');
  await field(b, '个人备注').fill('乙的未保存备注');
  await dialog(a)
    .getByRole('button', { name: '保存备注', exact: true })
    .click();
  await expect(dialog(a).getByRole('status')).toContainText('已保存');
  await dialog(b)
    .getByRole('button', { name: '保存备注', exact: true })
    .click();
  await expect(dialog(b).getByRole('alert')).toContainText('个人备注');
  await expect(field(b, '个人备注')).toHaveValue('乙的未保存备注');
  await expect(dialog(b).getByLabel('编辑冲突提示')).toContainText(
    '甲的新备注',
  );
  await b.screenshot({
    path: path.join(resolved, 'edit-conflict-desktop.png'),
  });
  await b.setViewportSize({ width: 390, height: 844 });
  await expect(dialog(b).getByLabel('编辑冲突提示')).toBeVisible();
  assert.equal(
    await b.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await dialog(b).getByLabel('编辑冲突提示').scrollIntoViewIfNeeded();
  await b.screenshot({ path: path.join(resolved, 'edit-conflict-mobile.png') });
  assert.deepEqual(errors, []);
  console.log('PASS 备注独立编辑基线、冲突最新值可见、窄屏与无浏览器错误');
  const { id: milestoneId } = await send('createMilestone', {
    opportunityId,
    title: '并发面试',
  });
  const { id: materialId } = await send('createMaterial', {
    name: '并发简历',
    filePath: '/tmp/concurrency.pdf',
    version: 'v1',
  });
  const { id: requirementId } = await send('createRequirement', {
    opportunityId,
    name: '提交简历',
    materialId,
  });
  for (const page of [a, b]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page);
  }
  for (const page of [a, b]) {
    await dialog(page)
      .getByRole('button', { name: '节点与记录', exact: true })
      .click();
    await page
      .getByTestId(`milestone-${milestoneId}`)
      .getByRole('button', { name: '编辑节点 并发面试', exact: true })
      .click();
  }
  const node = (page) => page.getByTestId(`milestone-${milestoneId}`);
  await node(a)
    .getByRole('textbox', { name: '节点结果 / 注意事项', exact: true })
    .fill('甲的节点结果');
  await node(b)
    .getByRole('textbox', { name: '节点结果 / 注意事项', exact: true })
    .fill('乙的未保存结果');
  await node(a).getByRole('button', { name: '保存节点', exact: true }).click();
  await node(a)
    .getByRole('button', { name: '编辑节点 并发面试', exact: true })
    .waitFor();
  await node(b).getByRole('button', { name: '保存节点', exact: true }).click();
  await expect(node(b).getByRole('alert')).toContainText('节点结果');
  await expect(
    node(b).getByRole('textbox', { name: '节点结果 / 注意事项', exact: true }),
  ).toHaveValue('乙的未保存结果');
  await expect(node(b).getByLabel('编辑冲突提示')).toContainText(
    '甲的节点结果',
  );
  console.log('PASS 招聘节点双窗口冲突保留及最新值核对');

  for (const page of [a, b]) {
    await open(page);
    await dialog(page)
      .getByRole('button', { name: '编辑任务 准备简历', exact: true })
      .click();
  }
  const task = (page) =>
    dialog(page).getByRole('group', { name: /^编辑任务 / });
  await task(a)
    .getByRole('textbox', { name: '任务名称', exact: true })
    .fill('甲改后的任务');
  await task(a)
    .getByLabel('任务时间（上海时区）', { exact: true })
    .fill('2026-10-30T09:00');
  await task(a)
    .getByRole('spinbutton', { name: '预计耗时（分钟）', exact: true })
    .fill('45');
  await task(b)
    .getByRole('textbox', { name: '任务名称', exact: true })
    .fill('乙未保存的任务');
  await task(a).getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(task(a)).toHaveCount(0);
  await task(b).getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(task(b).getByRole('alert')).toContainText('任务名称');
  await expect(
    task(b).getByRole('textbox', { name: '任务名称', exact: true }),
  ).toHaveValue('乙未保存的任务');
  await task(b).scrollIntoViewIfNeeded();
  await b.screenshot({ path: path.join(resolved, 'task-editor-desktop.png') });
  await b.setViewportSize({ width: 390, height: 844 });
  await task(b).scrollIntoViewIfNeeded();
  await b.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await b.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await expect(task(b).getByLabel('任务时间（上海时区）')).toBeVisible();
  await expect(task(b).getByLabel('预计耗时（分钟）')).toBeVisible();
  await b.screenshot({ path: path.join(resolved, 'task-editor-mobile.png') });
  await b.setViewportSize({ width: 1440, height: 1000 });
  assert.equal((await state()).opportunities[0].nextAction, '甲改后的任务');
  assert.equal(
    (await state()).opportunities[0].nextActionAt,
    '2026-10-30T01:00:00.000Z',
  );
  assert.equal(
    (await state()).tasks.find((t) => t.isNextAction).estimatedMinutes,
    45,
  );
  console.log('PASS 任务编辑、上海排期/耗时、重点镜像同步、旧稿防覆盖与窄屏');

  for (const page of [a, b]) {
    await page.goto(base);
    await page
      .getByRole('heading', { name: '今天，推进最重要的一步', exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: '材料库', exact: false })
      .first()
      .click();
    await page
      .getByRole('button', { name: '编辑材料 并发简历', exact: true })
      .click();
  }
  await field(a, '材料版本').fill('v2');
  await field(b, '材料版本').fill('乙的未保存版本');
  await dialog(a)
    .getByRole('button', { name: '保存材料', exact: true })
    .click();
  await expect(dialog(a)).toHaveCount(0);
  await dialog(b)
    .getByRole('button', { name: '保存材料', exact: true })
    .click();
  await expect(dialog(b).getByRole('alert')).toContainText('材料版本');
  await expect(field(b, '材料版本')).toHaveValue('乙的未保存版本');
  await expect(dialog(b).getByLabel('编辑冲突提示')).toContainText('v2');
  b.once('dialog', (d) => d.accept());
  await dialog(b)
    .getByRole('button', { name: '放弃编辑并载入最新', exact: true })
    .click();
  await field(b, '材料版本').fill('v3');
  await dialog(b)
    .getByRole('button', { name: '保存材料', exact: true })
    .click();
  await expect(dialog(b)).toHaveCount(0);
  console.log('PASS 材料版本冲突保留、最新材料读取与确认重建基线');

  for (const page of [a, b]) {
    await open(page);
    await dialog(page)
      .getByRole('button', { name: '编辑要求 提交简历', exact: true })
      .click();
  }
  const requirement = (page) =>
    dialog(page).getByRole('group', { name: /^编辑要求 / });
  await requirement(a)
    .getByRole('textbox', { name: '要求说明', exact: true })
    .fill('甲要求说明');
  await requirement(b)
    .getByRole('textbox', { name: '要求说明', exact: true })
    .fill('乙未保存说明');
  await requirement(a)
    .getByRole('button', { name: '保存要求', exact: true })
    .click();
  await expect(requirement(a)).toHaveCount(0);
  await requirement(b)
    .getByRole('button', { name: '保存要求', exact: true })
    .click();
  await expect(requirement(b).getByRole('alert')).toContainText('要求说明');
  await expect(
    requirement(b).getByRole('textbox', { name: '要求说明', exact: true }),
  ).toHaveValue('乙未保存说明');
  await expect(requirement(b).getByLabel('编辑冲突提示')).toContainText(
    '甲要求说明',
  );
  console.log('PASS 岗位要求编辑冲突、原值基线与输入保留');

  await open(b);
  let release, held;
  const readyHeld = new Promise((resolve) => {
    held = resolve;
  });
  const readyRelease = new Promise((resolve) => {
    release = resolve;
  });
  const delay = async (route) => {
    const input = route.request().postDataJSON();
    if (
      input.action === 'updateRequirement' &&
      input.payload.completed === true
    ) {
      assert.equal(input.payload.expectedMaterial.version, 'v3');
      held();
      await readyRelease;
    }
    await route.continue();
  };
  await b.route('**/api/action', delay);
  await dialog(b)
    .getByRole('button', { name: '材料标记就绪 提交简历', exact: true })
    .click();
  await readyHeld;
  await send('updateMaterial', { id: materialId, version: 'v4' });
  release();
  await expect(dialog(b).getByRole('alert')).toContainText(
    '关联材料的路径或版本已变化',
  );
  assert.equal(
    (await state()).requirements.find((r) => r.id === requirementId).completed,
    false,
  );
  await b.unroute('**/api/action', delay);
  console.log('PASS 就绪请求在途时替换材料，旧版本无法被标记就绪');

  const selected = (await state()).tasks.find((t) => t.isNextAction);
  const { id: otherTask } = await send('createTask', {
    opportunityId,
    title: '新的重点任务',
  });
  await send('setNextTask', { opportunityId, taskId: otherTask });
  await dialog(b)
    .getByRole('button', { name: '取消重点', exact: true })
    .click();
  await expect(dialog(b).getByRole('alert')).toContainText(
    '下一步重点已被其他操作修改',
  );
  assert.equal(attempted.payload.expectedTaskId, selected.id);
  assert.equal((await state()).opportunities[0].nextAction, '新的重点任务');
  assert.deepEqual(errors, []);
  console.log('PASS 旧窗口不能取消新重点任务；扩展完整流程无页面错误');
  const settingsForm = (page) =>
    page.locator('fieldset').filter({
      has: page.getByRole('textbox', { name: '模型名', exact: true }),
    });
  const openSettings = async (page) => {
    await page.goto(base);
    await page
      .getByRole('heading', { name: '今天，推进最重要的一步', exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: '设置', exact: false })
      .first()
      .click();
    await settingsForm(page)
      .getByRole('textbox', { name: '模型名', exact: true })
      .waitFor();
  };
  for (const page of [a, b]) {
    await openSettings(page);
    await expect(
      settingsForm(page).getByRole('textbox', {
        name: '兼容接口地址',
        exact: true,
      }),
    ).toHaveValue('');
    await expect(
      settingsForm(page).getByRole('button', {
        name: '保存设置',
        exact: true,
      }),
    ).toBeDisabled();
  }
  await settingsForm(a)
    .getByRole('textbox', {
      name: '模型名',
      exact: true,
    })
    .fill('空配置下的新模型');
  await settingsForm(b)
    .getByRole('spinbutton', {
      name: '停滞复查天数',
      exact: true,
    })
    .fill('6');
  await settingsForm(a)
    .getByRole('button', {
      name: '保存设置',
      exact: true,
    })
    .click();
  await expect(settingsForm(a).getByRole('status')).toContainText('已保存');
  await settingsForm(b)
    .getByRole('button', {
      name: '保存设置',
      exact: true,
    })
    .click();
  await expect(settingsForm(b).getByRole('status')).toContainText('已保存');
  assert.deepEqual(Object.keys(attempted.payload).sort(), [
    'expected',
    'staleDays',
  ]);
  assert.equal((await state()).settings.aiModel, '空配置下的新模型');
  assert.ok(!(await state()).settings.aiBaseUrl);
  console.log(
    'PASS 空设置无伪造修改、默认接口仅作提示、独立停滞保存不覆盖模型',
  );
  await send('saveSettings', {
    baseUrl: 'http://127.0.0.1:9/v1',
    model: '原模型',
    staleDays: 5,
  });
  for (const page of [a, b]) await openSettings(page);
  await settingsForm(a)
    .getByRole('textbox', { name: '模型名', exact: true })
    .fill('甲的模型');
  await settingsForm(b)
    .getByRole('textbox', { name: '模型名', exact: true })
    .fill('乙的未保存模型');
  await settingsForm(a)
    .getByRole('button', { name: '保存设置', exact: true })
    .click();
  await expect(settingsForm(a).getByRole('status')).toContainText('已保存');
  await settingsForm(b)
    .getByRole('button', { name: '保存设置', exact: true })
    .click();
  await expect(settingsForm(b).getByRole('alert')).toContainText('模型名');
  await expect(
    settingsForm(b).getByRole('textbox', { name: '模型名', exact: true }),
  ).toHaveValue('乙的未保存模型');
  await expect(settingsForm(b).getByLabel('编辑冲突提示')).toContainText(
    '甲的模型',
  );
  b.once('dialog', (d) => d.accept());
  await settingsForm(b)
    .getByRole('button', { name: '放弃编辑并载入最新', exact: true })
    .click();
  await settingsForm(b)
    .getByRole('textbox', { name: '模型名', exact: true })
    .fill('核对后的模型');
  await settingsForm(b)
    .getByRole('button', { name: '保存设置', exact: true })
    .click();
  await expect(settingsForm(b).getByRole('status')).toContainText('已保存');
  for (const page of [a, b]) await openSettings(page);
  await settingsForm(a)
    .getByRole('textbox', { name: '模型名', exact: true })
    .fill('独立更改模型');
  await settingsForm(b)
    .getByRole('spinbutton', { name: '停滞复查天数', exact: true })
    .fill('9');
  await settingsForm(a)
    .getByRole('button', { name: '保存设置', exact: true })
    .click();
  await expect(settingsForm(a).getByRole('status')).toContainText('已保存');
  await settingsForm(b)
    .getByRole('button', { name: '保存设置', exact: true })
    .click();
  await expect(settingsForm(b).getByRole('status')).toContainText('已保存');
  assert.deepEqual(Object.keys(attempted.payload).sort(), [
    'expected',
    'staleDays',
  ]);
  assert.equal((await state()).settings.aiModel, '独立更改模型');
  assert.equal((await state()).settings.staleDays, '9');
  await settingsForm(b)
    .getByRole('button', { name: '载入最新设置', exact: true })
    .click();
  await expect(
    settingsForm(b).getByRole('textbox', { name: '模型名', exact: true }),
  ).toHaveValue('独立更改模型');
  console.log('PASS 设置冲突保留、确认重建、不同设置独立提交及载入最新值');

  await b.goto(base);
  await b
    .getByRole('heading', { name: '今天，推进最重要的一步', exact: true })
    .waitFor();
  await b.getByRole('button', { name: '材料库', exact: false }).first().click();
  await b
    .getByRole('button', { name: '删除材料 并发简历', exact: true })
    .click();
  await send('updateMaterial', { id: materialId, notes: '确认期间新写入' });
  await dialog(b)
    .getByRole('button', { name: '确认移除引用', exact: true })
    .click();
  await expect(dialog(b).getByRole('alert')).toContainText(
    '未移除：材料或关联要求已变化',
  );
  assert.match(attempted.payload.expectedVersion, /^[a-f0-9]{64}$/);
  assert.ok((await state()).materials.some((m) => m.id === materialId));
  await dialog(b).getByRole('button', { name: '取消', exact: true }).click();
  await b
    .getByRole('button', { name: '删除材料 并发简历', exact: true })
    .click();
  await dialog(b)
    .getByRole('button', { name: '确认移除引用', exact: true })
    .click();
  await expect(dialog(b)).toHaveCount(0);
  assert.ok(!(await state()).materials.some((m) => m.id === materialId));
  console.log('PASS 材料删除确认已过时被拦截，重新核对后正常移除引用');

  await open(b);
  await dialog(b)
    .getByRole('button', { name: '编辑要求 提交简历', exact: true })
    .click();
  await requirement(b)
    .getByRole('button', { name: '移除这项要求', exact: true })
    .click();
  await send('updateRequirement', {
    id: requirementId,
    notes: '确认期间新要求',
  });
  await requirement(b)
    .getByRole('button', { name: '确认移除要求', exact: true })
    .click();
  await expect(requirement(b).getByRole('alert')).toContainText(
    '未移除：岗位要求已变化',
  );
  assert.ok((await state()).requirements.some((r) => r.id === requirementId));
  console.log('PASS 旧要求编辑会话不能删除已经变化的要求');

  await open(b);
  await dialog(b)
    .getByRole('button', { name: '岗位原文', exact: true })
    .click();
  b.once('dialog', async (confirmation) => {
    await send('createTask', { opportunityId, title: '确认期间新任务' });
    await confirmation.accept();
  });
  await dialog(b)
    .getByRole('button', { name: '删除这个机会', exact: true })
    .click();
  await expect(dialog(b).getByRole('alert')).toContainText(
    '未删除：机会或关联记录已变化',
  );
  assert.ok((await state()).opportunities.some((o) => o.id === opportunityId));
  assert.deepEqual(errors, []);
  console.log('PASS 机会删除确认期间新增行动，整机会与关联记录均保留');
} catch (error) {
  console.error(logs);
  if (b) {
    console.error(await b.locator('body').ariaSnapshot());
    await b.screenshot({
      path: path.join(resolved, 'edit-conflict-failure.png'),
    });
  }
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const ended = once(server, 'exit');
    server.kill('SIGTERM');
    await ended;
  }
}
