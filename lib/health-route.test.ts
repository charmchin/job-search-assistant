import { describe, expect, it, vi } from 'vitest';
vi.mock('./runtime-health', () => ({
  runtimeHealth: Object.freeze({
    appId: 'com.local.zhaopin-assistant',
    fingerprint: 'fixture',
    buildId: 'id',
    pid: 1,
  }),
}));
import { GET } from '@/app/api/health/route';
describe('只读版本身份接口', () => {
  it('不访问数据库，返回运行身份且不缓存', async () => {
    const response = await GET(new Request('http://127.0.0.1:3000/api/health'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      appId: 'com.local.zhaopin-assistant',
      fingerprint: 'fixture',
    });
  });
  it('仍拒绝恶意 Host、Origin 和嵌入', async () => {
    for (const headers of [
      { Host: 'evil.example:3000' },
      { Origin: 'http://127.0.0.1:3113' },
      { 'Sec-Fetch-Dest': 'iframe' },
    ] as Record<string, string>[])
      expect(
        (
          await GET(
            new Request('http://127.0.0.1:3000/api/health', { headers }),
          )
        ).status,
      ).toBe(403);
  });
});
