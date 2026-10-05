import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

// Explicit isolation is required because restore replaces every application table.
const baseUrl = new URL(process.env.ZHAOPIN_TEST_BASE_URL || 'http://127.0.0.1:3109');
const dataDir = process.env.ZHAOPIN_TEST_DATA_DIR;
if (baseUrl.hostname !== '127.0.0.1' || !baseUrl.port || baseUrl.port === '3000' || !dataDir) {
  throw new Error('仅允许独立本机测试端口，且必须设置 ZHAOPIN_TEST_DATA_DIR，禁止使用 3000 正式服务。');
}
const resolvedDir = fs.realpathSync(dataDir);
const tempRoots = [os.tmpdir(), '/tmp'].map((root) => fs.realpathSync(root));
assert.ok(tempRoots.some((root) => resolvedDir.startsWith(`${root}${path.sep}`)) && path.basename(resolvedDir).startsWith('zhaopin-'), '必须使用 zhaopin- 开头的临时数据库目录');
const disk = new Database(path.join(resolvedDir, 'app.db'), { readonly: true, fileMustExist: true });
const applicationTables = ['opportunities', 'materials', 'tasks', 'milestones', 'material_requirements', 'activities', 'extraction_drafts', 'reminder_deliveries', 'settings'];
for (const table of applicationTables) assert.equal(disk.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, '测试数据库必须为空');

const request = async (url, options = {}) => {
  const response = await fetch(new URL(url, baseUrl), options);
  return { status: response.status, body: await response.json() };
};
const exported = async () => {
  const response = await request('/api/export?format=json');
  assert.equal(response.status, 200); return response.body;
};
const action = async (actionName, payload) => {
  const response = await request('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: actionName, payload }) });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
};
const restore = (backup) => request('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
const isoText = '2026-10-02T10:00:00+08:00';
let original;
let createdId;
let verifiedIsolation = false;
let browser;

try {
  original = await exported();
  assert.ok(Object.values(original.data).every((rows) => rows.length === 0), '服务数据库也必须为空');
  createdId = (await action('createOpportunity', {
    organization: '备份回归组织', role: '备份回归岗位', notes: isoText, review: '中文复盘', description: '岗位正文 😀',
    tags: ['校招', isoText], nextActionAt: '2026-10-05T09:30:00+08:00',
    tasks: [{ title: '备份关联任务', source: 'manual', dueAt: '2026-10-05T09:30:00+08:00' }], requirements: [{ name: '简历' }],
  })).id;
  assert.ok(disk.prepare('SELECT id FROM opportunities WHERE id = ?').get(createdId), '服务没有使用指定的临时数据库，拒绝进行恢复');
  verifiedIsolation = true;
  const materialId = (await action('createMaterial', { name: '测试简历', filePath: '/tmp/缺失的简历.pdf', version: isoText })).id;
  const requirementId = (await exported()).data.materialRequirements[0].id;
  await action('updateRequirement', { id: requirementId, materialId, completed: true });
  await action('createMilestone', { opportunityId: createdId, title: '测试面试', scheduledAt: '2026-10-05T09:30:00+08:00' });
  await action('saveSettings', { baseUrl: 'https://example.invalid/v1', model: isoText, staleDays: 11 });
  const backup = await exported();
  await action('deleteOpportunity', { id: createdId });
  const result = await restore(backup);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual((await exported()).data, backup.data);
  assert.equal((await request('/api/state')).status, 200);
  const snapshot = new Database(result.body.snapshotPath, { readonly: true });
  try { assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM opportunities').get().count, 0); }
  finally { snapshot.close(); }
  console.log('PASS 真实 API 导出→删除→恢复逐字段一致；WAL 快照可读；平台继续可用');

  for (const [field, value] of [['tags', 'not-json'], ['stage', 'wrong-stage'], ['deadline', '2026-02-30T00:00:00Z']]) {
    const invalid = structuredClone(backup);
    invalid.data.opportunities[0][field] = value;
    const rejected = await restore(invalid);
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /当前数据未修改/);
    assert.deepEqual((await exported()).data, backup.data);
    assert.equal((await request('/api/state')).status, 200);
  }
  console.log('PASS 无效标签、阶段和日期均在写入前拒绝，原数据保持完整');

  browser = await chromium.launch({ headless: true, ...(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? { channel: 'chrome' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let acceptConfirm = true;
  page.on('dialog', (dialog) => acceptConfirm ? dialog.accept() : dialog.dismiss());
  await page.goto(baseUrl.href);
  await page.getByRole('button', { name: '设置与数据', exact: true }).click();
  const input = page.getByLabel('选择 JSON 备份', { exact: true });
  const file = (name, payload) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
  const invalid = structuredClone(backup);
  invalid.data.opportunities[0].tags = 'not-json';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = page.waitForResponse((r) => r.url().endsWith('/api/import'));
    await input.setInputFiles(file('invalid.json', invalid));
    assert.equal((await response).status(), 400);
    await page.getByRole('alert').filter({ hasText: /tags.*当前数据未修改/ }).waitFor();
    assert.equal(await input.inputValue(), '');
  }
  assert.deepEqual((await exported()).data, backup.data);
  console.log('PASS 浏览器清楚显示字段校验错误，同一文件可修正后再次选择');

  acceptConfirm = false;
  const snapshotCount = fs.readdirSync(path.join(resolvedDir, 'backups')).length;
  await input.setInputFiles(file('cancel.json', backup));
  assert.equal(await input.inputValue(), '');
  assert.equal(fs.readdirSync(path.join(resolvedDir, 'backups')).length, snapshotCount);
  assert.deepEqual((await exported()).data, backup.data);
  acceptConfirm = true;

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/import', async (route) => { await gate; await route.continue(); });
  const response = page.waitForResponse((r) => r.url().endsWith('/api/import'));
  await input.setInputFiles(file('valid.json', backup));
  await page.getByText('正在校验并恢复…', { exact: true }).waitFor();
  assert.equal(await input.isDisabled(), true);
  release();
  assert.equal((await response).status(), 200);
  await page.getByRole('status').filter({ hasText: /恢复完成.*before-restore/ }).waitFor();
  await input.waitFor({ state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('input[type=file][aria-label="选择 JSON 备份"]').disabled);
  assert.equal(await page.getByLabel('停滞复查天数').inputValue(), '11');
  assert.equal(await page.getByLabel('模型名', { exact: true }).inputValue(), isoText);
  assert.deepEqual((await exported()).data, backup.data);
  await page.unroute('**/api/import');
  await page.screenshot({ path: path.join(resolvedDir, 'backup-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('数据与备份', { exact: true }).scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '窄屏出现横向溢出');
  await page.screenshot({ path: path.join(resolvedDir, 'backup-mobile.png') });
  console.log('PASS 取消恢复无副作用；恢复中禁止重复选择；完成提示快照路径并刷新数据和设置');

  await page.route('**/api/import', (route) => route.abort('failed'));
  await input.setInputFiles(file('network-failure.json', backup));
  await page.getByRole('alert').filter({ hasText: /无法确认恢复结果/ }).waitFor();
  assert.equal(await input.isDisabled(), false);
  assert.deepEqual((await exported()).data, backup.data);
  assert.deepEqual(pageErrors, []);
  console.log('PASS 网络异常有明确提示，不把结果未知误报为成功或未修改；无页面异常');
} catch (error) {
  console.error('备份回归检查失败：', error);
  throw error;
} finally {
  if (browser) await browser.close();
  disk.close();
  if (verifiedIsolation) {
    const response = await restore(original);
    assert.equal(response.status, 200, '测试数据清理失败');
    assert.deepEqual((await exported()).data, original.data);
  } else if (createdId) {
    await action('deleteOpportunity', { id: createdId });
  }
}
