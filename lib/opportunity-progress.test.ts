import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, afterEach, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { createActionService } from './actions';
import { readWorkspaceState } from './workspace-repository';
import {
  applicationTasks,
  currentStageAt,
  progressPayload,
} from './opportunity-progress';
import type { Opportunity } from './client-types';

let client: Database.Database;
let service: ReturnType<typeof createActionService>;
beforeEach(() => {
  client = new Database(':memory:');
  client.pragma('foreign_keys=ON');
  for (const name of fs
    .readdirSync('drizzle')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    client.exec(fs.readFileSync(path.join('drizzle', name), 'utf8'));
  service = createActionService(client, async () => {});
});
afterEach(() => client.close());
const state = () =>
  JSON.parse(JSON.stringify(readWorkspaceState(drizzle(client, { schema }))))
    .opportunities as Opportunity[];
async function create(fields = {}) {
  await service.execute({
    action: 'createOpportunity',
    payload: { organization: '进展测试公司', role: '工程师', ...fields },
  });
  return state()[0];
}

it('今天投递同时更新阶段、发生时间和进展；相同请求重放不重复记录', async () => {
  const item = await create();
  const request = {
    action: 'addActivity',
    payload: progressPayload(item, '今天已投递', 'applied'),
    requestId: randomUUID(),
  };
  await service.execute(request);
  await service.execute(request);
  const updated = state()[0];
  expect(updated.stage).toBe('applied');
  expect(updated.latestNote?.content).toBe('今天已投递');
  expect(currentStageAt(updated)).toBe(updated.latestNote?.createdAt);
  expect(
    updated.stageHistory?.filter((r) => r.toStage === 'applied'),
  ).toHaveLength(1);
  expect(
    client
      .prepare("SELECT count(*) AS n FROM activities WHERE type='note'")
      .get(),
  ).toEqual({ n: 1 });
});

it('普通文字备注不猜测阶段，历史上未知的投递时间不编造', async () => {
  const item = await create({ stage: 'applied' });
  expect(currentStageAt(item)).toBeNull();
  await service.execute({
    action: 'addActivity',
    payload: progressPayload(item, '准备面试，尚未收到邀请'),
  });
  expect(state()[0].stage).toBe('applied');
  expect(currentStageAt(state()[0])).toBeNull();
});

it('另一窗口推进后拒绝旧状态同步，整条记录不写入', async () => {
  const item = await create();
  await service.execute({
    action: 'updateOpportunity',
    payload: { id: item.id, stage: 'interview' },
  });
  const before = client.serialize();
  await expect(
    service.execute({
      action: 'addActivity',
      payload: progressPayload(item, '今天已投递', 'applied'),
    }),
  ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
  expect(client.serialize()).toEqual(before);
});

it('备注写入失败会回滚阶段和阶段历史', async () => {
  const item = await create();
  client.exec(
    "CREATE TRIGGER reject_progress BEFORE INSERT ON activities WHEN NEW.type='note' BEGIN SELECT RAISE(ABORT, 'progress failure'); END",
  );
  const before = client.serialize();
  await expect(
    service.execute({
      action: 'addActivity',
      payload: progressPayload(item, '今天已投递', 'applied'),
    }),
  ).rejects.toThrow('progress failure');
  expect(client.serialize()).toEqual(before);
});

it('未提供原状态的同步请求被拒绝；已放弃机会不能直接同步为已投递', async () => {
  const item = await create({ decision: 'skip' });
  await expect(
    service.execute({
      action: 'addActivity',
      payload: { opportunityId: item.id, content: '已投递', stage: 'applied' },
    }),
  ).rejects.toThrow('同步阶段时须提供原状态');
  await expect(
    service.execute({
      action: 'addActivity',
      payload: progressPayload(item, '已投递', 'applied'),
    }),
  ).rejects.toMatchObject({ code: 'OPPORTUNITY_STATUS_CONFLICT' });
  expect(state()[0].stage).toBe('closed');
  expect(state()[0].latestNote).toBeNull();
});

const actualTime = '2026-10-11T17:45:00.000Z'; // Shanghai: 10/12 01:45.
function progress(item: Opportunity, changes: Record<string, unknown> = {}) {
  return {
    action: 'recordProgress',
    payload: {
      opportunityId: item.id,
      expectedStatus: progressPayload(item, '', item.stage).expectedStatus,
      stage: 'applied',
      occurredAt: actualTime,
      completedTasks: applicationTasks(item).map((task) => ({
        id: task.id,
        expected: { title: task.title, dueAt: task.dueAt, status: task.status },
      })),
      ...changes,
    },
    requestId: randomUUID(),
  };
}
const applicationFixture = () =>
  create({
    nextAction: '准备并投递简历',
    tasks: [
      { title: '准备并投递简历' },
      { title: '确认渠道，完成网申或邮件投递' },
      { title: '准备面试案例' },
    ],
  });

it('投递任务建议排除反馈跟进、补交材料及招聘结果处理', async () => {
  const item = await create({
    tasks: [
      { title: '完成网申或邮件投递' },
      { title: '跟进投递反馈' },
      { title: '查询网申结果' },
      { title: '补交投递材料' },
      { title: '撤回申请后重新准备' },
      { title: '准备面试' },
    ],
  });
  expect(applicationTasks(item).map((task) => task.title)).toEqual([
    '完成网申或邮件投递',
  ]);
});

it('一次保存实际投递时间、勾选任务和下一步，重放请求不重复建任务', async () => {
  const item = await applicationFixture();
  const command = progress(item, {
    followUp: {
      title: '跟进反馈',
      dueAt: '2026-10-18T09:00:00+08:00',
      expectedNextTaskId: item.tasks.find((t) => t.isNextAction)!.id,
    },
  });
  await service.execute(command);
  await service.execute(command);
  const updated = state()[0];
  expect(updated.stage).toBe('applied');
  expect(currentStageAt(updated)).toBe(actualTime);
  expect(
    updated.stageHistory?.find((r) => r.toStage === 'applied')?.recordedAt,
  ).not.toBe(actualTime);
  expect(applicationTasks(updated)).toHaveLength(0);
  expect(updated.tasks.find((t) => t.title === '准备面试案例')?.status).toBe(
    'todo',
  );
  expect(updated.tasks.filter((t) => t.title === '跟进反馈')).toHaveLength(1);
  expect(updated.nextAction).toBe('跟进反馈');
  expect(updated.nextActionAt).toBe('2026-10-18T01:00:00.000Z');
  expect(updated.latestNote?.content).toContain('10/12 01:45');
});

it('用户未勾选的投递任务保留，单独核对任务不改阶段发生时间', async () => {
  const item = await applicationFixture();
  const selected = progress(item).payload.completedTasks.slice(0, 1);
  await service.execute(progress(item, { completedTasks: selected }));
  const updated = state()[0];
  expect(applicationTasks(updated)).toHaveLength(1);
  const cleanup = progress(updated, {
    stage: undefined,
    occurredAt: undefined,
  });
  await service.execute(cleanup);
  expect(applicationTasks(state()[0])).toHaveLength(0);
  expect(currentStageAt(state()[0])).toBe(actualTime);
});

it('记录面试邀请和未来节点，发生时间与预约时间分别保存', async () => {
  const item = await create({ stage: 'applied' });
  await service.execute(
    progress(item, {
      stage: 'interview',
      milestone: { title: '一面', scheduledAt: '2026-11-01T14:00:00+08:00' },
    }),
  );
  const updated = state()[0];
  expect(updated.stage).toBe('interview');
  expect(currentStageAt(updated)).toBe(actualTime);
  expect(updated.milestones[0].scheduledAt).toBe('2026-11-01T06:00:00.000Z');
});

it('后续节点写入失败时回滚整个复合操作，包括任务完成和下一步', async () => {
  const item = await applicationFixture();
  client.exec(
    "CREATE TRIGGER reject_milestone BEFORE INSERT ON milestones BEGIN SELECT RAISE(ABORT, 'appointment failure'); END",
  );
  const before = client.serialize();
  await expect(
    service.execute(
      progress(item, {
        stage: 'interview',
        followUp: {
          title: '跟进',
          dueAt: null,
          expectedNextTaskId: item.tasks.find((t) => t.isNextAction)!.id,
        },
        milestone: { title: '一面', scheduledAt: '2026-11-01T14:00:00+08:00' },
      }),
    ),
  ).rejects.toThrow('appointment failure');
  expect(client.serialize()).toEqual(before);
});

it('其他窗口修改任一勾选任务时，旧复合操作完全不写入', async () => {
  const item = await applicationFixture();
  await service.execute({
    action: 'updateTask',
    payload: { id: item.tasks[0].id, title: '修改后的投递任务' },
  });
  const before = client.serialize();
  await expect(service.execute(progress(item))).rejects.toMatchObject({
    code: 'EDIT_CONFLICT',
  });
  expect(client.serialize()).toEqual(before);
});

it('拒绝跨机会任务和未来发生时间', async () => {
  const item = await applicationFixture();
  const second = await service.execute({
    action: 'createOpportunity',
    payload: {
      organization: '另一个组织',
      role: '另一个岗位',
      tasks: [{ title: '另一机会投递' }],
    },
  });
  const other = state().find((o) => o.id === second.id)!;
  const before = client.serialize();
  await expect(
    service.execute(
      progress(item, {
        completedTasks: progress(other).payload.completedTasks,
      }),
    ),
  ).rejects.toThrow('不属于这个机会');
  await expect(
    service.execute(
      progress(item, {
        occurredAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    ),
  ).rejects.toThrow('不能晚于现在');
  expect(client.serialize()).toEqual(before);
});

it('旧窗口不能覆盖后来选定的下一步', async () => {
  const item = await create({ stage: 'applied' });
  const newTask = await service.execute({
    action: 'createTask',
    payload: { opportunityId: item.id, title: '新重点' },
  });
  await service.execute({
    action: 'setNextTask',
    payload: { opportunityId: item.id, taskId: newTask.id },
  });
  const before = client.serialize();
  await expect(
    service.execute(
      progress(item, {
        stage: undefined,
        occurredAt: undefined,
        followUp: {
          title: '旧窗口的跟进',
          dueAt: null,
          expectedNextTaskId: null,
        },
      }),
    ),
  ).rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
  expect(client.serialize()).toEqual(before);
});

it('有效补录可以补齐未知日期；已有明确阶段日期不会被旧经历覆盖', async () => {
  const item = await create({ stage: 'applied' });
  await service.execute({
    action: 'addStageHistory',
    payload: {
      opportunityId: item.id,
      stage: 'applied',
      occurredAt: actualTime,
    },
  });
  expect(currentStageAt(state()[0])).toBe(actualTime);
  await service.execute({
    action: 'updateOpportunity',
    payload: { id: item.id, stage: 'preparing' },
  });
  await service.execute(
    progress(state()[0], { occurredAt: '2026-10-12T09:30:00+08:00' }),
  );
  await service.execute({
    action: 'addStageHistory',
    payload: {
      opportunityId: item.id,
      stage: 'applied',
      occurredAt: actualTime,
    },
  });
  expect(currentStageAt(state()[0])).toBe('2026-10-12T01:30:00.000Z');
});
