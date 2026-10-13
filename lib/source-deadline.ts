const numericDate =
  '(?:(20\\d{2})[年/.-])?(\\d{1,2})[月/.-](\\d{1,2})日?(?!\\d)';
const time =
  '(?:[T\\s]*(\\d{1,2}):(\\d{2})(?::(\\d{2})(\\.\\d{1,3})?)?\\s*(Z|[+-]\\d{2}:\\d{2})?)?';
const datePattern = `${numericDate}${time}`;
const labels =
  '(?:网申截止|报名截止|投递截止|申请截止|截止(?:时间|日期)?|网申|validThrough|application deadline|closing date|deadline)';

export type SourceDeadline = {
  deadline: string;
  evidence: string;
  dateText: string;
};

function parseDate(
  match: RegExpMatchArray,
  now: Date,
  yearHint?: number,
): string | null {
  const [, explicitYear, month, day, hour, minute, second, milliseconds, zone] =
    match;
  let year = Number(
    explicitYear ||
      yearHint ||
      new Date(now.getTime() + 8 * 3600_000).getUTCFullYear(),
  );
  const makeDate = (value: number) => {
    const date = `${value}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const calendar = new Date(`${date}T00:00:00Z`);
    if (
      !Number.isFinite(calendar.getTime()) ||
      calendar.toISOString().slice(0, 10) !== date
    )
      return null;
    if (
      Number(hour || 0) > 23 ||
      Number(minute || 0) > 59 ||
      Number(second || 0) > 59
    )
      return null;
    if (
      zone &&
      zone !== 'Z' &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)
    )
      return null;
    const stamp = Date.parse(
      hour === undefined
        ? `${date}T23:59:00+08:00`
        : `${date}T${hour.padStart(2, '0')}:${minute}:${second || '00'}${milliseconds || ''}${zone || '+08:00'}`,
    );
    return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
  };
  let result = makeDate(year);
  if (
    !explicitYear &&
    !yearHint &&
    result &&
    Date.parse(result) < now.getTime() - 30 * 86400_000
  )
    result = makeDate(++year);
  return result;
}

export function sourceDeadlines(
  text: string,
  now = new Date(),
): SourceDeadline[] {
  const candidates: SourceDeadline[] = [];
  const regex = new RegExp(
    `${labels}(?:[（(](?:北京时间|上海时间)[）)])?[：:\\s]*(${datePattern})`,
    'gi',
  );
  for (const match of text.matchAll(regex)) {
    // Exam/interview deadlines are separate recruitment milestones.
    const context = text.slice(
      Math.max(0, (match.index || 0) - 12),
      match.index,
    );
    if (
      /笔试|面试|公示|体检|资格审查/.test(context) &&
      !/报名|网申|申请|投递/.test(match[0])
    )
      continue;
    const date = new RegExp(`^${datePattern}$`, 'i').exec(match[1]);
    const deadline = date && parseDate(date, now);
    if (deadline)
      candidates.push({
        deadline,
        evidence: match[0].trim(),
        dateText: match[1].trim(),
      });
  }
  // A clearly stated application window supplies its ending date, not its opening date.
  for (const range of text.matchAll(
    /(?:报名|网申|申请|投递)(?:时间|日期|时段)[：:]([^\n]{1,180})/g,
  )) {
    const dates = [...range[1].matchAll(new RegExp(datePattern, 'g'))];
    if (
      dates.length !== 2 ||
      !/^\s*(?:至|到|[-—–~～])\s*$/.test(
        range[1].slice(
          (dates[0].index || 0) + dates[0][0].length,
          dates[1].index,
        ),
      )
    )
      continue;
    let yearHint = dates[0][1] ? Number(dates[0][1]) : undefined;
    if (yearHint && !dates[1][1] && Number(dates[1][2]) < Number(dates[0][2]))
      yearHint++;
    const deadline = parseDate(dates[1], now, yearHint);
    if (deadline)
      candidates.push({
        deadline,
        evidence: range[0].trim(),
        dateText: dates[1][0].trim(),
      });
  }
  return candidates.filter(
    (item, index) =>
      candidates.findIndex((other) => other.deadline === item.deadline) ===
      index,
  );
}

export function readSourceDeadline(text: string, now = new Date()) {
  const candidates = sourceDeadlines(text, now);
  return {
    deadline: candidates.length === 1 ? candidates[0].deadline : null,
    evidence: candidates.length === 1 ? candidates[0].evidence : '',
    candidates,
  };
}
