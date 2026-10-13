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
const decisions = ['undecided', 'pursue', 'hold', 'skip'];
const report = {
  combinations: 0,
  stageTransitions: [],
  decisionTransitions: [],
  checks: [],
  pageErrors: [],
};
async function action(action, payload) {
  const response = await fetch(base + '/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
async function state() {
  return (await fetch(base + '/api/state')).json();
}
try {
  for (let n = 0; n < 150; n++) {
    if (server.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(base + '/api/health')).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (let i = 0; i < stages.length; i++)
    await action('createOpportunity', {
      organization: '状态核查-' + stages[i][1],
      role: '审查岗位-' + stages[i][0],
      stage: stages[i][0],
      decision: i === 7 ? 'skip' : decisions[i % 3],
    });
  const target = (
    await action('createOpportunity', {
      organization: '状态核查目标',
      role: 'Filter Engineer',
      direction: '方向审查',
      tags: ['STATUS_TAG'],
      decision: 'undecided',
    })
  ).id;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => report.pageErrors.push(e.message));
  await page.clock.install({ time: Date.now() });
  await page.goto(base);
  await page
    .getByRole('button', { name: '机会库', exact: false })
    .first()
    .click();
  const query = page.getByPlaceholder('搜索公司、岗位、方向或标签');
  const judgment = page.getByRole('combobox', {
      name: '投入判断筛选',
      exact: true,
    }),
    stage = page.getByRole('combobox', { name: '招聘阶段筛选', exact: true });
  const rows = page.getByRole('button').filter({ hasText: '状态核查' });
  const targetRow = page
    .getByRole('button')
    .filter({ hasText: '状态核查目标' });
  const fixture = (await state()).opportunities;
  for (const mode of ['卡片', '列表']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    for (const filterStage of ['all', ...stages.map((s) => s[0])])
      for (const filterDecision of ['all', ...decisions]) {
        await stage.selectOption(filterStage);
        await judgment.selectOption(filterDecision);
        const expected = fixture.filter(
          (o) =>
            (filterStage === 'all' || o.stage === filterStage) &&
            (filterDecision === 'all' || o.decision === filterDecision),
        );
        await expect(rows).toHaveCount(expected.length);
        report.combinations++;
      }
  }
  await page.getByRole('button', { name: '卡片', exact: true }).click();
  await judgment.selectOption('all');
  await stage.selectOption('evaluating');
  await query.fill('状态核查目标');
  const dialog = page.getByRole('dialog');
  async function editSave(changes) {
    await expect(targetRow).toHaveCount(1);
    await targetRow.click();
    await dialog.getByRole('button', { name: '编辑', exact: true }).click();
    for (const [label, value] of Object.entries(changes))
      await dialog
        .getByRole('combobox', { name: label, exact: true })
        .selectOption(value);
    if (changes['投入判断'] === 'skip')
      await expect(
        dialog.getByRole('combobox', { name: '阶段', exact: true }),
      ).toHaveValue('closed');
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/action') && r.request().method() === 'POST',
    );
    await dialog
      .getByRole('button', { name: '保存全部修改', exact: true })
      .click();
    assert.equal((await response).status(), 200);
    await dialog.getByRole('button', { name: '编辑', exact: true }).waitFor();
    const current = (await state()).opportunities.find((o) => o.id === target);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    return current;
  }
  let previous = 'evaluating';
  for (const [next] of [...stages.slice(1), stages[0]]) {
    const current = await editSave({ 阶段: next });
    assert.equal(current.stage, next);
    await expect(targetRow).toHaveCount(0);
    await stage.selectOption(next);
    await expect(targetRow).toHaveCount(1);
    report.stageTransitions.push({
      from: previous,
      to: next,
      oldFilterCount: 0,
      newFilterCount: 1,
    });
    previous = next;
  }
  await stage.selectOption('all');
  let previousDecision = 'undecided';
  await judgment.selectOption(previousDecision);
  for (const next of ['pursue', 'hold', 'skip', 'undecided']) {
    const current = await editSave({ 投入判断: next });
    assert.equal(current.decision, next);
    await expect(targetRow).toHaveCount(0);
    await judgment.selectOption(next);
    await expect(targetRow).toHaveCount(1);
    report.decisionTransitions.push({
      from: previousDecision,
      to: next,
      actualStage: current.stage,
    });
    previousDecision = next;
  }
  await judgment.selectOption('all');
  let current = await editSave({ 阶段: 'preparing', 投入判断: 'pursue' });
  assert.equal(current.stage, 'preparing');
  current = await editSave({ 投入判断: 'skip' });
  assert.equal(current.stage, 'closed');
  const beforeRejected = (await state()).opportunities;
  const rejected = await fetch(base + '/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'updateOpportunity',
      payload: { id: target, stage: 'interview', notes: '不能保存' },
    }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, 'OPPORTUNITY_STATUS_CONFLICT');
  assert.deepEqual((await state()).opportunities, beforeRejected);
  await targetRow.click();
  await dialog.getByRole('button', { name: '编辑', exact: true }).click();
  await dialog
    .getByRole('combobox', { name: '阶段', exact: true })
    .selectOption('interview');
  await expect(dialog.getByRole('alert')).toContainText(
    '“不再考虑”只能对应“未通过/放弃”',
  );
  await expect(
    dialog.getByRole('button', { name: '保存全部修改', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: '岗位原文', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('请先将投入判断改为');
  await expect(
    dialog.getByRole('button', { name: '保存全部修改', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: '决策与行动', exact: true }).click();
  await expect(
    dialog.getByRole('combobox', { name: '阶段', exact: true }),
  ).toHaveValue('interview');
  await page.screenshot({ path: path.join(directory, 'status-conflict.png') });
  await dialog
    .getByRole('combobox', { name: '投入判断', exact: true })
    .selectOption('pursue');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: '保存全部修改', exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole('button', { name: '保存全部修改', exact: true })
    .click();
  await dialog.getByRole('button', { name: '编辑', exact: true }).waitFor();
  current = (await state()).opportunities.find((o) => o.id === target);
  assert.equal(current.stage, 'interview');
  assert.equal(current.decision, 'pursue');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await stage.selectOption('interview');
  await expect(targetRow).toHaveCount(1);
  report.checks.push({
    kind: 'statusConflict',
    apiStatus: 400,
    uiBlocked: true,
    resolvedStage: current.stage,
  });
  await query.fill(' 状态核查目标 ');
  await expect(targetRow).toHaveCount(1);
  await query.fill('　状态核查目标　');
  await expect(targetRow).toHaveCount(1);
  await query.fill('   ');
  await expect(rows).toHaveCount(
    (await state()).opportunities.filter((o) => o.stage === 'interview').length,
  );
  report.checks.push({
    kind: 'searchWhitespace',
    plainCount: 1,
    paddedCount: 1,
    fullWidthPaddingCount: 1,
  });
  await query.fill('FILTER ENGINEER');
  await expect(targetRow).toHaveCount(1);
  await query.fill('status_tag');
  await expect(targetRow).toHaveCount(1);
  await query.fill('方向审查');
  await expect(targetRow).toHaveCount(1);
  await query.fill('状态核查目标');
  await action('updateOpportunity', { id: target, stage: 'offer' });
  await page.clock.fastForward(61000);
  await expect(targetRow).toHaveCount(0);
  await stage.selectOption('offer');
  await expect(targetRow).toHaveCount(1);
  report.backgroundRefresh = {
    oldStage: 'interview',
    newStage: 'offer',
    oldFilterCount: 0,
    newFilterCount: 1,
  };
  await page.screenshot({
    path: path.join(directory, 'opportunity-filters.png'),
  });
  // Regressions from the live audit: URL identity, edit identity, stale discard.
  const first = await action('createOpportunity', {
    organization: '边界核查甲',
    role: '环境工程师',
    sourceUrl: 'https://jobs.example.com/#/job?id=1001',
  });
  const second = await action('createOpportunity', {
    organization: '边界核查乙',
    role: '安全工程师',
    sourceUrl: 'https://jobs.example.com/#/job?id=1002',
  });
  await page.reload();
  await page
    .getByRole('button', { name: '机会库', exact: false })
    .first()
    .click();
  await page.getByRole('button').filter({ hasText: '边界核查乙' }).click();
  await dialog.getByRole('button', { name: '编辑', exact: true }).click();
  await dialog.getByLabel('公司 / 组织', { exact: true }).fill('边界核查甲');
  await dialog.getByLabel('岗位', { exact: true }).fill('环境工程师');
  let saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/action') && r.request().method() === 'POST',
  );
  await dialog
    .getByRole('button', { name: '保存全部修改', exact: true })
    .click();
  assert.equal((await saved).status(), 409);
  await expect(
    dialog.getByText('该机会已在机会库中，请勿重复添加。', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('公司 / 组织', { exact: true })).toHaveValue(
    '边界核查甲',
  );
  assert.equal(
    (await state()).opportunities.find((o) => o.id === second.id).organization,
    '边界核查乙',
  );
  await dialog.getByLabel('岗位', { exact: true }).fill('分析工程师');
  saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/action') && r.request().method() === 'POST',
  );
  await dialog
    .getByRole('button', { name: '保存全部修改', exact: true })
    .click();
  assert.equal((await saved).status(), 200);
  await dialog.getByRole('button', { name: '编辑', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  const duplicateUrl = await fetch(base + '/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'updateOpportunity',
      payload: {
        id: second.id,
        sourceUrl: 'https://jobs.example.com/#/job?utm_source=share&id=1001',
      },
    }),
  });
  assert.equal(duplicateUrl.status, 409);
  assert.equal((await duplicateUrl.json()).duplicateId, first.id);
  report.checks.push({
    kind: 'editDuplicate',
    rejected: true,
    inputPreserved: true,
    correctionSaved: true,
  });

  const capture = async (input) => {
    const response = await fetch(base + '/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const draft = await capture({
    url: 'https://jobs.example.com/#/job?id=1003',
    text: '草稿核查公司｜实验室工程师\n工作地点：上海\n任职要求：本科及以上学历，负责实验室管理。',
  });
  await page.reload();
  await page
    .getByRole('button', { name: '机会库', exact: false })
    .first()
    .click();
  await page.getByRole('button', { name: '查看草稿', exact: true }).click();
  const list = page.getByLabel('待确认草稿列表', { exact: true });
  await expect(
    list.getByText('草稿核查公司 · 实验室工程师', { exact: true }),
  ).toBeVisible();
  const revised = await capture({
    draftId: draft.id,
    draftRevision: draft.draftRevision,
    url: 'https://jobs.example.com/#/job?id=1003',
    text: '草稿更新公司｜质量工程师\n工作地点：北京\n任职要求：硕士及以上学历，负责质量分析。',
  });
  assert.notEqual(revised.draftRevision, draft.draftRevision);
  page.once('dialog', (prompt) => prompt.accept());
  saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/action') && r.request().method() === 'POST',
  );
  await list.getByRole('button', { name: '移除草稿', exact: true }).click();
  assert.equal((await saved).status(), 409);
  await expect(list.getByRole('alert')).toContainText(
    '草稿已被其他操作更新或移除',
  );
  assert.equal(
    (
      await (
        await fetch(base + '/api/state?section=draft&id=' + draft.id)
      ).json()
    ).draftRevision,
    revised.draftRevision,
  );
  await page.screenshot({
    path: path.join(directory, 'stale-draft-protection.png'),
  });
  await list.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(
    list.getByText('草稿更新公司 · 质量工程师', { exact: true }),
  ).toBeVisible();
  page.once('dialog', (prompt) => prompt.accept());
  saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/action') && r.request().method() === 'POST',
  );
  await list.getByRole('button', { name: '移除草稿', exact: true }).click();
  assert.equal((await saved).status(), 200);
  await expect(list).toHaveCount(0);
  report.checks.push({
    kind: 'hashRouteAndDraftDiscard',
    distinctJobsAllowed: true,
    staleDiscardRejected: true,
    latestDiscardAllowed: true,
  });
  assert.deepEqual(report.pageErrors, []);
  fs.writeFileSync(
    path.join(directory, 'opportunity-filter-results.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(logs);
  if (page) {
    console.error((await page.locator('body').ariaSnapshot()).slice(-7000));
    await page.screenshot({
      path: path.join(directory, 'opportunity-filter-failure.png'),
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
  // The owning test runner collects artifacts and removes this isolated directory.
}
