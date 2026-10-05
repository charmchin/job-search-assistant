import { describe, expect, it } from 'vitest';
import type {
  Milestone,
  Opportunity,
  Task,
  WorkspaceState,
} from '@/lib/client-types';
import { buildTodayPlan } from '@/lib/today';

const now = new Date('2027-01-15T10:00:00+08:00');
const date = (hours: number) =>
  new Date(now.getTime() + hours * 3600_000).toISOString();
function opp(id: string, patch: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    organization: id,
    role: '研发岗',
    direction: '',
    location: '',
    sourceName: '',
    sourceUrl: '',
    description: '',
    priority: 'medium',
    stage: 'preparing',
    deadline: null,
    reminderDays: [7, 3, 1, 0],
    tags: [],
    notes: '',
    specialNotes: '',
    review: '',
    decision: 'pursue',
    fitScore: 0,
    interestScore: 0,
    nextAction: '',
    nextActionAt: null,
    highlights: [],
    risks: [],
    createdAt: date(-240),
    updatedAt: date(0),
    lastActivityAt: date(0),
    stale: false,
    tasks: [],
    milestones: [],
    requirements: [],
    activities: [],
    ...patch,
  };
}
function task(
  id: string,
  opportunityId: string | null,
  hours: number | null,
  status = 'todo',
): Task {
  return {
    id,
    title: id,
    opportunityId,
    dueAt: hours === null ? null : date(hours),
    status,
    source: 'manual',
    estimatedMinutes: 30,
    createdAt: date(-24),
  };
}
function node(
  id: string,
  opportunityId: string,
  hours: number | null,
  status = 'pending',
): Milestone {
  return {
    id,
    title: id,
    opportunityId,
    scheduledAt: hours === null ? null : date(hours),
    status,
    result: '',
    reminderOffsets: [0],
  };
}
function state(patch: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    now: now.toISOString(),
    opportunities: [],
    tasks: [],
    milestones: [],
    materials: [],
    requirements: [],
    drafts: [],
    settings: {},
    ...patch,
  };
}
const plan = (patch: Partial<WorkspaceState>) =>
  buildTodayPlan(state(patch), now);

describe('四类今日事项与焦点', () => {
  it('统一截止/节点/下一步/任务，不依赖服务端任务数组的原有顺序', () => {
    const result = plan({
      opportunities: [
        opp('a', {
          deadline: date(4),
          nextAction: '沟通 HR',
          nextActionAt: date(2),
        }),
      ],
      tasks: [
        task('later', 'a', 20),
        task('early', 'a', 1),
        { ...task('next-a', 'a', 2), title: '沟通 HR', isNextAction: true },
      ],
      milestones: [node('面试', 'a', 3)],
    });
    expect(result.actions.map((item) => item.id)).toEqual([
      'task:early',
      'nextAction:next-a',
      'milestone:面试',
      'deadline:a',
      'task:later',
    ]);
    expect(result.focus?.id).toBe('task:early');
    expect(result.urgentCount).toBe(5);
  });
  it('没有任务时临期岗位胜过更新时间更近的待判断岗位', () => {
    const result = plan({
      opportunities: [
        opp('new', { decision: 'undecided' }),
        opp('near', { deadline: date(1) }),
      ],
    });
    expect(result.focus?.id).toBe('deadline:near');
    expect(result.focus?.reason).toContain('72 小时');
  });
  it('无任务的笔试/面试仍能成为焦点', () => {
    expect(
      plan({ opportunities: [opp('a')], milestones: [node('笔试', 'a', 1)] })
        .focus?.kind,
    ).toBe('milestone');
  });
  it('下一步时间进入排序，没内容的孤立时间不产生事项', () => {
    expect(
      plan({
        opportunities: [
          opp('a', { nextAction: '确认内推', nextActionAt: date(-1) }),
        ],
        tasks: [
          { ...task('next-a', 'a', -1), title: '确认内推', isNextAction: true },
        ],
      }).focus?.reason,
    ).toContain('已逾期');
    expect(
      plan({
        opportunities: [opp('a', { nextAction: '  ', nextActionAt: date(-1) })],
      }).actions,
    ).toEqual([]);
  });
  it('Offer 保留签约节点和待办任务；旧镜像不会构造独立事项', () => {
    const result = plan({
      opportunities: [
        opp('offer', {
          stage: 'offer',
          deadline: date(-10),
          nextAction: '旧行动',
          nextActionAt: date(-5),
        }),
      ],
      tasks: [task('签约材料', 'offer', 2)],
      milestones: [node('体检', 'offer', 1)],
    });
    expect(result.actions.map((item) => item.id)).toEqual([
      'milestone:体检',
      'task:签约材料',
    ]);
    expect(result.undecided).toEqual([]);
    expect(result.stale).toEqual([]);
  });
  it('closed/skip 关联事项和孤儿外键不进入清单/雷达/收件箱', () => {
    const result = plan({
      opportunities: [
        opp('closed', {
          stage: 'closed',
          decision: 'undecided',
          deadline: date(-1),
        }),
        opp('skip', { decision: 'skip', deadline: date(-2) }),
      ],
      tasks: [
        task('c', 'closed', -1),
        task('s', 'skip', -1),
        task('orphan', 'missing', -1),
      ],
      milestones: [node('c', 'closed', -1), node('s', 'skip', -1)],
    });
    expect(result.actions).toEqual([]);
    expect(result.risks).toEqual([]);
    expect(result.undecided).toEqual([]);
    expect(result.fallback).toBeNull();
  });
  it('只用当前机会映射，不能被任务内旧机会快照误导', () => {
    const t = { ...task('a', 'closed', -1), opportunity: opp('closed') };
    expect(
      plan({ opportunities: [opp('closed', { stage: 'closed' })], tasks: [t] })
        .actions,
    ).toEqual([]);
  });
  it('已完成/跳过任务和节点不参与焦点；完成后下一项自动接替', () => {
    const patch = {
      opportunities: [opp('a')],
      tasks: [
        task('done', 'a', -10, 'done'),
        task('skip', 'a', -8, 'skipped'),
        task('next', 'a', 2),
      ],
      milestones: [
        node('done', 'a', -9, 'done'),
        node('skip', 'a', -7, 'skipped'),
        node('first', 'a', 1),
      ],
    };
    expect(plan(patch).focus?.id).toBe('milestone:first');
    patch.milestones[2].status = 'done';
    expect(plan(patch).focus?.id).toBe('task:next');
  });
  it('独立任务有自己的焦点，不关联无关岗位，空机会库也可使用', () => {
    const result = plan({ tasks: [task('独立', null, 1)] });
    expect(result.focus?.opportunity).toBeNull();
    expect(result.focus?.title).toBe('独立');
    expect(
      plan({
        opportunities: [opp('a', { decision: 'undecided' })],
        tasks: [task('独立', null, 1)],
      }).focus?.opportunity,
    ).toBeNull();
  });
  it('无日期事项保留，坏日期安全降为未定时间', () => {
    const result = plan({
      opportunities: [
        opp('a', { deadline: 'invalid', nextAction: '准备作品集' }),
      ],
      milestones: [node('待安排', 'a', null)],
      tasks: [
        { ...task('坏日期', 'a', 1), dueAt: 'invalid' },
        {
          ...task('next-a', 'a', null),
          title: '准备作品集',
          isNextAction: true,
        },
      ],
    });
    expect(result.actions).toHaveLength(3);
    expect(result.actions.every((item) => item.dueAt === null)).toBe(true);
  });
  it('无时间事项时才选择待判断或进度复查；终态不作为兜底', () => {
    expect(
      plan({ opportunities: [opp('a', { decision: 'undecided' })] })
        .fallbackTitle,
    ).toContain('判断');
    expect(plan({ opportunities: [opp('a')] }).fallbackTitle).toContain('复查');
    expect(
      plan({ opportunities: [opp('a', { stage: 'offer' })] }).fallbackTitle,
    ).toContain('没有');
  });
});
describe('雷达、停滞与统计口径', () => {
  it('雷达按最紧急事项排序，每个机会一次，7 天风险与无时间停滞都可见', () => {
    const result = plan({
      opportunities: [
        opp('stale', { lastActivityAt: date(-240) }),
        opp('later', { deadline: date(100) }),
        opp('near', {
          deadline: date(10),
          nextAction: '确认材料',
          nextActionAt: date(2),
        }),
        opp('offer', { stage: 'offer' }),
      ],
      milestones: [node('体检', 'offer', 1)],
      tasks: [
        {
          ...task('next-near', 'near', 2),
          title: '确认材料',
          isNextAction: true,
        },
      ],
    });
    expect(result.risks.map((item) => item.opportunity.id)).toEqual([
      'offer',
      'near',
      'later',
      'stale',
    ]);
    expect(result.risks[1].reason).toContain('确认材料');
    expect(result.risks[3].reason).toContain('5 天');
  });
  it('5 天与自定义停滞阈值使用固定当前时间，忽略旧 stale 布尔', () => {
    const data = state({
      opportunities: [opp('a', { lastActivityAt: date(-120), stale: false })],
    });
    expect(
      buildTodayPlan(data, new Date(now.getTime() - 1)).stale,
    ).toHaveLength(0);
    expect(buildTodayPlan(data, now).stale).toHaveLength(1);
    expect(
      plan({ opportunities: data.opportunities, settings: { staleDays: '6' } })
        .stale,
    ).toHaveLength(0);
    expect(
      plan({
        opportunities: data.opportunities,
        settings: { staleDays: 'invalid' },
      }).stale,
    ).toHaveLength(1);
  });
  it('收件箱完整计数并按截止排序，Offer 待判断也被排除', () => {
    const result = plan({
      opportunities: [
        opp('new', { decision: 'undecided' }),
        opp('near', { decision: 'undecided', deadline: date(1) }),
        opp('offer', { decision: 'undecided', stage: 'offer' }),
      ],
    });
    expect(result.undecided.map((item) => item.id)).toEqual(['near', 'new']);
  });
  it('材料就绪率排除放弃岗位要求，仍保留 Offer 签约材料', () => {
    const result = plan({
      opportunities: [
        opp('a'),
        opp('b', { stage: 'closed' }),
        opp('c', { stage: 'offer' }),
      ],
      requirements: ['a', 'b', 'c'].map((id) => ({
        id,
        opportunityId: id,
        name: id,
        materialId: null,
        completed: id === 'a',
        notes: '',
      })),
    });
    expect(result.readiness).toBe(50);
  });
  it('不修改输入数组，无事项的空状态稳定', () => {
    const data = state({
      opportunities: [opp('z'), opp('a', { deadline: date(1) })],
      tasks: [task('later', 'z', 48), task('near', 'z', 1)],
    });
    const copy = JSON.stringify(data);
    buildTodayPlan(data, now);
    expect(JSON.stringify(data)).toBe(copy);
    expect(plan({}).readiness).toBe(0);
    expect(plan({}).focus).toBeNull();
  });
});
