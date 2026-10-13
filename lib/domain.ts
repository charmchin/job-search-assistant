export const STAGES = [
  { id: 'evaluating', label: '待评估', color: '#747168' },
  { id: 'preparing', label: '准备中', color: '#a56c17' },
  { id: 'applied', label: '已投递', color: '#2f6690' },
  { id: 'assessment', label: '测评/笔试', color: '#7356a4' },
  { id: 'interview', label: '面试', color: '#9b4c61' },
  { id: 'waiting', label: '结果待定', color: '#806a36' },
  { id: 'offer', label: 'Offer', color: '#2e755d' },
  { id: 'closed', label: '未通过/放弃', color: '#89847b' },
] as const;

export const ACTIVE_STAGES = STAGES.filter(
  (stage) => !['offer', 'closed'].includes(stage.id),
);
export const DEFAULT_REMINDER_OFFSETS = [10080, 4320, 1440, 0];
export const APPLICATION_STAGES = ['evaluating', 'preparing'] as const;

export function needsApplication(stage: string, decision?: string) {
  return (
    APPLICATION_STAGES.some((value) => value === stage) && decision !== 'skip'
  );
}

export function isOpportunityActive(stage: string, decision?: string) {
  return !['offer', 'closed'].includes(stage) && decision !== 'skip';
}

type RankableTask = {
  id?: string;
  dueAt: Date | null;
  status: string;
  createdAt: Date;
  opportunity?: { priority: string; lastActivityAt: Date } | null;
};

type ActionOrder = {
  id: string;
  dueAt: Date | string | null;
  priority: string;
  lastActivityAt: Date | string | null;
};
export function dateTimestamp(value: Date | string | null | undefined) {
  const timestamp =
    value instanceof Date ? value.getTime() : value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : Infinity;
}
export function actionBucket(value: Date | string | null, now: Date) {
  const delta = dateTimestamp(value) - now.getTime();
  return delta < 0
    ? 0
    : delta <= 72 * 3600_000
      ? 1
      : delta <= 7 * 86400_000
        ? 2
        : 3;
}
export function compareActions(
  a: ActionOrder,
  b: ActionOrder,
  now = new Date(),
) {
  const priority = (value: string) =>
    value === 'high' ? 0 : value === 'low' ? 2 : 1;
  const compare = (left: number, right: number) =>
    left === right ? 0 : left < right ? -1 : 1;
  return (
    actionBucket(a.dueAt, now) - actionBucket(b.dueAt, now) ||
    priority(a.priority) - priority(b.priority) ||
    compare(dateTimestamp(a.dueAt), dateTimestamp(b.dueAt)) ||
    compare(dateTimestamp(a.lastActivityAt), dateTimestamp(b.lastActivityAt)) ||
    a.id.localeCompare(b.id)
  );
}
export function compareTasks(
  a: RankableTask,
  b: RankableTask,
  now = new Date(),
) {
  const completed = (task: RankableTask) =>
    ['done', 'skipped'].includes(task.status) ? 1 : 0;
  const order = (task: RankableTask): ActionOrder => ({
    id: task.id || '',
    dueAt: task.dueAt,
    priority: task.opportunity?.priority || 'medium',
    lastActivityAt: task.opportunity?.lastActivityAt || task.createdAt,
  });
  return completed(a) - completed(b) || compareActions(order(a), order(b), now);
}

export function isStale(
  lastActivityAt: Date,
  stage: string,
  now = new Date(),
  days = 5,
  decision?: string,
) {
  return (
    isOpportunityActive(stage, decision) &&
    now.getTime() - lastActivityAt.getTime() >= days * 86400_000
  );
}

export function deadlineBucket(date: Date | null, now = new Date()) {
  if (!date) return 'none';
  const delta = date.getTime() - now.getTime();
  if (delta < 0) return 'overdue';
  if (delta <= 72 * 3600_000) return '72h';
  if (delta <= 7 * 86400_000) return '7d';
  return 'later';
}

export function formatDateTime(
  value: Date | string | number | null | undefined,
) {
  if (!value) return '未设置';
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(date);
}
