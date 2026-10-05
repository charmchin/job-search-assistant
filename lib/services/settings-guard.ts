import { settings } from '@/db/schema';
import type { Writer } from './context';
import { ActionError } from './errors';
import { editableSettings } from '../settings-edit';
import { recordConflicts } from '../record-edit';
export function readEditableSettings(tx: Writer) {
  return editableSettings(
    Object.fromEntries(
      tx
        .select()
        .from(settings)
        .all()
        .map((row) => [row.key, row.value]),
    ),
  );
}
export function assertSettingsEdit(
  tx: Writer,
  expected: Record<string, unknown> | undefined,
) {
  if (!expected) return;
  const conflicts = recordConflicts(expected, readEditableSettings(tx));
  if (conflicts.length) {
    const labels: Record<string, string> = {
      baseUrl: '兼容接口地址',
      model: '模型名',
      staleDays: '停滞复查天数',
      keyRevision: '密钥版本',
    };
    throw new ActionError(
      `未保存：${conflicts.map((key) => labels[key]).join('、')}已被其他操作修改。输入已保留，请核对最新设置；不会覆盖已有修改。`,
      409,
      'EDIT_CONFLICT',
      { fields: conflicts },
    );
  }
}
