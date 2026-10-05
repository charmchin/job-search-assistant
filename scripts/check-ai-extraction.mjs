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
  async function openDraft(scenario) {
    await page.getByRole('button', { name: '收集岗位', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('textbox', { name: /招聘正文/ })
      .fill(`${source}\nAICASE:${scenario}`);
    await dialog
      .getByRole('button', { name: '整理岗位信息', exact: true })
      .click();
    await dialog
      .getByRole('heading', { name: '把岗位变成可执行计划', exact: true })
      .waitFor();
    return page
      .getByRole('dialog')
      .filter({
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

  const dialog = await openDraft('valid');
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
      if (draft?.status === 'pending') await action('discardDraft', { id });
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
