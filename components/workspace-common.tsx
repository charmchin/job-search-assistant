'use client';

import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  Circle,
  Inbox,
  Loader2,
  MapPin,
  MoveRight,
  TimerReset,
  Pencil,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  deadlineBucket,
  formatDateTime,
  STAGES,
  needsApplication,
} from '@/lib/domain';
import type { Mutate, Opportunity, Task } from '@/lib/client-types';
import { currentStageAt } from '@/lib/opportunity-progress';
import { ProgressActions } from './progress-actions';
import { toShanghaiInput, fromShanghaiInput } from '@/lib/reminder-policy';

export const priorityLabel = { high: '重点', medium: '常规', low: '低优先' };
export const priorityClass = {
  high: 'border-[#edc6be] bg-[#fff1ed] text-[#a64639]',
  medium: 'border-[#d9d6cd] bg-[#f7f5ef] text-[#676257]',
  low: 'border-[#e5e3dc] bg-[#faf9f6] text-[#8a857a]',
};
export const decisionLabel = {
  undecided: '待判断',
  pursue: '值得投入',
  hold: '暂缓',
  skip: '不再考虑',
};

export function todayText() {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    timeZone: 'Asia/Shanghai',
  }).format(new Date());
}
export const toInputDate = toShanghaiInput;
export const fromInputDate = fromShanghaiInput;

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="flex items-baseline justify-between gap-3 text-[13px] font-semibold text-[#3d3a34]">
        {label}
        {hint && <span className="font-normal text-[#8a857b]">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function StageBadge({
  stage,
  prominent = false,
}: {
  stage: string;
  prominent?: boolean;
}) {
  const item = STAGES.find((entry) => entry.id === stage);
  return (
    <Badge
      variant="outline"
      className={`rounded-full px-2.5 py-1 ${prominent ? 'h-7 font-semibold' : 'bg-white/70 font-medium'}`}
      style={{
        color: item?.color,
        borderColor: `${item?.color}45`,
        ...(prominent ? { backgroundColor: `${item?.color}12` } : {}),
      }}
    >
      {item?.label || stage}
    </Badge>
  );
}

export function ScoreDots({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-[#746f64]">
      <span>{label}</span>
      <span className="flex gap-1" aria-label={`${label} ${value}/5`}>
        {[1, 2, 3, 4, 5].map((score) => (
          <span
            key={score}
            className={`size-1.5 rounded-full ${score <= value ? 'bg-[#2d6b5d]' : 'bg-[#dedbd3]'}`}
          />
        ))}
      </span>
    </div>
  );
}

export function TaskRow({
  task,
  onToggle,
  onOpen,
  onFocus,
  onSkip,
  onEdit,
  featured = false,
}: {
  task: Task;
  onToggle: () => void;
  onOpen?: () => void;
  onFocus?: () => void;
  onSkip?: () => void;
  onEdit?: () => void;
  featured?: boolean;
}) {
  const overdue = Boolean(
    task.dueAt && new Date(task.dueAt) < new Date() && task.status !== 'done',
  );
  const finished = ['done', 'skipped'].includes(task.status);
  const title = (
    <>
      <p
        className={`break-words text-sm font-semibold ${finished ? 'text-[#918b81] line-through' : 'text-[#302e2a]'}`}
      >
        {task.title}
      </p>
      {task.isNextAction && (
        <Badge className="mt-1 bg-[#e8f4ef] text-[10px] text-[#2d6b5d]">
          下一步
        </Badge>
      )}
      {task.status === 'skipped' && (
        <p className="mt-1 text-xs text-[#858076]">已跳过</p>
      )}
      {task.opportunity && (
        <p className="mt-1 truncate text-xs text-[#858076]">
          {task.opportunity.organization} · {task.opportunity.role}
        </p>
      )}
    </>
  );
  return (
    <div
      className={`group flex flex-wrap items-center gap-3 rounded-[18px] border p-3.5 transition ${featured || task.isNextAction ? 'border-[#b8d1c9] bg-[#f2f8f5]' : 'border-[#e7e3da] bg-white hover:border-[#cfc9bc]'}`}
    >
      <button
        onClick={onToggle}
        className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-black/5"
        aria-label={finished ? '恢复任务' : '完成任务'}
      >
        {finished ? (
          <CheckCircle2 className="size-5 text-[#2d6b5d]" />
        ) : (
          <Circle className="size-5 text-[#aaa499]" />
        )}
      </button>
      {onOpen ? (
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          {title}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{title}</div>
      )}
      <div className="shrink-0 text-right">
        <p
          className={`text-xs font-medium ${overdue && !finished ? 'text-[#b2483b]' : 'text-[#716c62]'}`}
        >
          {task.dueAt ? formatDateTime(task.dueAt) : '未定时间'}
        </p>
        <p className="mt-1 text-[10px] text-[#9a958a]">
          约 {task.estimatedMinutes} 分钟
        </p>
      </div>
      {(onFocus || onEdit) && (
        <div className="flex w-full justify-end gap-1 border-t border-black/5 pt-2">
          {onEdit && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              aria-label={`编辑任务 ${task.title}`}
              onClick={onEdit}
            >
              <Pencil className="size-3" />
              编辑
            </Button>
          )}
          {onFocus && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              aria-label={`${task.isNextAction ? '取消重点' : '设为下一步'} ${task.title}`}
              onClick={onFocus}
            >
              {task.isNextAction ? '取消重点' : '设为下一步'}
            </Button>
          )}
          {onSkip && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-[#858076]"
              aria-label={`跳过任务 ${task.title}`}
              onClick={onSkip}
            >
              跳过
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function OpportunityCard({
  item,
  onClick,
  mutate,
}: {
  item: Opportunity;
  onClick: () => void;
  mutate: Mutate;
}) {
  const stageAt = currentStageAt(item);
  const note = item.latestNote?.content || item.notes;
  const awaitingApplication = needsApplication(item.stage, item.decision);
  const deadline = awaitingApplication
    ? deadlineBucket(item.deadline ? new Date(item.deadline) : null)
    : 'none';
  return (
    <article
      aria-label={`${item.organization} · ${item.role}机会卡片`}
      className="group flex h-full flex-col overflow-hidden rounded-[20px] border border-[#e5e1d8] bg-[#fffefa] text-left shadow-[0_4px_18px_rgba(58,50,37,.04)] transition duration-200 hover:-translate-y-0.5 hover:border-[#b7cbc4] hover:shadow-[0_12px_32px_rgba(45,63,56,.10)]"
    >
      <button
        onClick={onClick}
        className="flex w-full flex-1 flex-col items-stretch p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[#2d6b5d]"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StageBadge stage={item.stage} prominent />
            {item.stage === 'closed' &&
              item.closedReason !== 'unknown' &&
              item.closedReason && (
                <span className="text-xs text-[#817c72]">
                  {item.closedReason === 'rejected' ? '未通过' : '主动放弃'}
                </span>
              )}
          </div>
          <Badge
            variant="outline"
            className={`shrink-0 ${priorityClass[item.priority]}`}
          >
            {priorityLabel[item.priority]}
          </Badge>
        </div>
        <p className="truncate text-xs font-medium text-[#807a70]">
          {item.organization}
        </p>
        <h3 className="mt-1 line-clamp-2 min-h-11 text-[15px] font-semibold leading-[1.45] text-[#2f2c27]">
          {item.role}
        </h3>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#817c72]">
          <span>{decisionLabel[item.decision]}</span>
          {stageAt && (
            <span>
              {item.stage === 'applied' ? '投递时间' : '阶段更新'} ·{' '}
              {formatDateTime(stageAt)}
            </span>
          )}
        </div>
        {note && (
          <div className="mt-3 border-l-2 border-[#b8d1c9] pl-3">
            <p className="text-[10px] font-semibold text-[#8a8479]">
              {item.latestNote
                ? `最近进展 · ${formatDateTime(item.latestNote.createdAt)}`
                : '个人备注'}
            </p>
            <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-[#48443d]">
              {note}
            </p>
          </div>
        )}
        {item.nextAction && (
          <div className="mt-3 rounded-xl bg-[#f3f1eb] px-3 py-2.5">
            <p className="text-[10px] font-semibold tracking-wide text-[#8a8479]">
              下一步
            </p>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#48443d]">
              {item.nextAction}
            </p>
          </div>
        )}
        <div className="mt-auto flex items-center gap-2 pt-3 text-[11px] text-[#817c72]">
          {item.location && (
            <span className="flex min-w-0 items-center gap-1 truncate">
              <MapPin className="size-3" />
              {item.location}
            </span>
          )}
          <span
            className={`ml-auto shrink-0 ${deadline === 'overdue' ? 'font-semibold text-[#b2483b]' : ['72h', '7d'].includes(deadline) ? 'font-semibold text-[#9a671c]' : ''}`}
          >
            {item.deadline
              ? `报名截止 ${formatDateTime(item.deadline)}`
              : '截止未设置'}
          </span>
        </div>
      </button>
      {item.stage !== 'closed' && item.decision !== 'skip' && (
        <div className="border-t border-[#ebe7df] px-4 py-3">
          <ProgressActions item={item} mutate={mutate} />
        </div>
      )}
    </article>
  );
}

export function EmptyPanel({
  title,
  description,
  action,
  actionLabel = '收集第一个机会',
}: {
  title: string;
  description: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="grid min-h-80 place-items-center rounded-[24px] border border-dashed border-[#d8d3c8] bg-white/55 p-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-[#eaf3ef] text-[#2d6b5d]">
          <Inbox className="size-6" />
        </div>
        <h2 className="text-lg font-semibold text-[#302d28]">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-[#7e786e]">{description}</p>
        {action && (
          <Button className="mt-5 rounded-xl" onClick={action}>
            {actionLabel}
            <MoveRight />
          </Button>
        )}
      </div>
    </div>
  );
}

export function Notice({
  title,
  detail,
  tone = 'amber',
}: {
  title: string;
  detail?: string;
  tone?: 'amber' | 'green' | 'red';
}) {
  const style = {
    amber: 'border-[#eed4a5] bg-[#fff8e9] text-[#795416]',
    green: 'border-[#bad5cc] bg-[#eef7f3] text-[#285f53]',
    red: 'border-[#edc9c2] bg-[#fff1ee] text-[#9c4035]',
  }[tone];
  const Icon = tone === 'green' ? CheckCircle2 : AlertTriangle;
  return (
    <div
      className={`flex items-start gap-3 rounded-2xl border p-3.5 text-sm ${style}`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-semibold">{title}</p>
        {detail && (
          <p className="mt-1 text-xs leading-5 opacity-80">{detail}</p>
        )}
      </div>
    </div>
  );
}
export function LoadingState() {
  return (
    <div className="grid min-h-[540px] place-items-center">
      <div className="text-center">
        <Loader2 className="mx-auto size-6 animate-spin text-[#2d6b5d]" />
        <p className="mt-3 text-sm text-[#817b71]">正在整理你的求职节奏…</p>
      </div>
    </div>
  );
}
export function QuickStat({
  label,
  value,
  icon = 'calendar',
  warning = false,
}: {
  label: string;
  value: string;
  icon?: 'calendar' | 'stale';
  warning?: boolean;
}) {
  const Icon = icon === 'stale' ? TimerReset : CalendarClock;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-[#e4e0d7] bg-white/75 p-3.5">
      <div
        className={`grid size-9 place-items-center rounded-xl ${warning ? 'bg-[#fff0e4] text-[#a75f22]' : 'bg-[#eef4f1] text-[#3f6f63]'}`}
      >
        <Icon className="size-4" />
      </div>
      <div>
        <p className="text-lg font-semibold tracking-tight text-[#302d28]">
          {value}
        </p>
        <p className="text-[11px] text-[#878176]">{label}</p>
      </div>
    </div>
  );
}
export function CheckMark({ active }: { active: boolean }) {
  return (
    <span
      className={`grid size-5 place-items-center rounded-full border ${active ? 'border-[#2d6b5d] bg-[#2d6b5d] text-white' : 'border-[#cfcac0]'}`}
    >
      {active && <Check className="size-3" />}
    </span>
  );
}
