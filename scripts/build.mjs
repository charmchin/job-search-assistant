import path from 'node:path';
import { acquireLock, buildProject } from './build-tools.mjs';
import {
  configuration,
  createPlatform,
  projectServers,
} from './launcher-platform.mjs';
const root = path.resolve(import.meta.dirname, '..');
const unlock = await acquireLock(root);
try {
  if (projectServers(root).length)
    throw new Error('请先停止此项目的开发、测试和正式服务，再构建生产包。');
  await buildProject(
    root,
    createPlatform(configuration(root), console.log).run,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  unlock();
}
