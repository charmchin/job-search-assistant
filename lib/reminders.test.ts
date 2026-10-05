import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  notify,
  quoteAppleScript,
  startReminderScheduler,
} from '@/lib/reminders';

const fake = vi.hoisted(() => ({ exec: vi.fn(), prepare: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: fake.exec }));
vi.mock('@/lib/db', () => ({ sqlite: { prepare: fake.prepare } }));
beforeEach(() => {
  fake.exec.mockReset();
  fake.prepare.mockReset();
  vi.stubEnv('ZHAOPIN_DISABLE_NOTIFICATIONS', '0');
  fake.exec.mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: Error | null) => void)(null);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('系统通知适配器（模拟 osascript，不发送实际通知）', () => {
  it('引号、反斜线和控制字符安全编码', () => {
    expect(quoteAppleScript('岗位"\\\n\r\t\u0000结束')).toBe(
      '岗位\\"\\\\    结束',
    );
  });
  it('禁用通知不调用进程，也不创建调度器或修改库', async () => {
    vi.stubEnv('ZHAOPIN_DISABLE_NOTIFICATIONS', '1');
    await expect(notify('测试', '正文')).rejects.toThrow();
    startReminderScheduler();
    expect(fake.exec).not.toHaveBeenCalled();
    expect(fake.prepare).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== 'darwin')(
    '只调用 osascript，参数为单独 argv，限时 10 秒',
    async () => {
      await notify('标题"', '正文\\\n');
      expect(fake.exec).toHaveBeenCalledTimes(1);
      expect(fake.exec.mock.calls[0][0]).toBe('osascript');
      expect(fake.exec.mock.calls[0][1]).toEqual([
        '-e',
        'display notification "正文\\\\ " with title "标题\\""',
      ]);
      expect(fake.exec.mock.calls[0][2]).toEqual({
        timeout: 10_000,
        maxBuffer: 8192,
      });
    },
  );
  it.skipIf(process.platform !== 'darwin')(
    'OS 拒绝或超时时返回失败而非成功',
    async () => {
      fake.exec.mockImplementation((...args: unknown[]) => {
        (args.at(-1) as (error: Error | null) => void)(
          new Error('OS rejected'),
        );
      });
      await expect(notify('测试', '正文')).rejects.toThrow('OS rejected');
    },
  );
});
