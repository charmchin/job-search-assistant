import fs from 'node:fs';
import path from 'node:path';

export const APP_NAME = '求职助手';
export const LEGACY_APP_NAME = '求职工作台';
export const LAUNCHER_BUNDLE_ID = 'com.local.zhaopin-assistant.launcher';

export function bundleExists(bundle) {
  try {
    fs.lstatSync(bundle);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Only migrate/replace entries generated for this checkout. A similarly named
// unrelated app, or a symlink to one, must never be overwritten.
export function assertManagedBundle(bundle, root) {
  const contents = path.join(bundle, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const info = path.join(contents, 'Info.plist');
  const fail = () => {
    throw new Error(
      `未修改应用入口：${bundle} 不属于当前项目或结构异常，请先核对。`,
    );
  };
  for (const directory of [bundle, contents, macos]) {
    if (!bundleExists(directory) || !fs.lstatSync(directory).isDirectory())
      fail();
  }
  if (!bundleExists(info) || !fs.lstatSync(info).isFile()) fail();
  const plist = fs.readFileSync(info, 'utf8');
  const identifier = plist.match(
    /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];
  const executable = plist.match(
    /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];
  if (
    identifier !== LAUNCHER_BUNDLE_ID ||
    ![APP_NAME, LEGACY_APP_NAME].includes(executable)
  )
    fail();
  const entry = path.join(macos, executable);
  if (!bundleExists(entry) || !fs.lstatSync(entry).isFile()) fail();
  const quotedRoot = `'${root.replaceAll("'", `'\\''`)}'`;
  if (
    !fs
      .readFileSync(entry, 'utf8')
      .split('\n')
      .includes(`project_root=${quotedRoot}`)
  )
    fail();
  return executable;
}

export function prepareAppBundle(applicationsDir, root) {
  const current = path.join(applicationsDir, `${APP_NAME}.app`);
  const legacy = path.join(applicationsDir, `${LEGACY_APP_NAME}.app`);
  if (bundleExists(current)) assertManagedBundle(current, root);
  if (bundleExists(legacy)) {
    assertManagedBundle(legacy, root);
    if (bundleExists(current))
      throw new Error(
        '新旧应用入口同时存在，未覆盖或删除任何入口。请核对后移走旧入口，再重试安装。',
      );
    fs.renameSync(legacy, current);
    // Keep the old executable until the installer has written the new entry
    // and metadata. An interrupted installation remains valid for a retry.
  }
  return current;
}
