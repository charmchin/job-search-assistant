import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/reminders/route';
import { getReminderStatus, testReminderNotification } from '@/lib/reminders';

vi.mock('@/lib/reminders', () => ({
  getReminderStatus: vi.fn(),
  testReminderNotification: vi.fn(),
}));
const status = {
  mode: 'available' as const,
  timeZone: 'Asia/Shanghai',
  lastCheckedAt: null,
  cursorAt: null,
  lastSubmittedAt: null,
  lastCount: 0,
  pendingCount: 0,
  lastError: '',
  invalidConfigurations: 0,
  nextAt: null,
  lastTestAt: null,
  lastTestError: '',
};
const request = (
  body: string,
  headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: 'http://127.0.0.1:3110',
  },
) =>
  new Request('http://127.0.0.1:3110/api/reminders', {
    method: 'POST',
    headers,
    body,
  });
beforeEach(() => {
  vi.mocked(getReminderStatus).mockReset().mockReturnValue(status);
  vi.mocked(testReminderNotification).mockReset().mockResolvedValue();
});
describe('提醒状态与测试接口（全部模拟通知）', () => {
  it('读取状态没有通知副作用', async () => {
    expect(
      await (
        await GET(new Request('http://127.0.0.1:3110/api/reminders'))
      ).json(),
    ).toEqual(status);
    expect(testReminderNotification).not.toHaveBeenCalled();
  });
  it('读取失败有明确 HTTP 500', async () => {
    vi.mocked(getReminderStatus).mockImplementation(() => {
      throw new Error();
    });
    expect(
      (await GET(new Request('http://127.0.0.1:3110/api/reminders'))).status,
    ).toBe(500);
  });
  it('用户测试只确认已提交，不声称通知已显示', async () => {
    const result = await POST(request('{"action":"test"}'));
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.submitted).toBe(true);
    expect(body.message).toContain('不代表');
    expect(testReminderNotification).toHaveBeenCalledTimes(1);
  });
  it('Next 内部 localhost URL 不影响浏览器的 127.0.0.1 同源请求', async () => {
    const response = await POST(
      new Request('http://localhost:3110/api/reminders', {
        method: 'POST',
        headers: {
          Host: '127.0.0.1:3110',
          Origin: 'http://127.0.0.1:3110',
          'Content-Type': 'application/json',
        },
        body: '{"action":"test"}',
      }),
    );
    expect(response.status).toBe(200);
    expect(testReminderNotification).toHaveBeenCalledTimes(1);
  });
  it.each([
    'untrusted.example',
    '127.0.0.1:99999',
    'localhost@untrusted.example',
    '127.0.0.1/path',
  ])('不信任任意 Host（%s）', async (host) => {
    expect(
      (
        await POST(
          request('{"action":"test"}', {
            Host: host,
            Origin: `http://${host}`,
            'Content-Type': 'application/json',
          }),
        )
      ).status,
    ).toBe(403);
    expect(testReminderNotification).not.toHaveBeenCalled();
  });
  it.each(['{}', '{"action":"scan"}', 'bad-json'])(
    '非法请求不触发通知（%s）',
    async (body) => {
      expect((await POST(request(body))).status).toBe(400);
      expect(testReminderNotification).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['text/plain', 'http://127.0.0.1:3110'],
    ['application/json', 'https://untrusted.example'],
  ])('拒绝跨来源与非 JSON 请求（%#）', async (contentType, origin) => {
    expect(
      (
        await POST(
          request('{"action":"test"}', {
            'Content-Type': contentType,
            Origin: origin,
          }),
        )
      ).status,
    ).toBe(403);
    expect(testReminderNotification).not.toHaveBeenCalled();
  });
  it('OS 失败保留可观察状态', async () => {
    vi.mocked(testReminderNotification).mockRejectedValue(
      new Error('测试通知提交失败'),
    );
    const response = await POST(request('{"action":"test"}'));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('提交失败');
  });
});
