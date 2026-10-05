import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

// Run against an isolated local server, never the user's everyday service.
const baseUrl = new URL(process.env.ZHAOPIN_TEST_BASE_URL || 'http://127.0.0.1:3109');
if (baseUrl.hostname !== '127.0.0.1' || !baseUrl.port || baseUrl.port === '3000') {
  throw new Error('回归检查仅允许隔离的 127.0.0.1 测试端口，禁止使用 3000 正式服务。');
}

const createdIds = [];
const tag = crypto.randomUUID().slice(0, 8);
let browser;
let page;

async function action(actionName, payload) {
  const response = await fetch(new URL('/api/action', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: actionName, payload }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function readOpportunities() {
  const response = await fetch(new URL('/api/state', baseUrl));
  assert.equal(response.status, 200);
  return (await response.json()).opportunities;
}

try {
  const a = { organization: `回归甲-${tag}`, role: '甲工程师', notes: '甲的备注', review: '甲的复盘' };
  const b = { organization: `回归乙-${tag}`, role: '乙工程师', notes: '乙的备注', review: '乙的复盘' };
  a.id = (await action('createOpportunity', a)).id;
  createdIds.push(a.id);
  b.id = (await action('createOpportunity', b)).id;
  createdIds.push(b.id);

  const hasSystemChrome = fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  browser = await chromium.launch({ headless: true, ...(hasSystemChrome ? { channel: 'chrome' } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl.href);
  await page.getByRole('button', { name: /机会库/ }).click();

  const dialog = () => page.getByRole('dialog');
  const open = async (organization) => {
    await page.getByRole('button').filter({ hasText: organization }).last().click();
    await dialog().waitFor();
  };
  const close = async () => {
    await page.keyboard.press('Escape');
    await dialog().waitFor({ state: 'hidden' });
  };
  const edit = () => dialog().getByRole('button', { name: '编辑', exact: true }).click();
  const source = () => dialog().getByRole('button', { name: '岗位原文', exact: true }).click();
  const notes = () => dialog().getByRole('textbox', { name: '个人备注', exact: true });
  const review = () => dialog().getByRole('textbox', { name: '复盘', exact: true });
  const save = async (label) => {
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/state') && response.request().method() === 'GET'),
      dialog().getByRole('button', { name: label, exact: true }).click(),
    ]);
  };

  await open(a.organization);
  await edit();
  await dialog().getByLabel('公司 / 组织', { exact: true }).fill('甲未保存的修改');
  await close();
  await open(b.organization);
  assert.equal(await dialog().getByRole('button', { name: '编辑', exact: true }).count(), 1);
  await edit();
  assert.equal(await dialog().getByLabel('公司 / 组织', { exact: true }).inputValue(), b.organization);
  assert.equal(await dialog().getByLabel('岗位', { exact: true }).inputValue(), b.role);
  await dialog().getByLabel('岗位', { exact: true }).fill('乙工程师已修改');
  await save('保存全部修改');
  let rows = await readOpportunities();
  assert.equal(rows.find((row) => row.id === a.id).organization, a.organization);
  assert.equal(rows.find((row) => row.id === b.id).organization, b.organization);
  assert.equal(rows.find((row) => row.id === b.id).role, '乙工程师已修改');
  await close();
  console.log('PASS 关闭甲的未保存编辑后，乙的数据和写入目标保持独立');

  await open(a.organization);
  await edit();
  await dialog().getByLabel('岗位', { exact: true }).fill('应当被取消的岗位');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await edit();
  assert.equal(await dialog().getByLabel('岗位', { exact: true }).inputValue(), a.role);
  await dialog().getByLabel('岗位', { exact: true }).fill('甲工程师已保存');
  await save('保存全部修改');
  await close();
  await open(b.organization);
  await source();
  assert.equal(await notes().inputValue(), b.notes);
  assert.equal(await review().inputValue(), b.review);
  assert.equal(await dialog().getByRole('button', { name: '保存备注', exact: true }).isDisabled(), true);
  rows = await readOpportunities();
  assert.equal(rows.find((row) => row.id === a.id).role, '甲工程师已保存');
  assert.equal(rows.find((row) => row.id === b.id).role, '乙工程师已修改');
  assert.equal(rows.find((row) => row.id === b.id).notes, b.notes);
  assert.equal(rows.find((row) => row.id === b.id).review, b.review);
  await close();
  console.log('PASS 取消编辑重新进入，以及保存甲后保存乙备注，均不串数据');

  await open(a.organization);
  await source();
  await notes().fill('甲未保存的备注');
  await review().fill('甲未保存的复盘');
  await close();
  await open(a.organization);
  await source();
  assert.equal(await notes().inputValue(), a.notes);
  assert.equal(await review().inputValue(), a.review);
  await close();
  await open(b.organization);
  await source();
  assert.equal(await notes().inputValue(), b.notes);
  assert.equal(await review().inputValue(), b.review);
  await notes().fill('乙自己的新备注');
  await save('保存备注');
  rows = await readOpportunities();
  assert.equal(rows.find((row) => row.id === a.id).notes, a.notes);
  assert.equal(rows.find((row) => row.id === b.id).notes, '乙自己的新备注');
  await close();
  console.log('PASS 未保存备注关闭后丢弃；再次打开和切换岗位不会带入旧内容');

  await open(a.organization);
  await dialog().getByPlaceholder('新增一个明确行动').fill('甲未提交任务');
  await dialog().getByRole('button', { name: /节点与记录/ }).click();
  await dialog().getByPlaceholder('例如：一面、体检、政审').fill('甲未提交节点');
  await dialog().getByPlaceholder('记录沟通、反馈或下一步…').fill('甲未提交记录');
  await close();
  await open(b.organization);
  assert.equal(await dialog().getByPlaceholder('新增一个明确行动').inputValue(), '');
  await dialog().getByRole('button', { name: /节点与记录/ }).click();
  assert.equal(await dialog().getByPlaceholder('例如：一面、体检、政审').inputValue(), '');
  assert.equal(await dialog().getByPlaceholder('记录沟通、反馈或下一步…').inputValue(), '');
  assert.deepEqual(pageErrors, []);
  console.log('PASS 任务、节点、记录和当前标签均按打开的岗位重置；无页面异常');
} catch (error) {
  if (page) console.error(await page.getByRole('dialog').ariaSnapshot().catch(() => '详情已关闭'));
  throw error;
} finally {
  if (browser) await browser.close();
  for (const id of createdIds) await action('deleteOpportunity', { id });
}
