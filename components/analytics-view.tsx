'use client';

import { useState } from 'react';
import { ArrowUpRight, History, Target } from 'lucide-react';
import { buildRecruitmentAnalytics } from '@/lib/analytics';
import type { WorkspaceState } from '@/lib/client-types';

export function RecordAnalyticsView({ data }: { data: WorkspaceState }) {
  const [includeWithdrawn, setIncludeWithdrawn] = useState(false);
  const metrics = buildRecruitmentAnalytics(
    data.opportunities,
    includeWithdrawn,
  );
  return (
    <div className="space-y-5" data-testid="recruitment-analytics">
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-[22px] border border-[#e2ded4] bg-white/80 p-5">
        <div>
          <h2 className="font-semibold">让真实经历，成为下一次的依据</h2>
          <p className="mt-1 text-sm text-[#817b71]">
            按有效阶段记录去重；阶段回退保留经历，不推断跳过的环节。
          </p>
        </div>
        <label className="text-sm text-[#6f6960]">
          统计范围
          <select
            aria-label="统计范围"
            value={includeWithdrawn ? 'all' : 'active'}
            onChange={(event) =>
              setIncludeWithdrawn(event.target.value === 'all')
            }
            className="ml-3 rounded-lg border border-input bg-white p-2"
          >
            <option value="active">排除主动放弃，保留未通过</option>
            <option value="all">全部机会（含主动放弃）</option>
          </select>
        </label>
      </section>
      <div className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
        <section className="rounded-[26px] border border-[#e2ded4] bg-white/80 p-6">
          <div className="flex items-center gap-2 text-sm text-[#817b71]">
            <History className="size-4" />
            已记录的招聘经历{' '}
            <span className="ml-auto">已排除 {metrics.excluded} 条</span>
          </div>
          <div className="mt-7 space-y-6">
            {metrics.rows.map((row) => (
              <div key={row.id} data-testid={`metric-${row.id}`}>
                <div className="mb-2 flex items-end justify-between gap-3">
                  <p className="text-sm font-semibold">{row.label}</p>
                  <span
                    className="text-xl font-semibold"
                    data-testid="metric-count"
                  >
                    {row.count}
                  </span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-[#ece9e2]">
                  <div
                    className="h-full rounded-full bg-[#3e796b] transition-all"
                    style={{
                      width: `${metrics.total ? (row.count / metrics.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                {row.conversion && (
                  <p className="mt-2 text-xs text-[#817b71]">
                    {row.conversionLabel}：
                    {row.conversion.percent === null
                      ? '—'
                      : `${row.conversion.percent}%`}{' '}
                    <span className="ml-1">
                      （{row.conversion.numerator} /{' '}
                      {row.conversion.denominator}）
                    </span>
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="mt-6 border-t border-[#e7e3db] pt-4 text-xs leading-6 text-[#817b71]">
            人数是各环节的实际记录；转化率只计算同时有分子、分母环节记录的机会。面试以投递为分母，允许跳过笔试；无分母时显示“—”。建档晚、跳过环节时，人数不必逐级递减。
          </p>
        </section>
        <div className="space-y-4">
          {[
            {
              icon: Target,
              value: metrics.total,
              label: '纳入统计的机会',
              text: `当前筛选口径 · ${metrics.rejected} 条未通过 · ${metrics.withdrawn} 条主动放弃`,
            },
            {
              icon: ArrowUpRight,
              value: metrics.rows[4].count,
              label: '记录过 Offer',
              text: '统计经历，不因当前阶段回退而丢失',
            },
          ].map(({ icon: Icon, value, label, text }) => (
            <section
              key={label}
              className="flex items-center gap-4 rounded-[22px] border border-[#e2ded4] bg-white/80 p-5"
            >
              <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[#edf4f1] text-[#2d6b5d]">
                <Icon className="size-5" />
              </div>
              <div>
                <p className="text-2xl font-semibold">
                  {value}
                  <span className="ml-2 text-sm text-[#6f6960]">{label}</span>
                </p>
                <p className="mt-1 text-xs leading-5 text-[#888278]">{text}</p>
              </div>
            </section>
          ))}
          <section className="rounded-[22px] border border-[#e2ded4] bg-[#f5f2e9] p-5 text-sm leading-7 text-[#736c60]">
            <p className="font-semibold text-[#514d44]">关于历史完整性</p>
            <p>
              {metrics.partialHistory
                ? `${metrics.partialHistory} 条机会来自旧数据或中途阶段建档，未记录的经历不视为已经发生。可在详情的“推进记录”中补录。`
                : '所有机会均从建档开始记录；仍可补录遗漏或作废误录。'}
            </p>
            {metrics.unknownClosed > 0 && (
              <p className="mt-2">
                {metrics.unknownClosed}{' '}
                条已结束机会尚未分类，仍纳入统计。请在编辑信息中确认是未通过还是主动放弃。
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
