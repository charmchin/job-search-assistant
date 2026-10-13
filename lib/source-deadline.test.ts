import { describe, expect, it } from 'vitest';
import { readSourceDeadline } from './source-deadline';
const now = new Date('2026-10-10T00:00:00Z');
describe('原文报名截止时间', () => {
  it.each([
    ['报名截止：2026-12-31 23:59:59', '2026-12-31T15:59:59.000Z'],
    ['截止时间（北京时间）：2026年12月31日 18:30', '2026-12-31T10:30:00.000Z'],
    ['validThrough:2026-12-31T12:00:00Z', '2026-12-31T12:00:00.000Z'],
    ['报名时间：2026-12-01至12月31日', '2026-12-31T15:59:00.000Z'],
    ['网申：12月31日', '2026-12-31T15:59:00.000Z'],
    ['网申截止：1月10日', '2027-01-10T15:59:00.000Z'],
    ['报名日期：2026-12-20至1月10日', '2027-01-10T15:59:00.000Z'],
  ])('读取 %s', (text, deadline) =>
    expect(readSourceDeadline(text, now).deadline).toBe(deadline),
  );
  it.each([
    '发布日期：2026-12-31',
    '面试截止：2026-12-31',
    '报名截止：2026-02-30',
    '报名截止：2026-12-31 24:00',
    '长期招聘',
    '报名截止：2026-12-201',
  ])('不推测 %s', (text) =>
    expect(readSourceDeadline(text, now).deadline).toBeNull(),
  );
  it('多个冲突的截止时间需要核对', () =>
    expect(
      readSourceDeadline(
        '一批报名截止：2026-12-20\n二批报名截止：2026-12-31',
        now,
      ).deadline,
    ).toBeNull());
});
