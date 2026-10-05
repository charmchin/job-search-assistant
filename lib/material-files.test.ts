import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MaterialFileError, validateMaterialFile } from './material-files';

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'zhaopin-material-tests-'),
);
let sequence = 0;
function file(
  extension: string,
  body: string | Buffer = 'test document',
  mode = 0o600,
) {
  const target = path.join(directory, `material-${sequence++}${extension}`);
  fs.writeFileSync(target, body, { mode });
  return target;
}
afterAll(() => {
  const trash = path.join(os.homedir(), '.Trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(directory, path.join(trash, path.basename(directory)));
});
describe('材料文件打开边界（不执行任何系统命令）', () => {
  it.each([
    '.pdf',
    '.docx',
    '.xlsx',
    '.pptx',
    '.txt',
    '.md',
    '.png',
    '.jpg',
    '.PDF',
  ])('允许普通 %s 文件', (extension) => {
    const target = file(extension);
    expect(validateMaterialFile(target)).toBe(fs.realpathSync(target));
  });
  it.each([
    '.app',
    '.command',
    '.sh',
    '.js',
    '.py',
    '.scpt',
    '.workflow',
    '.pkg',
    '.webloc',
    '.html',
    '.svg',
    '.zip',
    '.docm',
    '.xlsm',
    '.pptm',
  ])('拒绝非材料 %s', (extension) => {
    expect(() => validateMaterialFile(file(extension))).toThrow(
      MaterialFileError,
    );
  });
  it.each(['relative.pdf', '', '/tmp/control\n.pdf', '/tmp/null\0.pdf'])(
    '拒绝异常路径 %s',
    (target) => {
      expect(() => validateMaterialFile(target)).toThrow(MaterialFileError);
    },
  );
  it('缺失文件给出 404，目录不能当作文件', () => {
    try {
      validateMaterialFile(path.join(directory, 'missing.pdf'));
      throw new Error('should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(MaterialFileError);
      expect((error as MaterialFileError).status).toBe(404);
    }
    const folder = path.join(directory, 'folder.pdf');
    fs.mkdirSync(folder);
    expect(() => validateMaterialFile(folder)).toThrow('普通文件');
  });
  it('文档扩展名不能绕过可执行权限或程序包限制', () => {
    expect(() => validateMaterialFile(file('.pdf', '%PDF', 0o700))).toThrow(
      '可执行权限',
    );
    const bundle = path.join(directory, 'Hidden.APP');
    fs.mkdirSync(bundle);
    const target = path.join(bundle, 'resume.pdf');
    fs.writeFileSync(target, '%PDF');
    expect(() => validateMaterialFile(target)).toThrow('程序包');
  });
  it.each([
    'feedface',
    'cefaedfe',
    'feedfacf',
    'cffaedfe',
    'cafebabe',
    'bebafeca',
    'cafebabf',
    'bfbafeca',
    '7f454c46',
    '4d5a',
    '23212f62696e2f7368',
    'efbbbf23212f62696e2f7368',
  ])('程序/脚本内容不能伪装 PDF：%s', (magic) => {
    expect(() =>
      validateMaterialFile(file('.pdf', Buffer.from(magic, 'hex'))),
    ).toThrow('程序或脚本');
  });
  it('符号链接同时检查入口和实际目标，允许普通文档但拒绝脚本与程序包', () => {
    const normal = file('.pdf'),
      script = file('.sh');
    const link = file('.pdf');
    fs.unlinkSync(link);
    fs.symlinkSync(normal, link);
    expect(validateMaterialFile(link)).toBe(fs.realpathSync(normal));
    fs.unlinkSync(link);
    fs.symlinkSync(script, link);
    expect(() => validateMaterialFile(link)).toThrow('仅支持');
    const bundle = path.join(directory, 'Linked.app');
    fs.mkdirSync(bundle);
    const hidden = path.join(bundle, 'resume.pdf');
    fs.writeFileSync(hidden, '%PDF');
    fs.unlinkSync(link);
    fs.symlinkSync(hidden, link);
    expect(() => validateMaterialFile(link)).toThrow('程序包');
  });
  it('每次打开重新检查文件，登记后替换内容不能继承信任', () => {
    const target = file('.pdf');
    validateMaterialFile(target);
    fs.writeFileSync(target, '#!/bin/sh');
    expect(() => validateMaterialFile(target)).toThrow('程序或脚本');
  });
});
