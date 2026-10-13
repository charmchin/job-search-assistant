'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  ExternalLink,
  MapPin,
  Pencil,
  Plus,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import {
  deadlineBucket,
  formatDateTime,
  STAGES,
  needsApplication,
} from '@/lib/domain';
import {
  canMarkApplied,
  currentStageAt,
  progressPayload,
} from '@/lib/opportunity-progress';
import type {
  Material,
  Mutate,
  Opportunity,
  Task,
  Requirement,
} from '@/lib/client-types';
import { buildRecordUpdate, buildRequirementUpdate } from '@/lib/record-edit';
import { EditConflictNotice as RecordEditConflictNotice } from './edit-conflict-notice';
import {
  MilestoneCard,
  ReminderOffsetsEditor,
} from '@/components/reminder-controls';
import { DEFAULT_MILESTONE_MINUTES } from '@/lib/reminder-policy';
import { useSaveAction } from '@/components/use-save-action';
import { RequirementEditor } from '@/components/requirement-editor';
import { ProgressActions } from './progress-actions';
import { StageHistoryPanel } from '@/components/stage-history-panel';
import { ActivityList } from '@/components/paged-workspace';
import { TaskEditor } from './task-editor';
import {
  buildOpportunityUpdate,
  opportunityConflicts,
  opportunityFields,
  opportunityStatusConflict,
} from '@/lib/opportunity-edit';
import {
  decisionLabel,
  Field,
  fromInputDate,
  priorityClass,
  priorityLabel,
  ScoreDots,
  StageBadge,
  TaskRow,
  toInputDate,
} from '@/components/workspace-common';

type OpportunitySheetProps = {
  opportunity: Opportunity | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mutate: Mutate;
  materials: Material[];
};

export function OpportunitySheet(props: OpportunitySheetProps) {
  if (!props.open || !props.opportunity) return null;

  // Each opening owns its draft state; changing the opportunity must start a new session.
  return (
    <OpportunitySheetSession
      key={props.opportunity.id}
      {...props}
      opportunity={props.opportunity}
    />
  );
}

function OpportunitySheetSession({
  opportunity,
  open,
  onOpenChange,
  mutate,
  materials,
}: Omit<OpportunitySheetProps, 'opportunity'> & { opportunity: Opportunity }) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<Partial<Opportunity>>({});
  const [original, setOriginal] = useState(opportunity);
  const [notesDraft, setNotesDraft] = useState<{
    original: Opportunity;
    notes: string;
    review: string;
    stage?: string;
  } | null>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [milestoneTitle, setMilestoneTitle] = useState('');
  const [milestoneAt, setMilestoneAt] = useState('');
  const [milestoneOffsets, setMilestoneOffsets] = useState([
    ...DEFAULT_MILESTONE_MINUTES,
  ]);
  const [activity, setActivity] = useState('');
  const [activityStage, setActivityStage] = useState('');
  const [activityOriginal, setActivityOriginal] = useState<Opportunity | null>(
    null,
  );
  const [requirementName, setRequirementName] = useState('');
  const [requirementNotes, setRequirementNotes] = useState('');
  const [editingRequirement, setEditingRequirement] = useState<string | null>(
    null,
  );
  const [editingTask, setEditingTask] = useState<string | null>(null);
  const nextTask = opportunity.tasks.find(
    (t) => t.isNextAction && ['todo', 'doing'].includes(t.status),
  );
  const [requirementDrafts, setRequirementDrafts] = useState<
    Record<string, { value: string; original: Requirement }>
  >({});
  const [tab, setTab] = useState<'plan' | 'timeline' | 'source'>('plan');
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [tab, edit]);
  const saving = useSaveAction();
  const updateTask = async (task: Task, changes: Record<string, unknown>) => {
    const update = buildRecordUpdate('task', task, changes);
    if (update) return mutate('updateTask', update);
  };
  const updateRequirement = async (
    item: Requirement,
    changes: Partial<Requirement>,
  ) => {
    const update = buildRequirementUpdate(item, changes, materials);
    if (update) return mutate('updateRequirement', update);
    return { unchanged: true };
  };
  const focusTask = (task: Task | null) =>
    mutate('setNextTask', {
      opportunityId: opportunity.id,
      taskId: task?.id ?? null,
      expectedTaskId: nextTask?.id ?? null,
      ...(task
        ? {
            expectedTask: {
              title: task.title,
              dueAt: task.dueAt,
              status: task.status,
            },
          }
        : {}),
    });
  const formUpdate = buildOpportunityUpdate(original, form);
  const statusConflict = edit ? opportunityStatusConflict(form) : '';
  const notesUpdate = notesDraft
    ? buildOpportunityUpdate(notesDraft.original, notesDraft)
    : null;
  const save = () =>
    saving.run(async () => {
      if (statusConflict) throw new Error(statusConflict);
      const result = formUpdate
        ? await mutate('updateOpportunity', formUpdate)
        : undefined;
      setEdit(false);
      return result;
    });
  const quickDecision = (decision: Opportunity['decision']) =>
    saving.run(async () => {
      const update = buildOpportunityUpdate(opportunity, { decision });
      if (update) return mutate('updateOpportunity', update);
    });
  const addTask = () =>
    saving.run(async () => {
      if (!taskTitle.trim()) return;
      const result = await mutate('createTask', {
        opportunityId: opportunity.id,
        title: taskTitle,
        dueAt: fromInputDate(taskDue),
        estimatedMinutes: 30,
        source: 'manual',
      });
      setTaskTitle('');
      setTaskDue('');
      return result;
    });
  const addMilestone = () =>
    saving.run(async () => {
      if (!milestoneTitle.trim()) return;
      const result = await mutate('createMilestone', {
        opportunityId: opportunity.id,
        title: milestoneTitle,
        scheduledAt: fromInputDate(milestoneAt),
        reminderOffsets: milestoneOffsets,
      });
      setMilestoneTitle('');
      setMilestoneAt('');
      setMilestoneOffsets([...DEFAULT_MILESTONE_MINUTES]);
      return result;
    });
  const addActivity = () =>
    saving.run(async () => {
      if (!activity) return;
      const result = await mutate(
        'addActivity',
        progressPayload(
          activityOriginal ?? opportunity,
          activity,
          activityStage || undefined,
        ),
      );
      setActivity('');
      setActivityStage('');
      setActivityOriginal(null);
      return result;
    });
  const remove = async () => {
    if (!confirm('确定删除这个机会及其任务、节点和记录吗？')) return;
    await saving.run(async () => {
      await mutate('deleteOpportunity', {
        id: opportunity.id,
        expectedVersion: opportunity.deleteVersion,
      });
      onOpenChange(false);
    });
  };
  const updateFormList = (
    key: 'highlights' | 'risks',
    index: number,
    value: string,
  ) =>
    setForm((current) => ({
      ...current,
      [key]: (current[key] || []).map((item, i) =>
        i === index ? value : item,
      ),
    }));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={scrollRef}
        className="data-[side=right]:w-[min(920px,98vw)] data-[side=right]:sm:max-w-[920px] overflow-y-auto border-l-[#ddd8ce] bg-[#f6f4ee] p-0"
      >
        <fieldset
          disabled={saving.pending}
          className="contents"
          aria-label="机会操作"
        >
          <SheetHeader className="border-b border-[#dedad1] bg-white/70 px-6 py-6 sm:px-8">
            <div className="flex items-start gap-4 pr-8">
              <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[#e7f1ed] text-lg font-bold text-[#2d6b5d]">
                {opportunity.organization.slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[#777168]">
                  {opportunity.organization}
                </p>
                <SheetTitle className="mt-1 text-xl leading-tight tracking-tight sm:text-2xl">
                  {opportunity.role}
                </SheetTitle>
                <SheetDescription className="mt-3 flex flex-wrap items-center gap-2">
                  <StageBadge stage={opportunity.stage} />
                  {opportunity.stage === 'closed' && (
                    <Badge variant="outline">
                      {opportunity.closedReason === 'rejected'
                        ? '未通过'
                        : opportunity.closedReason === 'withdrawn'
                          ? '主动放弃'
                          : '结束原因待确认'}
                    </Badge>
                  )}
                  <Badge
                    variant="outline"
                    className={priorityClass[opportunity.priority]}
                  >
                    {priorityLabel[opportunity.priority]}
                  </Badge>
                  <Badge variant="outline" className="rounded-full">
                    {decisionLabel[opportunity.decision]}
                  </Badge>
                  {opportunity.location && (
                    <span className="flex items-center gap-1 text-xs">
                      <MapPin className="size-3" />
                      {opportunity.location}
                    </span>
                  )}
                </SheetDescription>
                {currentStageAt(opportunity) && (
                  <p className="mt-2 text-xs text-[#817b71]">
                    {opportunity.stage === 'applied' ? '投递时间' : '阶段更新'}{' '}
                    · {formatDateTime(currentStageAt(opportunity))}
                  </p>
                )}
                <div className="mt-3">
                  <ProgressActions item={opportunity} mutate={mutate} />
                </div>
              </div>
            </div>
          </SheetHeader>
          <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-[#e2ded5] bg-[#f6f4ee]/95 px-4 py-3 backdrop-blur sm:gap-2 sm:px-8">
            <div className="flex rounded-xl bg-[#e9e6de] p-1">
              {[
                ['plan', '决策', '决策与行动'],
                ['timeline', '记录', '节点与记录'],
                ['source', '原文', '岗位原文'],
              ].map(([id, shortLabel, label]) => (
                <button
                  key={id}
                  onClick={() => setTab(id as typeof tab)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold sm:px-3 ${tab === id ? 'bg-white text-[#2e6256] shadow-sm' : 'text-[#777168]'}`}
                >
                  <span className="sm:hidden">{shortLabel}</span>
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
            {opportunity.sourceUrl && (
              <a
                href={opportunity.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto"
              >
                <Button variant="ghost" size="sm">
                  <ExternalLink />
                  <span className="hidden sm:inline">原始链接</span>
                </Button>
              </a>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setForm(opportunity);
                setOriginal(opportunity);
                setEdit(!edit);
                saving.reset();
              }}
            >
              <Pencil />
              <span className="hidden sm:inline">{edit ? '取消' : '编辑'}</span>
            </Button>
          </div>

          {(saving.pending || saving.message) && (
            <p
              role={saving.failed ? 'alert' : 'status'}
              className={`sticky top-14 z-20 border-b bg-[#fffaf0] px-6 py-3 text-sm ${saving.failed ? 'text-[#a64639]' : 'text-[#41675c]'}`}
            >
              {saving.pending ? '正在保存，请勿重复提交…' : saving.message}
            </p>
          )}
          <div className="space-y-6 px-6 py-6 sm:px-8">
            {(edit || tab === 'source') && (
              <p className="text-xs text-[#827c72]">
                修改后请点击保存。取消编辑或关闭详情会放弃未保存的修改。
              </p>
            )}
            {edit && (
              <EditConflictNotice
                update={formUpdate}
                current={opportunity}
                onDiscard={() => {
                  if (!confirm('放弃本次未保存的修改，并载入最新岗位信息？'))
                    return;
                  setForm(opportunity);
                  setOriginal(opportunity);
                  saving.reset();
                }}
              />
            )}
            {statusConflict && (
              <p
                id="opportunity-status-conflict"
                role="alert"
                className="rounded-2xl border border-[#e9c9a1] bg-[#fff8ec] p-4 text-sm leading-6 text-[#795a29]"
              >
                {statusConflict}
              </p>
            )}
            {edit && tab !== 'timeline' ? (
              <>
                <EditForm
                  section={tab}
                  form={form}
                  setForm={setForm}
                  updateFormList={updateFormList}
                />
              </>
            ) : tab === 'plan' ? (
              <>
                <section className="rounded-[24px] bg-[#173f37] p-5 text-white shadow-[0_16px_38px_rgba(23,63,55,.15)] sm:p-6">
                  <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-white/10">
                      <Target className="size-5 text-[#f0c978]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-[#bcd7ce]">
                        下一步行动
                      </p>
                      <h3 className="mt-1 text-xl font-semibold leading-snug">
                        {opportunity.nextAction ||
                          (opportunity.stage === 'closed' ||
                          opportunity.decision === 'skip'
                            ? '这项机会已结束，整理结果与复盘。'
                            : opportunity.decision === 'undecided'
                              ? '还没有明确下一步。建议先完成投入判断。'
                              : opportunity.tasks.some((t) =>
                                    ['todo', 'doing'].includes(t.status),
                                  )
                                ? '从下方行动任务中，选一个作为下一步。'
                                : '当前行动已处理，安排下一轮准备或跟进。')}
                      </h3>
                      <p className="mt-2 text-xs text-white/60">
                        {opportunity.nextActionAt
                          ? `计划完成：${formatDateTime(opportunity.nextActionAt)}`
                          : '未设置计划时间'}
                      </p>
                      {nextTask && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            className="rounded-xl bg-white text-[#173f37] hover:bg-white/90"
                            onClick={() =>
                              void saving.run(() =>
                                updateTask(nextTask, { status: 'done' }),
                              )
                            }
                          >
                            <Check className="size-4" />
                            完成下一步
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="rounded-xl text-white hover:bg-white/10 hover:text-white"
                            onClick={() =>
                              void saving.run(() => focusTask(null))
                            }
                          >
                            取消重点
                          </Button>
                        </div>
                      )}
                      {opportunity.stage !== 'closed' &&
                        opportunity.decision !== 'skip' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="mt-3 rounded-xl text-white hover:bg-white/10 hover:text-white"
                            onClick={() => {
                              setForm(opportunity);
                              setEdit(true);
                            }}
                          >
                            {nextTask ? '修改计划' : '安排下一步'}
                          </Button>
                        )}
                    </div>
                  </div>
                </section>
                <section className="grid gap-4 sm:grid-cols-[1fr_260px]">
                  <div className="rounded-[22px] border border-[#e1ddd4] bg-white/75 p-5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold text-[#817b71]">
                          投入判断
                        </p>
                        <h3 className="mt-1 text-lg font-semibold">
                          {decisionLabel[opportunity.decision]}
                        </h3>
                      </div>
                      <div className="space-y-2">
                        <ScoreDots value={opportunity.fitScore} label="匹配" />
                        <ScoreDots
                          value={opportunity.interestScore}
                          label="兴趣"
                        />
                      </div>
                    </div>
                    {opportunity.decision === 'undecided' && (
                      <div className="mt-5 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          className="rounded-xl"
                          onClick={() => void quickDecision('pursue')}
                        >
                          值得投入
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-xl"
                          onClick={() => void quickDecision('hold')}
                        >
                          暂缓
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="rounded-xl"
                          onClick={() => void quickDecision('skip')}
                        >
                          不再考虑
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <InfoTile
                      label="截止时间"
                      value={formatDateTime(opportunity.deadline)}
                      warning={
                        needsApplication(
                          opportunity.stage,
                          opportunity.decision,
                        ) &&
                        deadlineBucket(
                          opportunity.deadline
                            ? new Date(opportunity.deadline)
                            : null,
                        ) === 'overdue'
                      }
                    />
                    <InfoTile
                      label="最近推进"
                      value={formatDateTime(opportunity.lastActivityAt)}
                    />
                  </div>
                </section>
                {(opportunity.highlights.length > 0 ||
                  opportunity.risks.length > 0) && (
                  <section className="grid gap-4 sm:grid-cols-2">
                    <EvidenceBox
                      title="为什么值得看"
                      items={opportunity.highlights}
                      tone="green"
                    />
                    <EvidenceBox
                      title="门槛与风险"
                      items={opportunity.risks}
                      tone="amber"
                    />
                  </section>
                )}
                {opportunity.specialNotes && (
                  <section className="rounded-[20px] border border-[#ead1a8] bg-[#fff8e9] p-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-[#7d571e]">
                      <AlertTriangle className="size-4" />
                      特殊注意事项
                    </h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#795f36]">
                      {opportunity.specialNotes}
                    </p>
                  </section>
                )}
                <DetailSection
                  title="行动任务"
                  count={
                    opportunity.tasks.filter((item) =>
                      ['todo', 'doing'].includes(item.status),
                    ).length
                  }
                >
                  <div className="space-y-2">
                    {opportunity.tasks.map((task) => (
                      <div key={task.id} className="space-y-2">
                        <TaskRow
                          task={task}
                          onEdit={() =>
                            setEditingTask(
                              editingTask === task.id ? null : task.id,
                            )
                          }
                          onFocus={
                            ['todo', 'doing'].includes(task.status)
                              ? () =>
                                  void saving.run(() =>
                                    focusTask(task.isNextAction ? null : task),
                                  )
                              : undefined
                          }
                          onSkip={
                            ['todo', 'doing'].includes(task.status)
                              ? () =>
                                  void saving.run(() =>
                                    updateTask(task, { status: 'skipped' }),
                                  )
                              : undefined
                          }
                          onToggle={() =>
                            void saving.run(() =>
                              updateTask(task, {
                                status: ['done', 'skipped'].includes(
                                  task.status,
                                )
                                  ? 'todo'
                                  : 'done',
                              }),
                            )
                          }
                        />
                        {editingTask === task.id && (
                          <TaskEditor
                            key={task.id}
                            item={task}
                            mutate={mutate}
                            onClose={() => setEditingTask(null)}
                          />
                        )}
                      </div>
                    ))}
                    <div className="grid gap-2 rounded-[18px] border border-dashed border-[#d7d2c8] bg-white/45 p-3 sm:grid-cols-[1fr_190px_auto]">
                      <Input
                        value={taskTitle}
                        onChange={(e) => setTaskTitle(e.target.value)}
                        placeholder="新增一个明确行动"
                      />
                      <Input
                        type="datetime-local"
                        value={taskDue}
                        onChange={(e) => setTaskDue(e.target.value)}
                      />
                      <Button
                        variant="outline"
                        disabled={!taskTitle.trim()}
                        onClick={() => void addTask()}
                      >
                        <Plus />
                        添加
                      </Button>
                    </div>
                  </div>
                </DetailSection>
                <DetailSection
                  title="材料缺口"
                  count={
                    opportunity.requirements.filter((item) => !item.completed)
                      .length
                  }
                >
                  <div className="space-y-2">
                    {opportunity.requirements.length ? (
                      opportunity.requirements.map((item) => (
                        <div
                          key={item.id}
                          className="flex flex-wrap items-center gap-3 rounded-[16px] border border-[#e5e1d8] bg-white/75 p-3"
                        >
                          <button
                            aria-label={`材料${item.completed ? '重新待准备' : '标记就绪'} ${item.name}`}
                            onClick={() =>
                              void saving.run(() =>
                                updateRequirement(item, {
                                  completed: !item.completed,
                                }),
                              )
                            }
                          >
                            {item.completed ? (
                              <CheckCircle2 className="size-5 text-[#2d6b5d]" />
                            ) : (
                              <Circle className="size-5 text-[#aaa49a]" />
                            )}
                          </button>
                          <span
                            className={`text-sm font-medium ${item.completed ? 'text-[#918b81] line-through' : ''}`}
                          >
                            {item.name}
                          </span>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`编辑要求 ${item.name}`}
                            onClick={() =>
                              setEditingRequirement(
                                editingRequirement === item.id ? null : item.id,
                              )
                            }
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <select
                            aria-label={`关联材料 ${item.name}`}
                            value={
                              requirementDrafts[item.id]?.value ??
                              item.materialId ??
                              ''
                            }
                            onChange={(e) =>
                              setRequirementDrafts((current) => ({
                                ...current,
                                [item.id]: {
                                  value: e.target.value,
                                  original: current[item.id]?.original ?? item,
                                },
                              }))
                            }
                            className="ml-auto h-8 max-w-48 rounded-lg border border-input bg-white px-2 text-xs"
                          >
                            <option value="">未关联材料</option>
                            {materials.map((mat) => (
                              <option key={mat.id} value={mat.id}>
                                {mat.name}
                              </option>
                            ))}
                          </select>
                          {Object.hasOwn(requirementDrafts, item.id) && (
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`保存关联 ${item.name}`}
                              onClick={() =>
                                void saving.run(async () => {
                                  const result = await updateRequirement(
                                    requirementDrafts[item.id].original,
                                    {
                                      materialId:
                                        requirementDrafts[item.id].value ||
                                        null,
                                    },
                                  );
                                  if (
                                    !(result as { refreshFailed?: boolean })
                                      .refreshFailed
                                  )
                                    setRequirementDrafts((current) => {
                                      const next = { ...current };
                                      delete next[item.id];
                                      return next;
                                    });
                                  return result;
                                })
                              }
                            >
                              保存关联
                            </Button>
                          )}
                          {requirementDrafts[item.id] && (
                            <RecordEditConflictNotice
                              kind="requirement"
                              update={buildRecordUpdate(
                                'requirement',
                                requirementDrafts[item.id].original,
                                {
                                  materialId:
                                    requirementDrafts[item.id].value || null,
                                },
                              )}
                              current={item}
                              onDiscard={() => {
                                if (
                                  !confirm(
                                    '放弃未保存的材料关联，并载入最新内容？',
                                  )
                                )
                                  return;
                                setRequirementDrafts((current) => {
                                  const next = { ...current };
                                  delete next[item.id];
                                  return next;
                                });
                                saving.reset();
                              }}
                            />
                          )}
                          {item.notes && (
                            <p className="w-full whitespace-pre-wrap text-xs leading-5 text-[#827c72]">
                              {item.notes}
                            </p>
                          )}
                          {item.materialId &&
                            (() => {
                              const mat = materials.find(
                                (m) => m.id === item.materialId,
                              );
                              return (
                                mat && (
                                  <p
                                    className={`w-full text-xs ${mat.fileExists ? 'text-[#2d6b5d]' : 'text-[#a64639]'}`}
                                  >
                                    {mat.name}
                                    {mat.version
                                      ? ` · ${mat.version}`
                                      : ''} ·{' '}
                                    {mat.fileExists
                                      ? '文件路径存在，请核对内容'
                                      : '未找到关联文件，请到材料库编辑 / 替换引用'}
                                  </p>
                                )
                              );
                            })()}
                          {editingRequirement === item.id && (
                            <RequirementEditor
                              key={item.id}
                              item={item}
                              mutate={mutate}
                              onClose={() => setEditingRequirement(null)}
                            />
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="rounded-2xl border border-dashed border-[#d9d4ca] p-5 text-sm text-[#827c72]">
                        暂未记录材料要求。
                      </p>
                    )}
                    <div className="space-y-2 rounded-[18px] border border-dashed border-[#d7d2c8] bg-white/45 p-3">
                      <Input
                        aria-label="新增材料要求名称"
                        value={requirementName}
                        onChange={(e) => setRequirementName(e.target.value)}
                        placeholder="新增要求，例如：盖章成绩单"
                        maxLength={1000}
                      />
                      <Textarea
                        aria-label="新增材料要求说明"
                        value={requirementNotes}
                        onChange={(e) => setRequirementNotes(e.target.value)}
                        placeholder="补充文件格式、命名、盖章等要求（选填）"
                        className="min-h-16"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!requirementName.trim()}
                        onClick={() =>
                          void saving.run(async () => {
                            const result = await mutate('createRequirement', {
                              opportunityId: opportunity.id,
                              name: requirementName,
                              notes: requirementNotes,
                            });
                            setRequirementName('');
                            setRequirementNotes('');
                            return result;
                          })
                        }
                      >
                        <Plus className="size-4" />
                        添加要求
                      </Button>
                    </div>
                  </div>
                </DetailSection>
              </>
            ) : tab === 'timeline' ? (
              <>
                <StageHistoryPanel opportunity={opportunity} mutate={mutate} />
                <DetailSection
                  title="招聘节点"
                  count={opportunity.milestones.length}
                >
                  <div className="space-y-2">
                    {opportunity.milestones.map((item) => (
                      <MilestoneCard
                        key={item.id}
                        item={item}
                        mutate={mutate}
                      />
                    ))}
                    <div className="grid gap-2 rounded-[18px] border border-dashed border-[#d7d2c8] bg-white/45 p-3 sm:grid-cols-[1fr_190px_auto]">
                      <Input
                        value={milestoneTitle}
                        aria-label="新增节点名称"
                        onChange={(e) => setMilestoneTitle(e.target.value)}
                        placeholder="例如：一面、体检、政审"
                      />
                      <Input
                        type="datetime-local"
                        value={milestoneAt}
                        aria-label="新增节点时间（上海时区）"
                        onChange={(e) => setMilestoneAt(e.target.value)}
                      />
                      <Button
                        variant="outline"
                        onClick={() => void addMilestone()}
                        disabled={saving.pending || !milestoneTitle.trim()}
                      >
                        <Plus />
                        添加
                      </Button>
                    </div>
                    <ReminderOffsetsEditor
                      label="新节点提醒"
                      unit="minutes"
                      value={milestoneOffsets}
                      onChange={setMilestoneOffsets}
                    />
                    <p className="text-xs text-[#827c72]">
                      节点时间为上海时间。Offer
                      后的体检、签约仍会提醒；放弃、已完成或跳过的节点不提醒。
                    </p>
                  </div>
                </DetailSection>
                <DetailSection title="推进记录">
                  <Field label="记录时同步阶段">
                    <select
                      aria-label="记录时同步阶段"
                      value={activityStage}
                      onChange={(e) => {
                        setActivityStage(e.target.value);
                        setActivityOriginal(
                          e.target.value ? opportunity : null,
                        );
                      }}
                      className="h-9 w-full rounded-lg border border-input bg-white px-3 text-sm"
                    >
                      <option value="">保持当前阶段</option>
                      {STAGES.map((s) => (
                        <option
                          key={s.id}
                          value={s.id}
                          disabled={
                            opportunity.decision === 'skip' && s.id !== 'closed'
                          }
                        >
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <p className="text-xs text-[#827c72]">
                    选择阶段后，记录和状态会一起保存。仅填写文字时保留当前阶段。
                  </p>
                  <div className="flex gap-2">
                    <Input
                      aria-label="推进记录内容"
                      value={activity}
                      onChange={(e) => setActivity(e.target.value)}
                      placeholder="记录沟通、反馈或下一步…"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void addActivity();
                        }
                      }}
                    />
                    <Button
                      disabled={saving.pending || !activity.trim()}
                      onClick={() => void addActivity()}
                    >
                      记录
                    </Button>
                  </div>
                  {canMarkApplied(opportunity) &&
                    /已投递|投递了|投递成功/.test(activity) &&
                    !activityStage && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setActivityStage('applied');
                          setActivityOriginal(opportunity);
                        }}
                      >
                        同时标记为已投递
                      </Button>
                    )}
                  <ActivityList
                    opportunityId={opportunity.id}
                    updatedAt={opportunity.updatedAt}
                  />
                </DetailSection>
              </>
            ) : (
              <>
                <DetailSection title="岗位正文">
                  <p className="whitespace-pre-wrap rounded-[20px] border border-[#e2ded5] bg-white/75 p-5 text-sm leading-7 text-[#615c54]">
                    {opportunity.description || '未保存岗位正文。'}
                  </p>
                </DetailSection>
                <DetailSection title="备注与复盘">
                  <div className="grid gap-4">
                    <Field label="个人备注">
                      <Textarea
                        value={notesDraft?.notes ?? opportunity.notes}
                        onChange={(e) =>
                          setNotesDraft((draft) => ({
                            ...draft,
                            original: draft?.original ?? opportunity,
                            notes: e.target.value,
                            review: draft?.review ?? opportunity.review,
                          }))
                        }
                        className="min-h-28"
                      />
                    </Field>
                    <Field label="复盘">
                      <Textarea
                        value={notesDraft?.review ?? opportunity.review}
                        onChange={(e) =>
                          setNotesDraft((draft) => ({
                            ...draft,
                            original: draft?.original ?? opportunity,
                            notes: draft?.notes ?? opportunity.notes,
                            review: e.target.value,
                          }))
                        }
                        className="min-h-28"
                      />
                    </Field>
                    <Field label="保存备注时同步阶段">
                      <select
                        aria-label="保存备注时同步阶段"
                        value={notesDraft?.stage ?? ''}
                        onChange={(e) =>
                          setNotesDraft((draft) => ({
                            original: draft?.original ?? opportunity,
                            notes: draft?.notes ?? opportunity.notes,
                            review: draft?.review ?? opportunity.review,
                            stage: e.target.value || undefined,
                          }))
                        }
                        className="h-9 w-full rounded-lg border border-input bg-white px-3 text-sm"
                      >
                        <option value="">保持当前阶段</option>
                        {STAGES.map((s) => (
                          <option
                            key={s.id}
                            value={s.id}
                            disabled={
                              opportunity.decision === 'skip' &&
                              s.id !== 'closed'
                            }
                          >
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {canMarkApplied(opportunity) &&
                      /已投递|投递了|投递成功/.test(
                        notesDraft?.notes ?? opportunity.notes,
                      ) &&
                      !notesDraft?.stage && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setNotesDraft((draft) => ({
                              original: draft?.original ?? opportunity,
                              notes: draft?.notes ?? opportunity.notes,
                              review: draft?.review ?? opportunity.review,
                              stage: 'applied',
                            }))
                          }
                        >
                          同时标记为已投递
                        </Button>
                      )}
                    <EditConflictNotice
                      update={notesUpdate}
                      current={opportunity}
                      onDiscard={() => {
                        if (
                          !confirm('放弃未保存的备注和复盘，并载入最新内容？')
                        )
                          return;
                        setNotesDraft(null);
                        saving.reset();
                      }}
                    />
                    <Button
                      className="w-fit"
                      disabled={!notesUpdate}
                      onClick={() =>
                        void saving.run(async () => {
                          if (!notesUpdate) return;
                          const result = await mutate(
                            'updateOpportunity',
                            notesUpdate,
                          );
                          if (
                            !(
                              result &&
                              typeof result === 'object' &&
                              'refreshFailed' in result &&
                              result.refreshFailed
                            )
                          )
                            setNotesDraft(null);
                          return result;
                        })
                      }
                    >
                      <Check />
                      保存备注
                    </Button>
                  </div>
                </DetailSection>
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => void remove()}
                  >
                    <Trash2 />
                    删除这个机会
                  </Button>
                </div>
              </>
            )}
            {edit && (
              <Button
                disabled={!formUpdate || Boolean(statusConflict)}
                onClick={() => void save()}
              >
                <Check />
                保存全部修改
              </Button>
            )}
          </div>
        </fieldset>
      </SheetContent>
    </Sheet>
  );
}

function EditConflictNotice({
  update,
  current,
  onDiscard,
}: {
  update: ReturnType<typeof buildOpportunityUpdate>;
  current: Opportunity;
  onDiscard: () => void;
}) {
  const conflicts = update
    ? opportunityConflicts(update.expected, current)
    : [];
  if (!conflicts.length) return null;
  return (
    <section
      aria-label="编辑冲突提示"
      className="rounded-2xl border border-[#e9c9a1] bg-[#fff8ec] p-4 text-sm text-[#795a29]"
    >
      <p className="font-semibold">最新内容已变化，未保存输入已保留</p>
      <p className="mt-1">
        请核对下方已保存内容。保存不会覆盖冲突字段；可先复制自己的输入，再放弃编辑并载入最新内容。
      </p>
      <dl className="my-3 space-y-2">
        {conflicts.map((key) => (
          <div key={key}>
            <dt className="text-xs font-semibold">
              {opportunityFields[key]} · 最新已保存
            </dt>
            <dd className="max-h-28 overflow-auto whitespace-pre-wrap break-words">
              {Array.isArray(current[key])
                ? current[key].join('、') || '（空）'
                : String(current[key] ?? '（空）') || '（空）'}
            </dd>
          </div>
        ))}
      </dl>
      <Button variant="outline" size="sm" onClick={onDiscard}>
        放弃编辑并载入最新
      </Button>
    </section>
  );
}

function EditForm({
  section,
  form,
  setForm,
  updateFormList,
}: {
  section: 'plan' | 'source';
  form: Partial<Opportunity>;
  setForm: React.Dispatch<React.SetStateAction<Partial<Opportunity>>>;
  updateFormList: (
    key: 'highlights' | 'risks',
    index: number,
    value: string,
  ) => void;
}) {
  if (section === 'source')
    return (
      <section className="space-y-4 rounded-[24px] border border-[#e0dcd2] bg-white/75 p-5">
        <h3 className="text-sm font-semibold">岗位原文与备注</h3>
        {(
          [
            ['sourceName', '来源名称'],
            ['sourceUrl', '来源链接'],
            ['description', '岗位正文'],
            ['specialNotes', '特殊注意事项'],
            ['notes', '个人备注'],
            ['review', '复盘'],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            {key === 'sourceName' || key === 'sourceUrl' ? (
              <Input
                value={form[key] || ''}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            ) : (
              <Textarea
                className={key === 'description' ? 'min-h-64' : 'min-h-28'}
                value={form[key] || ''}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </section>
    );
  return (
    <section className="rounded-[24px] border border-[#e0dcd2] bg-white/75 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="公司 / 组织">
          <Input
            value={form.organization || ''}
            onChange={(e) => setForm({ ...form, organization: e.target.value })}
          />
        </Field>
        <Field label="岗位">
          <Input
            value={form.role || ''}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          />
        </Field>
        <Field label="方向">
          <Input
            value={form.direction || ''}
            onChange={(e) => setForm({ ...form, direction: e.target.value })}
          />
        </Field>
        <Field label="地点">
          <Input
            value={form.location || ''}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
          />
        </Field>
        <Field label="阶段">
          <select
            aria-label="阶段"
            aria-invalid={Boolean(opportunityStatusConflict(form))}
            aria-describedby={
              opportunityStatusConflict(form)
                ? 'opportunity-status-conflict'
                : undefined
            }
            value={form.stage}
            onChange={(e) => setForm({ ...form, stage: e.target.value })}
            className="h-9 w-full rounded-lg border border-input bg-white px-3 text-sm"
          >
            {STAGES.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.label}
              </option>
            ))}
          </select>
          <p className="text-xs leading-5 text-[#827c72]">
            重新推进已放弃的机会时，请同时恢复投入判断和目标阶段。
          </p>
        </Field>
        <Field label="投入判断">
          <select
            aria-label="投入判断"
            value={form.decision}
            onChange={(e) =>
              setForm((current) => ({
                ...current,
                decision: e.target.value as Opportunity['decision'],
                ...(e.target.value === 'skip'
                  ? { stage: 'closed', closedReason: 'withdrawn' as const }
                  : {}),
              }))
            }
            className="h-9 w-full rounded-lg border border-input bg-white px-3 text-sm"
          >
            <option value="undecided">待判断</option>
            <option value="pursue">值得投入</option>
            <option value="hold">暂缓</option>
            <option value="skip">不再考虑</option>
          </select>
        </Field>
        {(form.stage === 'closed' || form.decision === 'skip') && (
          <Field label="结束原因">
            <select
              aria-label="结束原因"
              value={
                form.decision === 'skip'
                  ? 'withdrawn'
                  : (form.closedReason ?? 'unknown')
              }
              disabled={form.decision === 'skip'}
              onChange={(e) =>
                setForm({
                  ...form,
                  closedReason: e.target.value as Opportunity['closedReason'],
                })
              }
              className="h-9 w-full rounded-lg border border-input bg-white px-3 text-sm"
            >
              <option value="unknown">尚未确认</option>
              <option value="rejected">未通过（保留在统计中）</option>
              <option value="withdrawn">主动放弃（默认排除）</option>
            </select>
          </Field>
        )}
        <Field label="匹配度 0-5">
          <Input
            type="number"
            min="0"
            max="5"
            value={form.fitScore ?? 0}
            onChange={(e) =>
              setForm({ ...form, fitScore: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="兴趣度 0-5">
          <Input
            type="number"
            min="0"
            max="5"
            value={form.interestScore ?? 0}
            onChange={(e) =>
              setForm({ ...form, interestScore: Number(e.target.value) })
            }
          />
        </Field>
        <Field label="截止时间">
          <Input
            type="datetime-local"
            value={toInputDate(form.deadline)}
            onChange={(e) =>
              setForm({ ...form, deadline: fromInputDate(e.target.value) })
            }
          />
        </Field>
        <Field label="优先级">
          <select
            value={form.priority}
            onChange={(e) =>
              setForm({
                ...form,
                priority: e.target.value as Opportunity['priority'],
              })
            }
            className="h-9 w-full rounded-lg border border-input bg-white px-3 text-sm"
          >
            <option value="high">重点</option>
            <option value="medium">常规</option>
            <option value="low">低优先</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="下一步行动">
            <Input
              value={form.nextAction || ''}
              onChange={(e) => setForm({ ...form, nextAction: e.target.value })}
            />
            <p className="text-xs text-[#827c72]">
              保存后同步为真实任务；清空只取消重点，不删除任务。已有任务可在行动列表中设为下一步。
            </p>
          </Field>
        </div>
        <div className="sm:col-span-2">
          <ReminderOffsetsEditor
            label="投递截止提醒"
            unit="days"
            value={form.reminderDays || []}
            onChange={(reminderDays) => setForm({ ...form, reminderDays })}
          />
        </div>
        <Field label="下一步时间">
          <Input
            type="datetime-local"
            value={toInputDate(form.nextActionAt)}
            onChange={(e) =>
              setForm({ ...form, nextActionAt: fromInputDate(e.target.value) })
            }
          />
          <p className="text-xs text-[#827c72]">
            上海时间；有行动内容时，在计划完成时提醒一次。
          </p>
        </Field>
        <Field label="来源链接">
          <Input
            value={form.sourceUrl || ''}
            onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="特殊注意事项">
            <Textarea
              value={form.specialNotes || ''}
              onChange={(e) =>
                setForm({ ...form, specialNotes: e.target.value })
              }
            />
          </Field>
        </div>
        {(['highlights', 'risks'] as const).map((key) => (
          <div key={key}>
            <p className="mb-2 text-sm font-semibold">
              {key === 'highlights' ? '岗位亮点' : '门槛与风险'}
            </p>
            <div className="space-y-2">
              {(form[key] || []).map((item, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    value={item}
                    onChange={(e) => updateFormList(key, index, e.target.value)}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() =>
                      setForm({
                        ...form,
                        [key]: (form[key] || []).filter((_, i) => i !== index),
                      })
                    }
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setForm({ ...form, [key]: [...(form[key] || []), ''] })
                }
              >
                <Plus />
                添加
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function InfoTile({
  label,
  value,
  warning,
}: {
  label: string;
  value: string;
  warning?: boolean;
}) {
  return (
    <div
      className={`rounded-[18px] border p-3.5 ${warning ? 'border-[#edc7bf] bg-[#fff0ed]' : 'border-[#e2ded5] bg-white/75'}`}
    >
      <p className="text-[10px] font-semibold text-[#8a847a]">{label}</p>
      <p
        className={`mt-1 text-sm font-semibold ${warning ? 'text-[#a64639]' : ''}`}
      >
        {value}
      </p>
    </div>
  );
}
function EvidenceBox({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: 'green' | 'amber';
}) {
  return (
    <section
      className={`rounded-[22px] border p-5 ${tone === 'green' ? 'border-[#c9ddd6] bg-[#f1f7f4]' : 'border-[#ead7b7] bg-[#fff9ef]'}`}
    >
      <h3
        className={`text-sm font-semibold ${tone === 'green' ? 'text-[#315f54]' : 'text-[#79561f]'}`}
      >
        {title}
      </h3>
      <ul className="mt-3 space-y-2">
        {items.map((item, index) => (
          <li
            key={index}
            className="flex gap-2 text-sm leading-6 text-[#625d55]"
          >
            <span
              className={`mt-2.5 size-1.5 shrink-0 rounded-full ${tone === 'green' ? 'bg-[#5e8d81]' : 'bg-[#c18b38]'}`}
            />
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
function DetailSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        {count !== undefined && (
          <Badge variant="secondary" className="rounded-full">
            {count}
          </Badge>
        )}
      </div>
      {children}
    </section>
  );
}
