import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  deadlineDaysSchema,
  deadlineReminderAt,
  milestoneMinutesSchema,
} from '@/lib/reminder-policy';

export type ReminderCandidate = {
  entityType: 'opportunity' | 'milestone' | 'task' | 'nextAction';
  entityId: string;
  title: string;
  scheduledFor: number;
  key: string;
};
export type ReminderMode = 'available' | 'disabled' | 'unsupported';
export type ReminderStatus = {
  mode: ReminderMode;
  timeZone: string;
  lastCheckedAt: string | null;
  cursorAt: string | null;
  lastSubmittedAt: string | null;
  lastCount: number;
  pendingCount: number;
  lastError: string;
  invalidConfigurations: number;
  nextAt: string | null;
  lastTestAt: string | null;
  lastTestError: string;
};
const prefix = 'reminders.';
const iso = (value: string | undefined) =>
  value &&
  Number.isFinite(Number(value)) &&
  Math.abs(Number(value)) <= 8_640_000_000_000_000
    ? new Date(Number(value)).toISOString()
    : null;

export function createReminderEngine(
  database: Database.Database,
  send: (title: string, message: string) => Promise<void>,
  mode: () => ReminderMode = () => 'available',
) {
  const get = (key: string) =>
    (
      database
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(prefix + key) as { value: string } | undefined
    )?.value;
  const put = (key: string, value: string | number, now: number) =>
    database
      .prepare(
        'INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
      )
      .run(prefix + key, String(value), now);
  let inFlight: Promise<number> | undefined;

  function collect() {
    const candidates: ReminderCandidate[] = [];
    let invalidConfigurations = 0;
    const add = (
      entityType: ReminderCandidate['entityType'],
      entityId: string,
      title: string,
      scheduledFor: number,
    ) => {
      if (
        Number.isFinite(scheduledFor) &&
        Math.abs(scheduledFor) <= 8_640_000_000_000_000
      )
        candidates.push({
          entityType,
          entityId,
          title,
          scheduledFor,
          key: `${entityType}:${entityId}:${scheduledFor}`,
        });
    };
    const opportunities = database
      .prepare(
        "SELECT id, organization, role, deadline, reminder_days FROM opportunities WHERE stage NOT IN ('offer','closed') AND decision <> 'skip'",
      )
      .all() as {
      id: string;
      organization: string;
      role: string;
      deadline: number | null;
      reminder_days: string;
    }[];
    for (const item of opportunities) {
      if (item.deadline !== null) {
        try {
          for (const days of deadlineDaysSchema.parse(
            JSON.parse(item.reminder_days),
          ))
            add(
              'opportunity',
              item.id,
              `${item.organization} · ${item.role}：投递截止`,
              deadlineReminderAt(item.deadline, days),
            );
        } catch {
          invalidConfigurations++;
        }
      }
    }
    const milestones = database
      .prepare(
        "SELECT m.id,m.title,m.scheduled_at,m.reminder_offsets,o.organization FROM milestones m JOIN opportunities o ON o.id=m.opportunity_id WHERE m.scheduled_at IS NOT NULL AND m.status='pending' AND o.stage <> 'closed' AND o.decision <> 'skip'",
      )
      .all() as {
      id: string;
      title: string;
      scheduled_at: number;
      reminder_offsets: string;
      organization: string;
    }[];
    for (const item of milestones) {
      try {
        for (const minutes of milestoneMinutesSchema.parse(
          JSON.parse(item.reminder_offsets),
        ))
          add(
            'milestone',
            item.id,
            `${item.organization}：${item.title}`,
            item.scheduled_at - minutes * 60_000,
          );
      } catch {
        invalidConfigurations++;
      }
    }
    const tasks = database
      .prepare(
        "SELECT t.id,t.title,t.due_at,o.organization FROM tasks t LEFT JOIN opportunities o ON t.opportunity_id=o.id WHERE t.due_at IS NOT NULL AND t.status IN ('todo','doing') AND (t.opportunity_id IS NULL OR (o.stage <> 'closed' AND o.decision <> 'skip'))",
      )
      .all() as {
      id: string;
      title: string;
      due_at: number;
      organization: string | null;
    }[];
    for (const item of tasks)
      add(
        'task',
        item.id,
        `${item.organization ? item.organization + '：' : ''}${item.title}`,
        item.due_at,
      );
    const delivered = new Set(
      (
        database
          .prepare('SELECT delivery_key FROM reminder_deliveries')
          .all() as { delivery_key: string }[]
      ).map((item) => item.delivery_key),
    );
    return {
      candidates: [
        ...new Map(
          candidates
            .filter((item) => !delivered.has(item.key))
            .map((item) => [item.key, item]),
        ).values(),
      ].sort(
        (a, b) => a.scheduledFor - b.scheduledFor || a.key.localeCompare(b.key),
      ),
      invalidConfigurations,
    };
  }

  function claim(now: number) {
    const token = randomUUID();
    return database
      .transaction(() => {
        const stored = get('lease');
        if (stored) {
          try {
            if (JSON.parse(stored).until > now) return null;
          } catch {}
        }
        put('lease', JSON.stringify({ token, until: now + 30_000 }), now);
        return token;
      })
      .immediate();
  }
  function release(token: string) {
    database
      .transaction(() => {
        const stored = get('lease');
        if (stored && JSON.parse(stored).token === token)
          database
            .prepare('DELETE FROM settings WHERE key = ?')
            .run(prefix + 'lease');
      })
      .immediate();
  }

  async function scan(now: Date, startup: boolean) {
    if (mode() !== 'available') return 0;
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new Error('检查时间无效');
    const token = claim(nowMs);
    if (!token) return 0;
    try {
      const { candidates, invalidConfigurations } = collect();
      const pending = candidates.filter((item) => item.scheduledFor <= nowMs);
      const previousCursor = Number(get('cursor')) || 0;
      put('checked', nowMs, nowMs);
      put('invalidConfigurations', invalidConfigurations, nowMs);
      if (pending.length) {
        const entities = [
          ...new Map(
            pending.map((item) => [
              `${item.entityType}:${item.entityId}`,
              item,
            ]),
          ).values(),
        ];
        const missed =
          startup ||
          !previousCursor ||
          nowMs - previousCursor > 90_000 ||
          pending.some((item) => item.scheduledFor <= previousCursor);
        const message = missed
          ? `有 ${entities.length} 项未处理事项的提醒已到时间，已合并遗漏提醒。打开工作台核对截止、任务与招聘节点。`
          : entities.length === 1
            ? `该推进了：${entities[0].title.slice(0, 180)}`
            : `有 ${entities.length} 项招聘事项需要关注，打开工作台查看。`;
        await send(
          missed ? '求职助手 · 遗漏提醒汇总' : '求职助手',
          message,
        );
        // Notification + DB commit cannot be atomic. Prefer retry over silent loss.
        database
          .transaction(() => {
            const insert = database.prepare(
              'INSERT OR IGNORE INTO reminder_deliveries (id,entity_type,entity_id,scheduled_for,delivered_at,delivery_key) VALUES (?,?,?,?,?,?)',
            );
            for (const item of pending)
              insert.run(
                `rem_${randomUUID()}`,
                item.entityType,
                item.entityId,
                item.scheduledFor,
                nowMs,
                item.key,
              );
            put('submitted', nowMs, nowMs);
            put('count', entities.length, nowMs);
            put('cursor', nowMs, nowMs);
            put('error', '', nowMs);
          })
          .immediate();
        return entities.length;
      }
      database
        .transaction(() => {
          put('cursor', nowMs, nowMs);
          put('error', '', nowMs);
        })
        .immediate();
      return 0;
    } catch {
      put(
        'error',
        '通知提交失败，未标记送达；服务会在下一次检查时重试。',
        nowMs,
      );
      throw new Error('提醒检查或通知提交失败');
    } finally {
      release(token);
    }
  }
  function check(now = new Date(), startup = false) {
    if (inFlight) return inFlight;
    inFlight = scan(now, startup).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }
  function status(now = new Date()): ReminderStatus {
    const { candidates, invalidConfigurations } = collect();
    const next = candidates.find((item) => item.scheduledFor > now.getTime());
    return {
      mode: mode(),
      timeZone: 'Asia/Shanghai',
      lastCheckedAt: iso(get('checked')),
      cursorAt: iso(get('cursor')),
      lastSubmittedAt: iso(get('submitted')),
      lastCount: Number(get('count')) || 0,
      pendingCount: new Set(
        candidates
          .filter((item) => item.scheduledFor <= now.getTime())
          .map((item) => `${item.entityType}:${item.entityId}`),
      ).size,
      lastError: get('error') || '',
      invalidConfigurations,
      nextAt: next ? new Date(next.scheduledFor).toISOString() : null,
      lastTestAt: iso(get('testAt')),
      lastTestError: get('testError') || '',
    };
  }
  let testFlight: Promise<void> | undefined;
  async function test(now = new Date()) {
    if (mode() !== 'available')
      throw new Error(
        mode() === 'disabled'
          ? '当前环境已禁用系统通知，未发送测试。'
          : '系统通知仅支持 macOS。',
      );
    if (testFlight) return testFlight;
    if (Number(get('testAt')) > now.getTime() - 10_000)
      throw new Error('请稍候再发送测试通知。');
    testFlight = (async () => {
      try {
        await send(
          '求职助手 · 测试通知',
          '这是你手动发送的测试。若能看到，说明当前 Mac 可以显示工作台通知。',
        );
        put('testAt', now.getTime(), now.getTime());
        put('testError', '', now.getTime());
      } catch {
        put(
          'testError',
          '测试通知提交失败，请检查 macOS 通知设置后重试。',
          now.getTime(),
        );
        throw new Error('测试通知提交失败，请检查 macOS 通知设置后重试。');
      }
    })().finally(() => {
      testFlight = undefined;
    });
    return testFlight;
  }
  return { check, status, test, collect };
}
