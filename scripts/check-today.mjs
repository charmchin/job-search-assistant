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
assert.ok(!fs.existsSync(path.join(resolved, 'app.db')), '只允许全新临时库');
const port = Number(process.env.ZHAOPIN_TEST_PORT || 3112);
assert.ok(Number.isInteger(port) && port >= 3100 && port <= 3199);
const checker = http.createServer();
await new Promise((resolve, reject) =>
  checker.once('error', reject).listen(port, '127.0.0.1', resolve),
);
await new Promise((resolve) => checker.close(resolve));
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
let browser, page, disk;
async function action(action, payload) {
  const response = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
async function state() {
  const response = await fetch(`${base}/api/state`);
  assert.equal(response.status, 200);
  return response.json();
}
async function clearFixtures() {
  for (const row of disk.prepare('SELECT id FROM opportunities').all())
    await action('deleteOpportunity', { id: row.id });
  // No public delete-task action exists. Only this script's verified empty
  // temporary database is touched; remaining standalone fixtures are removed.
  disk.prepare('DELETE FROM tasks').run();
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
  disk = new Database(path.join(resolved, 'app.db'), { fileMustExist: true });
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM opportunities').get().n,
    0,
  );
  const anchor = new Date((await state()).now);
  const at = (hours) =>
    new Date(anchor.getTime() + hours * 3600000).toISOString();
  const opp = async (organization, extra = {}) =>
    (
      await action('createOpportunity', {
        organization,
        role: '研发岗',
        decision: 'pursue',
        stage: 'preparing',
        ...extra,
      })
    ).id;
  const task = async (title, opportunityId, hours) =>
    (await action('createTask', { title, opportunityId, dueAt: at(hours) })).id;
  const node = async (title, opportunityId, hours) =>
    (
      await action('createMilestone', {
        title,
        opportunityId,
        scheduledAt: at(hours),
      })
    ).id;
  const a = await opp('临近截止组织'),
    b = await opp('停滞组织');
  const early = await task('一小时内准备简历', a, 1),
    late = await task('两天后准备作品集', b, 48);
  disk
    .prepare('UPDATE opportunities SET last_activity_at=? WHERE id=?')
    .run(anchor.getTime() - 12 * 86400000, b);
  const ranked = (await state()).tasks;
  assert.ok(
    ranked.findIndex((t) => t.id === early) <
      ranked.findIndex((t) => t.id === late),
  );
  console.log('PASS 真实 API：一小时后到期排在两天后且停滞十二天的任务之前');

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
  const focus = page.getByTestId('today-focus'),
    queue = page.getByTestId('today-queue');
  const reload = async () => {
    await page.reload();
    await focus.waitFor();
  };
  const focusTitle = async (title) => {
    await focus.getByRole('heading', { name: title, exact: true }).waitFor();
  };
  await page.goto(base);
  await focusTitle('一小时内准备简历');
  let failedWrites = 0;
  await page.route('**/api/action', async (route) => {
    if (route.request().postDataJSON().action === 'updateTask') {
      failedWrites++;
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({ status: 503, json: { error: '模拟完成失败' } });
    } else await route.continue();
  });
  await focus.getByRole('button', { name: '完成这一步', exact: true }).click();
  assert.equal(
    await queue
      .getByRole('button', { name: '完成任务 一小时内准备简历', exact: true })
      .isDisabled(),
    true,
  );
  await queue
    .getByRole('button', { name: '完成任务 一小时内准备简历', exact: true })
    .evaluate((element) => element.click());
  await page.getByRole('alert').filter({ hasText: '模拟完成失败' }).waitFor();
  assert.equal(failedWrites, 1);
  await focusTitle('一小时内准备简历');
  await page.unroute('**/api/action');
  await focus.getByRole('button', { name: '完成这一步', exact: true }).click();
  await focusTitle('两天后准备作品集');
  assert.equal(
    disk.prepare('SELECT status FROM tasks WHERE id=?').get(early).status,
    'done',
  );
  console.log(
    'PASS Chrome：焦点/清单一致；失败不移除事项、可重试，双入口共用提交锁，完成后下一项接替',
  );

  await opp('刚收藏的待判断组织', { decision: 'undecided' });
  const deadline = await opp('半小时后截止组织', { deadline: at(0.5) });
  await reload();
  await focusTitle('核对投递截止与当前进度');
  assert.ok((await focus.innerText()).includes('半小时后截止组织'));
  assert.equal(
    await focus
      .getByRole('button', { name: '完成这一步', exact: true })
      .count(),
    0,
  );
  await focus
    .getByRole('button', { name: '打开机会工作区', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByText('半小时后截止组织', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  const interview = await opp('面试组织'),
    interviewId = await node('十五分钟后面试', interview, 0.25);
  const next = await opp('沟通组织', {
    nextAction: '六分钟后确认内推',
    nextActionAt: at(0.1),
  });
  await reload();
  await focusTitle('六分钟后确认内推');
  const nextTask = (await state()).tasks.find(
    (t) => t.opportunityId === next && t.isNextAction,
  );
  assert.ok(nextTask);
  assert.deepEqual(
    await queue
      .locator('[data-testid^="today-action-"]')
      .evaluateAll((elements) =>
        elements.map((element) => element.dataset.testid),
      ),
    [
      `today-action-nextAction:${nextTask.id}`,
      `today-action-milestone:${interviewId}`,
      `today-action-deadline:${deadline}`,
      `today-action-task:${late}`,
    ],
  );
  const risks = page.getByTestId('today-risks').getByRole('button');
  assert.ok((await risks.nth(0).innerText()).includes('沟通组织'));
  assert.ok((await risks.nth(1).innerText()).includes('面试组织'));
  await page.screenshot({ path: path.join(resolved, 'today-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(resolved, 'today-mobile.png') });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await focus.getByRole('button', { name: '完成这一步', exact: true }).click();
  await focusTitle('十五分钟后面试');
  assert.equal(
    disk.prepare('SELECT status FROM tasks WHERE id=?').get(nextTask.id).status,
    'done',
  );
  assert.equal(
    disk.prepare('SELECT next_action FROM opportunities WHERE id=?').get(next)
      .next_action,
    '',
  );
  await focus
    .getByRole('button', { name: '完成这个节点', exact: true })
    .click();
  await focusTitle('核对投递截止与当前进度');
  assert.equal(
    disk.prepare('SELECT status FROM milestones WHERE id=?').get(interviewId)
      .status,
    'done',
  );
  console.log(
    'PASS 四类事项统一排序/雷达；无任务的截止与面试仍能成为焦点；下一步绑定真实任务，节点完成正确写盘',
  );

  const offer = await opp('Offer 签约组织', {
    stage: 'offer',
    decision: 'undecided',
    deadline: at(-10),
  });
  await task('签约材料', offer, 0.2);
  await node('Offer 体检', offer, 0.3);
  for (const [name, extra] of [
    ['放弃组织', { decision: 'skip' }],
    ['未通过组织', { stage: 'closed' }],
  ]) {
    const id = await opp(name, { deadline: at(-20), ...extra });
    await task(`${name}隐藏任务`, id, -20);
    await node(`${name}隐藏节点`, id, -20);
  }
  const standalone = await task('独立的逾期行动', null, -2);
  await reload();
  await focusTitle('独立的逾期行动');
  assert.ok((await focus.innerText()).includes('独立行动'));
  assert.equal(
    await focus
      .getByRole('button', { name: '打开机会工作区', exact: true })
      .count(),
    0,
  );
  const queueText = await queue.innerText();
  assert.ok(!queueText.includes('隐藏'));
  assert.ok(!queueText.includes('旧投递'));
  assert.ok(queueText.includes('签约材料'));
  assert.ok(queueText.includes('Offer 体检'));
  await focus.getByRole('button', { name: '完成这一步', exact: true }).click();
  await focusTitle('签约材料');
  assert.equal(
    disk.prepare('SELECT status FROM tasks WHERE id=?').get(standalone).status,
    'done',
  );
  console.log(
    'PASS Offer 签约节点/任务保留，放弃全部排除；独立任务不再误关联其他岗位',
  );

  await clearFixtures();
  const onlyTask = await task('无岗位也能推进', null, 1);
  await reload();
  await focusTitle('无岗位也能推进');
  await focus.getByRole('button', { name: '完成这一步', exact: true }).click();
  await page
    .getByRole('heading', {
      name: '把每个岗位，变成一个清晰的决定和下一步。',
      exact: true,
    })
    .waitFor();
  assert.equal(
    disk.prepare('SELECT status FROM tasks WHERE id=?').get(onlyTask).status,
    'done',
  );
  await opp('所有记录已结束', { stage: 'closed' });
  await reload();
  await focusTitle('当前没有待推进事项');
  const fallback = await opp('需要做投入判断', { decision: 'undecided' });
  await reload();
  await focusTitle('判断这个岗位是否值得投入');
  for (let i = 1; i <= 8; i++) await task(`后续行动${i}`, fallback, 120 + i);
  await reload();
  assert.equal(
    await queue.locator('[data-testid^="today-action-"]').count(),
    7,
  );
  await queue
    .getByRole('button', { name: '查看全部 8 项', exact: true })
    .click();
  assert.equal(
    await queue.locator('[data-testid^="today-action-"]').count(),
    8,
  );
  await page.clock.setFixedTime(new Date(anchor.getTime() + 6 * 86400000));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await focus.getByText(/已逾期/).waitFor();
  await page
    .getByText(
      new Intl.DateTimeFormat('zh-CN', {
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        timeZone: 'Asia/Shanghai',
      }).format(new Date(anchor.getTime() + 6 * 86400000)),
      { exact: true },
    )
    .waitFor();
  await page.getByText('停滞需复查', { exact: true }).waitFor();
  assert.ok(
    (await page.getByTestId('today-risks').innerText()).includes('已逾期'),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(resolved, 'today-expanded-mobile.png'),
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  const longTitle = `核对${'VeryLongUnbrokenTaskTitle'.repeat(12)}`;
  const firstLaterTask = disk
    .prepare('SELECT id FROM tasks WHERE title=?')
    .get('后续行动1');
  await action('updateTask', { id: firstLaterTask.id, title: longTitle });
  await action('updateOpportunity', {
    id: fallback,
    organization: 'VeryLongUnbrokenOrganizationName'.repeat(8),
  });
  await reload();
  await focusTitle(longTitle);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.ok(
    await focus
      .getByRole('heading')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await clearFixtures();
  const future = await opp('远期截止组织', {
    decision: 'undecided',
    deadline: at(1800),
    nextAction: '先核对专业与准备简历',
  });
  await reload();
  await focusTitle('先核对专业与准备简历');
  const upcoming = page.getByTestId('today-upcoming');
  await upcoming.getByText('后续日程 · 1 项', { exact: true }).waitFor();
  assert.equal(
    await upcoming.getByTestId(`today-action-deadline:${future}`).isVisible(),
    false,
  );
  await upcoming.locator('summary').click();
  await upcoming.getByTestId(`today-action-deadline:${future}`).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: path.join(resolved, 'today-actionable-and-upcoming.png'),
  });
  await action('updateOpportunity', { id: future, stage: 'applied' });
  await reload();
  await focusTitle('先核对专业与准备简历');
  assert.equal(await page.getByTestId('today-upcoming').count(), 0);
  assert.equal(
    await queue.getByTestId(`today-action-deadline:${future}`).count(),
    0,
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(resolved, 'today-long-mobile.png') });
  assert.equal(
    disk.prepare('SELECT COUNT(*) AS n FROM reminder_deliveries').get().n,
    0,
  );
  console.log(
    `PASS 空状态/独立任务/待判断兜底/展开全清单/跨日重新分组，窄屏无横向溢出；截图位于 ${resolved}`,
  );
} catch (error) {
  if (page) {
    console.error(
      await page.evaluate(() =>
        [...document.querySelectorAll('main *')]
          .filter(
            (element) => element.getBoundingClientRect().right > innerWidth + 1,
          )
          .slice(0, 12)
          .map((element) => ({
            tag: element.tagName,
            class: element.className,
            width: element.getBoundingClientRect().width,
          })),
      ),
    );
    console.error(await page.locator('main').ariaSnapshot());
    await page.screenshot({ path: path.join(resolved, 'today-failure.png') });
  }
  throw error;
} finally {
  if (browser) await browser.close();
  try {
    if (disk) await clearFixtures();
  } finally {
    disk?.close();
    if (server.exitCode === null) {
      const ended = once(server, 'exit');
      server.kill('SIGTERM');
      await ended;
    }
  }
}
