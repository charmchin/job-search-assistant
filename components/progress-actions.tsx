'use client';

import { cloneElement, useId, useState, type ReactElement } from 'react';
import { Check, CalendarClock, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSaveAction } from './use-save-action';
import {
  applicationTasks,
  canMarkApplied,
  progressPayload,
} from '@/lib/opportunity-progress';
import { toShanghaiInput, fromShanghaiInput } from '@/lib/reminder-policy';
import { STAGES } from '@/lib/domain';
import type { Mutate, Opportunity } from '@/lib/client-types';

type Mode = 'application' | 'progress' | 'tasks' | 'followup';
const titles: Record<Mode, string> = {
  application: '记录投递',
  progress: '记录招聘进展',
  tasks: '核对投递任务',
  followup: '安排跟进',
};

export function ProgressActions({
  item,
  mutate,
}: {
  item: Opportunity;
  mutate: Mutate;
}) {
  const [session, setSession] = useState<{
    item: Opportunity;
    mode: Mode;
  } | null>(null);
  const [message, setMessage] = useState('');
  if (item.stage === 'closed' || item.decision === 'skip') return null;
  const beforeApplication = canMarkApplied(item);
  const candidates = applicationTasks(item);
  const open = (mode: Mode) => {
    setMessage('');
    setSession({ item, mode });
  };
  return (
    <div className="space-y-2" aria-label="快捷推进">
      <div className="flex flex-wrap gap-2">
        {beforeApplication ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => open('application')}
          >
            <Check />
            记录投递
          </Button>
        ) : (
          <>
            {item.stage !== 'offer' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => open('progress')}
              >
                <ArrowUpRight />
                记录进展
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => open('followup')}
            >
              <CalendarClock />
              安排跟进
            </Button>
            {candidates.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => open('tasks')}>
                核对投递任务（{candidates.length}）
              </Button>
            )}
          </>
        )}
      </div>
      {message && (
        <output className="block text-xs text-[#41675c]">{message}</output>
      )}
      {session && (
        <ProgressDialog
          item={session.item}
          mode={session.mode}
          mutate={mutate}
          onClose={() => setSession(null)}
          onSaved={() => {
            setSession(null);
            setMessage('已更新进展。');
          }}
        />
      )}
    </div>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="grid gap-2 text-sm">
      <label htmlFor={id} className="font-semibold text-[#514c43]">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}

function ProgressDialog({
  item,
  mode,
  mutate,
  onClose,
  onSaved,
}: {
  item: Opportunity;
  mode: Mode;
  mutate: Mutate;
  onClose: () => void;
  onSaved: () => void;
}) {
  const saving = useSaveAction();
  const [saved, setSaved] = useState(false);
  const [stage, setStage] = useState(mode === 'application' ? 'applied' : '');
  const [occurredAt, setOccurredAt] = useState(
    toShanghaiInput(new Date().toISOString()),
  );
  const [content, setContent] = useState('');
  const candidates = applicationTasks(item);
  const [selected, setSelected] = useState<string[]>([]);
  const [followUp, setFollowUp] = useState(mode === 'followup');
  const [followTitle, setFollowTitle] = useState(
    item.stage === 'offer' ? '跟进签约安排' : '跟进招聘反馈',
  );
  const [followAt, setFollowAt] = useState('');
  const [milestone, setMilestone] = useState(false);
  const [milestoneTitle, setMilestoneTitle] = useState('面试');
  const [milestoneAt, setMilestoneAt] = useState('');
  const hasStage = mode === 'application' || mode === 'progress';
  const save = () =>
    saving.run(async () => {
      if (saved) return;
      if (hasStage && !stage) throw new Error('请选择本次进展。');
      if (mode === 'tasks' && !selected.length)
        throw new Error('请勾选已经完成的任务。');
      const result = await mutate('recordProgress', {
        opportunityId: item.id,
        expectedStatus: progressPayload(item, '', item.stage).expectedStatus,
        ...(hasStage
          ? { stage, occurredAt: fromShanghaiInput(occurredAt) }
          : {}),
        content,
        completedTasks: candidates
          .filter((task) => selected.includes(task.id))
          .map((task) => ({
            id: task.id,
            expected: {
              title: task.title,
              dueAt: task.dueAt,
              status: task.status,
            },
          })),
        ...(followUp
          ? {
              followUp: {
                title: followTitle,
                dueAt: fromShanghaiInput(followAt),
                expectedNextTaskId:
                  item.tasks.find((task) => task.isNextAction)?.id ?? null,
              },
            }
          : {}),
        ...(milestone
          ? {
              milestone: {
                title: milestoneTitle,
                scheduledAt: fromShanghaiInput(milestoneAt),
              },
            }
          : {}),
      });
      setSaved(true);
      if (
        !(
          result &&
          typeof result === 'object' &&
          'refreshFailed' in result &&
          result.refreshFailed
        )
      )
        onSaved();
      return result;
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving.pending) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto bg-[#faf9f5] sm:max-w-xl"
        showCloseButton={!saving.pending}
      >
        <DialogHeader>
          <DialogTitle>{titles[mode]}</DialogTitle>
          <DialogDescription>
            {item.organization} · {item.role}
          </DialogDescription>
        </DialogHeader>
        <fieldset
          disabled={saving.pending || saved}
          className="min-w-0 space-y-4"
        >
          {mode === 'progress' && (
            <FormField label="本次进展">
              <select
                value={stage}
                onChange={(event) => {
                  setStage(event.target.value);
                  setMilestone(false);
                  setMilestoneTitle(
                    event.target.value === 'assessment' ? '测评/笔试' : '面试',
                  );
                }}
                className="h-9 rounded-lg border border-input bg-white px-3 text-sm"
              >
                <option value="">选择已发生的进展</option>
                {STAGES.filter((s) =>
                  ['assessment', 'interview', 'waiting', 'offer'].includes(
                    s.id,
                  ),
                ).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </FormField>
          )}
          {hasStage && (
            <div className="space-y-2">
              <FormField
                label={
                  mode === 'application'
                    ? '实际投递时间（上海）'
                    : '进展发生时间（上海）'
                }
              >
                <Input
                  type="datetime-local"
                  value={occurredAt}
                  onChange={(event) => setOccurredAt(event.target.value)}
                  max={toShanghaiInput(new Date().toISOString())}
                />
              </FormField>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setOccurredAt(toShanghaiInput(new Date().toISOString()))
                  }
                >
                  今天
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setOccurredAt(
                      toShanghaiInput(
                        new Date(Date.now() - 86400000).toISOString(),
                      ),
                    )
                  }
                >
                  昨天
                </Button>
              </div>
              <p className="text-xs text-[#827c72]">
                请核对实际日期和时刻。收到邀请可记录为面试或笔试，再单独安排考试、面试时间。
              </p>
            </div>
          )}
          {mode !== 'followup' && candidates.length > 0 && (
            <section
              className="space-y-2 rounded-xl border border-[#dfdcd3] bg-white p-3"
              aria-label="核对投递相关任务"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">
                  勾选确实完成的任务（{selected.length}/{candidates.length}）
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setSelected(
                      selected.length === candidates.length
                        ? []
                        : candidates.map((task) => task.id),
                    )
                  }
                >
                  {selected.length === candidates.length ? '取消全选' : '全选'}
                </Button>
              </div>
              {candidates.map((task) => (
                <label
                  key={task.id}
                  className="flex items-start gap-2 py-1 text-sm leading-5"
                >
                  <input
                    type="checkbox"
                    className="mt-1 accent-[#2d6b5d]"
                    checked={selected.includes(task.id)}
                    onChange={(event) =>
                      setSelected((values) =>
                        event.target.checked
                          ? [...values, task.id]
                          : values.filter((id) => id !== task.id),
                      )
                    }
                  />
                  <span className="min-w-0 break-words">{task.title}</span>
                </label>
              ))}
              <p className="text-xs text-[#827c72]">
                只完成勾选项。仍需补充材料的任务可以保留。
              </p>
            </section>
          )}
          {mode !== 'tasks' && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="accent-[#2d6b5d]"
                  checked={followUp}
                  onChange={(event) => setFollowUp(event.target.checked)}
                />
                安排下一步
              </label>
              {followUp && (
                <div className="grid gap-3 rounded-xl border border-[#dfdcd3] bg-white p-3">
                  <FormField label="下一步内容">
                    <Input
                      value={followTitle}
                      onChange={(event) => setFollowTitle(event.target.value)}
                    />
                  </FormField>
                  <FormField label="跟进时间（上海，可留空）">
                    <Input
                      type="datetime-local"
                      value={followAt}
                      onChange={(event) => setFollowAt(event.target.value)}
                    />
                  </FormField>
                  <p className="text-xs text-[#827c72]">
                    保存为新的下一步。原有任务仍保留在行动列表中；设置时间后会按时提醒。
                  </p>
                </div>
              )}
            </div>
          )}
          {['assessment', 'interview'].includes(stage) && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="accent-[#2d6b5d]"
                  checked={milestone}
                  onChange={(event) => setMilestone(event.target.checked)}
                />
                同时安排招聘节点
              </label>
              {milestone && (
                <div className="grid gap-3 rounded-xl border border-[#dfdcd3] bg-white p-3">
                  <FormField label="节点名称">
                    <Input
                      value={milestoneTitle}
                      onChange={(event) =>
                        setMilestoneTitle(event.target.value)
                      }
                    />
                  </FormField>
                  <FormField label="节点时间（上海）">
                    <Input
                      type="datetime-local"
                      value={milestoneAt}
                      onChange={(event) => setMilestoneAt(event.target.value)}
                    />
                  </FormField>
                </div>
              )}
            </div>
          )}
          <FormField label="补充记录（可选）">
            <Input
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="例如：官网投递成功，收到邮件确认"
            />
          </FormField>
        </fieldset>
        {saving.message && (
          <p
            role={saving.failed ? 'alert' : 'status'}
            className={`text-sm ${saving.failed ? 'text-[#a64639]' : 'text-[#41675c]'}`}
          >
            {saving.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving.pending} onClick={onClose}>
            {saved ? '关闭' : '取消'}
          </Button>
          <Button
            disabled={
              saving.pending || saved || (mode === 'tasks' && !selected.length)
            }
            onClick={() => void save()}
          >
            {saving.pending
              ? '保存中…'
              : selected.length
                ? `保存并完成 ${selected.length} 项任务`
                : '保存进展'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
