import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupValidationError, createJsonBackup, MAX_BACKUP_BYTES, parseBackup, readBackupRequest, restoreBackup } from '@/lib/backup';

const isoText = '2026-10-02T10:00:00+08:00';
const dates = { createdAt: '2026-10-01T00:00:00.123Z', updatedAt: '2026-10-02T00:00:00.456Z' };
function fixture(prefix = 'fixture') {
  return {
    version: 1, exportedAt: '2026-10-02T00:00:00.000Z',
    data: {
      opportunities: [{
        id: `${prefix}-opp`, organization: ' 示例组织 ', role: '示例岗位', ...dates, lastActivityAt: dates.updatedAt,
        deadline: null, notes: isoText, review: '复盘\n第二行', description: '中文正文 😀',
        sourceName: isoText, tags: ['校招', isoText], highlights: ['亮点'], risks: [],
        nextActionAt: '2026-10-05T09:30:00+08:00', reminderDays: [7, 3, 1, 0],
      }],
      materials: [{ id: `${prefix}-mat`, name: '简历', ...dates, filePath: '/tmp/不存在的材料.pdf', version: isoText }],
      tasks: [
        { id: `${prefix}-task`, opportunityId: `${prefix}-opp`, title: '准备材料', ...dates, dueAt: dates.updatedAt },
        { id: `${prefix}-standalone`, opportunityId: null, title: '独立行动', ...dates, dueAt: null },
      ],
      milestones: [{ id: `${prefix}-mile`, opportunityId: `${prefix}-opp`, title: '一面', scheduledAt: dates.updatedAt, createdAt: dates.createdAt, result: isoText }],
      materialRequirements: [{ id: `${prefix}-req`, opportunityId: `${prefix}-opp`, materialId: `${prefix}-mat`, name: '中文简历', completed: true, notes: isoText }],
      activities: [{ id: `${prefix}-act`, opportunityId: `${prefix}-opp`, type: 'note', content: isoText, createdAt: dates.createdAt }],
      extractionDrafts: [{
        id: `${prefix}-draft`, sourceText: isoText, extractedJson: { organization: '示例组织', nested: { timeText: isoText }, tasks: [], confidence: 0.8 },
        evidenceJson: { organization: isoText }, confidence: 0.8, status: 'pending', createdAt: dates.createdAt,
      }],
      // Historical delivery records can refer to a deleted entity.
      reminderDeliveries: [{ id: `${prefix}-rem`, entityType: 'task', entityId: 'already-deleted', scheduledFor: dates.createdAt, deliveredAt: dates.updatedAt, deliveryKey: `${prefix}-delivery` }],
      settings: [{ key: 'staleDays', value: '5', updatedAt: dates.updatedAt }, { key: 'aiModel', value: isoText, updatedAt: dates.updatedAt }],
    },
  };
}

function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function change(table: keyof ReturnType<typeof fixture>['data'], field: string, value: unknown) {
  return (backup: ReturnType<typeof fixture>) => ({
    ...backup, data: { ...backup.data, [table]: backup.data[table].map((row, index) => index === 0 ? { ...row, [field]: value } : row) },
  });
}

describe('备份恢复的数据完整性（只使用内存数据库和临时快照目录）', () => {
  let client: Database.Database;
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaopin-backup-test-'));
    client = new Database(':memory:');
    client.pragma('foreign_keys = ON');
    for (const file of fs.readdirSync(path.resolve('drizzle')).filter((name) => name.endsWith('.sql')).sort()) {
      client.exec(fs.readFileSync(path.resolve('drizzle', file), 'utf8'));
    }
    restoreBackup(client, fixture('original'), directory);
  });
  afterEach(() => {
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const currentData = () => json(createJsonBackup(client)).data;

  it('九张表导出→恢复逐字段一致，ISO 样式普通文本不变', () => {
    const backup = json(createJsonBackup(client));
    const result = restoreBackup(client, backup, directory);
    expect(result.restored).toBe(true);
    expect(currentData()).toEqual(backup.data);
    expect(currentData().opportunities[0].notes).toBe(isoText);
    expect(client.prepare('SELECT typeof(notes) AS kind FROM opportunities').get()).toEqual({ kind: 'text' });
    expect(client.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(client.pragma('foreign_key_check')).toEqual([]);
  });
  it('下一步提醒类型及持久化检查游标可备份恢复', () => {
    const backup = json(createJsonBackup(client));
    backup.data.reminderDeliveries[0].entityType = 'nextAction';
    backup.data.settings.push({ key: 'reminders.cursor', value: '1790906400000', updatedAt: new Date(dates.updatedAt) });
    restoreBackup(client, backup, directory);
    expect(currentData().reminderDeliveries[0].entityType).toBe('nextAction');
    expect(currentData().settings.find((item) => item.key === 'reminders.cursor')?.value).toBe('1790906400000');
  });

  it('恢复前 JSON/SQLite 快照完整可读且仅当前用户可读写，可用 JSON 撤销恢复', () => {
    const original = currentData();
    const result = restoreBackup(client, fixture('replacement'), directory);
    const snapshot = new Database(result.snapshotPath, { readonly: true });
    try {
      expect(json(createJsonBackup(snapshot)).data).toEqual(original);
    } finally { snapshot.close(); }
    expect(fs.statSync(result.snapshotPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(result.recoveryBackupPath).mode & 0o777).toBe(0o600);
    const recovery = JSON.parse(fs.readFileSync(result.recoveryBackupPath, 'utf8'));
    expect(recovery.data).toEqual(original);
    restoreBackup(client, recovery, directory);
    expect(currentData()).toEqual(original);
  });

  const invalid: [string, (backup: ReturnType<typeof fixture>) => unknown][] = [
    ['字符串标签', change('opportunities', 'tags', 'not-json')],
    ['JSON 字符串冒充数组', change('opportunities', 'tags', '["校招"]')],
    ['null 标签', change('opportunities', 'tags', null)],
    ['混合类型标签', change('opportunities', 'tags', ['校招', 1])],
    ['无效阶段', change('opportunities', 'stage', 'not-a-stage')],
    ['無效优先级', change('opportunities', 'priority', 'urgent')],
    ['无效投入判断', change('opportunities', 'decision', 'other')],
    ['空公司', change('opportunities', 'organization', '  ')],
    ['无效日期', change('opportunities', 'deadline', 'invalid-date')],
    ['不存在的日历日期', change('opportunities', 'deadline', '2026-02-30T00:00:00Z')],
    ['无时区日期', change('opportunities', 'deadline', '2026-10-02T10:00:00')],
    ['缺少必需日期', change('opportunities', 'createdAt', undefined)],
    ['超出日期范围', change('opportunities', 'deadline', 8_640_000_000_000_001)],
    ['超毫秒精度', change('opportunities', 'deadline', '2026-10-02T10:00:00.1234Z')],
    ['评分越界', change('opportunities', 'fitScore', 6)],
    ['负数提醒', change('opportunities', 'reminderDays', [-1])],
    ['字符串提醒', change('milestones', 'reminderOffsets', ['1440'])],
    ['无效任务状态', change('tasks', 'status', 'finished')],
    ['无效任务来源', change('tasks', 'source', 'unknown')],
    ['负数预计耗时', change('tasks', 'estimatedMinutes', -1)],
    ['未知机会关联', change('tasks', 'opportunityId', 'missing')],
    ['未知节点机会', change('milestones', 'opportunityId', 'missing')],
    ['未知记录机会', change('activities', 'opportunityId', 'missing')],
    ['未知要求机会', change('materialRequirements', 'opportunityId', 'missing')],
    ['未知材料关联', change('materialRequirements', 'materialId', 'missing')],
    ['布尔值类型错误', change('materialRequirements', 'completed', 'false')],
    ['提取 JSON 类型错误', change('extractionDrafts', 'extractedJson', '{}')],
    ['证据字段类型错误', change('extractionDrafts', 'evidenceJson', { organization: [] })],
    ['置信度越界', change('extractionDrafts', 'confidence', 10)],
    ['未知字段/SQL 名称', change('opportunities', 'id) VALUES (1); --', 'injected')],
    ['未知表', (b) => ({ ...b, data: { ...b.data, unknownTable: [] } })],
    ['重复机会 ID', (b) => ({ ...b, data: { ...b.data, opportunities: [b.data.opportunities[0], b.data.opportunities[0]] } })],
    ['重复提醒去重标识', (b) => ({ ...b, data: { ...b.data, reminderDeliveries: [b.data.reminderDeliveries[0], { ...b.data.reminderDeliveries[0], id: 'other-id' }] } })],
    ['重复设置键', (b) => ({ ...b, data: { ...b.data, settings: [b.data.settings[0], b.data.settings[0]] } })],
    ['非法复查天数', change('settings', 'value', 'NaN')],
    ['不支持的备份版本', (b) => ({ ...b, version: 2 })],
  ];
  it.each(invalid)('拒绝%s；原数据和快照目录不变', (_, alter) => {
    const original = currentData();
    const files = fs.readdirSync(directory);
    expect(() => restoreBackup(client, alter(fixture('replacement')), directory)).toThrow(BackupValidationError);
    expect(currentData()).toEqual(original);
    expect(fs.readdirSync(directory)).toEqual(files);
    expect(client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('旧版 v1 缺少新增字段/可选表时补默认值，不丢弃未知字段', () => {
    const b = fixture();
    const { extractionDrafts, reminderDeliveries, settings, ...legacyData } = b.data;
    expect(extractionDrafts.length + reminderDeliveries.length + settings.length).toBeGreaterThan(0);
    restoreBackup(client, { version: 1, data: legacyData }, directory);
    const restored = currentData();
    expect(restored.opportunities[0].decision).toBe('undecided');
    expect(restored.opportunities[0].fitScore).toBe(0);
    expect(restored.extractionDrafts).toEqual([]);
    expect(restored.reminderDeliveries).toEqual([]);
    expect(restored.settings).toEqual([]);
  });

  it('日期按字段转换，支持带时区 ISO、毫秒时间戳、零值和 null', () => {
    const b = fixture();
    const input = { ...b, data: { ...b.data, opportunities: [{ ...b.data.opportunities[0], deadline: 0 }] } };
    restoreBackup(client, input, directory);
    const restored = currentData();
    expect(restored.opportunities[0].deadline).toEqual(json(new Date(0)));
    expect(restored.opportunities[0].nextActionAt).toEqual(json(new Date('2026-10-05T01:30:00Z')));
    expect(restored.tasks.find((row) => row.opportunityId === null)?.dueAt).toBeNull();
  });

  it('快照目录无法写入时，中止恢复且原数据不变', () => {
    const original = currentData();
    const blocked = path.join(directory, 'not-a-directory');
    fs.writeFileSync(blocked, 'blocked');
    expect(() => restoreBackup(client, fixture('replacement'), blocked)).toThrow();
    expect(currentData()).toEqual(original);
  });

  it('正式写入中途失败会回滚所有表，恢复前快照仍可读', () => {
    const original = currentData();
    client.exec("CREATE TEMP TRIGGER block_restore BEFORE INSERT ON main.tasks BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;");
    expect(() => restoreBackup(client, fixture('replacement'), directory)).toThrow('simulated write failure');
    expect(currentData()).toEqual(original);
    expect(client.pragma('foreign_key_check')).toEqual([]);
    const snapshots = fs.readdirSync(directory).filter((file) => file.endsWith('.json'));
    expect(snapshots).toHaveLength(2);
    for (const file of snapshots) expect(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')).version).toBe(1);
  });

  it('读回发现字段被改变时也会回滚，不静默提交', () => {
    const original = currentData();
    client.exec("CREATE TEMP TRIGGER alter_restore AFTER INSERT ON main.opportunities BEGIN UPDATE opportunities SET notes = 'unexpected' WHERE id = NEW.id; END;");
    expect(() => restoreBackup(client, fixture('replacement'), directory)).toThrow('恢复后字段核对失败');
    expect(currentData()).toEqual(original);
  });

  it('现有 JSON 字段已损坏时，仍能从有效备份恢复并保留原 SQLite 快照', () => {
    client.prepare("UPDATE opportunities SET tags = 'not-json'").run();
    const result = restoreBackup(client, fixture('replacement'), directory);
    expect(result.recoveryBackupPath).toBe(result.snapshotPath);
    const snapshot = new Database(result.snapshotPath, { readonly: true });
    try { expect(snapshot.prepare('SELECT tags FROM opportunities').get()).toEqual({ tags: 'not-json' }); }
    finally { snapshot.close(); }
    expect(currentData().opportunities[0].id).toBe('replacement-opp');
  });

  it('磁盘 WAL 数据进入快照；其他连接和重新打开数据库都能读取恢复结果', () => {
    const filename = path.join(directory, 'wal.db');
    fs.writeFileSync(filename, client.serialize());
    const disk = new Database(filename);
    disk.pragma('journal_mode = WAL'); disk.pragma('foreign_keys = ON');
    const observer = new Database(filename, { readonly: true });
    let result;
    try {
      disk.prepare('UPDATE opportunities SET notes = ?').run('最新 WAL 内容');
      result = restoreBackup(disk, fixture('replacement'), directory);
      expect(observer.prepare('SELECT id FROM opportunities').get()).toEqual({ id: 'replacement-opp' });
    } finally { observer.close(); disk.close(); }
    const snapshot = new Database(result.snapshotPath, { readonly: true });
    const reopened = new Database(filename, { readonly: true });
    try {
      expect(snapshot.prepare('SELECT notes FROM opportunities').get()).toEqual({ notes: '最新 WAL 内容' });
      expect(json(createJsonBackup(reopened)).data).toEqual(json(parseBackup(fixture('replacement')).data));
    } finally { snapshot.close(); reopened.close(); }
  });
});

describe('备份请求边界', () => {
  it('支持普通 JSON 和 UTF-8 BOM', async () => {
    const request = new Request('http://127.0.0.1/api/import', { method: 'POST', body: '\uFEFF{"version":1}' });
    expect(await readBackupRequest(request)).toEqual({ version: 1 });
  });
  it('拒绝截断 JSON', async () => {
    const request = new Request('http://127.0.0.1/api/import', { method: 'POST', body: '{"version":' });
    await expect(readBackupRequest(request)).rejects.toThrow('文件不是有效的 JSON');
  });
  it('拒绝超限 Content-Length', async () => {
    const request = new Request('http://127.0.0.1/api/import', { method: 'POST', body: '{}', headers: { 'Content-Length': String(MAX_BACKUP_BYTES + 1) } });
    await expect(readBackupRequest(request)).rejects.toThrow('超过 50 MB');
  });
  it('无 Content-Length 时仍累计限制响应体，并取消超限流', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_BACKUP_BYTES + 1)); },
      cancel() { cancelled = true; },
    });
    const request = new Request('http://127.0.0.1/api/import', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    await expect(readBackupRequest(request)).rejects.toThrow('超过 50 MB');
    expect(cancelled).toBe(true);
  });
  it('空请求体不会被当作清空数据的备份', async () => {
    await expect(readBackupRequest(new Request('http://127.0.0.1/api/import', { method: 'POST' }))).rejects.toThrow('请选择有效的 JSON');
  });
  it('缺失主表不能隐式清空当前数据', () => {
    expect(() => parseBackup({ version: 1, data: {} })).toThrow(BackupValidationError);
  });
});
