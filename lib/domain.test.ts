import { describe, expect, it } from 'vitest';
import {
  actionBucket,
  compareActions,
  compareTasks,
  deadlineBucket,
  isOpportunityActive,
  isStale,
} from '@/lib/domain';

const now = new Date('2026-08-30T12:00:00+08:00');

describe('今日清单排序', () => {
  it('逾期任务优先于未来任务', () => {
    expect(
      compareTasks(
        {
          dueAt: new Date('2026-08-30T10:00:00+08:00'),
          status: 'todo',
          createdAt: now,
          opportunity: null,
        },
        {
          dueAt: new Date('2026-09-02T10:00:00+08:00'),
          status: 'todo',
          createdAt: now,
          opportunity: null,
        },
        now,
      ),
    ).toBeLessThan(0);
  });

  it('同一时间桶内高优先机会排在低优先之前', () => {
    expect(
      compareTasks(
        {
          dueAt: new Date('2026-09-01T10:00:00+08:00'),
          status: 'todo',
          createdAt: now,
          opportunity: { priority: 'high', lastActivityAt: now },
        },
        {
          dueAt: new Date('2026-09-01T09:00:00+08:00'),
          status: 'todo',
          createdAt: now,
          opportunity: { priority: 'low', lastActivityAt: now },
        },
        now,
      ),
    ).toBeLessThan(0);
  });

  it('完成任务沉到末尾', () => {
    expect(
      compareTasks(
        { dueAt: new Date('2026-08-29'), status: 'done', createdAt: now },
        { dueAt: null, status: 'todo', createdAt: now },
        now,
      ),
    ).toBeGreaterThan(0);
  });
});

describe('逐字段比较而非混合数值分数', () => {
  const action = (
    id: string,
    hours: number | null,
    priority = 'medium',
    activityDays = 0,
  ) => ({
    id,
    dueAt: hours === null ? null : new Date(now.getTime() + hours * 3600_000),
    priority,
    lastActivityAt: new Date(now.getTime() - activityDays * 86400_000),
  });
  it('复现原漏洞：1 小时后到期始终在 2 天后且停滞 12 天的事项之前', () => {
    expect(
      compareActions(action('near', 1), action('stale', 48, 'medium', 12), now),
    ).toBeLessThan(0);
  });
  it('逾期事项保留准确截止顺序，不抹平成零', () => {
    expect(
      compareActions(
        action('old', -48),
        action('recent', -1, 'medium', 12),
        now,
      ),
    ).toBeLessThan(0);
  });
  it('分组优先于优先级，优先级只在同组内起作用', () => {
    expect(
      compareActions(
        action('overdue', -1, 'low'),
        action('near', 1, 'high'),
        now,
      ),
    ).toBeLessThan(0);
    expect(
      compareActions(
        action('week', 100, 'low'),
        action('later', 200, 'high'),
        now,
      ),
    ).toBeLessThan(0);
  });
  it('仅同组同优先级同截止时，最后活动更早的优先', () => {
    expect(
      compareActions(action('recent', 2), action('stale', 2, 'medium', 5), now),
    ).toBeGreaterThan(0);
  });
  it('未定日期排在同优先级已定日期之后；无日期间仍可比较停滞', () => {
    expect(
      compareActions(action('none', null), action('dated', 240), now),
    ).toBeGreaterThan(0);
    expect(
      compareActions(
        action('recent', null),
        action('stale', null, 'medium', 5),
        now,
      ),
    ).toBeGreaterThan(0);
  });
  it('完全相同时用 ID 稳定排序，避免刷新跳动', () => {
    expect(compareActions(action('a', 1), action('b', 1), now)).toBeLessThan(0);
    expect(compareActions(action('a', 1), action('a', 1), now)).toBe(0);
  });
  it.each([
    [-1, 0],
    [0, 1],
    [72, 1],
    [72.001, 2],
    [168, 2],
    [168.001, 3],
    [null, 3],
  ])('时间边界 %s 小时属于组 %s', (hours, bucket) => {
    expect(actionBucket(action('a', hours).dueAt, now)).toBe(bucket);
  });
  it('空日期和坏日期不会产生 NaN 比较结果', () => {
    expect(
      compareActions(
        { ...action('a', null), dueAt: 'invalid' },
        action('b', null),
        now,
      ),
    ).toBeLessThan(0);
  });
  it('比较器满足反对称与传递性', () => {
    const entries = [-48, -1, 1, 48, 100, 200, null].flatMap((hours) =>
      ['high', 'medium', 'low'].map((priority) =>
        action(`${hours}-${priority}`, hours, priority),
      ),
    );
    const sorted = [...entries].sort((a, b) => compareActions(a, b, now));
    for (const a of sorted)
      for (const b of sorted) {
        expect(
          Math.sign(compareActions(a, b, now)) +
            Math.sign(compareActions(b, a, now)),
        ).toBe(0);
      }
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++)
        expect(compareActions(sorted[i], sorted[j], now)).toBeLessThan(0);
  });
});

describe('停滞与截止规则', () => {
  it('五天未推进的非终态机会标记停滞', () =>
    expect(isStale(new Date('2026-08-25T11:59:00+08:00'), 'applied', now)).toBe(
      true,
    ));
  it('Offer 不会标记停滞', () =>
    expect(isStale(new Date('2026-07-01'), 'offer', now)).toBe(false));
  it('已决定放弃的机会不会进入活跃或停滞队列', () => {
    expect(isOpportunityActive('evaluating', 'skip')).toBe(false);
    expect(isStale(new Date('2026-07-01'), 'evaluating', now, 5, 'skip')).toBe(
      false,
    );
  });
  it('正确区分逾期、72 小时和 7 天', () => {
    expect(deadlineBucket(new Date('2026-08-30T11:00:00+08:00'), now)).toBe(
      'overdue',
    );
    expect(deadlineBucket(new Date('2026-09-01T12:00:00+08:00'), now)).toBe(
      '72h',
    );
    expect(deadlineBucket(new Date('2026-09-05T12:00:00+08:00'), now)).toBe(
      '7d',
    );
  });
});
