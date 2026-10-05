'use client';
import { useState } from 'react';
import { History, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, fromInputDate } from '@/components/workspace-common';
import { useSaveAction } from '@/components/use-save-action';
import { highestRecordedStage, stageLabel } from '@/lib/analytics';
import { STAGES } from '@/lib/domain';
import type { Opportunity, Mutate } from '@/lib/client-types';

const historyTime = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value));

export function StageHistoryPanel({
  opportunity,
  mutate,
}: {
  opportunity: Opportunity;
  mutate: Mutate;
}) {
  const [adding, setAdding] = useState(false);
  const [stage, setStage] = useState('applied');
  const [occurredAt, setOccurredAt] = useState('');
  const [notes, setNotes] = useState('');
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const saving = useSaveAction();
  const highest = highestRecordedStage(opportunity);
  return (
    <section className="space-y-4" aria-label="阶段历史">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <History className="size-4 text-[#3e796b]" />
            阶段历史
          </h3>
          <p className="mt-1 text-xs text-[#817b71]">
            最高记录：{highest ? stageLabel(highest) : '暂无有效进展记录'} ·
            回退当前阶段不会删除历史
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={saving.pending}
          onClick={() => {
            saving.reset();
            setAdding(!adding);
            setCorrecting(null);
          }}
        >
          <Plus className="size-4" />
          {adding ? '收起补录' : '补录经历'}
        </Button>
      </div>
      {adding && (
        <fieldset
          disabled={saving.pending}
          aria-label="补录阶段经历"
          className="space-y-3 rounded-[18px] border border-[#dedad1] bg-white/70 p-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="经历的阶段">
              <select
                aria-label="补录阶段"
                className="h-9 w-full rounded-lg border border-input bg-white px-3 text-sm"
                value={stage}
                onChange={(e) => setStage(e.target.value)}
              >
                {STAGES.filter((s) => s.id !== 'closed').map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="发生时间（可留空，上海时区）">
              <Input
                aria-label="阶段发生时间"
                type="datetime-local"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
              />
            </Field>
          </div>
          <Input
            aria-label="阶段经历说明"
            placeholder="例如：已在官网投递，补记之前遗漏的经历"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <p className="text-xs leading-5 text-[#817b71]">
            只补录已经发生的经历，不改变当前阶段；未来安排请添加招聘节点。
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                void saving.run(async () => {
                  const result = await mutate('addStageHistory', {
                    opportunityId: opportunity.id,
                    stage,
                    occurredAt: fromInputDate(occurredAt),
                    notes,
                  });
                  setAdding(false);
                  setOccurredAt('');
                  setNotes('');
                  return result;
                })
              }
            >
              {saving.pending ? '保存中…' : '保存经历'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              取消补录
            </Button>
          </div>
        </fieldset>
      )}
      {saving.message && (
        <p
          role={saving.failed ? 'alert' : 'status'}
          className={`text-xs ${saving.failed ? 'text-[#a64639]' : 'text-[#3e796b]'}`}
        >
          {saving.message}
        </p>
      )}
      <div className="space-y-2">
        {opportunity.stageHistory?.map((row) => (
          <div
            key={row.id}
            data-testid={`stage-record-${row.id}`}
            className={`rounded-[16px] border border-[#e2ded5] bg-white/65 p-3 ${row.valid ? '' : 'opacity-65'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p
                  className={`text-sm font-semibold ${row.valid ? '' : 'line-through'}`}
                >
                  {row.fromStage ? `${stageLabel(row.fromStage)} → ` : ''}
                  {stageLabel(row.toStage)}
                  <span className="ml-2 text-xs font-normal text-[#817b71]">
                    {!row.valid
                      ? '已作废'
                      : row.source === 'legacy'
                        ? '旧数据快照'
                        : row.source === 'manual'
                          ? '手动补录'
                          : row.source === 'initial'
                            ? '建档阶段'
                            : '阶段变更'}
                  </span>
                </p>
                <p className="mt-1 text-xs text-[#817b71]">
                  发生时间：
                  {row.occurredAt
                    ? historyTime(row.occurredAt)
                    : '未知 / 未填写'}{' '}
                  · {row.source === 'legacy' ? '快照依据时间' : '记录时间'}：
                  {historyTime(row.recordedAt)}
                </p>
                {row.notes && (
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs text-[#736c60]">
                    {row.notes}
                  </p>
                )}
              </div>
              {row.valid && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`作废${stageLabel(row.toStage)}记录`}
                  disabled={saving.pending}
                  onClick={() => {
                    saving.reset();
                    setCorrecting(row.id);
                    setReason('');
                    setAdding(false);
                  }}
                >
                  <X className="size-3.5" />
                  作废
                </Button>
              )}
            </div>
            {correcting === row.id && (
              <fieldset
                disabled={saving.pending}
                className="mt-3 space-y-3 border-t border-[#e2ded5] pt-3"
              >
                <p className="text-xs leading-5 text-[#a64639]">
                  作废后不再参与统计，原记录仍保留。不会改变当前阶段；如果当前阶段误选，请另行编辑信息。
                </p>
                <Input
                  aria-label="作废原因"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="说明误录原因（必填）"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!reason.trim()}
                    onClick={() =>
                      void saving.run(async () => {
                        const result = await mutate('invalidateStageHistory', {
                          id: row.id,
                          notes: reason,
                        });
                        setCorrecting(null);
                        setReason('');
                        return result;
                      })
                    }
                  >
                    确认作废记录
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCorrecting(null)}
                  >
                    保留记录
                  </Button>
                </div>
              </fieldset>
            )}
          </div>
        ))}
      </div>
      {!opportunity.stageHistory?.length && (
        <p className="text-sm text-[#817b71]">
          暂无阶段历史。仅根据明确记录统计，不从当前阶段推断此前经历。
        </p>
      )}
    </section>
  );
}
