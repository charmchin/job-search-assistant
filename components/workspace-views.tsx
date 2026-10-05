'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildRecordUpdate } from '@/lib/record-edit';
import { buildSettingsUpdate, editableSettings } from '@/lib/settings-edit';
import { EditConflictNotice } from './edit-conflict-notice';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FileCheck2,
  FileStack,
  Flame,
  Focus,
  ListFilter,
  Loader2,
  Pencil,
  Trash2,
  Search,
  Settings2,
  Sparkles,
  Target,
  Upload,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ReminderSettings } from '@/components/reminder-settings';
import { RecordAnalyticsView } from '@/components/analytics-view';
import { TodayActionRow } from '@/components/today-action-row';
import { useSaveAction } from '@/components/use-save-action';
import { buildTodayPlan, type TodayAction, type TodayRisk } from '@/lib/today';
import { formatDateTime, STAGES } from '@/lib/domain';
import type { Material, Mutate, WorkspaceState } from '@/lib/client-types';
import {
  decisionLabel,
  EmptyPanel,
  Field,
  OpportunityCard,
  QuickStat,
  StageBadge,
} from '@/components/workspace-common';

export function TodayView({
  data,
  mutate,
  openOpportunity,
  openCapture,
}: {
  data: WorkspaceState;
  mutate: Mutate;
  openOpportunity: (id: string) => void;
  openCapture: () => void;
}) {
  const [now, setNow] = useState(() => new Date());
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState('');
  const [completionError, setCompletionError] = useState('');
  const completionLock = useRef(false);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = setInterval(tick, 30_000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, []);
  const plan = buildTodayPlan(data, now);
  const { focus, undecided, stale, readiness } = plan;
  const focusOpportunity = focus ? focus.opportunity : plan.fallback;
  const complete = async (action: TodayAction) => {
    if (
      completionLock.current ||
      !['task', 'milestone', 'nextAction'].includes(action.kind)
    )
      return;
    completionLock.current = true;
    setPending(action.id);
    setCompletionError('');
    try {
      const milestone = action.kind === 'milestone';
      const original = (milestone ? data.milestones : data.tasks).find(
        (item) => item.id === action.entityId,
      );
      if (!original) throw new Error('该事项已不存在，请刷新核对。');
      const update = buildRecordUpdate(
        milestone ? 'milestone' : 'task',
        original,
        { status: 'done' },
      );
      if (update)
        await mutate(milestone ? 'updateMilestone' : 'updateTask', update);
    } catch (failure) {
      setCompletionError(
        failure instanceof Error
          ? failure.message
          : '完成状态未能保存，请重试。',
      );
    } finally {
      completionLock.current = false;
      setPending('');
    }
  };

  if (!data.opportunities.length && !plan.actions.length)
    return <WelcomeState openCapture={openCapture} />;

  return (
    <div className="min-w-0 space-y-5">
      <section
        data-testid="today-focus"
        className="relative overflow-hidden rounded-[28px] bg-[#173f37] p-6 text-white shadow-[0_24px_60px_rgba(23,63,55,.18)] sm:p-8"
      >
        <div className="absolute -right-16 -top-24 size-72 rounded-full bg-[#75a091]/15 blur-2xl" />
        <div className="absolute bottom-0 right-24 h-32 w-56 rotate-[-12deg] rounded-[50%] border border-white/8" />
        <div className="relative grid gap-7 xl:grid-cols-[minmax(0,1fr)_310px]">
          <div>
            <div className="mb-5 flex items-center gap-2 text-xs font-medium text-[#c6ddd5]">
              <Focus className="size-4" />
              此刻最值得推进
            </div>
            <p className="text-sm text-white/65 [overflow-wrap:anywhere]">
              {focusOpportunity
                ? `${focusOpportunity.organization} · ${focusOpportunity.role}`
                : focus
                  ? '独立行动 · 不关联岗位'
                  : '今天的行动已整理完毕'}
            </p>
            <h2 className="mt-2 max-w-3xl text-2xl font-semibold leading-tight tracking-[-.03em] [overflow-wrap:anywhere] sm:text-3xl">
              {focus?.title || plan.fallbackTitle}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[#c6ddd5]">
              {focus?.reason || plan.fallbackReason}
              {focus?.dueAt && ` · ${formatDateTime(focus.dueAt)}（上海时间）`}
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {focus &&
                ['task', 'milestone', 'nextAction'].includes(focus.kind) && (
                  <Button
                    className="rounded-xl bg-[#f0c978] text-[#2c382f] hover:bg-[#f5d68e]"
                    disabled={Boolean(pending)}
                    onClick={() => void complete(focus)}
                  >
                    {pending === focus.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Check />
                    )}
                    {focus.kind === 'milestone' ? '完成这个节点' : '完成这一步'}
                  </Button>
                )}
              {focusOpportunity && (
                <Button
                  variant="outline"
                  className="rounded-xl border-white/20 bg-white/8 text-white hover:bg-white/14 hover:text-white"
                  onClick={() => openOpportunity(focusOpportunity.id)}
                >
                  打开机会工作区
                  <ArrowUpRight />
                </Button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5 self-end">
            <QuickStat label="待判断机会" value={String(undecided.length)} />
            <QuickStat
              label="逾期 / 72小时"
              value={String(plan.urgentCount)}
              warning={plan.urgentCount > 0}
            />
            <QuickStat
              label="停滞需复查"
              value={String(stale.length)}
              icon="stale"
              warning={stale.length > 0}
            />
            <QuickStat label="材料就绪率" value={`${readiness}%`} />
          </div>
        </div>
      </section>
      {completionError && (
        <p
          role="alert"
          className="rounded-2xl border border-[#edc9c2] bg-[#fff1ee] p-4 text-sm text-[#9c4035]"
        >
          {completionError} 请刷新核对状态后重试。
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(330px,.65fr)]">
        <section
          data-testid="today-queue"
          className="min-w-0 rounded-[24px] border border-[#e2ded4] bg-white/80 p-5 shadow-[0_10px_35px_rgba(55,48,37,.05)]"
        >
          <div className="mb-4 flex flex-col items-start gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[.16em] text-[#8c867b]">
                Action queue
              </p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight">
                今天的推进清单
              </h2>
              <p className="mt-1 text-sm text-[#837d73]">
                任务、招聘节点、投递截止与下一步统一排序。按事项计数，同一机会可含多项。
              </p>
            </div>
            <Badge variant="secondary" className="rounded-full">
              {plan.actions.length} 项待推进
            </Badge>
          </div>
          <div className="space-y-2.5">
            {plan.actions.length ? (
              plan.actions
                .slice(0, expanded ? undefined : 7)
                .map((action, index) => (
                  <TodayActionRow
                    key={action.id}
                    action={action}
                    featured={index === 0}
                    pending={pending === action.id}
                    disabled={Boolean(pending)}
                    onComplete={() => void complete(action)}
                    onOpen={openOpportunity}
                  />
                ))
            ) : (
              <div className="rounded-2xl border border-dashed border-[#d7d2c8] py-10 text-center text-sm text-[#817b71]">
                暂无待推进事项。可评估机会、安排下一步；已有结果仍保留在机会库。
              </div>
            )}
          </div>
          {plan.actions.length > 7 && (
            <Button
              variant="ghost"
              className="mt-3 w-full text-[#397365]"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '收起清单' : `查看全部 ${plan.actions.length} 项`}
            </Button>
          )}
          <p className="mt-4 text-xs leading-5 text-[#8a847a]">
            排序：逾期 → 72 小时 → 7 天 →
            更晚或未定时间；同组按机会优先级、准确截止、最后活动依次比较。下一步是真实任务，可直接完成；投递截止请进入机会核对。
          </p>
        </section>
        <div className="min-w-0 space-y-5">
          <DecisionInbox items={undecided} openOpportunity={openOpportunity} />
          <RiskPanel items={plan.risks} openOpportunity={openOpportunity} />
        </div>
      </div>
    </div>
  );
}

function WelcomeState({ openCapture }: { openCapture: () => void }) {
  return (
    <div className="grid gap-5 xl:grid-cols-[1.25fr_.75fr]">
      <section className="relative min-h-[540px] overflow-hidden rounded-[30px] bg-[#173f37] p-8 text-white sm:p-12">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-[#8bb4a6]/15 blur-3xl" />
        <div className="relative flex h-full max-w-2xl flex-col justify-center">
          <div className="mb-7 grid size-14 place-items-center rounded-2xl bg-white/10">
            <Target className="size-6 text-[#f0c978]" />
          </div>
          <p className="text-sm font-semibold tracking-wide text-[#bcd7ce]">
            不只是记录投递
          </p>
          <h2 className="mt-3 text-4xl font-semibold leading-[1.15] tracking-[-.045em] sm:text-5xl">
            把每个岗位，变成一个清晰的决定和下一步。
          </h2>
          <p className="mt-6 max-w-xl text-base leading-7 text-white/66">
            粘贴招聘链接或正文，工作台会整理岗位门槛、关键风险、材料和行动。你只需要判断是否值得投入，然后按优先顺序推进。
          </p>
          <Button
            size="lg"
            className="mt-8 w-fit rounded-xl bg-[#f0c978] text-[#28372f] hover:bg-[#f5d68e]"
            onClick={openCapture}
          >
            收集第一个岗位
            <ArrowUpRight />
          </Button>
        </div>
      </section>
      <section className="rounded-[30px] border border-[#e0dcd2] bg-white/75 p-7">
        <p className="text-xs font-semibold uppercase tracking-[.16em] text-[#8b857a]">
          工作流
        </p>
        <div className="mt-8 space-y-7">
          {[
            ['01', '收集', '链接能读就自动整理；读不了时给出明确的粘贴指引。'],
            ['02', '判断', '给匹配度和兴趣度打分，明确追、缓、弃。'],
            ['03', '准备', '把材料缺口和截止日期转成可执行任务。'],
            ['04', '推进', '首页每天只突出最重要的一步。'],
          ].map(([n, title, text]) => (
            <div key={n} className="flex gap-4">
              <span className="mt-0.5 text-xs font-bold text-[#4d8174]">
                {n}
              </span>
              <div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-1 text-sm leading-6 text-[#817b71]">{text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function DecisionInbox({
  items,
  openOpportunity,
}: {
  items: WorkspaceState['opportunities'];
  openOpportunity: (id: string) => void;
}) {
  return (
    <section className="rounded-[24px] border border-[#e2ded4] bg-white/80 p-5">
      <div className="mb-4 flex items-center gap-2">
        <ListFilter className="size-4 text-[#3a7567]" />
        <h2 className="font-semibold">待判断收件箱</h2>
        <Badge variant="secondary" className="ml-auto rounded-full">
          {items.length}
        </Badge>
      </div>
      {items.length ? (
        <div className="space-y-2">
          {items.slice(0, 4).map((item) => (
            <button
              key={item.id}
              onClick={() => openOpportunity(item.id)}
              className="flex w-full items-center gap-3 rounded-2xl border border-[#ebe7df] bg-[#fffefa] p-3 text-left hover:border-[#bdcec8]"
            >
              <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#edf4f1] text-xs font-bold text-[#2d6b5d]">
                {item.organization.slice(0, 1)}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {item.organization}
                </p>
                <p className="truncate text-xs text-[#817b72]">{item.role}</p>
              </div>
              <ChevronRight className="ml-auto size-4 text-[#aaa49a]" />
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-2xl bg-[#f3f7f5] p-4 text-sm text-[#5f766f]">
          所有机会都已经做过投入判断。
        </p>
      )}
    </section>
  );
}

function RiskPanel({
  items,
  openOpportunity,
}: {
  items: TodayRisk[];
  openOpportunity: (id: string) => void;
}) {
  return (
    <section
      data-testid="today-risks"
      className="rounded-[24px] border border-[#eadcc2] bg-[#fff9ed] p-5"
    >
      <div className="mb-4 flex items-center gap-2 text-[#865c20]">
        <Flame className="size-4" />
        <h2 className="font-semibold">风险雷达</h2>
      </div>
      {items.length ? (
        <div className="space-y-2">
          {items.slice(0, 4).map(({ opportunity: item, reason }) => (
            <button
              key={item.id}
              onClick={() => openOpportunity(item.id)}
              className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left hover:bg-black/4"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[#57442c]">
                  {item.organization} · {item.role}
                </p>
                <p className="mt-0.5 text-xs text-[#936d36] [overflow-wrap:anywhere]">
                  {reason}
                </p>
              </div>
              <ChevronRight className="ml-auto size-4 text-[#b69767]" />
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm leading-6 text-[#8a6a3c]">
          没有临期或停滞风险，当前节奏安全。
        </p>
      )}
    </section>
  );
}

export function OpportunitiesView({
  data,
  openOpportunity,
  openCapture,
}: {
  data: WorkspaceState;
  openOpportunity: (id: string) => void;
  openCapture: () => void;
}) {
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('all');
  const [decision, setDecision] = useState('all');
  const [mode, setMode] = useState<'cards' | 'list'>('cards');
  const filtered = useMemo(
    () =>
      data.opportunities.filter(
        (item) =>
          `${item.organization} ${item.role} ${item.direction} ${item.tags.join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase()) &&
          (stage === 'all' || item.stage === stage) &&
          (decision === 'all' || item.decision === decision),
      ),
    [data.opportunities, query, stage, decision],
  );
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-[20px] border border-[#e2ded5] bg-white/75 p-2.5">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#918b81]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索公司、岗位、方向或标签"
            className="h-10 border-0 bg-transparent pl-10 shadow-none"
          />
        </div>
        <select
          value={decision}
          onChange={(event) => setDecision(event.target.value)}
          className="h-9 rounded-xl border border-[#ddd8ce] bg-[#faf9f6] px-3 text-xs"
        >
          <option value="all">全部判断</option>
          <option value="undecided">待判断</option>
          <option value="pursue">值得投入</option>
          <option value="hold">暂缓</option>
          <option value="skip">不再考虑</option>
        </select>
        <select
          value={stage}
          onChange={(event) => setStage(event.target.value)}
          className="h-9 rounded-xl border border-[#ddd8ce] bg-[#faf9f6] px-3 text-xs"
        >
          <option value="all">全部阶段</option>
          {STAGES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <div className="flex rounded-xl bg-[#f0eee8] p-1">
          <button
            onClick={() => setMode('cards')}
            className={`rounded-lg px-3 py-1.5 text-xs ${mode === 'cards' ? 'bg-white font-semibold shadow-sm' : 'text-[#7f796f]'}`}
          >
            卡片
          </button>
          <button
            onClick={() => setMode('list')}
            className={`rounded-lg px-3 py-1.5 text-xs ${mode === 'list' ? 'bg-white font-semibold shadow-sm' : 'text-[#7f796f]'}`}
          >
            列表
          </button>
        </div>
      </div>
      {!data.opportunities.length ? (
        <EmptyPanel
          title="机会库还是空的"
          description="收集一个真实岗位，完成匹配判断，并把它变成可以推进的行动。"
          action={openCapture}
        />
      ) : mode === 'cards' ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((item) => (
            <OpportunityCard
              key={item.id}
              item={item}
              onClick={() => openOpportunity(item.id)}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-[22px] border border-[#e2ded4] bg-white/80">
          <div className="hidden grid-cols-[1fr_1.5fr_.7fr_.75fr_.85fr] gap-4 border-b border-[#e7e3da] bg-[#f5f3ed] px-5 py-3 text-xs font-semibold text-[#817b70] md:grid">
            <span>公司</span>
            <span>岗位 / 下一步</span>
            <span>判断</span>
            <span>阶段</span>
            <span>截止</span>
          </div>
          {filtered.map((item) => (
            <button
              key={item.id}
              onClick={() => openOpportunity(item.id)}
              className="grid w-full grid-cols-1 gap-2 border-b border-[#ebe7df] px-5 py-4 text-left last:border-0 hover:bg-[#f9f8f4] md:grid-cols-[1fr_1.5fr_.7fr_.75fr_.85fr] md:items-center md:gap-4"
            >
              <span className="font-semibold">{item.organization}</span>
              <span>
                <span className="block text-sm font-medium">{item.role}</span>
                <span className="mt-1 block truncate text-xs text-[#8a847a]">
                  {item.nextAction || '尚未设置下一步'}
                </span>
              </span>
              <span className="text-xs text-[#6f6960]">
                {decisionLabel[item.decision]}
              </span>
              <StageBadge stage={item.stage} />
              <span className="text-xs text-[#777168]">
                {formatDateTime(item.deadline)}
              </span>
            </button>
          ))}
        </div>
      )}
      {data.opportunities.length > 0 && !filtered.length && (
        <EmptyPanel
          title="没有符合条件的机会"
          description="试试清空搜索词，或切换判断与阶段筛选。"
        />
      )}
    </div>
  );
}

export function CalendarView({
  data,
  openOpportunity,
}: {
  data: WorkspaceState;
  openOpportunity: (id: string) => void;
}) {
  const events = [
    ...data.opportunities
      .filter((item) => item.deadline)
      .map((item) => ({
        id: `o-${item.id}`,
        opportunityId: item.id,
        date: item.deadline!,
        title: `${item.organization} · ${item.role}`,
        kind: '投递截止',
      })),
    ...data.milestones
      .filter((item) => item.scheduledAt)
      .map((item) => ({
        id: `m-${item.id}`,
        opportunityId: item.opportunityId,
        date: item.scheduledAt!,
        title: item.title,
        kind: '招聘节点',
      })),
    ...data.tasks
      .filter(
        (item) => item.dueAt && !['done', 'skipped'].includes(item.status),
      )
      .map((item) => ({
        id: `t-${item.id}`,
        opportunityId: item.opportunityId,
        date: item.dueAt!,
        title: item.title,
        kind: '行动任务',
      })),
  ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return events.length ? (
    <div className="mx-auto max-w-4xl rounded-[26px] border border-[#e2ded4] bg-white/80 p-5 sm:p-7">
      <div className="mb-7">
        <p className="text-sm text-[#827c72]">
          任务、截止时间与招聘节点合并排序
        </p>
      </div>
      <div className="space-y-3">
        {events.map((item) => (
          <button
            key={item.id}
            onClick={() =>
              item.opportunityId && openOpportunity(item.opportunityId)
            }
            className="flex w-full items-center gap-4 rounded-[18px] border border-[#ebe7df] bg-[#fffefa] p-4 text-left hover:border-[#b9cdc6]"
          >
            <div className="w-14 shrink-0 text-center">
              <p className="text-lg font-semibold text-[#355f55]">
                {new Intl.DateTimeFormat('en-US', {
                  day: 'numeric',
                  timeZone: 'Asia/Shanghai',
                }).format(new Date(item.date))}
              </p>
              <p className="text-[10px] text-[#8c867c]">
                {new Intl.DateTimeFormat('zh-CN', {
                  month: 'short',
                  timeZone: 'Asia/Shanghai',
                }).format(new Date(item.date))}
              </p>
            </div>
            <div className="h-9 w-px bg-[#e3ded4]" />
            <div className="min-w-0">
              <Badge
                variant="secondary"
                className="mb-1 rounded-full text-[10px]"
              >
                {item.kind}
              </Badge>
              <p className="truncate text-sm font-semibold">{item.title}</p>
            </div>
            <span className="ml-auto shrink-0 text-xs text-[#7e786f]">
              {formatDateTime(item.date)}
            </span>
          </button>
        ))}
      </div>
    </div>
  ) : (
    <EmptyPanel
      title="时间线还是空的"
      description="给机会设置截止日期、下一步任务或面试节点后，这里会形成完整时间线。"
    />
  );
}

export function MaterialsView({
  data,
  openCreate,
  openEdit,
  mutate,
}: {
  data: WorkspaceState;
  openCreate: () => void;
  openEdit: (material: Material) => void;
  mutate: Mutate;
}) {
  const [removing, setRemoving] = useState<Material | null>(null);
  const deletion = useSaveAction();
  const opening = useRef(new Set<string>());
  const [pending, setPending] = useState<string[]>([]);
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  const openFile = async (materialId: string) => {
    if (opening.current.has(materialId)) return;
    opening.current.add(materialId);
    setPending([...opening.current]);
    setFileErrors((current) => ({ ...current, [materialId]: '' }));
    try {
      const response = await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'open', materialId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '无法打开文件');
    } catch (error) {
      setFileErrors((current) => ({
        ...current,
        [materialId]:
          error instanceof Error ? error.message : '文件操作失败，请重试。',
      }));
    } finally {
      opening.current.delete(materialId);
      setPending([...opening.current]);
    }
  };
  return (
    <div>
      <div className="mb-5 flex items-center justify-between rounded-2xl border border-[#e2ded4] bg-white/70 p-4">
        <p className="text-sm text-[#787268]">
          只保存文件路径，不复制、不上传。可打开普通文档与图片，不运行程序或脚本，不支持
          DOCM 等含宏格式。
        </p>
        <Button className="rounded-xl" onClick={openCreate}>
          <FileStack />
          添加材料
        </Button>
      </div>
      {data.materials.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.materials.map((item) => (
            <Card
              key={item.id}
              className="border-[#e2ded4] bg-white/80 shadow-none"
            >
              <CardHeader>
                <div className="mb-2 grid size-11 place-items-center rounded-2xl bg-[#eaf3ef] text-[#2d6b5d]">
                  <FileCheck2 className="size-5" />
                </div>
                <CardTitle>{item.name}</CardTitle>
                <CardDescription>
                  {item.category}
                  {item.version && ` · ${item.version}`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Badge
                  className={
                    item.filePath
                      ? item.fileExists
                        ? 'bg-[#e8f4ef] text-[#2d6b5d]'
                        : 'bg-[#fff0ed] text-[#a64639]'
                      : 'bg-[#f0eee8] text-[#777168]'
                  }
                >
                  {item.filePath
                    ? item.fileExists
                      ? '路径存在'
                      : '文件已移动'
                    : '未关联文件'}
                </Badge>
                <p className="mt-2 text-xs text-[#787268]">
                  关联{' '}
                  {
                    data.requirements.filter((r) => r.materialId === item.id)
                      .length
                  }{' '}
                  项岗位要求
                </p>
                <p className="my-4 line-clamp-2 min-h-10 break-all text-xs leading-5 text-[#858076]">
                  {item.filePath || item.notes || '暂无文件路径或备注'}
                </p>
                <Button
                  variant="outline"
                  className="w-full rounded-xl"
                  disabled={!item.fileExists || pending.includes(item.id)}
                  onClick={() => void openFile(item.id)}
                >
                  {pending.includes(item.id) ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ExternalLink />
                  )}
                  {pending.includes(item.id) ? '正在打开…' : '打开文件'}
                </Button>
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="ghost"
                    className="flex-1 rounded-xl"
                    aria-label={`编辑材料 ${item.name}`}
                    onClick={() => openEdit(item)}
                  >
                    <Pencil className="size-4" />
                    {item.filePath && !item.fileExists
                      ? '修复文件引用'
                      : '编辑 / 替换'}
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`删除材料 ${item.name}`}
                    onClick={() => {
                      deletion.reset();
                      setRemoving(item);
                    }}
                  >
                    <Trash2 className="size-4 text-[#a64639]" />
                  </Button>
                </div>
                {fileErrors[item.id] && (
                  <p
                    role="alert"
                    className="mt-3 text-xs leading-5 text-[#a64639]"
                  >
                    {fileErrors[item.id]}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyPanel
          title="材料库还是空的"
          description="关联简历、成绩单、作品集等本机文件，后续可以直接检查岗位材料缺口。"
          action={openCreate}
          actionLabel="添加第一份材料"
        />
      )}
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && !deletion.pending && setRemoving(null)}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto border-[#ddd8ce] bg-[#f8f6f1] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>移除材料引用？</DialogTitle>
            <DialogDescription>
              只从材料库移除“{removing?.name}”，不会删除或改动本机文件。关联的{' '}
              {
                data.requirements.filter((r) => r.materialId === removing?.id)
                  .length
              }{' '}
              项岗位要求会保留，取消文件关联并恢复待准备。
            </DialogDescription>
          </DialogHeader>
          {deletion.failed && (
            <p role="alert" className="text-sm text-[#a64639]">
              {deletion.message}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deletion.pending}
              onClick={() => setRemoving(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={deletion.pending}
              onClick={() =>
                void deletion.run(async () => {
                  if (!removing) return;
                  const result = await mutate('deleteMaterial', {
                    id: removing.id,
                    expectedVersion: removing.deleteVersion,
                  });
                  setRemoving(null);
                  return result;
                })
              }
            >
              {deletion.pending ? '正在移除…' : '确认移除引用'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AnalyticsView({ data }: { data: WorkspaceState }) {
  return <RecordAnalyticsView data={data} />;
}

export function SettingsView({
  data,
  mutate,
  onRestored,
  onRestoreBusyChange,
}: {
  data: WorkspaceState;
  mutate: Mutate;
  onRestored: () => Promise<WorkspaceState | undefined>;
  onRestoreBusyChange?: (busy: boolean) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(data.settings.aiBaseUrl || '');
  const [model, setModel] = useState(data.settings.aiModel || '');
  const [apiKey, setApiKey] = useState('');
  const [originalSettings, setOriginalSettings] = useState(() =>
    editableSettings(data.settings),
  );
  const [staleDays, setStaleDays] = useState(data.settings.staleDays || '5');
  const [saved, setSaved] = useState(false);
  const saving = useSaveAction();
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState('');
  const settingsUpdate = buildSettingsUpdate(originalSettings, {
    baseUrl,
    model,
    staleDays: Number(staleDays),
    apiKey,
  });
  const save = () =>
    saving.run(async () => {
      if (!settingsUpdate) return;
      const result = await mutate('saveSettings', settingsUpdate);
      if (!(result as { refreshFailed?: boolean }).refreshFailed)
        setOriginalSettings((original) => ({
          ...original,
          ...(settingsUpdate.baseUrl !== undefined ? { baseUrl } : {}),
          ...(settingsUpdate.model !== undefined ? { model } : {}),
          ...(settingsUpdate.staleDays !== undefined
            ? { staleDays: Number(staleDays) }
            : {}),
          keyRevision:
            (result as { keyRevision?: string }).keyRevision ??
            original.keyRevision,
        }));
      setApiKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return result;
    });
  const loadLatestSettings = () => {
    if (
      settingsUpdate &&
      !confirm('放弃未保存的设置与密钥输入，并载入最新设置？')
    )
      return;
    const latest = editableSettings(data.settings);
    setOriginalSettings(latest);
    setBaseUrl(latest.baseUrl);
    setModel(latest.model);
    setStaleDays(String(latest.staleDays));
    setApiKey('');
    saving.reset();
  };
  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || importing) return;
    setImportError('');
    setImportResult('');
    if (file.size > 50 * 1024 * 1024) {
      setImportError('备份超过 50 MB，请选择较小的文件。当前数据未修改。');
      return;
    }
    if (
      !confirm(
        '恢复备份会替换当前全部数据。系统会先校验并自动保存恢复前快照，确定继续吗？',
      )
    )
      return;
    setImporting(true);
    onRestoreBusyChange?.(true);
    let committed = false;
    try {
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await file.text(),
      });
      const result = await response.json();
      if (!response.ok) {
        setImportError(result.error || '恢复失败，请刷新核对当前数据后重试。');
        return;
      }
      if (result.restored !== true) throw new Error('unexpected response');
      committed = true;
      setImportResult(
        `恢复完成。恢复前快照已保存在：${result.recoveryBackupPath}`,
      );
      const updated = await onRestored();
      if (!updated) {
        setImportError(
          '数据已恢复，但列表刷新失败。请使用页面上方“重试”刷新，不要重复恢复。',
        );
        return;
      }
      setBaseUrl(updated.settings.aiBaseUrl || '');
      setModel(updated.settings.aiModel || '');
      setStaleDays(updated.settings.staleDays || '5');
      setApiKey('');
      setSaved(false);
      setOriginalSettings(editableSettings(updated.settings));
    } catch {
      setImportError(
        committed
          ? '数据已恢复，但列表刷新失败。请刷新平台查看，不要重复恢复。'
          : '无法确认恢复结果。请确认本地服务正在运行并刷新核对数据，确认前不要重复恢复。',
      );
    } finally {
      setImporting(false);
      onRestoreBusyChange?.(false);
    }
  };
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <ReminderSettings />
      <Card className="border-[#e2ded4] bg-white/80 shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-[#ad7625]" />
            智能提取
          </CardTitle>
          <CardDescription>
            不配置也可完整使用；密钥只进入 macOS 钥匙串。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset
            disabled={saving.pending || importing}
            className="space-y-4"
          >
            <EditConflictNotice
              kind="settings"
              update={settingsUpdate}
              current={editableSettings(data.settings)}
              onDiscard={loadLatestSettings}
            />
            <Field label="兼容接口地址">
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="留空使用 https://api.openai.com/v1"
              />
            </Field>
            <Field label="模型名">
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="填写服务商支持的模型名"
              />
            </Field>
            <Field label="API 密钥">
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="留空表示不更改"
              />
            </Field>
            <Field label="停滞复查天数">
              <Input
                type="number"
                min="1"
                max="30"
                value={staleDays}
                onChange={(e) => setStaleDays(e.target.value)}
              />
            </Field>
            <Button
              className="rounded-xl"
              disabled={saving.pending || importing || !settingsUpdate}
              onClick={() => void save()}
            >
              {saved ? <Check /> : <Settings2 />}
              {saving.pending ? '保存中…' : saved ? '已保存' : '保存设置'}
            </Button>
            <Button
              variant="outline"
              disabled={saving.pending || importing}
              onClick={loadLatestSettings}
            >
              载入最新设置
            </Button>
            {saving.message && (
              <p
                role={saving.failed ? 'alert' : 'status'}
                className={`text-sm ${saving.failed ? 'text-[#a64639]' : 'text-[#41675c]'}`}
              >
                {saving.message}
              </p>
            )}
          </fieldset>
        </CardContent>
      </Card>
      <Card className="border-[#e2ded4] bg-white/80 shadow-none">
        <CardHeader>
          <CardTitle>数据与备份</CardTitle>
          <CardDescription>
            完整数据保存在本机；建议每周导出一次 JSON。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <BackupLink
            href="/api/export?format=json"
            title="导出完整 JSON"
            description="用于恢复全部机会、任务、材料和设置"
          />
          <BackupLink
            href="/api/export?format=csv"
            title="导出机会 CSV"
            description="适合用 Excel 查看、筛选或归档"
          />
          <label
            aria-busy={importing}
            className={`flex items-center gap-3 rounded-2xl border border-dashed border-[#d9d4ca] p-4 ${importing ? 'cursor-wait opacity-60' : 'cursor-pointer hover:bg-[#f7f5f0]'}`}
          >
            <Upload className="size-5 text-[#ad7625]" />
            <div>
              <p className="text-sm font-semibold">
                {importing ? '正在校验并恢复…' : '恢复 JSON 备份'}
              </p>
              <p className="text-xs text-[#837d73]">
                最多 50 MB；替换前自动保存快照，失败不改动原数据
              </p>
            </div>
            <input
              type="file"
              accept="application/json,.json"
              aria-label="选择 JSON 备份"
              className="hidden"
              disabled={importing}
              onChange={(event) => void importFile(event)}
            />
          </label>
          {importError && (
            <p
              role="alert"
              className="rounded-xl border border-[#edc9c2] bg-[#fff1ee] p-3 text-sm leading-6 text-[#9c4035]"
            >
              {importError}
            </p>
          )}
          {importResult && (
            <output className="block break-all rounded-xl border border-[#c9ddd6] bg-[#f1f7f4] p-3 text-sm leading-6 text-[#315f54]">
              {importResult}
            </output>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BackupLink({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <a
      href={href}
      download
      className="flex items-center gap-3 rounded-2xl border border-[#e4e0d7] p-4 hover:bg-[#f7f5f0]"
    >
      <Download className="size-5 text-[#3d7668]" />
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-[#837d73]">{description}</p>
      </div>
    </a>
  );
}
