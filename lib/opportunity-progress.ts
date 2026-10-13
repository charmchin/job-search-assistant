import type { Opportunity } from './client-types';
import { needsApplication } from './domain';

export function canMarkApplied(item: Pick<Opportunity, 'stage' | 'decision'>) {
  return needsApplication(item.stage, item.decision);
}

// These are suggestions for explicit review, never automatic task completion.
export function applicationTasks(item: Opportunity) {
  return item.tasks.filter(
    (task) =>
      ['todo', 'doing'].includes(task.status) &&
      /投递|网申|提交.{0,8}申请|发送.{0,8}简历/.test(task.title) &&
      !/跟进|反馈|回访|查询|结果|撤回|取消|补交|补充|追加|投递后|网申后|申请后/.test(
        task.title,
      ),
  );
}

export function progressPayload(
  item: Opportunity,
  content: string,
  stage?: string,
) {
  return {
    opportunityId: item.id,
    type: 'note',
    content,
    ...(stage
      ? {
          stage,
          expectedStatus: {
            stage: item.stage,
            decision: item.decision,
            closedReason: item.closedReason ?? 'unknown',
          },
        }
      : {}),
  };
}

export function currentStageAt(item: Opportunity) {
  const current = item.stageHistory?.find(
    (row) => row.valid && row.toStage === item.stage && row.source !== 'manual',
  );
  if (current?.occurredAt) return current.occurredAt;
  // A known transition retains its own date. Only an undated snapshot can be
  // supplemented by explicitly recorded history of that same stage.
  return (
    item.stageHistory
      ?.filter(
        (row) =>
          row.valid &&
          row.toStage === item.stage &&
          row.source === 'manual' &&
          row.occurredAt,
      )
      .sort((a, b) => Date.parse(b.occurredAt!) - Date.parse(a.occurredAt!))[0]
      ?.occurredAt ?? null
  );
}
