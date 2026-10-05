export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startReminderScheduler } = await import('@/lib/reminders');
    startReminderScheduler();
  }
}
