import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fs.realpathSync(process.cwd());
const dataDir = path.resolve(
  /* turbopackIgnore: true */
  process.env.ZHAOPIN_DATA_DIR ||
    path.join(os.homedir(), 'Library/Application Support/ZhaopinAssistant'),
);
let manifest: { fingerprint?: string; buildId?: string } = {};
try {
  manifest = JSON.parse(
    fs.readFileSync(path.join(root, '.next/zhaopin-build.json'), 'utf8'),
  );
} catch {}
// Captured once per process/module. An old running service must not report a new disk build.
export const runtimeHealth = Object.freeze({
  appId: 'com.local.zhaopin-assistant',
  installationId: createHash('sha256')
    .update(JSON.stringify([root, dataDir]))
    .digest('hex'),
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  fingerprint:
    process.env.ZHAOPIN_RUNNING_FINGERPRINT || manifest.fingerprint || null,
  buildId: process.env.ZHAOPIN_RUNNING_BUILD_ID || manifest.buildId || null,
  pid: process.pid,
});
