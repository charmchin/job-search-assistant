import { z } from 'zod';
import { STAGES } from './domain';
import { coupledOpportunityFields } from './opportunity-edit';
import { recordGroups } from './record-edit';
import {
  deadlineDaysSchema,
  milestoneMinutesSchema,
  scheduledTimeSchema,
} from './reminder-policy';

const id = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(1000);
const text = z.string().max(100000);
const short = z.string().max(4096);
const httpUrl = short.trim().refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}, '仅支持不含账号密码的 HTTP/HTTPS 地址');
const strings = z.array(z.string().max(4096)).max(100);
const deletion = z.strictObject({
  id,
  expectedVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const time = scheduledTimeSchema
  .unwrap()
  .transform((value) =>
    value === null || value === '' ? null : new Date(value),
  );
const minutes = z.number().int().min(0).max(525600);
const source = z.enum(['manual', 'ai', 'rule']);
const opportunityShape = {
  organization: name,
  role: name,
  direction: short,
  location: short,
  sourceName: short,
  sourceUrl: httpUrl,
  description: text,
  priority: z.enum(['high', 'medium', 'low']),
  stage: z.enum(STAGES.map((item) => item.id)),
  closedReason: z.enum(['unknown', 'rejected', 'withdrawn']),
  deadline: time,
  reminderDays: deadlineDaysSchema,
  tags: strings,
  notes: text,
  specialNotes: text,
  review: text,
  decision: z.enum(['undecided', 'pursue', 'hold', 'skip']),
  fitScore: z.number().int().min(0).max(5),
  interestScore: z.number().int().min(0).max(5),
  nextAction: short,
  nextActionAt: time,
  highlights: strings,
  risks: strings,
};
const taskShape = {
  title: z.string().trim().min(1).max(4096),
  dueAt: time,
  estimatedMinutes: minutes,
  source,
};
const milestoneShape = {
  title: name,
  scheduledAt: time,
  result: text,
  reminderOffsets: milestoneMinutesSchema,
};
const materialShape = {
  name,
  filePath: short,
  version: short,
  category: name,
  notes: text,
};
const update = <T extends z.ZodRawShape>(shape: T) =>
  z
    .strictObject(shape)
    .partial()
    .extend({ id })
    .refine(
      (value) =>
        Object.keys(value).some(
          (key) =>
            key !== 'id' &&
            (value as Record<string, unknown>)[key] !== undefined,
        ),
      '请至少修改一个字段',
    );
const guardedUpdate = <T extends z.ZodRawShape>(
  shape: T,
  groups: string[][] = [],
) =>
  z
    .strictObject(shape)
    .partial()
    .extend({ id, expected: z.strictObject(shape).partial().optional() })
    .superRefine((value, ctx) => {
      const record = value as Record<string, unknown>;
      const changed = Object.keys(record).filter(
        (key) =>
          !['id', 'expected', 'expectedMaterial'].includes(key) &&
          record[key] !== undefined,
      );
      if (!changed.length)
        ctx.addIssue({ code: 'custom', message: '请至少修改一个字段' });
      if (!record.expected) return;
      const expected = record.expected as Record<string, unknown>;
      const required = new Set(changed);
      for (const group of groups)
        if (group.some((key) => required.has(key)))
          for (const key of group) required.add(key);
      for (const key of required)
        if (expected[key] === undefined)
          ctx.addIssue({
            code: 'custom',
            path: ['expected', key],
            message: '缺少编辑前的字段值，请刷新后重新编辑',
          });
    });
const command = <A extends string, S extends z.ZodType>(
  action: A,
  payload: S,
) =>
  z.strictObject({
    action: z.literal(action),
    payload,
    requestId: z.uuid().optional(),
  });
export const actionSchema = z.discriminatedUnion('action', [
  command(
    'createOpportunity',
    z.strictObject({
      ...opportunityShape,
      direction: short.default(''),
      location: short.default(''),
      sourceName: short.default(''),
      sourceUrl: httpUrl.default(''),
      description: text.default(''),
      priority: opportunityShape.priority.default('medium'),
      stage: opportunityShape.stage.default('evaluating'),
      closedReason: opportunityShape.closedReason.default('unknown'),
      deadline: time.default(null),
      nextActionAt: time.default(null),
      reminderDays: deadlineDaysSchema.default([7, 3, 1, 0]),
      tags: strings.default([]),
      notes: text.default(''),
      specialNotes: text.default(''),
      review: text.default(''),
      decision: opportunityShape.decision.default('undecided'),
      fitScore: opportunityShape.fitScore.default(0),
      interestScore: opportunityShape.interestScore.default(0),
      nextAction: short.default(''),
      highlights: strings.default([]),
      risks: strings.default([]),
      tasks: z
        .array(
          z.strictObject({
            ...taskShape,
            dueAt: time.default(null),
            estimatedMinutes: minutes.default(30),
            source: source.default('manual'),
          }),
        )
        .max(100)
        .default([]),
      requirements: z.array(z.strictObject({ name })).max(100).default([]),
      draftId: id.optional(),
      // The capture dialog submits verified extraction metadata; the draft is
      // already stored separately. These fields never become opportunity columns.
      evidence: z.record(z.string(), z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
  command(
    'updateOpportunity',
    update(opportunityShape)
      .safeExtend({
        expected: z.strictObject(opportunityShape).partial().optional(),
      })
      .superRefine((value, ctx) => {
        // Legacy internal clients may omit expected. When supplied, a partial
        // guard must never silently omit a changed or semantically coupled field.
        const changed = Object.keys(value).filter(
          (key) =>
            key !== 'id' &&
            key !== 'expected' &&
            value[key as keyof typeof value] !== undefined,
        );
        if (!changed.length)
          ctx.addIssue({ code: 'custom', message: '请至少修改一个字段' });
        if (!value.expected) return;
        const required = new Set(changed);
        for (const group of coupledOpportunityFields)
          if (group.some((key) => required.has(key)))
            for (const key of group) required.add(key);
        for (const key of required)
          if (
            !(key in value.expected) ||
            value.expected[key as keyof typeof value.expected] === undefined
          )
            ctx.addIssue({
              code: 'custom',
              path: ['expected', key],
              message: '缺少编辑前的字段值，请刷新后重新编辑',
            });
      }),
  ),
  command('deleteOpportunity', deletion),
  command(
    'addStageHistory',
    z.strictObject({
      opportunityId: id,
      stage: opportunityShape.stage,
      occurredAt: time.default(null),
      notes: text.default(''),
    }),
  ),
  command(
    'invalidateStageHistory',
    z.strictObject({ id, notes: text.trim().min(1) }),
  ),
  command(
    'createTask',
    z.strictObject({
      ...taskShape,
      dueAt: time.default(null),
      opportunityId: id.nullable().optional(),
      estimatedMinutes: minutes.default(30),
      source: source.default('manual'),
    }),
  ),
  command(
    'updateTask',
    guardedUpdate(
      {
        title: taskShape.title,
        dueAt: time,
        estimatedMinutes: minutes,
        status: z.enum(['todo', 'doing', 'done', 'skipped']),
      },
      recordGroups.task,
    ),
  ),
  command(
    'setNextTask',
    z
      .strictObject({
        opportunityId: id,
        taskId: id.nullable(),
        expectedTaskId: id.nullable().optional(),
        expectedTask: z
          .strictObject({
            title: taskShape.title,
            dueAt: time,
            status: z.enum(['todo', 'doing', 'done', 'skipped']),
          })
          .optional(),
      })
      .refine(
        (value) =>
          value.expectedTaskId === undefined ||
          !value.taskId ||
          Boolean(value.expectedTask),
        '选择下一步时须提供任务原值',
      ),
  ),
  command(
    'createMilestone',
    z.strictObject({
      ...milestoneShape,
      scheduledAt: time.default(null),
      opportunityId: id,
      result: text.default(''),
      reminderOffsets: milestoneMinutesSchema.default([10080, 4320, 1440, 0]),
    }),
  ),
  command(
    'updateMilestone',
    guardedUpdate(
      {
        ...milestoneShape,
        status: z.enum(['pending', 'done', 'skipped']),
      },
      recordGroups.milestone,
    ),
  ),
  command(
    'createMaterial',
    z.strictObject({
      ...materialShape,
      filePath: short.default(''),
      version: short.default(''),
      category: name.default('其他'),
      notes: text.default(''),
    }),
  ),
  command(
    'updateMaterial',
    guardedUpdate(materialShape, recordGroups.material),
  ),
  command('deleteMaterial', deletion),
  command(
    'createRequirement',
    z.strictObject({
      opportunityId: id,
      name,
      notes: text.default(''),
      materialId: id.nullable().default(null),
    }),
  ),
  command('deleteRequirement', deletion),
  command(
    'updateRequirement',
    guardedUpdate(
      {
        name,
        materialId: id.nullable(),
        completed: z.boolean(),
        notes: text,
      },
      recordGroups.requirement,
    )
      .safeExtend({
        expectedMaterial: z
          .strictObject({ id, filePath: short, version: short })
          .optional(),
      })
      .superRefine((value, ctx) => {
        if (
          value.expected &&
          value.completed === true &&
          value.expected.materialId &&
          value.expectedMaterial?.id !== value.expected.materialId
        )
          ctx.addIssue({
            code: 'custom',
            path: ['expectedMaterial'],
            message: '标记就绪时须核对关联材料版本',
          });
      }),
  ),
  command(
    'addActivity',
    z.strictObject({
      opportunityId: id,
      content: text.trim().min(1),
      type: name.default('note'),
    }),
  ),
  command('discardDraft', z.strictObject({ id })),
  command(
    'saveSettings',
    z
      .strictObject({
        baseUrl: httpUrl.optional(),
        model: short.optional(),
        apiKey: z.string().max(8192).optional(),
        staleDays: z.number().int().min(1).max(30).optional(),
        expected: z
          .strictObject({
            baseUrl: httpUrl,
            model: short,
            staleDays: z.number().int().min(1).max(30),
            keyRevision: z.string().max(200),
          })
          .partial()
          .optional(),
      })
      .superRefine((value, ctx) => {
        if (!value.expected) return;
        const changed = (['baseUrl', 'model', 'staleDays'] as const).filter(
          (key) => value[key] !== undefined,
        );
        if (!changed.length && !value.apiKey)
          ctx.addIssue({ code: 'custom', message: '请至少修改一个设置' });
        const required = new Set<string>(changed);
        if (
          value.baseUrl !== undefined ||
          value.model !== undefined ||
          value.apiKey
        )
          for (const key of ['baseUrl', 'model', 'keyRevision'])
            required.add(key);
        for (const key of required)
          if (value.expected[key as keyof typeof value.expected] === undefined)
            ctx.addIssue({
              code: 'custom',
              path: ['expected', key],
              message: '缺少编辑前的设置值',
            });
      })
      .transform((value) =>
        value.expected
          ? value
          : {
              ...value,
              baseUrl: value.baseUrl ?? '',
              model: value.model ?? '',
              staleDays: value.staleDays ?? 5,
            },
      ),
  ),
]);
export type ActionCommand = z.output<typeof actionSchema>;

export function describeActionValidation(error: z.ZodError) {
  const issue = error.issues[0];
  const label: Record<string, string> = {
    organization: '公司/组织',
    role: '岗位',
    title: '名称',
    name: '名称',
    stage: '招聘阶段',
    deadline: '截止时间',
    dueAt: '任务时间',
    scheduledAt: '节点时间',
    nextActionAt: '下一步时间',
    estimatedMinutes: '预计耗时',
    staleDays: '停滞复查天数',
    fitScore: '匹配度',
    interestScore: '兴趣度',
    status: '状态',
    id: '记录标识',
    requestId: '请求标识',
  };
  const field = String(issue.path.at(-1) || '输入');
  return `${label[field] || field}不合法：请检查必填内容、允许的取值及日期格式。时间需包含时区，名称不能为空。`;
}
