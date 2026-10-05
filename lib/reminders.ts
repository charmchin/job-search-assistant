import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sqlite } from '@/lib/db';
import { createReminderEngine, type ReminderMode } from '@/lib/reminder-engine';

const execFileAsync = promisify(execFile);
const globals = globalThis as typeof globalThis & {
  __zhaopinReminderStarted?: boolean;
  __zhaopinReminderEngine?: ReturnType<typeof createReminderEngine>;
};
export function reminderMode(): ReminderMode {
  return process.env.ZHAOPIN_DISABLE_NOTIFICATIONS === '1'
    ? 'disabled'
    : process.platform === 'darwin'
      ? 'available'
      : 'unsupported';
}
export function quoteAppleScript(value: string) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .split('')
    .map((character) => (character.charCodeAt(0) < 32 ? ' ' : character))
    .join('');
}
export async function notify(title: string, message: string) {
  if (reminderMode() !== 'available') throw new Error('系统通知不可用');
  await execFileAsync(
    'osascript',
    [
      '-e',
      `display notification "${quoteAppleScript(message)}" with title "${quoteAppleScript(title)}"`,
    ],
    { timeout: 10_000, maxBuffer: 8192 },
  );
}
const engine = () =>
  (globals.__zhaopinReminderEngine ??= createReminderEngine(
    sqlite,
    notify,
    reminderMode,
  ));
export const checkReminders = (now = new Date(), startup = false) =>
  engine().check(now, startup);
export const getReminderStatus = () => engine().status();
export const testReminderNotification = () => engine().test();
export function startReminderScheduler() {
  if (
    globals.__zhaopinReminderStarted ||
    process.env.NODE_ENV === 'test' ||
    reminderMode() !== 'available'
  )
    return;
  globals.__zhaopinReminderStarted = true;
  void checkReminders(new Date(), true).catch(() =>
    console.error('Reminder check failed; will retry'),
  );
  setInterval(
    () =>
      void checkReminders().catch(() =>
        console.error('Reminder check failed; will retry'),
      ),
    60_000,
  ).unref();
}
