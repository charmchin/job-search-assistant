'use client';

import { useEffect, useState } from 'react';
import { Bell, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatDateTime } from '@/lib/domain';
import type { ReminderStatus } from '@/lib/reminder-engine';

export function ReminderSettings() {
  const [status, setStatus] = useState<ReminderStatus | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/reminders', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      setStatus(await response.json());
    } catch {
      setError('无法读取提醒状态，请确认本地服务在运行后重试。');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const response = await fetch('/api/reminders', { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (active) setStatus(result);
      } catch {
        if (active) setError('无法读取提醒状态，请点击刷新状态重试。');
      }
    };
    void read();
    const timer = setInterval(() => {
      if (!document.hidden) void read();
    }, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const test = async () => {
    if (testing) return;
    setTesting(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test' }),
      });
      const result = await response.json();
      if (result.status) setStatus(result.status);
      if (!response.ok) {
        setError(result.error || '测试通知未能提交。');
        return;
      }
      setMessage(result.message);
    } catch {
      setError('无法确认测试结果。请检查本地服务和实际通知，稍后再试。');
    } finally {
      setTesting(false);
    }
  };
  return (
    <Card className="border-[#e2ded4] bg-white/80 shadow-none xl:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-4 text-[#397365]" />
          时间与系统提醒
        </CardTitle>
        <CardDescription>
          所有输入和提醒均使用
          Asia/Shanghai；服务每分钟检查一次，停机后合并遗漏提醒。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-2xl border border-[#e1ddd4] bg-[#fcfbf8] p-4">
          <p className="text-sm font-semibold">
            {!status
              ? '正在读取状态…'
              : status.mode === 'available'
                ? '通知通道可用 · 是否显示由 macOS 决定'
                : status.mode === 'disabled'
                  ? '当前环境已禁用系统通知'
                  : '当前系统不支持 macOS 通知'}
          </p>
          <p className="mt-2 text-xs leading-5 text-[#827c72]">
            关闭浏览器不会停止提醒；停止本地服务后不会提醒。投递截止默认提前
            7、3、1 天与当天
            09:00；节点可提前到分钟，任务和下一步在到点时提醒。进入 Offer
            后保留待办任务与招聘节点，已放弃机会停止所有提醒。
          </p>
        </div>
        {status && (
          <dl className="grid gap-3 text-xs sm:grid-cols-3">
            {[
              ['最近检查', status.lastCheckedAt],
              ['下次计划提醒', status.nextAt],
              ['最近提交给系统', status.lastSubmittedAt],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[#8a847a]">{label}</dt>
                <dd className="mt-1 font-semibold">
                  {value ? formatDateTime(value) : '暂无记录'}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {Boolean(status?.pendingCount) && (
          <p className="text-xs text-[#827c72]">
            有 {status?.pendingCount}{' '}
            项待提交的到期提醒；通知通道可用时将在下一次检查合并处理。
          </p>
        )}
        {status?.lastTestError && (
          <p role="alert" className="text-sm text-[#9c4035]">
            {status.lastTestError}
          </p>
        )}
        {status?.lastError && (
          <p
            role="alert"
            className="rounded-xl bg-[#fff1ee] p-3 text-sm text-[#9c4035]"
          >
            {status.lastError}
          </p>
        )}
        {Boolean(status?.invalidConfigurations) && (
          <p role="alert" className="text-sm text-[#9c4035]">
            有 {status?.invalidConfigurations}{' '}
            项提醒配置无效，已跳过。请编辑对应机会或节点，重新设置提醒。
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新状态
          </Button>
          <Button
            disabled={testing || status?.mode !== 'available'}
            onClick={() => void test()}
          >
            {testing ? <Loader2 className="animate-spin" /> : <Bell />}
            发送测试通知
          </Button>
        </div>
        <p className="text-xs leading-5 text-[#827c72]">
          测试仅在你点击时发送。未看到通知时，检查 macOS「系统设置 →
          通知」和专注模式；“已提交”不代表通知一定显示。具体截止与节点提醒在机会详情中设置。
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-[#fff1ee] p-3 text-sm text-[#9c4035]"
          >
            {error}
          </p>
        )}
        {message && (
          <output className="block rounded-xl bg-[#f1f7f4] p-3 text-sm leading-6 text-[#315f54]">
            {message}
          </output>
        )}
      </CardContent>
    </Card>
  );
}
