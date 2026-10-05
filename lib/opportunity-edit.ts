import type { Opportunity } from './client-types';

export const opportunityFields = {
  organization: '公司 / 组织',
  role: '岗位',
  direction: '方向',
  location: '地点',
  sourceName: '来源',
  sourceUrl: '原始链接',
  description: '岗位原文',
  priority: '优先级',
  stage: '招聘阶段',
  closedReason: '结束原因',
  deadline: '投递截止',
  reminderDays: '截止提醒',
  tags: '标签',
  notes: '个人备注',
  specialNotes: '特殊注意事项',
  review: '复盘',
  decision: '投入决策',
  fitScore: '匹配度',
  interestScore: '兴趣度',
  nextAction: '下一步行动',
  nextActionAt: '下一步时间',
  highlights: '岗位亮点',
  risks: '门槛与风险',
} as const;
export type OpportunityField = keyof typeof opportunityFields;
export const coupledOpportunityFields: OpportunityField[][] = [
  ['stage', 'closedReason', 'decision'],
  ['nextAction', 'nextActionAt'],
];

// JSON serializes Date and an ISO string identically. Array order is meaningful.
export const sameEditValue = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function buildOpportunityUpdate(
  original: Opportunity,
  draft: Partial<Opportunity>,
) {
  const changes: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const key of Object.keys(opportunityFields) as OpportunityField[]) {
    const before =
      key === 'closedReason' ? (original[key] ?? 'unknown') : original[key];
    if (draft[key] !== undefined && !sameEditValue(draft[key], before)) {
      changes[key] = draft[key];
      expected[key] = before;
    }
  }
  if (!Object.keys(changes).length) return null;
  for (const group of coupledOpportunityFields)
    if (group.some((key) => key in changes))
      for (const key of group)
        expected[key] =
          key === 'closedReason' ? (original[key] ?? 'unknown') : original[key];
  return { id: original.id, ...changes, expected };
}

export function opportunityConflicts(
  expected: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  return (Object.keys(expected) as OpportunityField[]).filter(
    (key) => !sameEditValue(expected[key], current[key]),
  );
}
