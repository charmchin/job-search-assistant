import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fetch as fetchAi } from 'undici';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const lock = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
);
const atLeast = (version: string, floor: number[]) => {
  const actual = version.split('.').map(Number);
  for (let index = 0; index < floor.length; index++) {
    if (actual[index] !== floor[index]) return actual[index] > floor[index];
  }
  return true;
};

describe('依赖修复的配置回归（不代替实时 npm audit）', () => {
  it('AI 请求不依赖 Node 内置旧客户端，单元环境仍禁止真实网络', async () => {
    expect(manifest.dependencies.undici).toBe('7.30.0');
    expect(
      fs.readFileSync(path.join(root, 'lib/capture.ts'), 'utf8'),
    ).toContain("import { fetch as fetchAi } from 'undici';");
    await expect(fetchAi('https://provider.invalid')).rejects.toThrow(
      '禁止未模拟',
    );
  });
  it('Next 使用明确版本，锁文件与清单一致且不低于安全补丁', () => {
    expect(manifest.dependencies.next).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages['node_modules/next'].version).toBe(
      manifest.dependencies.next,
    );
    expect(atLeast(manifest.dependencies.next, [16, 3, 6])).toBe(true);
  });
  it('不重新带入 shadcn CLI，保留实际需要的 React 组件依赖', () => {
    expect(manifest.dependencies.shadcn).toBeUndefined();
    expect(manifest.devDependencies.shadcn).toBeUndefined();
    expect(lock.packages['node_modules/shadcn']).toBeUndefined();
    expect(manifest.dependencies['@shadcn/react']).toBeDefined();
  });
  it('所有锁定的 undici 与 esbuild 均不低于本轮公告的修复版本', () => {
    const packages = Object.entries(lock.packages) as [
      string,
      { version: string },
    ][];
    for (const [name, value] of packages) {
      if (name.endsWith('/undici'))
        expect(atLeast(value.version, [7, 29, 1])).toBe(true);
      if (name.endsWith('/esbuild'))
        expect(atLeast(value.version, [0, 25, 0])).toBe(true);
    }
    expect(manifest.overrides['@esbuild-kit/core-utils'].esbuild).toBe(
      '0.25.12',
    );
  });
  it('静态样式与原 4.18.0 内容一致，且保留版权许可和本地导入', () => {
    const file = fs.readFileSync(
      path.join(root, 'app/shadcn-utilities.css'),
      'utf8',
    );
    const css = file.replace(/^\/\*[\s\S]*?\*\/\n/, '').trimEnd();
    expect(createHash('sha256').update(css).digest('hex')).toBe(
      '1e595e88d95c6583d8d9d615a2b5ab0e785c24fc0b0c23e1d6fe2aa600a73710',
    );
    expect(
      fs.readFileSync(path.join(root, 'docs/licenses/shadcn-MIT.txt'), 'utf8'),
    ).toContain('Copyright (c) 2023 shadcn');
    expect(
      fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8'),
    ).toContain("@import './shadcn-utilities.css';");
  });
});
