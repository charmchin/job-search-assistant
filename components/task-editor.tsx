'use client';
import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, fromInputDate, toInputDate } from './workspace-common';
import { EditConflictNotice } from './edit-conflict-notice';
import { useSaveAction } from './use-save-action';
import { buildRecordUpdate } from '@/lib/record-edit';
import type { Mutate, Task } from '@/lib/client-types';

export function TaskEditor({
  item,
  mutate,
  onClose,
}: {
  item: Task;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [original, setOriginal] = useState(item);
  const [form, setForm] = useState({
    title: item.title,
    dueAt: item.dueAt,
    estimatedMinutes: item.estimatedMinutes,
  });
  const saving = useSaveAction();
  const update = buildRecordUpdate('task', original, form);
  return (
    <fieldset
      aria-label={`编辑任务 ${item.title}`}
      disabled={saving.pending}
      className="space-y-3 rounded-2xl border border-[#dcd7cc] bg-[#f5f3ed] p-4"
    >
      <EditConflictNotice
        kind="task"
        update={update}
        current={item}
        onDiscard={() => {
          if (!confirm('放弃未保存的任务修改，并载入最新内容？')) return;
          setOriginal(item);
          setForm({
            title: item.title,
            dueAt: item.dueAt,
            estimatedMinutes: item.estimatedMinutes,
          });
          saving.reset();
        }}
      />
      <Field label="任务名称">
        <Input
          aria-label="任务名称"
          value={form.title}
          maxLength={4096}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="任务时间（上海时区）">
          <Input
            aria-label="任务时间（上海时区）"
            type="datetime-local"
            value={toInputDate(form.dueAt)}
            onChange={(e) =>
              setForm({ ...form, dueAt: fromInputDate(e.target.value) })
            }
          />
        </Field>
        <Field label="预计耗时（分钟）">
          <Input
            aria-label="预计耗时（分钟）"
            type="number"
            min={0}
            max={525600}
            step={1}
            value={form.estimatedMinutes}
            onChange={(e) =>
              setForm({ ...form, estimatedMinutes: Number(e.target.value) })
            }
          />
        </Field>
      </div>
      {saving.message && (
        <p
          role={saving.failed ? 'alert' : 'status'}
          className="text-sm text-[#a64639]"
        >
          {saving.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!update || !form.title.trim()}
          onClick={() =>
            void saving.run(async () => {
              if (!update) return;
              const result = await mutate('updateTask', update);
              onClose();
              return result;
            })
          }
        >
          保存任务
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>
          取消编辑
        </Button>
      </div>
    </fieldset>
  );
}
