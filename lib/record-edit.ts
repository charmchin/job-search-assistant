import type { Material, Requirement } from './client-types';
import { sameEditValue } from './opportunity-edit';

export const recordFields = {
  task: {
    title: '任务名称',
    dueAt: '任务时间',
    estimatedMinutes: '预计耗时',
    status: '任务状态',
  },
  milestone: {
    title: '节点名称',
    scheduledAt: '节点时间',
    result: '节点结果 / 注意事项',
    reminderOffsets: '节点提醒',
    status: '节点状态',
  },
  material: {
    name: '材料名称',
    filePath: '本机文件路径',
    version: '材料版本',
    category: '材料类型',
    notes: '材料备注',
  },
  requirement: {
    name: '要求名称',
    materialId: '关联材料',
    completed: '材料就绪状态',
    notes: '要求说明',
  },
  settings: {
    baseUrl: '兼容接口地址',
    model: '模型名',
    staleDays: '停滞复查天数',
    keyRevision: '密钥版本',
  },
} as const;
export type RecordKind = keyof typeof recordFields;
export const recordGroups: Record<RecordKind, string[][]> = {
  task: [['title', 'dueAt', 'status']],
  milestone: [['title', 'scheduledAt', 'status']],
  material: [['filePath', 'version']],
  requirement: [['materialId', 'completed']],
  settings: [['baseUrl', 'model', 'keyRevision']],
};
export function buildRecordUpdate(
  kind: RecordKind,
  original: { id: string } & Record<string, unknown>,
  draft: Record<string, unknown>,
) {
  const changes: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const key of Object.keys(recordFields[kind]))
    if (draft[key] !== undefined && !sameEditValue(draft[key], original[key])) {
      changes[key] = draft[key];
      expected[key] = original[key];
    }
  if (!Object.keys(changes).length) return null;
  for (const group of recordGroups[kind])
    if (group.some((key) => key in changes))
      for (const key of group) expected[key] = original[key];
  return { id: original.id, ...changes, expected };
}
export function recordConflicts(
  expected: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  return Object.keys(expected).filter(
    (key) => !sameEditValue(expected[key], current[key]),
  );
}
export function buildRequirementUpdate(
  original: Requirement,
  draft: Partial<Requirement>,
  materials: Material[],
) {
  const update = buildRecordUpdate('requirement', original, draft);
  if (!update || draft.completed !== true || !original.materialId)
    return update;
  const material = materials.find((m) => m.id === original.materialId);
  if (!material)
    throw new Error('关联材料已不存在，请刷新核对后重新标记就绪。');
  return {
    ...update,
    expectedMaterial: {
      id: material.id,
      filePath: material.filePath,
      version: material.version,
    },
  };
}
