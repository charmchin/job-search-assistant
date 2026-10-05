'use client';

import { ArrowUpRight, CalendarDays, Circle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/domain';
import { ACTION_LABELS, type TodayAction } from '@/lib/today';

export function TodayActionRow({
  action,
  featured,
  pending,
  disabled,
  onComplete,
  onOpen,
}: {
  action: TodayAction;
  featured: boolean;
  pending: boolean;
  disabled: boolean;
  onComplete: () => void;
  onOpen: (id: string) => void;
}) {
  const completable = ['task', 'milestone', 'nextAction'].includes(action.kind);
  return (
    <div
      data-testid={`today-action-${action.id}`}
      className={`flex items-start gap-3 rounded-2xl border p-4 ${featured ? 'border-[#bfd1c8] bg-[#f2f7f4]' : 'border-[#e6e1d7] bg-[#fffefa]'}`}
    >
      {completable ? (
        <button
          disabled={disabled}
          onClick={onComplete}
          aria-label={`完成${action.kind !== 'milestone' ? '任务' : '节点'} ${action.title}`}
          className="mt-1 grid size-8 shrink-0 place-items-center rounded-full text-[#397365] hover:bg-[#e1eee7] disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Circle className="size-5" />
          )}
        </button>
      ) : (
        <div className="mt-1 grid size-8 shrink-0 place-items-center text-[#8c7550]">
          <CalendarDays className="size-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#827c72]">
          <span className="rounded-md bg-black/[.04] px-1.5 py-0.5">
            {ACTION_LABELS[action.kind]}
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {action.opportunity
              ? `${action.opportunity.organization} · ${action.opportunity.role}`
              : '独立任务'}
          </span>
        </div>
        <p className="mt-2 text-sm font-semibold [overflow-wrap:anywhere]">
          {action.title}
        </p>
        <p
          className={`mt-1 text-xs leading-5 [overflow-wrap:anywhere] ${action.bucket === 0 ? 'text-[#a64639]' : action.bucket === 1 ? 'text-[#936d36]' : 'text-[#6e786d]'}`}
        >
          {action.reason}
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-[#817b71]">
            {formatDateTime(action.dueAt)}
            {action.dueAt && ' · 上海时间'}
          </p>
          {action.opportunity && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-[#397365]"
              onClick={() => onOpen(action.opportunity!.id)}
            >
              查看机会
              <ArrowUpRight className="size-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
