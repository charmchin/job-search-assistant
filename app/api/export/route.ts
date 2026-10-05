import { NextResponse } from 'next/server';
import { guardLocalRequest } from '@/lib/local-request';
import { opportunities } from '@/db/schema';
import { db, sqlite } from '@/lib/db';
import { createJsonBackup } from '@/lib/backup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function csvCell(value: unknown) {
  const text =
    value == null
      ? ''
      : typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  const blocked = guardLocalRequest(request);
  if (blocked) return blocked;
  const format = new URL(request.url).searchParams.get('format') || 'json';
  if (format === 'csv') {
    const opportunityRows = await db.select().from(opportunities);
    const headers = [
      '公司/组织',
      '岗位',
      '方向',
      '地点',
      '阶段',
      '投入判断',
      '匹配度',
      '兴趣度',
      '优先级',
      '下一步行动',
      '下一步时间',
      '截止时间',
      '来源链接',
      '标签',
      '备注',
    ];
    const rows = opportunityRows.map((item) => [
      item.organization,
      item.role,
      item.direction,
      item.location,
      item.stage,
      item.decision,
      item.fitScore,
      item.interestScore,
      item.priority,
      item.nextAction,
      item.nextActionAt?.toISOString() || '',
      item.deadline?.toISOString() || '',
      item.sourceUrl,
      item.tags.join('、'),
      item.notes,
    ]);
    const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}`;
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="opportunities-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }
  const payload = createJsonBackup(sqlite);
  return NextResponse.json(payload, {
    headers: {
      'Content-Disposition': `attachment; filename="zhaopin-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
