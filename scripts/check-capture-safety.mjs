import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const baseUrl = new URL(process.env.ZHAOPIN_TEST_BASE_URL || 'http://127.0.0.1:3109');
const dataDir = process.env.ZHAOPIN_TEST_DATA_DIR;
if (baseUrl.hostname !== '127.0.0.1' || !baseUrl.port || baseUrl.port === '3000' || !dataDir) throw new Error('必须使用独立本机测试端口和 ZHAOPIN_TEST_DATA_DIR，不能使用正式 3000 服务。');
const resolvedDir = fs.realpathSync(dataDir);
assert.ok([os.tmpdir(), '/tmp'].some((root) => resolvedDir.startsWith(`${fs.realpathSync(root)}${path.sep}`)) && path.basename(resolvedDir).startsWith('zhaopin-'));
const disk = new Database(path.join(resolvedDir, 'app.db'), { readonly: true, fileMustExist: true });
assert.equal(disk.prepare('SELECT COUNT(*) AS count FROM opportunities').get().count, 0, '测试库不能有用户机会');
assert.equal(disk.prepare('SELECT COUNT(*) AS count FROM settings').get().count, 0, '测试库必须不配置 AI');
const draftIds = new Set();
let browser;
let requestsToTrap = 0;
// This is our own disposable listener, not a probe of an existing local service.
const trap = http.createServer((_request, response) => { requestsToTrap++; response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('不应被抓取的本机内容'); });
await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve));
const trapUrl = `http://127.0.0.1:${trap.address().port}/job`;
const text = '安全回归组织｜研发工程师\n工作地点：上海\n岗位职责：负责服务端开发、测试和质量管理。\n任职要求：硕士学历，熟悉 TypeScript 与数据库。\n申请材料：简历和成绩单。\n网申截止：2026年12月20日';

async function capture(url, sourceText = '') {
  const response = await fetch(new URL('/api/capture', baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, text: sourceText }) });
  const body = await response.json();
  if (body.id) {
    assert.ok(disk.prepare('SELECT id FROM extraction_drafts WHERE id = ?').get(body.id), '服务没有使用指定临时库');
    draftIds.add(body.id);
  }
  return { status: response.status, body };
}

try {
  for (const url of [trapUrl, 'http://[::1]/job', 'http://[::ffff:127.0.0.1]/job', 'http://2130706433/job', 'http://169.254.169.254/', 'https://example.com:8443/job']) {
    const result = await capture(url);
    assert.equal(result.status, 422); assert.equal(result.body.code, 'PAGE_UNSAFE_URL');
    assert.equal(result.body.needsText, true); assert.equal(result.body.id, undefined);
  }
  assert.equal(requestsToTrap, 0);
  console.log('PASS 真实 API 拒绝 IPv4/IPv6/映射/编码地址及危险端口；自建本机监听器未收到请求');

  const pasted = await capture(trapUrl, text);
  assert.equal(pasted.status, 200); assert.equal(pasted.body.mode, 'rules');
  assert.equal(pasted.body.extraction.organization, '安全回归组织'); assert.equal(requestsToTrap, 0);
  console.log('PASS 保留被拦截链接后粘贴正文可继续，不访问该链接，不调用 AI');

  const publicPage = await capture('https://example.com/');
  assert.equal(publicPage.status, 200, JSON.stringify(publicPage.body));
  assert.equal(publicPage.body.adapter, 'html'); assert.equal(publicPage.body.mode, 'rules');
  const tencent = await capture('https://careers.tencent.com/jobdesc.html?postId=1670301957484453888');
  assert.equal(tencent.status, 200, JSON.stringify(tencent.body));
  assert.equal(tencent.body.adapter, 'tencent'); assert.equal(tencent.body.extraction.organization, '腾讯');
  assert.ok(tencent.body.extraction.role); assert.equal(tencent.body.mode, 'rules');
  console.log('PASS 真实公开 HTML 和腾讯岗位接口均能生成草稿，不创建正式机会');

  browser = await chromium.launch({ headless: true, ...(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', async (response) => {
    if (response.url().endsWith('/api/capture') && response.ok()) {
      const body = await response.json(); if (body.id) draftIds.add(body.id);
    }
  });
  await page.goto(baseUrl.href);
  await page.getByRole('button', { name: '收集岗位', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const linkInput = dialog.getByRole('textbox', { name: /招聘链接/ });
  await linkInput.fill(trapUrl);
  await dialog.getByRole('button', { name: '整理岗位信息', exact: true }).click();
  await dialog.getByText('为保护本机安全，不能读取这个地址', { exact: true }).waitFor();
  assert.equal(await linkInput.inputValue(), trapUrl);
  await dialog.getByRole('textbox', { name: /招聘正文/ }).fill(text);
  await dialog.getByRole('button', { name: '整理岗位信息', exact: true }).click();
  await dialog.getByRole('heading', { name: '把岗位变成可执行计划', exact: true }).waitFor();
  await dialog.getByText('粘贴正文 · 已解析', { exact: true }).waitFor();
  assert.equal(requestsToTrap, 0); assert.deepEqual(pageErrors, []);
  assert.equal(disk.prepare('SELECT COUNT(*) AS count FROM opportunities').get().count, 0);
  console.log('PASS 浏览器清楚提示安全拦截、保留原链接，粘贴后可核对草稿；无页面异常');
} finally {
  if (browser) await browser.close();
  for (const id of draftIds) {
    const saved = await (await fetch(new URL('/api/state?section=draft&id=' + encodeURIComponent(id), baseUrl))).json();
    const response = await fetch(new URL('/api/action', baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'discardDraft', payload: { id, draftRevision: saved.draftRevision } }) });
    assert.equal(response.status, 200);
  }
  disk.close();
  await new Promise((resolve) => trap.close(resolve));
}
