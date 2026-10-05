import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configuration } from './launcher-platform.mjs';
import {
  APP_NAME,
  LEGACY_APP_NAME,
  LAUNCHER_BUNDLE_ID,
  assertManagedBundle,
  bundleExists,
  prepareAppBundle,
} from './app-bundle-name.mjs';

const action = process.argv[2];
if (!['install', 'uninstall'].includes(action)) {
  process.stderr.write(
    'Usage: node scripts/macos-app.mjs <install|uninstall>\n',
  );
  process.exit(2);
}

const taskRoot = path.resolve(import.meta.dirname, '..');
const config = configuration(taskRoot);
const installHome = config.home;
const dataDir = config.dataDir;
const applicationsDir = path.join(installHome, 'Applications');
const appBundle = path.join(applicationsDir, `${APP_NAME}.app`);
const contentsDir = path.join(appBundle, 'Contents');
const macosDir = path.join(contentsDir, 'MacOS');
const resourcesDir = path.join(contentsDir, 'Resources');
const launchAgentsDir = path.join(installHome, 'Library', 'LaunchAgents');
const launchAgentPath = path.join(launchAgentsDir, `${config.label}.plist`);
const nodePath = process.env.ZHAOPIN_NODE_PATH || process.execPath;
const serviceLog = path.join(dataDir, 'server.log');
const label = config.label;

function xml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

if (action === 'uninstall') {
  const bundles = [
    appBundle,
    path.join(applicationsDir, `${LEGACY_APP_NAME}.app`),
  ].filter(bundleExists);
  for (const bundle of bundles) assertManagedBundle(bundle, taskRoot);
  for (const bundle of bundles) fs.rmSync(bundle, { recursive: true });
  fs.rmSync(launchAgentPath, { force: true });
  process.stdout.write(`已移除：${appBundle}\n`);
  process.stdout.write(`已移除：${launchAgentPath}\n`);
  process.stdout.write(`数据已保留：${dataDir}\n`);
  process.exit(0);
}

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(applicationsDir, { recursive: true });
prepareAppBundle(applicationsDir, taskRoot);
fs.mkdirSync(launchAgentsDir, { recursive: true });
fs.mkdirSync(macosDir, { recursive: true });
fs.mkdirSync(resourcesDir, { recursive: true });

const executableName = APP_NAME;
const launcherPath = path.join(macosDir, executableName);
const launcher = `#!/bin/zsh
set -u

project_root=${shellQuote(taskRoot)}
export PATH=${shellQuote(path.dirname(nodePath))}:"/opt/homebrew/bin:/usr/local/bin:$PATH"
${config.test ? `export ZHAOPIN_LAUNCHER_TEST=1 ZHAOPIN_INSTALL_HOME=${shellQuote(config.home)} ZHAOPIN_DATA_DIR=${shellQuote(config.dataDir)} ZHAOPIN_PORT=${config.port}` : ''}
exec /bin/zsh "$project_root/start.command" --gui
`;
fs.writeFileSync(launcherPath, launcher, { mode: 0o755 });

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${executableName}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>${LAUNCHER_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
fs.writeFileSync(path.join(contentsDir, 'Info.plist'), infoPlist);
fs.copyFileSync(
  path.join(taskRoot, 'public', 'app-icon.svg'),
  path.join(resourcesDir, 'AppIcon.svg'),
);

try {
  const { default: sharp } = await import('sharp');
  const iconsetDir = path.join(dataDir, '.AppIcon.iconset');
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });
  const variants = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];
  await Promise.all(
    variants.map(([name, size]) =>
      sharp(path.join(taskRoot, 'public', 'app-icon.svg'))
        .resize(size, size)
        .png()
        .toFile(path.join(iconsetDir, name)),
    ),
  );
  const iconResult = spawnSync('/usr/bin/iconutil', [
    '-c',
    'icns',
    iconsetDir,
    '-o',
    path.join(resourcesDir, 'AppIcon.icns'),
  ]);
  if (iconResult.status !== 0)
    throw new Error(iconResult.stderr?.toString() || 'iconutil failed');
  fs.rmSync(iconsetDir, { recursive: true, force: true });
} catch (error) {
  process.stderr.write(
    `图标转换失败，将使用系统默认图标：${error instanceof Error ? error.message : String(error)}\n`,
  );
}

const launchAgent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${xml(path.join(taskRoot, 'run-server.command'))}</string>
    <string>${xml(nodePath)}</string>
    <string>${config.port}</string>
    <string>${xml(dataDir)}</string>
    ${config.test ? `<string>--test</string><string>${xml(config.home)}</string>` : ''}
  </array>
  <key>WorkingDirectory</key><string>${xml(taskRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>${xml(serviceLog)}</string>
  <key>StandardErrorPath</key><string>${xml(serviceLog)}</string>
</dict>
</plist>
`;
fs.writeFileSync(launchAgentPath, launchAgent, { mode: 0o644 });

const registerTool =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
if (!config.test && fs.existsSync(registerTool))
  spawnSync(registerTool, ['-f', appBundle]);

process.stdout.write(`应用入口：${appBundle}\n`);
process.stdout.write(`登录启动项：${launchAgentPath}\n`);
