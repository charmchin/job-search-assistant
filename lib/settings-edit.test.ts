import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, it, expect, vi, describe } from 'vitest';
import { createActionService } from './actions';
import { actionSchema } from './action-schema';
import { createJsonBackup } from './backup';
import { buildSettingsUpdate, editableSettings } from './settings-edit';

let client: Database.Database;
let service: ReturnType<typeof createActionService>;
const keychain = vi.fn<(_value: string) => Promise<void>>();
beforeEach(async () => {
  client = new Database(':memory:');
  client.pragma('foreign_keys=ON');
  for (const file of fs
    .readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    client.exec(fs.readFileSync(path.join('drizzle', file), 'utf8'));
  keychain.mockReset().mockResolvedValue();
  service = createActionService(client, keychain);
  await service.execute({
    action: 'saveSettings',
    payload: {
      baseUrl: 'https://provider.example/v1',
      model: '原模型',
      staleDays: 5,
    },
  });
});
afterEach(() => client.close());
const read = () =>
  editableSettings(
    Object.fromEntries(
      (
        client.prepare('SELECT key,value FROM settings').all() as {
          key: string;
          value: string;
        }[]
      ).map((r) => [r.key, r.value]),
    ),
  );
const update = (
  original: ReturnType<typeof read>,
  changes: Partial<ReturnType<typeof read>> & { apiKey?: string },
  requestId?: string,
) =>
  service.execute({
    action: 'saveSettings',
    payload: buildSettingsUpdate(original, { ...original, ...changes }),
    requestId,
  });
const snapshot = () =>
  ['settings', 'mutation_receipts'].map((t) =>
    client.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
  );
describe('设置及密钥版本保护', () => {
  it('仅提交实际修改，无变化返回 null', () => {
    const original = read();
    expect(buildSettingsUpdate(original, original)).toBeNull();
    expect(
      buildSettingsUpdate(original, { ...original, staleDays: 6 }),
    ).toEqual({ staleDays: 6, expected: { staleDays: 5 } });
  });
  it('模型与停滞天数可独立保存，不重传默认值', async () => {
    const original = read();
    await update(original, { model: '甲模型' });
    await update(original, { staleDays: 7 });
    expect(read()).toMatchObject({
      model: '甲模型',
      staleDays: 7,
      baseUrl: original.baseUrl,
    });
  });
  it('接口与模型关联组防止旧设置混用', async () => {
    const original = read();
    await update(original, { baseUrl: 'https://next-provider.example/v1' });
    const before = snapshot();
    await expect(
      update(original, { model: '旧接口对应模型' }),
    ).rejects.toMatchObject({ status: 409, code: 'EDIT_CONFLICT' });
    expect(snapshot()).toEqual(before);
  });
  it('已过时设置在调用钥匙串前拒绝，密钥输入不被外部使用', async () => {
    const original = read();
    await update(original, { model: '其他窗口模型' });
    const before = snapshot();
    await expect(
      update(original, { apiKey: 'fake-conflicting-key' }),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    expect(keychain).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });
  it('密钥只保存于注入适配器；数据库/备份/回执仅包含不透明版本', async () => {
    const original = read();
    const key = 'fake-key-never-in-database';
    const result = await update(original, { apiKey: key }, randomUUID());
    expect(keychain).toHaveBeenCalledExactlyOnceWith(key);
    expect(read().keyRevision).toMatch(/^key_/);
    expect(result).toEqual({ saved: true, keyRevision: read().keyRevision });
    expect(JSON.stringify(snapshot())).not.toContain(key);
    expect(JSON.stringify(createJsonBackup(client))).not.toContain(key);
  });
  it('同接口下更新过密钥，也能阻止旧窗口再次改密钥或接口', async () => {
    const original = read();
    await update(original, { apiKey: 'fake-new-key' });
    keychain.mockClear();
    const before = snapshot();
    await expect(
      update(original, { apiKey: 'fake-old-key' }),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    await expect(
      update(original, { baseUrl: 'https://other.example/v1' }),
    ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    expect(keychain).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });
  it('无关停滞天数变化不阻止核对后的密钥保存', async () => {
    const original = read();
    await update(original, { staleDays: 8 });
    await update(original, { apiKey: 'fake-same-provider-key' });
    expect(read().staleDays).toBe(8);
  });
  it('钥匙串失败不修改数据库或版本标识', async () => {
    const original = read();
    const before = snapshot();
    keychain.mockRejectedValue(new Error('fixture'));
    await expect(
      update(original, { apiKey: 'fake-error-key' }),
    ).rejects.toMatchObject({ code: 'KEYCHAIN_FAILED' });
    expect(snapshot()).toEqual(before);
  });
  it('异步钥匙串期间外部改设置，二次检查阻止覆写并报告部分成功', async () => {
    const original = read();
    keychain.mockImplementation(async () => {
      client
        .prepare("UPDATE settings SET value='外部模型' WHERE key='aiModel'")
        .run();
    });
    await expect(
      update(
        original,
        { model: '不得覆盖', apiKey: 'fake-partial-key' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'SETTINGS_PARTIAL' });
    expect(read().model).toBe('外部模型');
    expect(read().keyRevision).toBe('');
    expect(
      client.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').get(),
    ).toEqual({ n: 0 });
  });
  it('数据库写失败仍明确部分成功，不假称已回滚钥匙串', async () => {
    const original = read();
    const before = snapshot();
    client.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    await expect(
      update(original, { apiKey: 'fake-db-error-key' }, randomUUID()),
    ).rejects.toMatchObject({ code: 'SETTINGS_PARTIAL' });
    expect(keychain).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(before);
  });
  it('成功请求跨服务重放不会重复改密钥，版本变化后仍回放成功', async () => {
    const original = read();
    const requestId = randomUUID();
    const input = {
      action: 'saveSettings',
      payload: buildSettingsUpdate(original, {
        ...original,
        apiKey: 'fake-first-key',
      }),
      requestId,
    };
    const result = await service.execute(input);
    await update(read(), { apiKey: 'fake-later-key' });
    const before = snapshot();
    keychain.mockClear();
    service = createActionService(client, keychain);
    expect(await service.execute(input)).toEqual(result);
    expect(snapshot()).toEqual(before);
    expect(keychain).not.toHaveBeenCalled();
  });
  it.each([
    { model: '新', expected: { model: '旧' } },
    { apiKey: 'fake-key', expected: { baseUrl: '', model: '' } },
    { expected: { staleDays: 5 } },
    { staleDays: 6, expected: {} },
    {
      model: '新',
      expected: { baseUrl: '', model: '旧', keyRevision: '', apiKey: '不允许' },
    },
  ])('坏基线不允许绕过（%#）', (payload) => {
    expect(
      actionSchema.safeParse({ action: 'saveSettings', payload }).success,
    ).toBe(false);
  });
  it('旧内部调用仍保持默认设置语义', async () => {
    expect(
      await service.execute({
        action: 'saveSettings',
        payload: { staleDays: 9 },
      }),
    ).toEqual({ saved: true });
    expect(read()).toMatchObject({ baseUrl: '', model: '', staleDays: 9 });
  });
});
