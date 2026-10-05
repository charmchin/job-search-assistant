import {
  APP_ID,
  acquireLock,
  buildProject,
  installationId,
  readBuild,
  sourceFingerprint,
} from './build-tools.mjs';

export async function launchWorkspace({
  root,
  dataDir,
  mode = 'start',
  platform,
  log = console.log,
}) {
  const unlockProject = await acquireLock(root);
  let unlockData;
  try {
    unlockData = await acquireLock(dataDir);
    const identity = installationId(root, dataDir);
    const probe = await platform.probe();
    const ours =
      probe.health?.appId === APP_ID &&
      probe.health?.installationId === identity;
    const owned = await platform.owned(probe);
    if (probe.occupied && !ours && !owned)
      throw new Error(
        '端口被其他程序占用，未打开页面或停止该程序。请先关闭占用程序，或停止其他项目的求职助手。',
      );
    if (mode === 'stop') {
      if (probe.occupied && !owned)
        throw new Error(
          '此服务不是当前启动器管理的进程，未自动停止。请在启动它的终端中关闭。',
        );
      await platform.stop();
      await platform.waitStopped();
      log('求职助手已停止，数据保留。');
      return { stopped: true };
    }
    await platform.dependencies();
    const fingerprint = sourceFingerprint(root);
    let build = readBuild(root);
    const rebuild = !build || build.fingerprint !== fingerprint;
    // Also require a successful state read; the identity endpoint itself does not access SQLite.
    const current =
      ours &&
      !rebuild &&
      probe.health.mode === 'production' &&
      probe.health.fingerprint === build.fingerprint &&
      probe.health.buildId === build.buildId &&
      (await platform.stateReady());
    if (mode !== 'restart' && current) {
      log('当前版本已运行，正在打开工作台。');
      await platform.open();
      return { reused: true, build };
    }
    if (probe.occupied && !owned)
      throw new Error(
        '检测到旧版或开发服务，但它不是当前启动器管理的进程。请先在启动它的终端停止服务，再重新打开工作台。',
      );
    log(
      rebuild ? '检测到代码或迁移更新，正在安全更新…' : '正在重新启动当前构建…',
    );
    // Never overwrite .next or migrate while our old server is still serving.
    await platform.stop();
    await platform.waitStopped();
    await platform.assertBuildIdle();
    log('正在检查数据库迁移…');
    await platform.migrate();
    if (rebuild) {
      log('正在构建新版本，请等待完成…');
      build = await buildProject(root, platform.run);
    }
    // Do not start a build that became stale while dependencies/migrations were running.
    if (sourceFingerprint(root) !== build.fingerprint)
      throw new Error('源文件又发生变化，请保存后重试启动。');
    await platform.start();
    try {
      await platform.waitReady({ identity, build });
    } catch (error) {
      await platform.stop();
      await platform.waitStopped();
      throw error;
    }
    log('启动成功，正在打开工作台。');
    await platform.open();
    return { reused: false, build };
  } finally {
    unlockData?.();
    unlockProject();
  }
}
