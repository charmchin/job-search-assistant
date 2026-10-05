import { STAGES } from './domain';
import type { Opportunity } from './client-types';

type RecordOwner = Pick<
  Opportunity,
  'id' | 'stage' | 'decision' | 'closedReason' | 'stageHistory'
>;
export const isWithdrawn = (owner: RecordOwner) =>
  owner.decision === 'skip' ||
  (owner.stage === 'closed' && owner.closedReason === 'withdrawn');
export const stageLabel = (stage: string) =>
  STAGES.find((item) => item.id === stage)?.label ?? stage;

export function highestRecordedStage(owner: Pick<RecordOwner, 'stageHistory'>) {
  const stages = new Set(
    owner.stageHistory?.filter((row) => row.valid).map((row) => row.toStage),
  );
  return (
    [...STAGES]
      .reverse()
      .find((stage) => stage.id !== 'closed' && stages.has(stage.id))?.id ??
    null
  );
}

export function buildRecruitmentAnalytics(
  opportunities: RecordOwner[],
  includeWithdrawn = false,
) {
  const included = opportunities.filter(
    (owner) => includeWithdrawn || !isWithdrawn(owner),
  );
  const ids = new Set(included.map((owner) => owner.id));
  const reached = (stage: string) =>
    new Set(
      included
        .filter((owner) =>
          owner.stageHistory?.some((row) => row.valid && row.toStage === stage),
        )
        .map((owner) => owner.id),
    );
  const applied = reached('applied');
  const assessment = reached('assessment');
  const interview = reached('interview');
  const offer = reached('offer');
  const conversion = (target: Set<string>, base: Set<string>) => {
    const numerator = [...target].filter((id) => base.has(id)).length;
    return {
      numerator,
      denominator: base.size,
      percent: base.size ? Math.round((numerator / base.size) * 100) : null,
    };
  };
  return {
    total: ids.size,
    excluded: opportunities.length - included.length,
    rejected: included.filter(
      (owner) => owner.stage === 'closed' && owner.closedReason === 'rejected',
    ).length,
    withdrawn: included.filter(isWithdrawn).length,
    unknownClosed: included.filter(
      (owner) =>
        owner.stage === 'closed' &&
        owner.closedReason !== 'rejected' &&
        !isWithdrawn(owner),
    ).length,
    partialHistory: included.filter(
      (owner) =>
        !owner.stageHistory?.length ||
        owner.stageHistory.some(
          (row) =>
            row.source === 'legacy' ||
            (row.source === 'initial' && row.toStage !== 'evaluating'),
        ),
    ).length,
    rows: [
      {
        id: 'collection',
        label: '进入机会库',
        count: ids.size,
        conversion: null,
        conversionLabel: '',
      },
      {
        id: 'applied',
        label: '完成投递',
        count: applied.size,
        conversion: conversion(applied, ids),
        conversionLabel: '库内机会投递率',
      },
      {
        id: 'assessment',
        label: '测评 / 笔试',
        count: assessment.size,
        conversion: conversion(assessment, applied),
        conversionLabel: '已投递中的测评率',
      },
      {
        id: 'interview',
        label: '进入面试',
        count: interview.size,
        conversion: conversion(interview, applied),
        conversionLabel: '已投递中的面试率',
      },
      {
        id: 'offer',
        label: '获得 Offer',
        count: offer.size,
        conversion: conversion(offer, interview),
        conversionLabel: '已面试中的 Offer 率',
      },
    ],
  };
}
