import fs from 'node:fs';
import path from 'node:path';
import { test as base } from '@playwright/test';
import {
  runTestProcess,
  testEnvironment,
  validateTestRun,
} from '../scripts/test-sandbox.mjs';

const test = base.extend<{
  regression: (script: string, port: number) => Promise<void>;
}>({
  regression: async ({ playwright }, runTest, info) => {
    info.annotations.push({
      type: '浏览器驱动',
      description: playwright.chromium.name(),
    });
    const run = JSON.parse(process.env.ZHAOPIN_E2E_RUN || 'null');
    validateTestRun(run);
    const directory = fs.mkdtempSync(path.join(run.root, 'zhaopin-case-'));
    const controller = new AbortController();
    let running: Promise<string> | undefined;
    let logs = '';
    try {
      await runTest(async (script, port) => {
        running = runTestProcess(
          process.execPath,
          [path.join(run.project, 'scripts', script)],
          {
            cwd: run.project,
            env: {
              ...process.env,
              ...testEnvironment(directory),
              NODE_ENV: 'production',
              ZHAOPIN_TEST_DATA_DIR: directory,
              ZHAOPIN_TEST_PORT: String(port),
              ZHAOPIN_TEST_SERVER_MODE: 'start',
              ZHAOPIN_TEST_BACKUP_REGRESSION: '1',
            },
            signal: controller.signal,
            log: (value: string) => {
              logs += value;
            },
          },
        );
        await running;
      });
    } finally {
      controller.abort();
      await running?.catch(() => {});
      await info.attach('回归日志', { body: logs, contentType: 'text/plain' });
      for (const name of fs.readdirSync(directory))
        if (name.endsWith('.png'))
          await info.attach(name, {
            path: path.join(directory, name),
            contentType: 'image/png',
          });
    }
  },
});
const cases = [
  [
    '机会编辑并发保护、双窗口冲突保留与独立字段保存',
    'check-edit-conflicts.mjs',
    3116,
  ],
  ['已修复 AI 客户端、坏响应回退与草稿确认', 'check-ai-extraction.mjs', 3110],
  ['详情会话隔离、提醒配置与上海时间', 'check-reminders.mjs', 3111],
  ['今日焦点排序、截止和停滞规则', 'check-today.mjs', 3112],
  ['本机 API 来源拒绝、材料边界与备份往返', 'check-local-security.mjs', 3113],
  ['保存反馈、重复点击与事务一致性', 'check-mutations.mjs', 3115],
  [
    '下一步任务闭环、材料及要求维护、旧库与重启保留',
    'check-workflows.mjs',
    3117,
  ],
  ['阶段历史、真实转化率、补录作废与备份重启', 'check-analytics.mjs', 3118],
  [
    '状态聚合、活动与草稿分页、自动刷新与编辑保护',
    'check-state-refresh.mjs',
    3119,
  ],
] as const;
for (const [name, script, port] of cases)
  test(name, async ({ regression }) => {
    await regression(script, port);
  });
