import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/files/route';
import { MaterialFileError } from './material-files';

const mocks = vi.hoisted(() => {
  const native = vi.fn(async () => ({ stdout: '/tmp/resume.pdf\n' }));
  return {
    native,
    exec: Object.assign(vi.fn(), {
      [Symbol.for('nodejs.util.promisify.custom')]: native,
    }),
    get: vi.fn(),
    validate: vi.fn(),
  };
});
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ get: mocks.get }) }) }),
  },
}));
vi.mock('@/lib/material-files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./material-files')>()),
  validateMaterialFile: mocks.validate,
}));
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://127.0.0.1:3113/api/files', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:3113',
      ...headers,
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('ZHAOPIN_DISABLE_FILE_OPERATIONS', '0');
  mocks.native.mockReset().mockResolvedValue({ stdout: '/tmp/resume.pdf\n' });
  mocks.get
    .mockReset()
    .mockReturnValue({ id: 'registered', filePath: '/tmp/resume.pdf' });
  mocks.validate.mockReset().mockReturnValue('/private/tmp/resume.pdf');
});
describe('文件接口（所有系统命令均为模拟）', () => {
  it('跨来源请求不查材料、不读文件、不唤起系统', async () => {
    expect(
      (
        await POST(
          request({ action: 'pick' }, { Origin: 'http://127.0.0.1:3114' }),
        )
      ).status,
    ).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it.each([
    { action: 'open', path: '/tmp/resume.pdf' },
    { action: 'open', materialId: 'registered', path: '/tmp/resume.pdf' },
    { action: 'open', materialId: '' },
    { action: 'pick', path: '/tmp/resume.pdf' },
  ])('拒绝原始路径及多余参数（%#）', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === 'darwin')(
    '仅打开登记材料的已验证真实路径',
    async () => {
      expect(
        (await POST(request({ action: 'open', materialId: 'registered' })))
          .status,
      ).toBe(200);
      expect(mocks.validate).toHaveBeenCalledWith('/tmp/resume.pdf');
      expect(mocks.native).toHaveBeenCalledWith(
        'open',
        ['/private/tmp/resume.pdf'],
        expect.objectContaining({ timeout: 10000 }),
      );
    },
  );
  it.runIf(process.platform === 'darwin')('未登记材料不能读文件', async () => {
    mocks.get.mockReturnValue(undefined);
    expect(
      (await POST(request({ action: 'open', materialId: 'missing' }))).status,
    ).toBe(404);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === 'darwin')(
    '不安全文件拒绝时不调用 open',
    async () => {
      mocks.validate.mockImplementation(() => {
        throw new MaterialFileError('不能打开程序');
      });
      const response = await POST(
        request({ action: 'open', materialId: 'registered' }),
      );
      expect(response.status).toBe(422);
      expect((await response.json()).error).toContain('程序');
      expect(mocks.native).not.toHaveBeenCalled();
    },
  );
  it.runIf(process.platform === 'darwin')(
    '选择文件验证后才返回路径',
    async () => {
      const response = await POST(request({ action: 'pick' }));
      expect((await response.json()).path).toBe('/private/tmp/resume.pdf');
      expect(mocks.validate).toHaveBeenCalledWith('/tmp/resume.pdf');
    },
  );
  it.runIf(process.platform === 'darwin')('取消选择不报失败', async () => {
    mocks.native.mockRejectedValue(new Error('User canceled. (-128)'));
    expect(await (await POST(request({ action: 'pick' }))).json()).toEqual({
      canceled: true,
    });
    expect(mocks.validate).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === 'darwin')(
    '显式测试禁用系统操作，不展示弹窗或打开文件',
    async () => {
      vi.stubEnv('ZHAOPIN_DISABLE_FILE_OPERATIONS', '1');
      expect((await POST(request({ action: 'pick' }))).status).toBe(503);
      expect(
        (await POST(request({ action: 'open', materialId: 'registered' })))
          .status,
      ).toBe(503);
      expect(mocks.native).not.toHaveBeenCalled();
    },
  );
  it.runIf(process.platform === 'darwin')(
    '系统超时返回可读错误，不返回原始系统日志',
    async () => {
      mocks.native.mockRejectedValue(new Error('secret OS output'));
      const response = await POST(request({ action: 'pick' }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('超时');
    },
  );
});
