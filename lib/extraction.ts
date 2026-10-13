import { z } from 'zod';
import { readSourceDeadline } from './source-deadline';

// Reject calendar rollover (e.g. February 30), and ambiguous local datetimes.
const dateText = z
  .string()
  .max(40)
  .refine((value) => {
    const parts =
      /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(
        value,
      );
    if (!parts) return false;
    const [, year, month, day, hour, minute, second, zone] = parts;
    const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
    if (
      !Number.isFinite(calendar.getTime()) ||
      calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    )
      return false;
    if (!zone) return true;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second || 0) > 59)
      return false;
    if (
      zone !== 'Z' &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)
    )
      return false;
    return Number.isFinite(Date.parse(value));
  }, '必须是真实日期，时间须包含时区')
  .transform((value) =>
    new Date(
      value.length === 10 ? `${value}T23:59:00+08:00` : value,
    ).toISOString(),
  )
  .nullable();

const shortText = z.string().max(300);
const nonemptyText = shortText.trim().min(1);
export const extractionSchema = z.object({
  organization: shortText,
  role: shortText,
  direction: shortText,
  location: shortText,
  sourceName: shortText,
  sourceUrl: z.string().max(4096),
  description: z.string().max(8000),
  priority: z.enum(['high', 'medium', 'low']),
  deadline: dateText,
  tags: z.array(nonemptyText).max(20),
  specialNotes: z.string().max(4000),
  decision: z.enum(['undecided', 'pursue', 'hold', 'skip']),
  fitScore: z.number().int().min(0).max(5),
  interestScore: z.number().int().min(0).max(5),
  nextAction: shortText,
  nextActionAt: dateText,
  highlights: z.array(nonemptyText).max(4),
  risks: z.array(nonemptyText).max(4),
  requirements: z.array(z.object({ name: nonemptyText })).max(20),
  tasks: z
    .array(
      z.object({
        title: nonemptyText,
        dueAt: dateText,
        estimatedMinutes: z.number().int().min(0).max(1440),
        source: z.enum(['ai', 'rule']),
      }),
    )
    .max(4),
  evidence: z
    .record(z.string().max(80), z.string().max(600))
    .refine((value) => Object.keys(value).length <= 60),
  confidence: z.number().min(0).max(1),
});

export type Extraction = z.infer<typeof extractionSchema>;
const aiFieldsSchema = extractionSchema.partial();
const proofFields = new Set([
  'organization',
  'role',
  'direction',
  'location',
  'sourceName',
  'description',
  'priority',
  'deadline',
  'tags',
  'specialNotes',
  'highlights',
  'risks',
  'requirements',
]);
const normalizeProof = (text: string) => text.replace(/\s+/g, '');

export function validateAiExtraction(
  value: unknown,
  fallback: Extraction,
  sourceText: string,
  sourceUrl: string,
) {
  // Optional omissions use rules; explicit malformed values reject the entire AI response.
  const parsed = aiFieldsSchema.parse(value);
  if (!['organization', 'role', 'description'].some((key) => key in parsed))
    throw new Error('AI 草稿缺少岗位信息');
  const extraction = extractionSchema.parse({
    ...fallback,
    ...parsed,
    sourceUrl,
    evidence: parsed.evidence ?? {},
    confidence: parsed.confidence ?? 0,
    decision: 'undecided',
    fitScore: 0,
    interestScore: 0,
    nextActionAt: null,
  });
  extraction.tasks = extraction.tasks.map((task) => ({
    ...task,
    source: parsed.tasks ? 'ai' : 'rule',
  }));
  const source = normalizeProof(sourceText);
  let omittedProof = false;
  const evidence: Record<string, string> = {};
  for (const [key, quote] of Object.entries(extraction.evidence)) {
    const indexed =
      /^(tasks|requirements|highlights|risks)\[(\d+)\](?:\.(title|dueAt|name))?$/.exec(
        key,
      );
    const validIndex =
      indexed &&
      Number(indexed[2]) <
        extraction[
          indexed[1] as 'tasks' | 'requirements' | 'highlights' | 'risks'
        ].length &&
      (!indexed[3] ||
        (indexed[1] === 'tasks' && ['title', 'dueAt'].includes(indexed[3])) ||
        (indexed[1] === 'requirements' && indexed[3] === 'name'));
    if (
      quote.trim() &&
      (proofFields.has(key) || validIndex) &&
      source.includes(normalizeProof(quote))
    )
      evidence[key] = quote.trim();
    else if (quote.trim()) omittedProof = true;
  }
  extraction.evidence = evidence;
  const correctedFields: string[] = [];
  for (const key of ['organization', 'role', 'location'] as const) {
    if (extraction[key] && !source.includes(normalizeProof(extraction[key]))) {
      extraction[key] = source.includes(normalizeProof(fallback[key]))
        ? fallback[key]
        : '';
      delete evidence[key];
      correctedFields.push(key);
    }
  }
  // A syntactically valid date is not evidence. Use the actual application
  // deadline in the source, preserving its stated time and timezone.
  if (extraction.deadline) {
    const dates = readSourceDeadline(sourceText);
    const selected =
      dates.candidates.length === 1
        ? dates.candidates[0]
        : dates.candidates.find(
            (item) =>
              item.deadline === extraction.deadline &&
              evidence.deadline &&
              normalizeProof(evidence.deadline).includes(
                normalizeProof(item.dateText),
              ),
          );
    const deadline = selected?.deadline ?? null;
    if (deadline !== extraction.deadline) {
      correctedFields.push('deadline');
      extraction.deadline = deadline;
      // These suggestions may have been scheduled relative to an invented date.
      extraction.tasks = extraction.tasks.map((task) => ({
        ...task,
        dueAt: null,
      }));
    }
    if (selected) evidence.deadline = selected.evidence;
    else delete evidence.deadline;
  }
  return { extraction, omittedProof, correctedFields };
}

export const AI_RESPONSE_MAX_BYTES = 256 * 1024;
export async function readAiContent(response: {
  headers: Pick<Headers, 'get'>;
  body: {
    cancel(): Promise<void>;
    getReader(): Pick<
      ReadableStreamDefaultReader<Uint8Array>,
      'read' | 'cancel' | 'releaseLock'
    >;
  } | null;
}): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > AI_RESPONSE_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('AI 响应过大');
  }
  if (!response.body) throw new Error('AI 响应为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AI_RESPONSE_MAX_BYTES) throw new Error('AI 响应过大');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const envelope = z
    .object({
      choices: z
        .array(
          z.object({
            message: z.object({
              content: z.string().trim().min(1).max(64_000),
            }),
          }),
        )
        .min(1),
    })
    .parse(JSON.parse(new TextDecoder().decode(bytes)));
  return envelope.choices[0].message.content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}
