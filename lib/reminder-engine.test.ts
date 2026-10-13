import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReminderEngine } from '@/lib/reminder-engine';
import {
  deadlineDaysSchema,
  deadlineReminderAt,
  fromShanghaiInput,
  milestoneMinutesSchema,
  toShanghaiInput,
} from '@/lib/reminder-policy';

const ms = (value: string) => Date.parse(value);
const start = new Date('2026-12-10T08:00:00+08:00');
let client: Database.Database;
const send = vi.fn<(_title: string, _message: string) => Promise<void>>();
function initialize(database: Database.Database) {
  database.pragma('foreign_keys=ON');
  for (const file of fs
    .readdirSync(path.resolve('drizzle'))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    database.exec(fs.readFileSync(path.resolve('drizzle', file), 'utf8'));
}
function opp(
  id: string,
  stage = 'preparing',
  decision = 'pursue',
  deadline: string | null = null,
  days = [7, 3, 1, 0],
) {
  client
    .prepare(
      'INSERT INTO opportunities (id,organization,role,stage,decision,deadline,reminder_days,created_at,updated_at,last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      '星河科技',
      id,
      stage,
      decision,
      deadline ? ms(deadline) : null,
      JSON.stringify(days),
      start.getTime(),
      start.getTime(),
      start.getTime(),
    );
}
function task(
  id: string,
  parent: string | null,
  due: string | null,
  status = 'todo',
) {
  client
    .prepare(
      'INSERT INTO tasks (id,opportunity_id,title,due_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      id,
      parent,
      id,
      due ? ms(due) : null,
      status,
      start.getTime(),
      start.getTime(),
    );
}
function milestone(
  id: string,
  parent: string,
  when: string | null,
  offsets = [10080, 4320, 1440, 0],
  status = 'pending',
) {
  client
    .prepare(
      'INSERT INTO milestones (id,opportunity_id,title,scheduled_at,reminder_offsets,status,created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      id,
      parent,
      id,
      when ? ms(when) : null,
      JSON.stringify(offsets),
      status,
      start.getTime(),
    );
}
const deliveries = () =>
  client
    .prepare(
      'SELECT entity_type,entity_id,delivery_key FROM reminder_deliveries',
    )
    .all();
const setting = (key: string, value: string) =>
  client
    .prepare(
      'INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(`reminders.${key}`, value, start.getTime());

beforeEach(() => {
  client = new Database(':memory:');
  initialize(client);
  send.mockReset().mockResolvedValue();
});
afterEach(() => {
  client.close();
  vi.unstubAllEnvs();
});

describe('提醒计划与上海时区', () => {
  it.each(['UTC', 'America/New_York', 'Asia/Shanghai', 'Europe/London'])(
    '主机 TZ=%s 时默认提醒仍是上海 09:00',
    (zone) => {
      vi.stubEnv('TZ', zone);
      const deadline = ms('2027-01-01T23:59:00+08:00');
      expect(
        [7, 3, 1, 0].map((days) =>
          new Date(deadlineReminderAt(deadline, days)).toISOString(),
        ),
      ).toEqual([
        '2026-12-25T01:00:00.000Z',
        '2026-12-29T01:00:00.000Z',
        '2026-12-31T01:00:00.000Z',
        '2027-01-01T01:00:00.000Z',
      ]);
      expect(fromShanghaiInput('2027-01-01T23:59')).toBe(
        '2027-01-01T15:59:00.000Z',
      );
      expect(toShanghaiInput('2027-01-01T15:59:00Z')).toBe('2027-01-01T23:59');
    },
  );
  it('早于 09:00 的当天提醒不会晚于截止，提前天数仍是 09:00', () => {
    const deadline = ms('2026-12-15T08:00:00+08:00');
    expect(deadlineReminderAt(deadline, 0)).toBe(deadline);
    expect(deadlineReminderAt(deadline, 1)).toBe(
      ms('2026-12-14T09:00:00+08:00'),
    );
  });
  it('支持跨月、闰日和没有日期', () => {
    expect(deadlineReminderAt(ms('2028-03-01T23:59:00+08:00'), 1)).toBe(
      ms('2028-02-29T09:00:00+08:00'),
    );
    expect(toShanghaiInput(null)).toBe('');
    expect(toShanghaiInput('invalid')).toBe('');
    expect(fromShanghaiInput('')).toBeNull();
  });
  it.each(['2026-02-30T09:00', '2026-12-01T24:01', '2026-12-01', 'bad'])(
    '拒绝输入无效上海时间 %s',
    (value) => {
      expect(() => fromShanghaiInput(value)).toThrow();
    },
  );
  it('提醒配置去重、排序，空数组关闭提醒', () => {
    expect(deadlineDaysSchema.parse([0, 3, 3, 7])).toEqual([7, 3, 0]);
    expect(milestoneMinutesSchema.parse([30, 0, 60, 60])).toEqual([60, 30, 0]);
    expect(deadlineDaysSchema.parse([])).toEqual([]);
  });
  it.each([[-1], [1.5], ['3'], [Infinity], Array(21).fill(0)])(
    '拒绝非法偏移（%#）',
    (value) => {
      expect(deadlineDaysSchema.safeParse(value).success).toBe(false);
      expect(milestoneMinutesSchema.safeParse(value).success).toBe(false);
    },
  );
  it('节点按精确分钟提前，任务/下一步按到点', () => {
    opp('a');
    milestone('面试', 'a', '2026-12-15T14:00:00+08:00', [60, 30, 0]);
    task('材料', 'a', '2026-12-15T10:00:00+08:00');
    client
      .prepare(
        'UPDATE opportunities SET next_action=?,next_action_at=? WHERE id=?',
      )
      .run('确认面试安排', ms('2026-12-15T11:00:00+08:00'), 'a');
    task('下一步任务', 'a', '2026-12-15T11:00:00+08:00');
    client
      .prepare('UPDATE tasks SET is_next_action=1 WHERE id=?')
      .run('下一步任务');
    const items = createReminderEngine(client, send).collect().candidates;
    expect(
      items
        .filter((item) => item.entityType === 'milestone')
        .map((item) => item.scheduledFor),
    ).toEqual(
      [
        '2026-12-15T13:00:00+08:00',
        '2026-12-15T13:30:00+08:00',
        '2026-12-15T14:00:00+08:00',
      ].map(ms),
    );
    expect(
      items.find(
        (item) => item.entityType === 'task' && item.entityId === '下一步任务',
      )?.scheduledFor,
    ).toBe(ms('2026-12-15T11:00:00+08:00'));
  });
});

describe('遗漏、终态、重启与失败', () => {
  it('停机 48 小时以上只发一条汇总，按事项计数而非偏移数量', async () => {
    opp('a', 'preparing', 'pursue', '2026-12-12T23:59:00+08:00');
    milestone('面试', 'a', '2026-12-12T14:00:00+08:00');
    task('独立任务', null, '2026-12-12T10:00:00+08:00');
    const engine = createReminderEngine(client, send);
    await engine.check(start);
    send.mockClear();
    const now = new Date('2026-12-15T09:01:00+08:00');
    expect(await engine.check(now, true)).toBe(3);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('遗漏提醒汇总');
    expect(send.mock.calls[0][1]).toContain('3 项');
    expect(engine.status(now).cursorAt).toBe(now.toISOString());
    expect(await engine.check(now, true)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('首次启动不局限最近一天的未发送待办', async () => {
    task('过期任务', null, '2026-12-01T10:00:00+08:00');
    expect(
      await createReminderEngine(client, send).check(
        new Date('2026-12-15T10:00:00+08:00'),
        true,
      ),
    ).toBe(1);
    expect(deliveries()).toHaveLength(1);
  });
  it('正常一分钟轮询只提交一次，到点前不发送', async () => {
    task('准时任务', null, '2026-12-10T08:01:00+08:00');
    const engine = createReminderEngine(client, send);
    expect(await engine.check(start)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await engine.check(new Date(start.getTime() + 60_000))).toBe(1);
    expect(send.mock.calls[0][0]).toBe('求职助手');
    expect(await engine.check(new Date(start.getTime() + 120_000))).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['closed', 'pursue'],
    ['preparing', 'skip'],
    ['offer', 'skip'],
  ])('%s/%s 排除截止、下一步、节点与关联任务', (stage, decision) => {
    opp('a', stage, decision, '2026-12-15T23:59:00+08:00');
    milestone('节点', 'a', '2026-12-12T14:00:00+08:00');
    task('任务', 'a', '2026-12-12T14:00:00+08:00');
    client
      .prepare('UPDATE opportunities SET next_action=?,next_action_at=?')
      .run('行动', start.getTime());
    expect(createReminderEngine(client, send).collect().candidates).toEqual([]);
  });
  it('Offer 排除投递截止但保留体检/签约节点及待办任务', async () => {
    opp('a', 'offer', 'pursue', '2026-12-12T23:59:00+08:00');
    milestone('签约', 'a', '2026-12-12T14:00:00+08:00', [0]);
    task('提交体检报告', 'a', '2026-12-12T10:00:00+08:00');
    expect(
      await createReminderEngine(client, send).check(
        new Date('2026-12-15T10:00:00+08:00'),
        true,
      ),
    ).toBe(2);
    expect(deliveries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_type: 'milestone' }),
        expect.objectContaining({ entity_type: 'task' }),
      ]),
    );
  });
  it.each(['applied', 'assessment', 'interview', 'waiting'])(
    '%s 停止投递截止提醒，跟进任务和招聘节点继续提醒',
    (stage) => {
      opp('a', stage, 'pursue', '2026-12-12T23:59:00+08:00');
      milestone('招聘节点', 'a', '2026-12-12T14:00:00+08:00', [0]);
      task('跟进招聘反馈', 'a', '2026-12-12T10:00:00+08:00');
      const candidates = createReminderEngine(client, send).collect()
        .candidates;
      expect(candidates).toHaveLength(2);
      expect(candidates.some((row) => row.entityType === 'opportunity')).toBe(
        false,
      );
      client.prepare("UPDATE opportunities SET stage='preparing'").run();
      expect(
        createReminderEngine(client, send)
          .collect()
          .candidates.some((row) => row.entityType === 'opportunity'),
      ).toBe(true);
    },
  );
  it.each(['done', 'skipped'])(
    '完成或跳过的任务/节点不提醒（%s）',
    (status) => {
      opp('a');
      milestone('节点', 'a', '2026-12-12T14:00:00+08:00', [0], status);
      task('任务', 'a', '2026-12-12T10:00:00+08:00', status);
      expect(createReminderEngine(client, send).collect().candidates).toEqual(
        [],
      );
    },
  );
  it('无日期、空下一步、关闭配置不产生提醒', () => {
    opp('a', 'preparing', 'pursue', '2026-12-15T23:59:00+08:00', []);
    milestone('节点', 'a', '2026-12-12T14:00:00+08:00', []);
    milestone('无时间节点', 'a', null);
    task('无时间任务', null, null);
    client
      .prepare('UPDATE opportunities SET next_action_at=?')
      .run(start.getTime());
    expect(createReminderEngine(client, send).collect().candidates).toEqual([]);
  });
  it('禁用与非 macOS 不消耗任何提醒或游标', async () => {
    task('任务', null, '2026-12-01T10:00:00+08:00');
    for (const mode of ['disabled', 'unsupported'] as const) {
      const engine = createReminderEngine(client, send, () => mode);
      expect(await engine.check(start)).toBe(0);
      await expect(engine.test(start)).rejects.toThrow();
      expect(engine.status(start).mode).toBe(mode);
    }
    expect(deliveries()).toEqual([]);
    expect(client.prepare('SELECT * FROM settings').all()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it('通知失败不标记送达或推进游标，下次可以重试', async () => {
    task('任务', null, '2026-12-01T10:00:00+08:00');
    send.mockRejectedValueOnce(new Error('失败'));
    const engine = createReminderEngine(client, send);
    await expect(engine.check(start)).rejects.toThrow();
    expect(deliveries()).toEqual([]);
    expect(engine.status(start).cursorAt).toBeNull();
    expect(engine.status(start).lastError).toContain('未标记送达');
    expect(await engine.check(new Date(start.getTime() + 60_000))).toBe(1);
    expect(engine.status(start).lastError).toBe('');
  });
  it('数据库提交失败回滚，保留重试资格', async () => {
    task('任务', null, '2026-12-01T10:00:00+08:00');
    client.exec(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON reminder_deliveries BEGIN SELECT RAISE(ABORT,'test'); END;",
    );
    const engine = createReminderEngine(client, send);
    await expect(engine.check(start)).rejects.toThrow();
    expect(deliveries()).toEqual([]);
    expect(engine.status(start).cursorAt).toBeNull();
    client.exec('DROP TRIGGER fail_delivery');
    expect(await engine.check(start)).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('同引擎并发检查只提交一次', async () => {
    task('任务', null, '2026-12-01T10:00:00+08:00');
    let finish!: () => void;
    send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const engine = createReminderEngine(client, send);
    const one = engine.check(start);
    const two = engine.check(start);
    expect(one).toBe(two);
    finish();
    await Promise.all([one, two]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('两个引擎共享数据库时租约抑制重复提交', async () => {
    task('任务', null, '2026-12-01T10:00:00+08:00');
    let finish!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const a = createReminderEngine(client, send);
    const b = createReminderEngine(client, send);
    const first = a.check(start);
    expect(await b.check(start)).toBe(0);
    finish();
    await first;
    expect(await b.check(start)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('崩溃留下的租约到期后自动恢复', async () => {
    task('任务', null, '2026-12-01T10:00:00+08:00');
    setting(
      'lease',
      JSON.stringify({ token: 'old', until: start.getTime() + 30_000 }),
    );
    const engine = createReminderEngine(client, send);
    expect(await engine.check(start)).toBe(0);
    expect(await engine.check(new Date(start.getTime() + 31_000), true)).toBe(
      1,
    );
  });
  it('晚录入的逾期行动或补加旧提醒配置不被游标漏掉', async () => {
    const engine = createReminderEngine(client, send);
    await engine.check(start);
    task('晚录任务', null, '2026-12-01T10:00:00+08:00');
    expect(await engine.check(new Date(start.getTime() + 60_000))).toBe(1);
    expect(send.mock.calls[0][0]).toContain('遗漏');
  });
  it('修改时间会形成新提醒，原时间不重复发送', async () => {
    task('任务', null, '2026-12-01T10:00:00+08:00');
    const engine = createReminderEngine(client, send);
    await engine.check(start);
    client.prepare('UPDATE tasks SET due_at=?').run(start.getTime() + 60_000);
    await engine.check(new Date(start.getTime() + 60_000));
    expect(deliveries()).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('重复偏移与已送达 key 去重', async () => {
    opp('a', 'preparing', 'pursue', '2026-12-10T23:59:00+08:00', [0, 0]);
    const engine = createReminderEngine(client, send);
    expect(engine.collect().candidates).toHaveLength(1);
    await engine.check(new Date('2026-12-10T09:00:00+08:00'));
    expect(engine.collect().candidates).toHaveLength(0);
  });
  it('坏配置仅跳过该行，并可观察，不影响独立任务', async () => {
    opp('a', 'preparing', 'pursue', '2026-12-12T23:59:00+08:00');
    milestone('节点', 'a', '2026-12-12T14:00:00+08:00');
    client.prepare('UPDATE opportunities SET reminder_days=?').run('bad-json');
    client.prepare('UPDATE milestones SET reminder_offsets=?').run('[-1]');
    task('任务', null, '2026-12-01T10:00:00+08:00');
    const engine = createReminderEngine(client, send);
    expect(await engine.check(start)).toBe(1);
    expect(engine.status(start).invalidConfigurations).toBe(2);
  });
  it('只读状态不会发送通知或写库，显示下一次未来提醒', () => {
    task('任务', null, '2026-12-15T10:00:00+08:00');
    const status = createReminderEngine(client, send).status(start);
    expect(status.nextAt).toBe('2026-12-15T02:00:00.000Z');
    expect(send).not.toHaveBeenCalled();
    expect(client.prepare('SELECT * FROM settings').all()).toEqual([]);
  });
  it('测试通知不消耗业务提醒或检查游标，防止连续重复点击', async () => {
    task('任务', null, '2026-12-01T10:00:00+08:00');
    const engine = createReminderEngine(client, send);
    await engine.test(start);
    expect(deliveries()).toEqual([]);
    expect(engine.status(start).cursorAt).toBeNull();
    expect(engine.status(start).lastTestAt).toBe(start.toISOString());
    await expect(engine.test(start)).rejects.toThrow('稍候');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('测试通知失败显示错误但保留重试，不声称实际显示', async () => {
    send.mockRejectedValueOnce(new Error('OS failed'));
    const engine = createReminderEngine(client, send);
    await expect(engine.test(start)).rejects.toThrow();
    expect(engine.status(start).lastTestError).toContain('提交失败');
    await engine.test(start);
    expect(engine.status(start).lastTestError).toBe('');
  });
  it('关闭并重开磁盘 WAL 数据库仍保留游标与去重，停机后再汇总', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'zhaopin-reminder-test-'),
    );
    const databasePath = path.join(directory, 'app.db');
    client.close();
    client = new Database(databasePath);
    initialize(client);
    client.pragma('journal_mode=WAL');
    task('任务一', null, '2026-12-09T10:00:00+08:00');
    await createReminderEngine(client, send).check(start);
    client.close();
    client = new Database(databasePath);
    const reopened = createReminderEngine(client, send);
    expect(reopened.status(start).cursorAt).toBe(start.toISOString());
    expect(await reopened.check(start, true)).toBe(0);
    task('任务二', null, '2026-12-11T10:00:00+08:00');
    expect(
      await reopened.check(new Date('2026-12-13T10:00:00+08:00'), true),
    ).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    client.close();
    client = new Database(':memory:');
    initialize(client);
    fs.rmSync(directory, { recursive: true });
  });
});
