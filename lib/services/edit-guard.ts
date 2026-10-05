import { ActionError } from './errors';
import { recordConflicts, recordFields, type RecordKind } from '../record-edit';

export function assertRecordEdit(
  kind: RecordKind,
  expected: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
) {
  if (!expected) return;
  const conflicts = recordConflicts(expected, current);
  if (conflicts.length) {
    const labels: Record<string, string> = recordFields[kind];
    throw new ActionError(
      `未保存：${conflicts.map((key) => labels[key]).join('、')}已被其他操作修改。输入已保留，请核对最新内容；不会覆盖已有修改。`,
      409,
      'EDIT_CONFLICT',
      { fields: conflicts },
    );
  }
}
