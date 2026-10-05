'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/workspace-common';
import { useSaveAction } from '@/components/use-save-action';
import type { Mutate, Requirement } from '@/lib/client-types';
import { buildRecordUpdate } from '@/lib/record-edit';
import { EditConflictNotice } from './edit-conflict-notice';

export function RequirementEditor({
  item,
  mutate,
  onClose,
}: {
  item: Requirement;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [notes, setNotes] = useState(item.notes);
  const [original, setOriginal] = useState(item);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saving = useSaveAction();
  const update = buildRecordUpdate('requirement', original, { name, notes });
  return (
    <fieldset
      disabled={saving.pending}
      className="w-full space-y-3 rounded-xl bg-[#f5f3ed] p-3"
      aria-label={`编辑要求 ${item.name}`}
    >
      <EditConflictNotice
        kind="requirement"
        update={update}
        current={item}
        onDiscard={() => {
          if (!confirm('放弃未保存的要求修改，并载入最新内容？')) return;
          setOriginal(item);
          setName(item.name);
          setNotes(item.notes);
          saving.reset();
        }}
      />
      <Field label="要求名称">
        <Input
          aria-label="要求名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={1000}
        />
      </Field>
      <Field label="要求说明">
        <Textarea
          aria-label="要求说明"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="文件格式、命名规范、盖章要求等"
        />
      </Field>
      {saving.failed && (
        <p role="alert" className="text-xs text-[#a64639]">
          {saving.message}
        </p>
      )}
      {confirmDelete ? (
        <div className="space-y-2">
          <p className="text-xs text-[#a64639]">
            仅移除此岗位的这项要求，不删除材料库记录或本机文件。
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() =>
                void saving.run(async () => {
                  const result = await mutate('deleteRequirement', {
                    id: item.id,
                    expectedVersion: original.deleteVersion,
                  });
                  onClose();
                  return result;
                })
              }
            >
              确认移除要求
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmDelete(false)}
            >
              保留要求
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!name.trim() || !update}
            onClick={() =>
              void saving.run(async () => {
                if (!update) return;
                const result = await mutate('updateRequirement', update);
                onClose();
                return result;
              })
            }
          >
            保存要求
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            取消编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-[#a64639]"
            onClick={() => setConfirmDelete(true)}
          >
            移除这项要求
          </Button>
        </div>
      )}
    </fieldset>
  );
}
