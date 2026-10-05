import { sameEditValue } from './opportunity-edit';
export function editableSettings(settings: Record<string, string>) {
  const days = Number(settings.staleDays || 5);
  return {
    baseUrl: settings.aiBaseUrl || '',
    model: settings.aiModel || '',
    staleDays: Number.isInteger(days) && days >= 1 && days <= 30 ? days : 5,
    keyRevision: settings.aiKeyRevision || '',
  };
}
export type EditableSettings = ReturnType<typeof editableSettings>;
export function buildSettingsUpdate(
  original: EditableSettings,
  draft: { baseUrl: string; model: string; staleDays: number; apiKey?: string },
): ({ expected: Record<string, unknown> } & Record<string, unknown>) | null {
  const changes: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const key of ['baseUrl', 'model', 'staleDays'] as const)
    if (!sameEditValue(original[key], draft[key])) {
      changes[key] = draft[key];
      expected[key] = original[key];
    }
  if (draft.apiKey) changes.apiKey = draft.apiKey;
  if (!Object.keys(changes).length) return null;
  if ('baseUrl' in changes || 'model' in changes || 'apiKey' in changes)
    for (const key of ['baseUrl', 'model', 'keyRevision'] as const)
      expected[key] = original[key];
  return { ...changes, expected };
}
