import fs from 'node:fs';
import path from 'node:path';

const documentExtensions = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.rtf',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.odt',
  '.ods',
  '.odp',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
]);
const bundleSuffix = /\.(app|workflow|bundle|plugin|kext|framework|pkg)$/i;
const executableMagic = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
  '7f454c46',
]);

export class MaterialFileError extends Error {
  constructor(
    message: string,
    public readonly status = 422,
  ) {
    super(message);
    this.name = 'MaterialFileError';
  }
}

function validatePath(filePath: string) {
  if (
    !path.isAbsolute(filePath) ||
    filePath
      .split('')
      .some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new MaterialFileError(
      '请关联完整的本机文件路径，不支持相对路径或控制字符。',
    );
  if (filePath.split(path.sep).some((part) => bundleSuffix.test(part)))
    throw new MaterialFileError(
      '不能打开应用程序、安装包或程序包内的文件，请选择普通申请材料。',
    );
  if (!documentExtensions.has(path.extname(filePath).toLowerCase()))
    throw new MaterialFileError(
      '仅支持 PDF、普通 Office 文档、文本和常见图片；不支持程序、脚本、压缩包或 DOCM 等含宏格式。',
    );
}

/** Revalidate every open; registration and an extension alone are not trust. */
export function validateMaterialFile(filePath: string): string {
  validatePath(filePath);
  let fd: number | undefined;
  try {
    const canonical = fs.realpathSync(filePath);
    validatePath(canonical);
    fd = fs.openSync(
      canonical,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile())
      throw new MaterialFileError('请选择普通文件，不能打开目录或设备。');
    if (stat.mode & 0o111)
      throw new MaterialFileError(
        '这个文件具有可执行权限，已拒绝打开。请使用可信来源的非可执行文档。',
      );
    const buffer = Buffer.alloc(4096);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, length);
    const scriptHead = head.subarray(
      head.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0,
    );
    if (
      executableMagic.has(head.subarray(0, 4).toString('hex')) ||
      head.subarray(0, 2).toString('ascii') === 'MZ' ||
      scriptHead.subarray(0, 2).toString('ascii') === '#!'
    )
      throw new MaterialFileError(
        '文件内容看起来是程序或脚本，即使扩展名是文档也不能打开。',
      );
    return canonical;
  } catch (error) {
    if (error instanceof MaterialFileError) throw error;
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new MaterialFileError(
      missing
        ? '文件不存在或已被移动，请重新关联。'
        : '无法安全读取文件，请检查路径和访问权限。',
      missing ? 404 : 422,
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
