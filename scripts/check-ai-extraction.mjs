import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

// Own both servers and use fake credentials; no real provider/keychain/notification calls.
const dataDir = process.env.ZHAOPIN_TEST_DATA_DIR;
assert.ok(dataDir, '必须提供 ZHAOPIN_TEST_DATA_DIR');
const resolved = fs.realpathSync(dataDir);
assert.ok(
  [os.tmpdir(), '/tmp'].some((root) =>
    resolved.startsWith(`${fs.realpathSync(root)}${path.sep}`),
  ) && path.basename(resolved).startsWith('zhaopin-'),
);
assert.ok(
  !fs.existsSync(path.join(resolved, 'app.db')),
  '必须使用全新的临时库',
);
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3110);
assert.ok(
  Number.isInteger(port) && port >= 3100 && port <= 3199,
  '仅允许独立测试端口',
);
const portCheck = http.createServer();
await new Promise((resolve, reject) =>
  portCheck.once('error', reject).listen(port, '127.0.0.1', resolve),
);
await new Promise((resolve) => portCheck.close(resolve));
const source =
  '星河科技｜研发岗\n工作地点：上海\n网申截止：2026年12月20日\n申请材料：简历\n任职要求：硕士学历。';
let providerCalls = 0;
const provider = http.createServer(async (request, response) => {
  assert.equal(request.headers.authorization, 'Bearer fake-test-key');
  assert.equal(request.url, '/v1/chat/completions');
  let body = '';
  for await (const chunk of request) body += chunk;
  providerCalls++;
  const prompt = JSON.parse(body).messages.at(-1).content;
  const scenario = /AICASE:(\w+)/.exec(prompt)?.[1] || 'valid';
  let extraction = {
    organization: '星河科技',
    role: '研发岗',
    location: '上海',
    deadline: '2026-12-20',
    confidence: 0.84,
    requirements: [{ name: '简历' }],
    tasks: [
      {
        title: '准备简历',
        dueAt: '2026-12-19',
        estimatedMinutes: 30,
        source: 'ai',
      },
    ],
    evidence: {
      organization: '星河科技',
      role: '研发岗',
      location: '工作地点：上海',
      deadline: '网申截止：2026年12月20日',
      'requirements[0].name': '简历',
      'tasks[0].title': '申请材料：简历',
      specialNotes: '凭空编造的注意事项',
    },
  };
  if (scenario === 'wrong')
    extraction = {
      role: '研发岗',
      tasks: 'wrong-type',
      highlights: null,
      deadline: 'invalid-date',
      confidence: 10,
    };
  if (scenario === 'nulls') extraction.highlights = null;
  if (scenario === 'date') extraction.deadline = '2026-02-30';
  if (scenario === 'long') extraction.description = 'a'.repeat(8001);
  if (scenario === 'oversize') {
    response.writeHead(200);
    response.end('x'.repeat(256 * 1024 + 1));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content:
              scenario === 'badjson' ? 'not-json' : JSON.stringify(extraction),
          },
        },
      ],
    }),
  );
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
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
    cwd: process.cwd(),
    env: {
      ...process.env,
      ZHAOPIN_DATA_DIR: resolved,
      ZHAOPIN_DISABLE_NOTIFICATIONS: '1',
      OPENAI_API_KEY: 'fake-test-key',
      OPENAI_MODEL: 'fake-model',
      OPENAI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
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
const opportunityIds = new Set();
const draftIds = new Set();
async function capture(scenario) {
  const response = await fetch(`${base}/api/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${source}\nAICASE:${scenario}` }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  draftIds.add(result.id);
  assert.ok(
    disk
      .prepare('SELECT id FROM extraction_drafts WHERE id = ?')
      .get(result.id),
    '服务没有使用指定测试库',
  );
  return result;
}
async function action(action, payload) {
  const response = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
try {
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (server.exitCode !== null) throw new Error(`测试服务退出：${logs}`);
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
  for (const scenario of [
    'wrong',
    'nulls',
    'date',
    'long',
    'oversize',
    'badjson',
  ]) {
    const result = await capture(scenario);
    assert.equal(result.mode, 'rules');
    assert.equal(result.extraction.role, '研发岗');
    assert.equal(result.extraction.tasks.length, 3);
    assert.ok(result.warning.includes('自动改用本地规则'));
  }
  const valid = await capture('valid');
  assert.equal(valid.mode, 'ai');
  assert.equal(valid.extraction.deadline, '2026-12-20T15:59:00.000Z');
  assert.equal(valid.extraction.evidence.specialNotes, undefined);
  assert.ok(valid.warning.includes('已移除'));
  console.log(
    'PASS 真实 API：六种坏响应回退；有效 AI 草稿规范化日期、移除伪证据，仅保存在临时库',
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', async (response) => {
    if (response.url().endsWith('/api/capture') && response.ok()) {
      const result = await response.json();
      draftIds.add(result.id);
    }
  });
  await page.goto(base);
  async function openDraft(scenario, viaLink = false) {
    await page.getByRole('button', { name: '收集岗位', exact: true }).click();
    const dialog = page.getByRole('dialog');
    if (viaLink) {
      await dialog
        .getByRole('textbox', { name: /招聘链接/ })
        .fill(`https://jobs.example.com/${scenario}`);
      // Supply the deterministic fixture at the network boundary. The browser
      // starts with an empty textarea, as with a real link-only capture.
      await page.route(
        '**/api/capture',
        async (route) => {
          await route.continue({
            postData: JSON.stringify({
              ...route.request().postDataJSON(),
              text: `${source}\nAICASE:${scenario}`,
            }),
          });
        },
        { times: 1 },
      );
    } else {
      await dialog
        .getByRole('textbox', { name: /招聘正文/ })
        .fill(`${source}\nAICASE:${scenario}`);
    }
    await dialog
      .getByRole('button', { name: '整理岗位信息', exact: true })
      .click();
    await dialog
      .getByRole('heading', { name: '把岗位变成可执行计划', exact: true })
      .waitFor();
    return page.getByRole('dialog').filter({
      has: page.getByRole('heading', {
        name: '把岗位变成可执行计划',
        exact: true,
      }),
    });
  }
  for (const scenario of ['wrong', 'nulls', 'date', 'long']) {
    const dialog = await openDraft(scenario);
    await dialog.getByText('本地规则 · 请核对', { exact: true }).waitFor();
    assert.equal(
      await dialog
        .getByRole('textbox', { name: '岗位 *', exact: true })
        .inputValue(),
      '研发岗',
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  }
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n,
    0,
  );
  console.log(
    'PASS Chrome：错误数组/空值/日期/超长内容不崩溃；取消不会创建机会',
  );

  const dialog = await openDraft('valid', true);
  await dialog.getByText('AI 草稿 · 已通过结构校验', { exact: true }).waitFor();
  assert.ok(
    await dialog.evaluate(
      (element) => element.getBoundingClientRect().width >= 800,
    ),
    '桌面草稿宽度被错误限制',
  );
  assert.equal(
    await dialog.getByText('提取时原文：“星河科技”', { exact: true }).count(),
    1,
  );
  assert.ok((await dialog.innerText()).includes('不是系统验证的准确率'));
  await dialog.locator('.overflow-y-auto').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(resolved, 'ai-draft-desktop.png') });
  await dialog
    .getByText('提取时的字段依据 · 材料、任务与判断线索', { exact: true })
    .click();
  assert.equal(
    await dialog.getByText('材料要求 · 提取时第 1 项', { exact: true }).count(),
    1,
  );
  assert.equal(
    await dialog.getByText('凭空编造的注意事项', { exact: true }).count(),
    0,
  );
  await page.screenshot({ path: path.join(resolved, 'ai-draft-evidence.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await dialog.locator('.overflow-y-auto').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(resolved, 'ai-draft-mobile.png') });
  assert.ok(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    '草稿在窄屏横向溢出',
  );
  assert.ok(
    await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    }),
    '草稿边界超出窄屏视口',
  );
  assert.ok(
    await dialog.locator('[data-slot="dialog-footer"]').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    }),
    '保存按钮容器超出窄屏视口',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const latestDraft = disk
    .prepare('SELECT id FROM extraction_drafts ORDER BY rowid DESC LIMIT 1')
    .get().id;
  const draftCount = disk
    .prepare('SELECT COUNT(*) AS n FROM extraction_drafts')
    .get().n;
  await dialog.getByRole('button', { name: '返回来源', exact: true }).click();
  const sourceDialog = page.getByRole('dialog');
  const sourceInput = sourceDialog.getByRole('textbox', { name: /招聘正文/ });
  assert.equal(await sourceInput.inputValue(), `${source}\nAICASE:valid`);
  const revisedSource = `${source}\nAICASE:valid\n补充：请核对材料。`;
  await sourceInput.fill(revisedSource);
  await page.route(
    '**/api/capture',
    async (route) => {
      await route.fulfill({
        status: 422,
        json: { error: '读取失败夹具', guidance: '正文保留' },
      });
    },
    { times: 1 },
  );
  await sourceDialog
    .getByRole('button', { name: '整理岗位信息', exact: true })
    .click();
  await sourceDialog.getByText('读取失败夹具', { exact: true }).waitFor();
  assert.equal(await sourceInput.inputValue(), revisedSource);
  await sourceDialog
    .getByRole('button', { name: '整理岗位信息', exact: true })
    .click();
  await dialog
    .getByRole('heading', { name: '把岗位变成可执行计划', exact: true })
    .waitFor();
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM extraction_drafts').get().n,
    draftCount,
  );
  assert.equal(
    disk
      .prepare('SELECT source_text FROM extraction_drafts WHERE id=?')
      .get(latestDraft).source_text,
    revisedSource,
  );
  console.log(
    'PASS Chrome：返回原文、失败重试保留正文；再次整理更新原草稿，不增加待确认记录',
  );
  await dialog
    .getByRole('textbox', { name: '公司 / 组织 *', exact: true })
    .fill('手动修正组织');
  await dialog
    .getByRole('button', { name: '保存到机会库', exact: true })
    .click();
  await dialog.waitFor({ state: 'hidden' });
  const row = disk
    .prepare('SELECT id, organization, deadline FROM opportunities')
    .get();
  opportunityIds.add(row.id);
  assert.equal(row.organization, '手动修正组织');
  assert.equal(
    disk
      .prepare('SELECT status FROM extraction_drafts WHERE id=?')
      .get(latestDraft).status,
    'confirmed',
  );
  assert.equal(
    new Date(row.deadline).toISOString(),
    '2026-12-20T15:59:00.000Z',
  );
  const persisted = disk
    .prepare('SELECT title, due_at, source FROM tasks WHERE opportunity_id = ?')
    .all(row.id);
  assert.deepEqual(
    persisted
      .filter((item) => item.source === 'ai')
      .map((item) => [item.title, item.source]),
    [['准备简历', 'ai']],
  );
  const planned = disk
    .prepare(
      'SELECT t.title,t.due_at,o.next_action,o.next_action_at FROM tasks t JOIN opportunities o ON o.id=t.opportunity_id WHERE t.opportunity_id=? AND t.is_next_action=1',
    )
    .all(row.id);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].title, planned[0].next_action);
  assert.equal(planned[0].due_at, planned[0].next_action_at);
  await page.reload();
  assert.ok((await page.request.get(`${base}/api/state`)).ok());
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n,
    1,
  );
  const longDescription = Array.from(
    { length: 100 },
    (_, i) => `岗位职责第${i + 1}条：核对招聘原文与任职要求。`,
  ).join('\n');
  await action('updateOpportunity', {
    id: row.id,
    description: longDescription,
  });
  await page.reload();
  await page
    .getByRole('button', { name: /机会库/ })
    .first()
    .click();
  await page
    .getByRole('button')
    .filter({ hasText: '手动修正组织' })
    .last()
    .click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: '岗位原文', exact: true }).click();
  const scroller = page.locator('[data-slot="sheet-content"]');
  await scroller.evaluate((el) => {
    el.scrollTop = 1300;
  });
  assert.ok((await scroller.evaluate((el) => el.scrollTop)) > 1000);
  await sheet.getByRole('button', { name: '决策与行动', exact: true }).click();
  assert.equal(await scroller.evaluate((el) => el.scrollTop), 0);
  await sheet.getByRole('button', { name: '编辑', exact: true }).click();
  await sheet
    .getByRole('textbox', { name: '岗位', exact: true })
    .fill('跨标签编辑岗位');
  await sheet.getByRole('button', { name: '岗位原文', exact: true }).click();
  assert.equal(
    await sheet.getByRole('textbox', { name: '岗位', exact: true }).count(),
    0,
  );
  await sheet
    .getByRole('textbox', { name: '个人备注', exact: true })
    .fill('跨标签编辑备注');
  await sheet.getByRole('button', { name: '节点与记录', exact: true }).click();
  await sheet
    .getByRole('heading', { name: '招聘节点', exact: false })
    .waitFor();
  assert.equal(
    await sheet.getByRole('textbox', { name: '岗位正文', exact: true }).count(),
    0,
  );
  await sheet.getByRole('button', { name: '决策与行动', exact: true }).click();
  assert.equal(
    await sheet
      .getByRole('textbox', { name: '岗位', exact: true })
      .inputValue(),
    '跨标签编辑岗位',
  );
  await sheet.getByRole('button', { name: '岗位原文', exact: true }).click();
  assert.equal(
    await sheet
      .getByRole('textbox', { name: '个人备注', exact: true })
      .inputValue(),
    '跨标签编辑备注',
  );
  await sheet
    .getByRole('button', { name: '保存全部修改', exact: true })
    .click();
  await sheet.getByRole('button', { name: '编辑', exact: true }).waitFor();
  assert.deepEqual(
    disk.prepare('SELECT role,notes FROM opportunities WHERE id=?').get(row.id),
    { role: '跨标签编辑岗位', notes: '跨标签编辑备注' },
  );
  await sheet.getByRole('button', { name: '决策与行动', exact: true }).click();
  assert.equal(await scroller.evaluate((el) => el.scrollTop), 0);
  await page.screenshot({ path: path.join(resolved, 'fixed-detail-tabs.png') });
  console.log(
    'PASS Chrome：编辑期间三个标签显示对应内容，跨标签输入保留并一起保存，长正文切换回顶部',
  );
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  const savedCalls = providerCalls;
  const savedDraftCount = disk
    .prepare('SELECT COUNT(*) AS n FROM extraction_drafts')
    .get().n;
  await page.getByRole('button', { name: '收集岗位', exact: true }).click();
  const duplicateDialog = page.getByRole('dialog');
  const duplicateUrl = 'https://jobs.example.com/valid?utm_source=share#detail';
  await duplicateDialog
    .getByRole('textbox', { name: /招聘链接/ })
    .fill(duplicateUrl);
  await duplicateDialog
    .getByRole('button', { name: '整理岗位信息', exact: true })
    .click();
  await duplicateDialog
    .getByRole('alert')
    .getByText('该机会已在机会库中，请勿重复添加。', { exact: true })
    .waitFor();
  assert.equal(providerCalls, savedCalls);
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM extraction_drafts').get().n,
    savedDraftCount,
  );
  assert.equal(
    await duplicateDialog
      .getByRole('textbox', { name: /招聘链接/ })
      .inputValue(),
    duplicateUrl,
  );
  await page.screenshot({
    path: path.join(resolved, 'duplicate-opportunity.png'),
  });
  await page.route(
    '**/api/state',
    async (route) => {
      await route.fulfill({ status: 503, json: { error: '读取失败夹具' } });
    },
    { times: 1 },
  );
  await duplicateDialog
    .getByRole('button', { name: '查看已有机会', exact: true })
    .click();
  await duplicateDialog
    .getByRole('alert')
    .getByText('暂时无法读取机会库，请重试。当前输入已保留。', { exact: false })
    .waitFor();
  assert.equal(
    await duplicateDialog
      .getByRole('textbox', { name: /招聘链接/ })
      .inputValue(),
    duplicateUrl,
  );
  await duplicateDialog
    .getByRole('button', { name: '查看已有机会', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('heading', { name: '跨标签编辑岗位', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '收集岗位', exact: true }).click();
  const textDuplicate = page.getByRole('dialog');
  await textDuplicate
    .getByRole('textbox', { name: /招聘正文/ })
    .fill('手动修正组织｜跨标签编辑岗位\n岗位职责：核对材料。');
  await textDuplicate
    .getByRole('button', { name: '整理岗位信息', exact: true })
    .click();
  await textDuplicate
    .getByRole('alert')
    .getByText('该机会已在机会库中，请勿重复添加。', { exact: true })
    .waitFor();
  assert.equal(providerCalls, savedCalls);
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM extraction_drafts').get().n,
    savedDraftCount,
  );
  await page.keyboard.press('Escape');
  await textDuplicate.waitFor({ state: 'hidden' });
  // Another window creates the opportunity after the preview but before saving.
  const racedDraft = await openDraft('valid');
  const racedOpportunity = await action('createOpportunity', {
    organization: '星河科技',
    role: '研发岗',
  });
  opportunityIds.add(racedOpportunity.id);
  await racedDraft
    .getByRole('button', { name: '保存到机会库', exact: true })
    .click();
  await racedDraft
    .getByRole('alert')
    .getByText('该机会已在机会库中，请勿重复添加。', { exact: true })
    .waitFor();
  assert.equal(
    await racedDraft
      .getByRole('button', { name: '保存到机会库', exact: true })
      .isDisabled(),
    true,
  );
  await racedDraft
    .getByRole('button', { name: '查看已有机会', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('heading', { name: '研发岗', exact: true })
    .waitFor();
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n,
    2,
  );
  console.log(
    'PASS Chrome：重复链接/正文提取前提示且不调用 AI、不建草稿；可打开已有机会；保存期间新增同岗位仍被拦截',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS Chrome：显示真实字段证据与模型自评边界，手动纠正后保存/刷新仍保留；桌面与窄屏无溢出或页面异常',
  );
  console.log(
    `PASS ${providerCalls} 次请求全部命中自建模拟接口，未使用真实 AI；截图位于 ${resolved}`,
  );
} finally {
  if (browser) await browser.close();
  try {
    if (disk)
      for (const row of disk.prepare('SELECT id FROM opportunities').all())
        opportunityIds.add(row.id);
    for (const id of opportunityIds) await action('deleteOpportunity', { id });
    for (const id of draftIds) {
      // Confirmed drafts are immutable audit records, not cancellable forms.
      // The whole owned test DB is removed by the suite after attachments.
      const draft = disk
        .prepare('SELECT status FROM extraction_drafts WHERE id = ?')
        .get(id);
      if (draft?.status === 'pending') {
        const saved = await (
          await fetch(
            base + '/api/state?section=draft&id=' + encodeURIComponent(id),
          )
        ).json();
        await action('discardDraft', {
          id,
          draftRevision: saved.draftRevision,
        });
      }
    }
  } finally {
    disk?.close();
    if (server.exitCode === null) {
      const ended = once(server, 'exit');
      server.kill('SIGTERM');
      await ended;
    }
    await new Promise((resolve) => provider.close(resolve));
  }
}
