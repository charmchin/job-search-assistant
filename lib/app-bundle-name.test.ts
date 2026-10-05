import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import manifest from '../app/manifest';
import {
  APP_NAME,
  LEGACY_APP_NAME,
  LAUNCHER_BUNDLE_ID,
  assertManagedBundle,
  prepareAppBundle,
} from '../scripts/app-bundle-name.mjs';

let directory: string;
let applications: string;
const project = "/example/求职者's project";
const bundle = (name: string) => path.join(applications, `${name}.app`);
function fixture(
  name: string,
  root = project,
  identifier = LAUNCHER_BUNDLE_ID,
) {
  const target = bundle(name);
  fs.mkdirSync(path.join(target, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(
    path.join(target, 'Contents/Info.plist'),
    `<plist><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`,
  );
  fs.writeFileSync(
    path.join(target, 'Contents/MacOS', name),
    `#!/bin/zsh\nproject_root='${root.replaceAll("'", `'\\''`)}'\n`,
  );
  fs.writeFileSync(path.join(target, 'keep.txt'), name);
  return target;
}
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(process.env.ZHAOPIN_DATA_DIR!, 'app-name-'),
  );
  applications = path.join(directory, 'Applications');
  fs.mkdirSync(applications);
});
afterEach(() => fs.rmSync(directory, { recursive: true }));

describe('应用显示名迁移（仅自有文件夹，无原生命令或服务）', () => {
  it('全新安装使用新名字，不创建旧入口', () => {
    expect(prepareAppBundle(applications, project)).toBe(bundle(APP_NAME));
    expect(fs.readdirSync(applications)).toEqual([]);
  });
  it('迁移旧入口保留目录身份、文件与旧可执行入口，支持中断后重试', () => {
    const legacy = fixture(LEGACY_APP_NAME);
    const inode = fs.statSync(legacy).ino;
    const sentinel = path.join(directory, 'app.db');
    fs.writeFileSync(sentinel, '数据库不应被迁移');
    const current = prepareAppBundle(applications, project);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.statSync(current).ino).toBe(inode);
    expect(fs.readFileSync(path.join(current, 'keep.txt'), 'utf8')).toBe(
      LEGACY_APP_NAME,
    );
    expect(assertManagedBundle(current, project)).toBe(LEGACY_APP_NAME);
    expect(prepareAppBundle(applications, project)).toBe(current);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('数据库不应被迁移');
  });
  it('已安装新入口可幂等更新，不改动现有内容', () => {
    const current = fixture(APP_NAME);
    expect(prepareAppBundle(applications, project)).toBe(current);
    expect(fs.readFileSync(path.join(current, 'keep.txt'), 'utf8')).toBe(
      APP_NAME,
    );
  });
  it.each([APP_NAME, LEGACY_APP_NAME])('拒绝覆盖同名的其他应用：%s', (name) => {
    const foreign = fixture(name, project, 'org.example.foreign');
    expect(() => prepareAppBundle(applications, project)).toThrow(
      '不属于当前项目',
    );
    expect(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8')).toBe(name);
    expect(fs.readdirSync(applications)).toEqual([`${name}.app`]);
  });
  it('同标识但属于其他项目的旧入口不能被迁移', () => {
    fixture(LEGACY_APP_NAME, '/another/project');
    expect(() => prepareAppBundle(applications, project)).toThrow(
      '不属于当前项目',
    );
    expect(fs.existsSync(bundle(LEGACY_APP_NAME))).toBe(true);
    expect(fs.existsSync(bundle(APP_NAME))).toBe(false);
  });
  it('新旧入口共存时不覆盖、不删除，要求先核对', () => {
    fixture(APP_NAME);
    fixture(LEGACY_APP_NAME);
    expect(() => prepareAppBundle(applications, project)).toThrow(
      '新旧应用入口同时存在',
    );
    for (const name of [APP_NAME, LEGACY_APP_NAME])
      expect(fs.readFileSync(path.join(bundle(name), 'keep.txt'), 'utf8')).toBe(
        name,
      );
  });
  it.each([APP_NAME, LEGACY_APP_NAME])('拒绝同名符号链接：%s', (name) => {
    const target = path.join(directory, 'unrelated');
    fs.mkdirSync(target);
    fs.symlinkSync(target, bundle(name));
    expect(() => prepareAppBundle(applications, project)).toThrow('结构异常');
    expect(fs.lstatSync(bundle(name)).isSymbolicLink()).toBe(true);
  });
  it.each(['Info.plist', `MacOS/${LEGACY_APP_NAME}`])(
    '拒绝入口内部文件符号链接：%s',
    (file) => {
      const legacy = fixture(LEGACY_APP_NAME);
      const entry = path.join(legacy, 'Contents', file);
      const target = path.join(directory, 'unrelated-file');
      fs.renameSync(entry, target);
      fs.symlinkSync(target, entry);
      expect(() => prepareAppBundle(applications, project)).toThrow('结构异常');
      expect(fs.existsSync(bundle(APP_NAME))).toBe(false);
    },
  );
  it('旧入口元数据损坏时保留原入口', () => {
    const legacy = fixture(LEGACY_APP_NAME);
    fs.writeFileSync(path.join(legacy, 'Contents/Info.plist'), 'invalid plist');
    expect(() => prepareAppBundle(applications, project)).toThrow('结构异常');
    expect(fs.existsSync(legacy)).toBe(true);
  });
  it('显示名变化不改变应用标识和浏览器 manifest 身份', () => {
    expect(LAUNCHER_BUNDLE_ID).toBe('com.local.zhaopin-assistant.launcher');
    const value = manifest();
    expect(value.name).toBe(APP_NAME);
    expect(value.short_name).toBe(APP_NAME);
    expect(value.id).toBe('/');
    expect(value.start_url).toBe('/');
    expect(value.scope).toBe('/');
  });
});
