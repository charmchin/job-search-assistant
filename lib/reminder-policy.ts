import { z } from 'zod';

export const REMINDER_TIME_ZONE = 'Asia/Shanghai';
export const DEFAULT_DEADLINE_DAYS = [7, 3, 1, 0];
export const DEFAULT_MILESTONE_MINUTES = [10080, 4320, 1440, 0];
export const scheduledTimeSchema = z
  .union([
    z.iso.datetime({ offset: true }).refine((value) => {
      const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
      return (
        Number.isFinite(day.getTime()) &&
        day.toISOString().slice(0, 10) === value.slice(0, 10)
      );
    }, '节点时间必须是真实日期'),
    z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000),
    z.date(),
    z.null(),
    z.literal(''),
  ])
  .optional();
export const deadlineDaysSchema = z
  .array(z.number().int().min(0).max(3650))
  .max(20)
  .transform((values) => [...new Set(values)].sort((a, b) => b - a));
export const milestoneMinutesSchema = z
  .array(z.number().int().min(0).max(5256000))
  .max(20)
  .transform((values) => [...new Set(values)].sort((a, b) => b - a));

// Never use the host timezone for a Shanghai job-search deadline.
export function deadlineReminderAt(deadline: number, daysBefore: number) {
  const shanghaiDay = new Date(deadline + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
  const morning =
    Date.parse(`${shanghaiDay}T09:00:00+08:00`) - daysBefore * 86400_000;
  return Math.min(morning, deadline);
}
export function toShanghaiInput(value: string | null | undefined) {
  if (!value) return '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 16)
    : '';
}
export function fromShanghaiInput(value: string) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error('请输入完整的上海时间');
  const timestamp = Date.parse(`${value}:00+08:00`);
  if (
    !Number.isFinite(timestamp) ||
    toShanghaiInput(new Date(timestamp).toISOString()) !== value
  )
    throw new Error('请输入真实日期和时间');
  return new Date(timestamp).toISOString();
}
