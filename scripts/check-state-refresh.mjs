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
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3119);
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

try {
  await start();
  const a = await create('分页甲组织'),
    b = await create('分页乙组织');
  const due = new Date(Date.now() + 12 * 3600000).toISOString();
  await action('createTask', {
    opportunityId: a,
    title: '自动刷新行动',
    dueAt: due,
  });
  const captured = await fetch(base + '/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '公司：草稿组织\n岗位：开发工程师\n地点：杭州\n岗位职责：开发软件。任职要求：计算机专业。',
    }),
  });
  const template = await captured.json();
  assert.equal(captured.status, 200);
  const disk = new Database(path.join(resolved, 'app.db'));
  disk.pragma('foreign_keys=ON');
  disk.transaction(() => {
    disk.prepare('DELETE FROM extraction_drafts WHERE id=?').run(template.id);
    const insert = disk.prepare(
      'INSERT INTO activities (id,opportunity_id,type,content,created_at) VALUES (?,?,?,?,?)',
    );
    for (let i = 0; i < 45; i++)
      insert.run(
        'paging-a-' + String(i).padStart(3, '0'),
        a,
        'note',
        '历史记录' + i,
        1000,
      );
    insert.run('paging-b-only', b, 'note', '乙组织专属记录', 1000);
    const drafts = disk.prepare(
      'INSERT INTO extraction_drafts (id,source_text,extracted_json,created_at) VALUES (?,?,?,?)',
    );
    for (let i = 0; i < 45; i++) {
      drafts.run(
        'paging-draft-' + String(i).padStart(3, '0'),
        '草稿原文保密标记',
        JSON.stringify({
          ...template.extraction,
          organization: '草稿' + String(i).padStart(3, '0'),
        }),
        1000,
      );
    }
  })();
  disk.close();
  const core = await state();
  assert.equal(core.pendingDraftCount, 45);
  assert.deepEqual(core.drafts, []);
  assert.ok(core.opportunities.every((o) => o.activities.length === 0));
  assert.ok(!JSON.stringify(core).includes('草稿原文保密标记'));
  for (const query of [
    'section=drafts&limit=999',
    'section=activities',
    'section=drafts&cursor=invalid',
  ]) {
    assert.equal((await fetch(base + '/api/state?' + query)).status, 400);
  }
  assert.equal(
    (
      await fetch(base + '/api/state?section=drafts', {
        headers: { Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let reads = 0;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/state' && !new URL(r.url()).search)
      reads++;
  });
  await page.clock.install({ time: Date.now() });
  await page.goto(base);
  await page.getByTestId('today-focus').waitFor();
  await openOwner('分页甲组织');
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: '节点与记录', exact: false }).click();
  const records = page.getByRole('region', { name: '推进记录列表' });
  await expect(records).toContainText('已显示 20 条');
  await expect(records).toContainText('历史记录44');
  let failPage = true;
  const pageFailure = async (route) => {
    if (failPage && new URL(route.request().url()).searchParams.has('cursor')) {
      failPage = false;
      await route.fulfill({ status: 503, json: { error: '分页失败夹具' } });
    } else await route.continue();
  };
  await page.route('**/api/state?section=activities**', pageFailure);
  await records
    .getByRole('button', { name: '加载更早记录', exact: true })
    .click();
  await expect(records.getByRole('alert')).toContainText('分页失败夹具');
  await expect(records).toContainText('已显示 20 条');
  await records.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(records).toContainText('已显示 40 条');
  await records
    .getByRole('button', { name: '加载更早记录', exact: true })
    .click();
  // Creation and task activity + 45 historical fixture records.
  await expect(records).toContainText('已显示 47 条');
  await expect(records).toContainText('历史记录0');
  await expect(
    records.getByRole('button', { name: '加载更早记录', exact: true }),
  ).toHaveCount(0);
  await page.unroute('**/api/state?section=activities**', pageFailure);
  await page.screenshot({
    path: path.join(resolved, 'state-activities-desktop.png'),
  });
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();

  await openOwner('分页乙组织');
  await sheet.getByRole('button', { name: '节点与记录', exact: false }).click();
  await expect(records).toContainText('乙组织专属记录');
  await expect(records).not.toContainText('历史记录');
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  console.log(
    'PASS 真实分页、同时间顺序、读取失败保留/重试、切换归属与完整历史',
  );

  await nav('机会库');
  await page.getByRole('button', { name: '查看草稿', exact: true }).click();
  const drafts = page.getByLabel('待确认草稿列表');
  await expect(drafts).toContainText('草稿044');
  await drafts
    .getByRole('button', { name: '加载更早记录', exact: true })
    .click();
  await expect(drafts).toContainText('草稿005');
  await drafts
    .getByRole('button', { name: '加载更早记录', exact: true })
    .click();
  await expect(drafts).toContainText('草稿000');
  // The extraction adapter can infer a different role; select the row by its unique organization instead.
  const matching = drafts.getByText(/草稿044 ·/).locator('../..');
  await matching.getByRole('button', { name: '继续核对', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: '公司 / 组织 *', exact: true }),
  ).toHaveValue('草稿044');
  await expect(page.getByRole('dialog')).toContainText('保存的草稿 · 请核对');
  await page
    .getByRole('textbox', { name: '岗位 *', exact: true })
    .fill('开发工程师');
  await page.getByRole('button', { name: '保存到机会库', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('草稿044');
  assert.equal((await state()).pendingDraftCount, 44);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  // Starting a new capture must not reopen the last resumed draft.
  await page.getByRole('button', { name: '收集岗位', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('收集一个招聘岗位');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  if (await page.getByRole('button', { name: '查看草稿', exact: true }).count())
    await page.getByRole('button', { name: '查看草稿', exact: true }).click();
  page.once('dialog', (d) => d.dismiss());
  await page
    .getByLabel('待确认草稿列表')
    .getByRole('button', { name: '移除草稿', exact: true })
    .first()
    .click();
  assert.equal((await state()).pendingDraftCount, 44);
  page.once('dialog', (d) => d.accept());
  await page
    .getByLabel('待确认草稿列表')
    .getByRole('button', { name: '移除草稿', exact: true })
    .first()
    .click();
  await expect.poll(async () => (await state()).pendingDraftCount).toBe(43);
  await page.setViewportSize({ width: 390, height: 844 });
  // Re-enter at the real narrow viewport, rather than capture a compositor
  // frame immediately after resizing a long, already-open desktop list.
  await page.reload();
  await page
    .getByRole('heading', { name: '今天，推进最重要的一步', exact: true })
    .waitFor();
  await page.locator('header').getByRole('button').first().click();
  await nav('机会库');
  await page.getByRole('button', { name: '查看草稿', exact: true }).click();
  await expect(page.getByLabel('待确认草稿列表')).toContainText('草稿042');
  await expect(page.locator('main')).toHaveCount(1);
  await expect(
    page.getByRole('heading', {
      name: '机会不是收藏，是要做的决定',
      exact: true,
    }),
  ).toHaveCount(1);
  await page.clock.runFor(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(resolved, 'state-drafts-mobile.png'),
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('PASS 草稿轻量分页、继续核对/确认、取消/移除、新收集会话与窄屏');

  await openOwner('分页甲组织');
  await sheet.getByRole('button', { name: '编辑', exact: true }).click();
  const organization = sheet.getByLabel('公司 / 组织', { exact: true });
  await organization.fill('未保存编辑不会丢');
  await action('updateOpportunity', {
    id: b,
    nextAction: '另一窗口推进的下一步',
  });
  const beforePoll = reads;
  await page.clock.fastForward(61000);
  await expect.poll(() => reads).toBeGreaterThan(beforePoll);
  await expect(page.locator('main')).toContainText('另一窗口推进的下一步');
  await expect(organization).toHaveValue('未保存编辑不会丢');
  await sheet.getByRole('button', { name: '取消', exact: true }).click();
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  const beforeFocus = reads;
  await action('updateOpportunity', {
    id: b,
    nextAction: '聚焦刷新写入的下一步',
  });
  await page.clock.fastForward(1100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => reads).toBeGreaterThan(beforeFocus);
  await expect(page.locator('main')).toContainText('聚焦刷新写入的下一步');
  let offline = true;
  const failure = async (route) => {
    if (offline && !new URL(route.request().url()).search) {
      offline = false;
      await route.fulfill({ status: 503, json: { error: '读取失败夹具' } });
    } else await route.continue();
  };
  await page.route('**/api/state', failure);
  await page.clock.fastForward(61000);
  await expect(page.getByTestId('workspace-save-status')).toContainText(
    '暂时无法读取',
  );
  await expect(
    page.getByRole('heading', {
      name: '机会不是收藏，是要做的决定',
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: '重试刷新', exact: true }).click();
  await expect(page.getByTestId('workspace-save-status')).toHaveCount(0);
  await page.unroute('**/api/state', failure);
  assert.deepEqual(errors, []);
  console.log(
    'PASS 前台周期与聚焦刷新、编辑输入保留、后台失败旧数据保留与显式重试',
  );
} catch (error) {
  console.error(logs);
  if (page) {
    console.error(await page.locator('body').ariaSnapshot());
    await page.screenshot({ path: path.join(resolved, 'state-failure.png') });
  }
  throw error;
} finally {
  await browser?.close();
  await stop();
}
