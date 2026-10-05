import { describe, expect, it, vi } from 'vitest';
import { createMutationClient } from './mutation-client';
import { createWorkspaceReader } from './workspace-reader';

const setup = () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ id: 'created' }));
  const refresh = vi.fn(async () => true),
    notice = vi.fn(),
    makeId = vi.fn(() => crypto.randomUUID());
  return {
    fetcher,
    refresh,
    notice,
    makeId,
    client: createMutationClient({ fetcher, refresh, notice, makeId }),
  };
};
describe('保存结果与请求去重（无网络）', () => {
  it.each([true, false])(
    '冲突只读取最新状态，不自动重发或将草稿改为新基线（刷新=%s）',
    async (refreshed) => {
      const { client, fetcher, refresh, notice } = setup();
      refresh.mockResolvedValue(refreshed);
      fetcher.mockResolvedValue(
        Response.json(
          { error: '字段已修改，输入已保留', code: 'EDIT_CONFLICT' },
          { status: 409 },
        ),
      );
      const payload = { id: 'a', notes: '乙', expected: { notes: '旧' } };
      await expect(
        client.mutate('updateOpportunity', payload),
      ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(payload.expected).toEqual({ notes: '旧' });
      expect(client.isBusy()).toBe(false);
      expect(notice).toHaveBeenLastCalledWith({
        kind: 'error',
        message: '字段已修改，输入已保留',
      });
    },
  );
  it('双击共享同一进行中请求', async () => {
    const { client, fetcher } = setup();
    const a = client.mutate('createTask', { title: '任务' }),
      b = client.mutate('createTask', { title: '任务' });
    expect(client.isBusy()).toBe(true);
    expect(a).toBe(b);
    await a;
    expect(client.isBusy()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('已保存但刷新失败返回成功，拦截新的写入，只刷新后解锁', async () => {
    const { client, refresh, fetcher, notice } = setup();
    refresh.mockResolvedValue(false);
    expect(await client.mutate('createTask', { title: '任务' })).toMatchObject({
      id: 'created',
    });
    expect(notice).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'warning',
        message: expect.stringContaining('数据已保存'),
      }),
    );
    expect(client.isBusy()).toBe(true);
    await expect(
      client.mutate('createTask', { title: '任务' }),
    ).rejects.toMatchObject({ code: 'REFRESH_REQUIRED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.markRefreshed();
    expect(client.isBusy()).toBe(false);
    refresh.mockResolvedValue(true);
    fetcher.mockResolvedValue(Response.json({ id: 'next' }));
    await client.mutate('createTask', { title: '另一个任务' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('刷新抛错不会把已提交操作误报为写入失败', async () => {
    const { client, refresh } = setup();
    refresh.mockRejectedValue(new Error('read failed'));
    await expect(
      client.mutate('createTask', { title: '任务' }),
    ).resolves.toMatchObject({ id: 'created' });
  });
  it('响应丢失重试同内容沿用标识，不会自动重发', async () => {
    const { client, fetcher, makeId } = setup();
    fetcher.mockRejectedValueOnce(new Error('connection lost'));
    await expect(
      client.mutate('createTask', { title: '任务' }),
    ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    await client.mutate('createTask', { title: '任务' });
    const ids = fetcher.mock.calls.map(
      ([, init]) => JSON.parse(init!.body as string).requestId,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(makeId).toHaveBeenCalledTimes(1);
  });
  it.each([
    Response.json({}, { status: 200 }),
    new Response('not-json', { status: 200 }),
  ])('无有效确认不能声称已保存（%#）', async (response) => {
    const { client, fetcher, refresh } = setup();
    fetcher.mockResolvedValue(response);
    await expect(
      client.mutate('createTask', { title: '任务' }),
    ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect(refresh).not.toHaveBeenCalled();
  });
  it('明确 400 错误保持字段说明，不刷新；新提交换标识', async () => {
    const { client, fetcher, refresh } = setup();
    fetcher.mockResolvedValueOnce(
      Response.json(
        { error: '岗位不能为空', code: 'INVALID_INPUT' },
        { status: 400 },
      ),
    );
    await expect(
      client.mutate('createTask', { title: '任务' }),
    ).rejects.toThrow('岗位不能为空');
    expect(refresh).not.toHaveBeenCalled();
    await client.mutate('createTask', { title: '任务' });
    expect(
      JSON.parse(fetcher.mock.calls[0][1]!.body as string).requestId,
    ).not.toBe(JSON.parse(fetcher.mock.calls[1][1]!.body as string).requestId);
  });
  it('正常成功后允许同内容的新意图使用新标识', async () => {
    const { client, fetcher, makeId } = setup();
    await client.mutate('createTask', { title: '任务' });
    fetcher.mockResolvedValue(Response.json({ id: 'other' }));
    await client.mutate('createTask', { title: '任务' });
    expect(makeId).toHaveBeenCalledTimes(2);
  });
});
describe('读取顺序防止旧响应覆盖新状态', () => {
  it('后开始的读取先返回时，旧响应不再覆盖', async () => {
    let resolveOld!: (response: Response) => void;
    const state = vi.fn(),
      error = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(
        Response.json({
          opportunities: [],
          tasks: [],
          settings: { version: 'new' },
        }),
      );
    const reader = createWorkspaceReader({ fetcher, state, error });
    const old = reader.refresh();
    await reader.refresh();
    resolveOld(
      Response.json({
        opportunities: [],
        tasks: [],
        settings: { version: 'old' },
      }),
    );
    await old;
    expect(state).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { version: 'new' } }),
    );
  });
  it('写入开始后，旧读响应不生效；读取错误保持旧数据并可重试', async () => {
    let resolve!: (response: Response) => void;
    const state = vi.fn(),
      error = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const reader = createWorkspaceReader({ fetcher, state, error });
    const old = reader.refresh();
    reader.invalidate();
    resolve(Response.json({ opportunities: [], tasks: [], settings: {} }));
    await old;
    expect(state).not.toHaveBeenCalled();
    expect(await reader.refresh()).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('暂时无法读取'));
  });
});
