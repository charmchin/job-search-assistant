'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BriefcaseBusiness,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  FileStack,
  LayoutDashboard,
  Menu,
  Plus,
  RefreshCw,
  Settings2,
  Target,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CaptureDialog, MaterialDialog } from '@/components/capture-dialog';
import { OpportunitySheet } from '@/components/opportunity-sheet';
import { LoadingState } from '@/components/workspace-common';
import { LiveTodayDate } from '@/components/live-today-date';
import {
  AnalyticsView,
  CalendarView,
  MaterialsView,
  OpportunitiesView,
  SettingsView,
  TodayView,
} from '@/components/workspace-views';
import type { Material, WorkspaceState } from '@/lib/client-types';
import { createWorkspaceReader } from '@/lib/workspace-reader';
import { startWorkspaceRefresh } from '@/lib/workspace-refresh';
import { PendingDrafts, type SavedDraft } from '@/components/paged-workspace';
import {
  createMutationClient,
  type MutationNotice,
} from '@/lib/mutation-client';

type View =
  | 'today'
  | 'opportunities'
  | 'calendar'
  | 'materials'
  | 'analytics'
  | 'settings';
const navItems: {
  id: View;
  label: string;
  detail: string;
  icon: typeof LayoutDashboard;
}[] = [
  {
    id: 'today',
    label: '今日焦点',
    detail: '现在先做什么',
    icon: LayoutDashboard,
  },
  {
    id: 'opportunities',
    label: '机会库',
    detail: '判断与推进',
    icon: BriefcaseBusiness,
  },
  { id: 'calendar', label: '时间线', detail: '截止与节点', icon: CalendarDays },
  { id: 'materials', label: '材料库', detail: '版本与缺口', icon: FileStack },
  {
    id: 'analytics',
    label: '复盘',
    detail: '漏斗与结果',
    icon: ChartNoAxesColumnIncreasing,
  },
];

const pageCopy: Record<
  View,
  { eyebrow: string; title: string; description: string }
> = {
  today: {
    eyebrow: 'DAILY COMMAND CENTER',
    title: '今天，推进最重要的一步',
    description: '按截止风险、岗位价值和停滞时间整理行动顺序。',
  },
  opportunities: {
    eyebrow: 'OPPORTUNITY LIBRARY',
    title: '机会不是收藏，是要做的决定',
    description: '先判断是否值得投入，再把准备与招聘进度放进同一张卡。',
  },
  calendar: {
    eyebrow: 'TIMELINE',
    title: '所有时间点，一处看清',
    description: '汇总投递截止、行动任务、笔试面试和自定义节点。',
  },
  materials: {
    eyebrow: 'APPLICATION ASSETS',
    title: '让每次投递都用对材料',
    description: '管理简历、成绩单、作品集等本机文件引用与版本。',
  },
  analytics: {
    eyebrow: 'REVIEW',
    title: '看清你的求职转化',
    description: '用真实进展发现投入是否有效，而不是只看收藏数量。',
  },
  settings: {
    eyebrow: 'PREFERENCES',
    title: '设置与本机数据',
    description: '配置提取服务、停滞规则，以及导入导出。',
  },
};

export function WorkspaceApp() {
  const [data, setData] = useState<WorkspaceState | null>(null);
  const [view, setView] = useState<View>('today');
  const [captureOpen, setCaptureOpen] = useState(false);
  const [resumedDraft, setResumedDraft] = useState<SavedDraft | null>(null);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<Material | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [saveNotice, setSaveNotice] = useState<MutationNotice>(null);
  const restoring = useRef(false);
  const [reader] = useState(() =>
    createWorkspaceReader({ state: setData, error: setError }),
  );

  const refresh = useCallback(() => reader.refresh(), [reader]);
  const [client] = useState(() =>
    createMutationClient({
      refresh: async () => Boolean(await refresh()),
      notice: setSaveNotice,
      starting: () => reader.invalidate(),
    }),
  );
  const retryRefresh = async () => {
    if (await refresh()) {
      client.markRefreshed();
      setSaveNotice(null);
    }
  };
  useEffect(() => {
    let canceled = false;
    queueMicrotask(() => {
      if (!canceled) void refresh();
    });
    const stop = startWorkspaceRefresh({
      window,
      document,
      refresh: () => reader.refresh({ background: true }),
      canRefresh: () => !client.isBusy() && !restoring.current,
    });
    return () => {
      canceled = true;
      stop();
      reader.invalidate();
    };
  }, [refresh, reader, client]);
  const mutate = useCallback(
    (action: string, payload: Record<string, unknown>) => {
      return client.mutate(action, payload);
    },
    [client],
  );
  const selected =
    data?.opportunities.find((item) => item.id === selectedId) || null;
  const page = pageCopy[view];
  const openView = (next: View) => {
    setView(next);
    setMobileNav(false);
  };

  return (
    <main className="min-h-screen bg-[#f3f1eb] text-[#302d28]">
      <div className="mx-auto grid min-h-screen max-w-[1800px] lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside
          className={`${mobileNav ? 'fixed inset-0 z-50 flex' : 'hidden'} flex-col border-r border-[#ded9cf] bg-[#ece9e1]/96 p-4 backdrop-blur-xl lg:sticky lg:top-0 lg:flex lg:h-screen`}
        >
          <div className="flex items-center gap-3 px-2 py-2">
            <button
              onClick={() => openView('today')}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <div className="grid size-11 shrink-0 place-items-center rounded-[15px] bg-[#173f37] text-white shadow-[0_8px_18px_rgba(23,63,55,.18)]">
                <Target className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[15px] font-bold tracking-tight">
                  求职助手
                </p>
                <p className="text-[11px] text-[#817b70]">
                  LOCAL · PRIVATE · FOCUSED
                </p>
              </div>
            </button>
            <button
              className="grid size-9 place-items-center rounded-xl lg:hidden"
              onClick={() => setMobileNav(false)}
            >
              <X className="size-5" />
            </button>
          </div>
          <nav className="mt-8 space-y-1.5" aria-label="主导航">
            {navItems.map(({ id, label, detail, icon: Icon }) => (
              <button
                key={id}
                onClick={() => openView(id)}
                className={`group flex w-full items-center gap-3 rounded-[16px] px-3 py-3 text-left transition ${view === id ? 'bg-white text-[#244f45] shadow-[0_5px_18px_rgba(51,45,35,.07)]' : 'text-[#6f6960] hover:bg-white/55 hover:text-[#302d28]'}`}
              >
                <div
                  className={`grid size-9 place-items-center rounded-xl ${view === id ? 'bg-[#e8f1ed]' : 'bg-black/[.025] group-hover:bg-white'}`}
                >
                  <Icon className="size-[17px]" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{label}</p>
                  <p className="mt-0.5 text-[10px] opacity-60">{detail}</p>
                </div>
              </button>
            ))}
          </nav>
          <div className="mt-auto space-y-3">
            <button
              onClick={() => openView('settings')}
              className={`flex w-full items-center gap-3 rounded-[16px] px-3 py-3 text-left text-sm font-semibold ${view === 'settings' ? 'bg-white text-[#244f45] shadow-sm' : 'text-[#6f6960] hover:bg-white/55'}`}
            >
              <Settings2 className="size-[17px]" />
              设置与数据
            </button>
            <div className="rounded-[18px] border border-[#d8d3c8] bg-white/45 p-3.5">
              <p className="text-[11px] font-semibold text-[#4f4a43]">
                本机工作台
              </p>
              <p className="mt-1 text-[10px] leading-4 text-[#837d72]">
                数据仅保存在当前 Mac。关闭服务后提醒也会停止。
              </p>
            </div>
          </div>
        </aside>

        <section className="min-w-0 px-4 pb-20 pt-4 sm:px-7 lg:px-10 lg:pb-12 lg:pt-7 xl:px-12">
          <header className="mb-7 flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <button
                className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl border border-[#ddd8ce] bg-white/70 lg:hidden"
                onClick={() => setMobileNav(true)}
              >
                <Menu className="size-5" />
              </button>
              <div>
                <p className="text-[10px] font-bold tracking-[.18em] text-[#6f8b83]">
                  {page.eyebrow}
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-[-.035em] sm:text-[30px]">
                  {page.title}
                </h1>
                <p className="mt-1.5 hidden text-sm text-[#7f796f] sm:block">
                  {page.description}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="hidden text-right xl:block">
                <p className="text-xs font-medium text-[#5e5951]">
                  <LiveTodayDate />
                </p>
                <p className="mt-1 text-[10px] text-[#948e83]">
                  Asia / Shanghai
                </p>
              </div>
              <Button
                className="ml-2 rounded-xl bg-[#173f37] px-4 hover:bg-[#245d50]"
                onClick={() => {
                  setResumedDraft(null);
                  setCaptureOpen(true);
                }}
              >
                <Plus />
                收集岗位
              </Button>
            </div>
          </header>
          {(error || saveNotice) && (
            <div
              role={
                error || saveNotice?.kind === 'warning' ? 'alert' : 'status'
              }
              className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl border border-[#ddd8ce] bg-white/80 p-3.5 text-sm text-[#625b50]"
              data-testid="workspace-save-status"
            >
              <AlertCircle className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                {saveNotice?.kind === 'warning'
                  ? saveNotice.message
                  : error || saveNotice?.message}
              </span>
              {(error || saveNotice?.kind === 'warning') && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => void retryRefresh()}
                >
                  <RefreshCw />
                  重试刷新
                </Button>
              )}
            </div>
          )}
          {!data ? (
            <LoadingState />
          ) : (
            <>
              {view === 'today' && (
                <TodayView
                  data={data}
                  mutate={mutate}
                  openOpportunity={setSelectedId}
                  openCapture={() => {
                    setResumedDraft(null);
                    setCaptureOpen(true);
                  }}
                />
              )}
              {view === 'opportunities' && (
                <>
                  {!!data.pendingDraftCount && (
                    <PendingDrafts
                      count={data.pendingDraftCount}
                      mutate={mutate}
                      onResume={(draft) => {
                        setResumedDraft(draft);
                        setCaptureOpen(true);
                      }}
                    />
                  )}
                  <OpportunitiesView
                    data={data}
                    mutate={mutate}
                    openOpportunity={setSelectedId}
                    openCapture={() => {
                      setResumedDraft(null);
                      setCaptureOpen(true);
                    }}
                  />
                </>
              )}
              {view === 'calendar' && (
                <CalendarView data={data} openOpportunity={setSelectedId} />
              )}
              {view === 'materials' && (
                <MaterialsView
                  data={data}
                  mutate={mutate}
                  openCreate={() => {
                    setEditingMaterial(null);
                    setMaterialOpen(true);
                  }}
                  openEdit={(material) => {
                    setEditingMaterial(material);
                    setMaterialOpen(true);
                  }}
                />
              )}
              {view === 'analytics' && <AnalyticsView data={data} />}
              {view === 'settings' && (
                <SettingsView
                  data={data}
                  mutate={mutate}
                  onRestoreBusyChange={(busy) => {
                    restoring.current = busy;
                    if (busy) reader.invalidate();
                  }}
                  onRestored={async () => {
                    const updated = await refresh();
                    if (updated) {
                      client.markRefreshed();
                      setSaveNotice(null);
                    }
                    return updated;
                  }}
                />
              )}
            </>
          )}
        </section>
      </div>
      <CaptureDialog
        key={
          captureOpen ? (resumedDraft?.id ?? 'capture-new') : 'capture-closed'
        }
        open={captureOpen}
        onOpenChange={(next) => {
          setCaptureOpen(next);
          if (!next) {
            setResumedDraft(null);
            if (!client.isBusy() && !restoring.current)
              void reader.refresh({ background: true });
          }
        }}
        initialDraft={captureOpen ? resumedDraft : null}
        mutate={mutate}
        onOpenExisting={async (id) => {
          const latest = await refresh();
          if (!latest)
            throw new Error('暂时无法读取机会库，请重试。当前输入已保留。');
          if (!latest.opportunities.some((item) => item.id === id))
            throw new Error('该机会已被移除，请重新整理。当前输入已保留。');
          setSaveNotice(null);
          setCaptureOpen(false);
          setResumedDraft(null);
          setView('opportunities');
          setSelectedId(id);
        }}
        onCreated={(id) => {
          setCaptureOpen(false);
          setResumedDraft(null);
          setSelectedId(id);
        }}
      />
      {materialOpen && (
        <MaterialDialog
          key={editingMaterial?.id ?? 'new'}
          open={materialOpen}
          onOpenChange={setMaterialOpen}
          mutate={mutate}
          material={editingMaterial}
          latestMaterial={
            data?.materials.find((item) => item.id === editingMaterial?.id) ??
            null
          }
          linkedCount={
            data?.requirements.filter(
              (r) => r.materialId === editingMaterial?.id,
            ).length ?? 0
          }
        />
      )}
      <OpportunitySheet
        opportunity={selected}
        open={Boolean(selected)}
        onOpenChange={(next) => !next && setSelectedId(null)}
        mutate={mutate}
        materials={data?.materials || []}
      />
    </main>
  );
}
