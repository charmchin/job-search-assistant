import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError } from './actions';
const mocks = vi.hoisted(() => ({ state: vi.fn(), page: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/repository', () => ({ getWorkspaceState: mocks.state }));
vi.mock('@/lib/workspace-pages', async (original) => ({
  ...(await original<typeof import('./workspace-pages')>()),
  readWorkspacePage: mocks.page,
}));
import { GET } from '@/app/api/state/route';
beforeEach(() => {
  mocks.state.mockReset().mockResolvedValue({ opportunities: [] });
  mocks.page.mockReset().mockReturnValue({ items: [], nextCursor: null });
});
const request = (query = '', headers = {}) =>
  new Request('http://127.0.0.1:3000/api/state' + query, { headers });
describe('状态与分页共用本机边界', () => {
  it.each([
    '',
    '?section=drafts',
    '?section=draft&id=a',
    '?section=activities&opportunityId=a',
  ])('恶意来源在读取前拒绝：%s', async (query) => {
    expect(
      (await GET(request(query, { Origin: 'https://evil.example' }))).status,
    ).toBe(403);
    expect(mocks.state).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it('常规状态及分页均no-store，分页不读取全量状态', async () => {
    const state = await GET(request());
    const page = await GET(request('?section=drafts'));
    expect(state.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(mocks.state).toHaveBeenCalledTimes(1);
    expect(mocks.page).toHaveBeenCalledWith({}, { section: 'drafts' });
  });
  it('坏参数400、旧记录404/409与内部错误500均有可操作说明', async () => {
    expect((await GET(request('?section=unknown'))).status).toBe(400);
    expect(mocks.page).not.toHaveBeenCalled();
    for (const status of [404, 409]) {
      mocks.page.mockImplementationOnce(() => {
        throw new ActionError('请刷新列表。', status);
      });
      const response = await GET(request('?section=draft&id=a'));
      expect(response.status).toBe(status);
      expect(await response.text()).toContain('请刷新列表');
    }
    mocks.page.mockImplementationOnce(() => {
      throw new Error('private-data-secret');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await GET(request('?section=drafts'));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('private-data-secret');
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        'private-data-secret',
      );
    } finally {
      log.mockRestore();
    }
  });
});
