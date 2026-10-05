import { createHash } from 'node:crypto';
// Internal edit tokens, not authentication. Dates and row order are normalized.
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function deleteVersion(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
const sorted = <T extends { id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));
export function opportunityDeleteVersion(
  row: unknown,
  tasks: { id: string }[],
  milestones: { id: string }[],
  requirements: { id: string }[],
  history: { id: string }[],
  activityCount: number,
) {
  return deleteVersion({
    row,
    tasks: sorted(tasks),
    milestones: sorted(milestones),
    requirements: sorted(requirements),
    history: sorted(history),
    activityCount,
  });
}
export function materialDeleteVersion(
  row: unknown,
  requirements: { id: string }[],
) {
  return deleteVersion({ row, requirements: sorted(requirements) });
}
