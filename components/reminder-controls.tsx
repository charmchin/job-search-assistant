'use client';

import { useRef, useState } from 'react';
import { CalendarDays, Check, Loader2, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Field,
  fromInputDate,
  toInputDate,
} from '@/components/workspace-common';
import { formatDateTime } from '@/lib/domain';
import {
  DEFAULT_DEADLINE_DAYS,
  DEFAULT_MILESTONE_MINUTES,
} from '@/lib/reminder-policy';
import type { Milestone, Mutate } from '@/lib/client-types';
import { buildRecordUpdate } from '@/lib/record-edit';
import { EditConflictNotice } from './edit-conflict-notice';

export function offsetLabel(value: number, unit: 'days' | 'minutes') {
  if (value === 0) return unit === 'days' ? '当天' : '到点';
  if (unit === 'days') return `提前 ${value} 天`;
  if (value % 1440 === 0) return `提前 ${value / 1440} 天`;
  if (value % 60 === 0) return `提前 ${value / 60} 小时`;
  return `提前 ${value} 分钟`;
}

export function ReminderOffsetsEditor({
  value,
  onChange,
  unit,
  label,
}: {
  value: number[];
  onChange: (value: number[]) => void;
  unit: 'days' | 'minutes';
  label: string;
}) {
  const [custom, setCustom] = useState('');
  const [error, setError] = useState('');
  const defaults =
    unit === 'days' ? DEFAULT_DEADLINE_DAYS : DEFAULT_MILESTONE_MINUTES;
  const presets = unit === 'days' ? defaults : [...defaults, 60, 30];
  const set = (values: number[]) => {
    const unique = [...new Set(values)];
    if (unique.length > 20) {
      setError('最多 20 个提醒时间。');
      return;
    }
    onChange(unique.sort((a, b) => b - a));
    setError('');
  };
  const add = () => {
    const n = Number(custom);
    const max = unit === 'days' ? 3650 : 5256000;
    if (
      !custom.trim() ||
      !Number.isInteger(n) ||
      n < 0 ||
      n > max ||
      (value.length >= 20 && !value.includes(n))
    ) {
      setError(`请输入 0–${max} 的整数；最多 20 个时间。`);
      return;
    }
    set([...value, n]);
    setCustom('');
  };
  return (
    <fieldset className="min-w-0 rounded-2xl border border-[#e1ddd4] bg-[#fcfbf8] p-4">
      <legend className="px-1 text-sm font-semibold">{label}</legend>
      <p className="mb-3 text-xs leading-5 text-[#827c72]">
        {unit === 'days'
          ? '以截止所在的上海日期计算，每天 09:00；若当天截止早于 09:00，则在截止时提醒。'
          : '以节点的准确时间向前推算；例如面试前 1 小时。'}
        {value.length === 0 && ' 当前已关闭此项提醒。'}
      </p>
      <div className="flex flex-wrap gap-2">
        {[...new Set([...presets, ...value])]
          .sort((a, b) => b - a)
          .map((n) => (
            <button
              type="button"
              key={n}
              aria-pressed={value.includes(n)}
              onClick={() =>
                set(
                  value.includes(n)
                    ? value.filter((v) => v !== n)
                    : [...value, n],
                )
              }
              className={`rounded-full border px-3 py-1.5 text-xs ${value.includes(n) ? 'border-[#b8d0c5] bg-[#e7f1ed] text-[#2d6b5d]' : 'border-[#e1ddd4] bg-white text-[#827c72]'}`}
            >
              {offsetLabel(n, unit)}
            </button>
          ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          type="number"
          aria-label={`${label}自定义${unit === 'days' ? '天数' : '分钟'}`}
          min="0"
          max={unit === 'days' ? 3650 : 5256000}
          step="1"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder={unit === 'days' ? '自定义提前天数' : '自定义提前分钟'}
          className="w-40 bg-white"
        />
        <Button type="button" variant="outline" size="sm" onClick={add}>
          添加时间
        </Button>
        <button
          type="button"
          onClick={() => set([])}
          className="text-xs text-[#837d73]"
        >
          关闭此项提醒
        </button>
        <button
          type="button"
          onClick={() => set([...defaults])}
          className="text-xs text-[#397365]"
        >
          恢复默认
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-[#a64639]">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function MilestoneCard({
  item,
  mutate,
}: {
  item: Milestone;
  mutate: Mutate;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(item);
  const [original, setOriginal] = useState(item);
  const [pending, setPending] = useState(false);
  const savingLock = useRef(false);
  const [error, setError] = useState('');
  const submit = async (payload: Record<string, unknown>) => {
    if (savingLock.current) return;
    savingLock.current = true;
    setPending(true);
    setError('');
    try {
      const update = buildRecordUpdate(
        'milestone',
        editing ? original : item,
        payload,
      );
      if (update) await mutate('updateMilestone', update);
      setEditing(false);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : '保存失败，输入已保留。',
      );
    } finally {
      savingLock.current = false;
      setPending(false);
    }
  };
  return (
    <div
      className="rounded-[18px] border border-[#e5e1d8] bg-white/75 p-4"
      data-testid={`milestone-${item.id}`}
    >
      {editing ? (
        <div className="space-y-4">
          <EditConflictNotice
            kind="milestone"
            update={buildRecordUpdate('milestone', original, {
              title: form.title,
              scheduledAt: form.scheduledAt,
              reminderOffsets: form.reminderOffsets,
              result: form.result,
            })}
            current={item}
            onDiscard={() => {
              if (!confirm('放弃未保存的节点修改，并载入最新内容？')) return;
              setOriginal(item);
              setForm(item);
              setError('');
            }}
          />
          <Field label="节点名称">
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="节点时间（上海时区）">
            <Input
              type="datetime-local"
              value={toInputDate(form.scheduledAt)}
              onChange={(e) =>
                setForm({ ...form, scheduledAt: fromInputDate(e.target.value) })
              }
            />
          </Field>
          <ReminderOffsetsEditor
            label="节点提醒"
            unit="minutes"
            value={form.reminderOffsets}
            onChange={(reminderOffsets) =>
              setForm({ ...form, reminderOffsets })
            }
          />
          <Field label="节点结果 / 注意事项">
            <Textarea
              value={form.result}
              aria-label="节点结果 / 注意事项"
              onChange={(e) => setForm({ ...form, result: e.target.value })}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              disabled={
                pending ||
                !form.title.trim() ||
                !buildRecordUpdate('milestone', original, {
                  title: form.title,
                  scheduledAt: form.scheduledAt,
                  reminderOffsets: form.reminderOffsets,
                  result: form.result,
                })
              }
              onClick={() =>
                void submit({
                  title: form.title,
                  scheduledAt: form.scheduledAt,
                  reminderOffsets: form.reminderOffsets,
                  result: form.result,
                })
              }
            >
              {pending ? <Loader2 className="animate-spin" /> : <Check />}
              保存节点
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setError('');
              }}
            >
              <X />
              取消
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <CalendarDays className="size-4 text-[#7157a0]" />
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-semibold">{item.title}</p>
              <p className="text-xs text-[#827c72]">
                {formatDateTime(item.scheduledAt)} · 上海时间
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setForm(item);
                setOriginal(item);
                setEditing(true);
                setError('');
              }}
              aria-label={`编辑节点 ${item.title}`}
            >
              <Pencil />
              编辑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                void submit({
                  status: item.status === 'done' ? 'pending' : 'done',
                })
              }
            >
              {item.status === 'done' ? '已完成 · 恢复' : '标记完成'}
            </Button>
          </div>
          <p className="mt-2 text-xs leading-5 text-[#827c72]">
            {item.reminderOffsets.length
              ? `提醒：${item.reminderOffsets.map((n) => offsetLabel(n, 'minutes')).join('、')}`
              : '此节点提醒已关闭'}
            {item.status !== 'pending' && '；完成或跳过的节点不会提醒'}
          </p>
          {item.result && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-[#6f6960]">
              {item.result}
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-[#a64639]">
          {error}
        </p>
      )}
    </div>
  );
}
