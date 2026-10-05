import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/action/route';
import { ActionError } from './actions';
import { actionSchema } from './action-schema';
const execute = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ sqlite: {} }));
vi.mock('@/lib/secrets', () => ({ saveApiKey: vi.fn() }));
vi.mock('@/lib/actions', async (original) => ({
  ...(await original<typeof import('./actions')>()),
  createActionService: () => ({ execute }),
}));
const request = (body: string, headers: Record<string, string> = {}) =>
  new Request('http://127.0.0.1:3115/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
beforeEach(() => {
  execute.mockReset().mockResolvedValue({ id: 'saved' });
});
describe('写入 API 错误响应（服务与钥匙串模拟）', () => {
  it('来源拒绝及坏 JSON 不进入业务', async () => {
    expect((await POST(request('{}', { Origin: 'null' }))).status).toBe(403);
    expect((await POST(request('bad-json'))).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
  it('合法成功有明确回执', async () =>
    expect(await (await POST(request('{}'))).json()).toEqual({ id: 'saved' }));
  it('校验错误有字段说明与 400', async () => {
    execute.mockImplementation(() =>
      actionSchema.parse({
        action: 'updateTask',
        payload: { id: 't', title: '' },
      }),
    );
    const response = await POST(request('{}'));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('名称');
  });
  it.each([404, 409, 413])('业务错误状态 %i 保留', async (status) => {
    execute.mockRejectedValue(new ActionError('明确错误', status, 'FIXTURE'));
    const response = await POST(request('{}'));
    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe('FIXTURE');
  });
  it('存储错误返回 500，不泄露原始错误或密钥', async () => {
    execute.mockRejectedValue(new Error('secret fixture'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await POST(request('{}'));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('secret');
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    } finally {
      log.mockRestore();
    }
  });
});
