'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/domain';
import type { Activity, Extraction, Mutate } from '@/lib/client-types';

export type SavedDraft = {
  id: string;
  draftRevision: string;
  sourceUrl: string;
  sourceText: string;
  extraction: Extraction | null;
  warning: string;
};
type DraftSummary = {
  id: string;
  draftRevision: string;
  organization: string;
  role: string;
  createdAt: string;
};
type Page<T> = { items: T[]; nextCursor: string | null };

function useWorkspacePages<T extends { id: string }>(
  query: string,
  version: string | number,
) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  const attemptedCursor = useRef<string | null>(null);
  const load = useCallback(
    async (next: string | null = null) => {
      // Retrying an older page never drops the already visible records.
      if (next && active.current) return;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const token = ++sequence.current;
      attemptedCursor.current = next;
      setLoading(true);
      setError('');
      try {
        const response = await fetch(
          `/api/state?${query}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`,
          {
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        );
        const body = (await response.json()) as Page<T> & { error?: string };
        if (!response.ok) throw new Error(body.error || '读取失败');
        if (
          !Array.isArray(body.items) ||
          !(body.nextCursor === null || typeof body.nextCursor === 'string')
        )
          throw new Error('列表响应不完整，请重试。');
        if (token !== sequence.current) return;
        setItems((previous) =>
          next
            ? [
                ...previous,
                ...body.items.filter(
                  (row) => !previous.some((p) => p.id === row.id),
                ),
              ]
            : body.items,
        );
        setCursor(body.nextCursor);
      } catch (failure) {
        if (token === sequence.current)
          setError(
            failure instanceof Error ? failure.message : '读取失败，请重试。',
          );
      } finally {
        if (token === sequence.current) {
          active.current = null;
          setLoading(false);
        }
      }
    },
    [query],
  );
  const dispose = useCallback(() => {
    ++sequence.current;
    active.current?.abort();
    active.current = null;
  }, []);
  useEffect(() => {
    let canceled = false;
    queueMicrotask(() => {
      if (!canceled) void load();
    });
    return () => {
      canceled = true;
      dispose();
    };
    // Reload only when ownership/version changes, not every parent state read.
  }, [load, version, dispose]);
  return {
    items,
    cursor,
    loading,
    error,
    load,
    retry: () => load(attemptedCursor.current),
  };
}
function PageControls({
  page,
}: {
  page: {
    cursor: string | null;
    loading: boolean;
    error: string;
    load: (cursor?: string | null) => Promise<void>;
    retry: () => Promise<void>;
  };
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      {page.error && (
        <p role="alert" className="w-full text-xs text-[#996029]">
          {page.error}
        </p>
      )}
      {(page.cursor || page.error) && (
        <Button
          variant="outline"
          size="sm"
          disabled={page.loading}
          onClick={() =>
            void (page.error ? page.retry() : page.load(page.cursor))
          }
        >
          {page.loading
            ? '正在读取…'
            : page.error
              ? '重试读取'
              : page.cursor
                ? '加载更早记录'
                : '刷新记录'}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={page.loading}
        onClick={() => void page.load()}
      >
        {page.loading ? '正在读取…' : '刷新记录'}
      </Button>
    </div>
  );
}
export function ActivityList({
  opportunityId,
  updatedAt,
}: {
  opportunityId: string;
  updatedAt: string;
}) {
  const page = useWorkspacePages<Activity>(
    `section=activities&opportunityId=${encodeURIComponent(opportunityId)}`,
    updatedAt,
  );
  return (
    <section aria-label="推进记录列表">
      <p className="mt-4 text-xs text-[#888278]">
        已显示 {page.items.length} 条{page.cursor ? ' · 还有更早记录' : ''}
      </p>
      <div className="mt-5 space-y-4 border-l border-[#d9d4ca] pl-5">
        {page.items.map((item) => (
          <div key={item.id} className="relative">
            <span className="absolute -left-[25px] top-1.5 size-2 rounded-full bg-[#7aa095] ring-4 ring-[#f6f4ee]" />
            <p className="whitespace-pre-wrap text-sm font-medium [overflow-wrap:anywhere]">
              {item.content}
            </p>
            <p className="mt-1 text-xs text-[#888278]">
              {formatDateTime(item.createdAt)}
            </p>
          </div>
        ))}
      </div>
      <PageControls page={page} />
    </section>
  );
}
export function PendingDrafts({
  count,
  mutate,
  onResume,
}: {
  count: number;
  mutate: Mutate;
  onResume: (draft: SavedDraft) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mb-5 rounded-[20px] border border-[#d8e3dc] bg-[#edf3ef] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">待确认草稿 · {count}</h2>
          <p className="mt-1 text-xs text-[#6f796f]">
            提取后尚未确认的岗位，未计入机会或求职漏斗。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>
          {open ? '收起草稿' : '查看草稿'}
        </Button>
      </div>
      {open && <DraftList count={count} mutate={mutate} onResume={onResume} />}
    </section>
  );
}
function DraftList({
  count,
  mutate,
  onResume,
}: {
  count: number;
  mutate: Mutate;
  onResume: (draft: SavedDraft) => void;
}) {
  const page = useWorkspacePages<DraftSummary>('section=drafts', count);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState('');
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (id: string, remove = false) => {
    if (lock.current) return;
    if (
      remove &&
      !confirm('确定移除这个未确认草稿？正式机会和本机文件不会改变。')
    )
      return;
    lock.current = true;
    setBusy(id);
    setError('');
    try {
      if (remove) {
        const draft = page.items.find((item) => item.id === id);
        if (!draft?.draftRevision)
          throw new Error('请刷新草稿列表，核对最新内容后重新确认移除。');
        await mutate('discardDraft', {
          id,
          draftRevision: draft.draftRevision,
        });
        if (alive.current) await page.load();
      } else {
        const response = await fetch(
          `/api/state?section=draft&id=${encodeURIComponent(id)}`,
          { cache: 'no-store', signal: AbortSignal.timeout(15000) },
        );
        const draft = (await response.json()) as SavedDraft & {
          error?: string;
        };
        if (!response.ok) throw new Error(draft.error || '草稿读取失败');
        if (alive.current) onResume(draft);
      }
    } catch (failure) {
      if (alive.current)
        setError(
          failure instanceof Error ? failure.message : '操作失败，请重试。',
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(null);
    }
  };
  return (
    <div className="mt-4 space-y-2" aria-label="待确认草稿列表">
      {error && (
        <p role="alert" className="text-xs text-[#996029]">
          {error}
        </p>
      )}
      {page.items.map((item) => (
        <div
          key={item.id}
          className="flex flex-wrap items-center gap-2 rounded-xl bg-white/80 p-3"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium [overflow-wrap:anywhere]">
              {item.organization || '待核对组织'} · {item.role || '待核对岗位'}
            </p>
            <p className="mt-1 text-xs text-[#888278]">
              {formatDateTime(item.createdAt)}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void run(item.id)}
          >
            继续核对
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void run(item.id, true)}
          >
            移除草稿
          </Button>
        </div>
      ))}
      <PageControls page={page} />
    </div>
  );
}
