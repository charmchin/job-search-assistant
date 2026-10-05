'use client';
import { Button } from './ui/button';
import {
  recordConflicts,
  recordFields,
  type RecordKind,
} from '@/lib/record-edit';
import { formatDateTime } from '@/lib/domain';

export function EditConflictNotice({
  kind,
  update,
  current,
  onDiscard,
}: {
  kind: RecordKind;
  update: { expected: Record<string, unknown> } | null;
  current?: Record<string, unknown> | null;
  onDiscard: () => void;
}) {
  const conflicts =
    update && current ? recordConflicts(update.expected, current) : [];
  if (!update || (current && !conflicts.length)) return null;
  const labels: Record<string, string> = recordFields[kind];
  return (
    <section
      aria-label="编辑冲突提示"
      className="rounded-2xl border border-[#e9c9a1] bg-[#fff8ec] p-4 text-sm text-[#795a29]"
    >
      <p className="font-semibold">
        {current
          ? '最新内容已变化，未保存输入已保留'
          : '记录已不存在，未保存输入已保留'}
      </p>
      <p className="mt-1">
        不会覆盖已保存内容。请先复制并核对自己的输入，再载入最新内容。
      </p>
      <dl className="my-3 space-y-2">
        {conflicts.map((key) => (
          <div key={key}>
            <dt className="text-xs font-semibold">
              {labels[key]} · 最新已保存
            </dt>
            <dd className="max-h-28 overflow-auto whitespace-pre-wrap break-words">
              {displayValue(key, current![key])}
            </dd>
          </div>
        ))}
      </dl>
      <Button variant="outline" size="sm" onClick={onDiscard}>
        {current ? '放弃编辑并载入最新' : '放弃编辑并关闭'}
      </Button>
    </section>
  );
}
function displayValue(key: string, value: unknown) {
  if (key === 'keyRevision')
    return '密钥已更新，请重新核对接口与模型；不会显示密钥或其版本标识。';
  if (key === 'dueAt' || key === 'scheduledAt')
    return typeof value === 'string' && value
      ? formatDateTime(value)
      : '未设置';
  if (key === 'completed') return value ? '已就绪' : '待准备';
  if (key === 'status' && typeof value === 'string')
    return (
      (
        {
          todo: '待办',
          doing: '进行中',
          done: '已完成',
          skipped: '已跳过',
          pending: '待处理',
        } as Record<string, string>
      )[value] ?? value
    );
  return Array.isArray(value)
    ? value.join('、') || '（空）'
    : typeof value === 'string'
      ? value || '（空）'
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '（空）';
}
