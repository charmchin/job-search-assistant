import type { Opportunity, WorkspaceState } from '@/lib/client-types';
import {
  actionBucket,
  compareActions,
  dateTimestamp,
  isOpportunityActive,
  isStale,
} from '@/lib/domain';

export type TodayAction = {
  id: string;
  kind: 'task' | 'milestone' | 'deadline' | 'nextAction';
  entityId: string;
  title: string;
  dueAt: string | null;
  priority: string;
  lastActivityAt: string | null;
  opportunity: Opportunity | null;
  reason: string;
  bucket: number;
};
export const ACTION_LABELS = {
  task: '行动任务',
  milestone: '招聘节点',
  deadline: '投递截止',
  nextAction: '下一步',
};
export type TodayRisk = { opportunity: Opportunity; reason: string };

export function buildTodayPlan(data: WorkspaceState, now = new Date(data.now)) {
  const opportunities = new Map(
    data.opportunities.map((item) => [item.id, item]),
  );
  const allowed = (item: Opportunity) =>
    item.stage !== 'closed' && item.decision !== 'skip';
  const active = data.opportunities.filter((item) =>
    isOpportunityActive(item.stage, item.decision),
  );
  const configuredDays = Number(data.settings.staleDays || 5);
  const staleDays =
    Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 5;
  const opportunityOrder = (a: Opportunity, b: Opportunity) =>
    compareActions(
      { ...a, dueAt: a.deadline },
      { ...b, dueAt: b.deadline },
      now,
    );
  const undecided = active
    .filter((item) => item.decision === 'undecided')
    .sort(opportunityOrder);
  const stale = active
    .filter((item) =>
      isStale(
        new Date(item.lastActivityAt),
        item.stage,
        now,
        staleDays,
        item.decision,
      ),
    )
    .sort((a, b) =>
      compareActions({ ...a, dueAt: null }, { ...b, dueAt: null }, now),
    );
  const actions: TodayAction[] = [];
  function add(
    kind: TodayAction['kind'],
    entityId: string,
    title: string,
    dueAt: string | null,
    opportunity: Opportunity | null,
    createdAt?: string,
  ) {
    // A malformed date must not crash the homepage or become a fake deadline.
    const date = dueAt && Number.isFinite(dateTimestamp(dueAt)) ? dueAt : null;
    const bucket = actionBucket(date, now);
    const urgency =
      bucket === 0
        ? '已逾期，请核对并处理'
        : bucket === 1
          ? '72 小时内到期，优先安排'
          : bucket === 2
            ? '7 天内到期，提前准备'
            : date
              ? '已安排时间，按计划推进'
              : '未设置时间，建议安排下一步';
    const priority = opportunity?.priority || 'medium';
    actions.push({
      id: `${kind}:${entityId}`,
      kind,
      entityId,
      title,
      dueAt: date,
      priority,
      opportunity,
      lastActivityAt: opportunity?.lastActivityAt || createdAt || null,
      reason: `${ACTION_LABELS[kind]} · ${urgency}${priority === 'high' ? ' · 重点机会' : ''}`,
      bucket,
    });
  }
  for (const task of data.tasks) {
    const opportunity = task.opportunityId
      ? opportunities.get(task.opportunityId)
      : null;
    if (
      !['todo', 'doing'].includes(task.status) ||
      (task.opportunityId && (!opportunity || !allowed(opportunity)))
    )
      continue;
    add(
      task.isNextAction ? 'nextAction' : 'task',
      task.id,
      task.title,
      task.dueAt,
      opportunity || null,
      task.createdAt,
    );
  }
  for (const node of data.milestones) {
    const opportunity = opportunities.get(node.opportunityId);
    if (node.status === 'pending' && opportunity && allowed(opportunity))
      add('milestone', node.id, node.title, node.scheduledAt, opportunity);
  }
  for (const opportunity of active) {
    if (Number.isFinite(dateTimestamp(opportunity.deadline)))
      add(
        'deadline',
        opportunity.id,
        '核对投递截止与当前进度',
        opportunity.deadline,
        opportunity,
      );
  }
  actions.sort((a, b) => compareActions(a, b, now));
  const focus = actions[0] || null;
  const fallback =
    undecided[0] || stale[0] || [...active].sort(opportunityOrder)[0] || null;
  const risks = new Map<string, TodayRisk>();
  for (const action of actions) {
    if (
      action.opportunity &&
      actionBucket(action.dueAt, now) <= 2 &&
      !risks.has(action.opportunity.id)
    )
      risks.set(action.opportunity.id, {
        opportunity: action.opportunity,
        reason: `${action.title} · ${action.reason}`,
      });
  }
  for (const item of stale) {
    if (!risks.has(item.id))
      risks.set(item.id, {
        opportunity: item,
        reason: `超过 ${staleDays} 天未推进，建议复查状态`,
      });
  }
  const requirements = data.requirements.filter((item) => {
    const opportunity = opportunities.get(item.opportunityId);
    return opportunity && allowed(opportunity);
  });
  return {
    actions,
    focus,
    fallback,
    undecided,
    stale,
    risks: [...risks.values()],
    urgentCount: actions.filter((item) => actionBucket(item.dueAt, now) <= 1)
      .length,
    readiness: requirements.length
      ? Math.round(
          (requirements.filter((item) => item.completed).length /
            requirements.length) *
            100,
        )
      : 0,
    fallbackTitle: !fallback
      ? '当前没有待推进事项'
      : fallback.decision === 'undecided'
        ? '判断这个岗位是否值得投入'
        : '复查当前进度，并安排下一步',
    fallbackReason: !fallback
      ? '可以收集新机会；已有记录仍保留在机会库中。'
      : fallback.decision === 'undecided'
        ? '没有待推进的任务或时间事项，先做投入判断。'
        : '没有待推进的任务或时间事项，建议核对状态并补充行动。',
  };
}
