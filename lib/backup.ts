import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as tables from '@/db/schema';
import { STAGES } from '@/lib/domain';

export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
export class BackupValidationError extends Error {}

// No trimming/coercion of ordinary text: a restore must preserve its contents.
const text = z.string();
const identity = text.refine((value) => value.trim().length > 0, '不能为空');
const date = z
  .union([
    z.iso
      .datetime({ offset: true })
      .refine((value) => !/\.\d{4,}/.test(value), '时间最多支持毫秒精度'),
    z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000),
    z.date(),
  ])
  .transform((value) => new Date(value));
const nullableDate = date.nullable();
const strings = z.array(text);
const offsets = z.array(z.number().int().nonnegative());

const opportunity = z.strictObject({
  id: identity,
  organization: identity,
  role: identity,
  direction: text.default(''),
  location: text.default(''),
  sourceName: text.default(''),
  sourceUrl: text.default(''),
  description: text.default(''),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  stage: z.enum(STAGES.map((stage) => stage.id)).default('evaluating'),
  closedReason: z.enum(['unknown', 'rejected', 'withdrawn']).default('unknown'),
  deadline: nullableDate.default(null),
  reminderDays: offsets.default([7, 3, 1, 0]),
  tags: strings.default([]),
  notes: text.default(''),
  specialNotes: text.default(''),
  review: text.default(''),
  decision: z
    .enum(['undecided', 'pursue', 'hold', 'skip'])
    .default('undecided'),
  fitScore: z.number().int().min(0).max(5).default(0),
  interestScore: z.number().int().min(0).max(5).default(0),
  nextAction: text.default(''),
  nextActionAt: nullableDate.default(null),
  highlights: strings.default([]),
  risks: strings.default([]),
  createdAt: date,
  updatedAt: date,
  lastActivityAt: date,
});

const backupSchema = z
  .strictObject({
    version: z.literal(1),
    exportedAt: date.optional(),
    data: z.strictObject({
      opportunities: z.array(opportunity),
      stageHistory: z
        .array(
          z.strictObject({
            id: identity,
            opportunityId: identity,
            fromStage: z.enum(STAGES.map((stage) => stage.id)).nullable(),
            toStage: z.enum(STAGES.map((stage) => stage.id)),
            occurredAt: nullableDate,
            recordedAt: date,
            source: z.enum(['initial', 'transition', 'legacy', 'manual']),
            valid: z.boolean(),
            notes: text,
          }),
        )
        .default([]),
      materials: z.array(
        z.strictObject({
          id: identity,
          name: identity,
          filePath: text.default(''),
          version: text.default(''),
          category: text.default('其他'),
          notes: text.default(''),
          createdAt: date,
          updatedAt: date,
        }),
      ),
      tasks: z.array(
        z.strictObject({
          id: identity,
          opportunityId: identity.nullable().default(null),
          title: identity,
          dueAt: nullableDate.default(null),
          estimatedMinutes: z.number().int().nonnegative().default(30),
          status: z.enum(['todo', 'doing', 'done', 'skipped']).default('todo'),
          source: z.enum(['manual', 'ai', 'rule']).default('manual'),
          createdAt: date,
          updatedAt: date,
          isNextAction: z.boolean().default(false),
        }),
      ),
      milestones: z.array(
        z.strictObject({
          id: identity,
          opportunityId: identity,
          title: identity,
          scheduledAt: nullableDate.default(null),
          result: text.default(''),
          status: z.enum(['pending', 'done', 'skipped']).default('pending'),
          reminderOffsets: offsets.default([10080, 4320, 1440, 0]),
          createdAt: date,
        }),
      ),
      materialRequirements: z.array(
        z.strictObject({
          id: identity,
          opportunityId: identity,
          materialId: identity.nullable().default(null),
          name: identity,
          completed: z.boolean().default(false),
          notes: text.default(''),
        }),
      ),
      activities: z.array(
        z.strictObject({
          id: identity,
          opportunityId: identity,
          type: identity.default('note'),
          content: text,
          createdAt: date,
        }),
      ),
      extractionDrafts: z
        .array(
          z.strictObject({
            id: identity,
            sourceUrl: text.default(''),
            sourceText: text,
            extractedJson: z.record(z.string(), z.json()),
            evidenceJson: z.record(z.string(), text).default({}),
            confidence: z.number().min(0).max(1).default(0),
            status: z
              .enum(['pending', 'confirmed', 'discarded'])
              .default('pending'),
            createdAt: date,
          }),
        )
        .default([]),
      reminderDeliveries: z
        .array(
          z.strictObject({
            id: identity,
            entityType: z.enum([
              'opportunity',
              'milestone',
              'task',
              'nextAction',
            ]),
            entityId: identity,
            scheduledFor: date,
            deliveredAt: date,
            deliveryKey: identity,
          }),
        )
        .default([]),
      settings: z
        .array(z.strictObject({ key: identity, value: text, updatedAt: date }))
        .default([]),
    }),
  })
  .superRefine(({ data }, context) => {
    const ids = new Map<string, Set<string>>();
    for (const [key, rows] of Object.entries(data)) {
      const seen = new Set<string>();
      rows.forEach((row, index) => {
        const value = 'id' in row ? row.id : row.key;
        if (seen.has(value))
          context.addIssue({
            code: 'custom',
            path: ['data', key, index, 'id' in row ? 'id' : 'key'],
            message: '标识重复',
          });
        seen.add(value);
      });
      ids.set(key, seen);
    }
    for (const key of [
      'tasks',
      'milestones',
      'materialRequirements',
      'activities',
      'stageHistory',
    ] as const) {
      data[key].forEach((row, index) => {
        if (
          row.opportunityId !== null &&
          !ids.get('opportunities')!.has(row.opportunityId)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['data', key, index, 'opportunityId'],
            message: '关联的机会不存在于备份中',
          });
        }
      });
    }
    data.materialRequirements.forEach((row, index) => {
      if (
        row.materialId !== null &&
        !ids.get('materials')!.has(row.materialId)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['data', 'materialRequirements', index, 'materialId'],
          message: '关联的材料不存在于备份中',
        });
      }
    });
    const focused = new Set<string>();
    data.tasks.forEach((row, index) => {
      if (!row.isNextAction) return;
      const owner = data.opportunities.find((o) => o.id === row.opportunityId);
      if (
        !owner ||
        !['todo', 'doing'].includes(row.status) ||
        focused.has(owner.id) ||
        owner.nextAction !== row.title ||
        owner.nextActionAt?.getTime() !== row.dueAt?.getTime()
      )
        context.addIssue({
          code: 'custom',
          path: ['data', 'tasks', index, 'isNextAction'],
          message: '下一步任务归属、状态或镜像字段不一致',
        });
      if (owner) focused.add(owner.id);
    });
    // Delivery logs intentionally survive deletion of their entity; they are historical, not foreign keys.
    const deliveryKeys = new Set<string>();
    data.reminderDeliveries.forEach((row, index) => {
      if (deliveryKeys.has(row.deliveryKey))
        context.addIssue({
          code: 'custom',
          path: ['data', 'reminderDeliveries', index, 'deliveryKey'],
          message: '提醒去重标识重复',
        });
      deliveryKeys.add(row.deliveryKey);
    });
    data.settings.forEach((row, index) => {
      if (
        row.key === 'staleDays' &&
        (!/^\d+$/.test(row.value) ||
          Number(row.value) < 1 ||
          Number(row.value) > 30)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['data', 'settings', index, 'value'],
          message: '停滞复查天数必须为 1–30 的整数',
        });
      }
    });
  });

export type BackupData = z.output<typeof backupSchema>['data'];

export function parseBackup(input: unknown) {
  const result = backupSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason =
      issue.code === 'custom'
        ? issue.message
        : issue.code === 'unrecognized_keys'
          ? '包含未支持的字段'
          : issue.code === 'invalid_type'
            ? '字段缺失或类型错误'
            : '字段取值或日期格式不合法';
    throw new BackupValidationError(
      `备份校验失败：${issue.path.join('.') || '备份'}，${reason}。当前数据未修改。`,
    );
  }
  // Version-1 backups predate canonical next-action tasks. Convert in memory
  // before the trial restore; preserve all original tasks, text and timestamps.
  const rawData = (
    input as {
      data: {
        stageHistory?: unknown;
        opportunities: { closedReason?: unknown }[];
      };
    }
  ).data;
  for (const [index, owner] of result.data.data.opportunities.entries()) {
    if (
      rawData.opportunities[index].closedReason === undefined &&
      owner.stage === 'closed' &&
      owner.decision === 'skip'
    )
      owner.closedReason = 'withdrawn';
    if (rawData.stageHistory === undefined)
      result.data.data.stageHistory.push({
        id: `legacy_${owner.id}`,
        opportunityId: owner.id,
        fromStage: null,
        toStage: owner.stage,
        occurredAt: null,
        recordedAt: owner.updatedAt,
        source: 'legacy',
        valid: true,
        notes: '旧数据当前阶段快照；进入时间及此前经历未知。',
      });
    if (
      !owner.nextAction.trim() ||
      result.data.data.tasks.some(
        (t) => t.opportunityId === owner.id && t.isNextAction,
      )
    )
      continue;
    let task = result.data.data.tasks
      .filter(
        (t) =>
          t.opportunityId === owner.id &&
          ['todo', 'doing'].includes(t.status) &&
          t.title === owner.nextAction &&
          (!t.dueAt ||
            !owner.nextActionAt ||
            t.dueAt.getTime() === owner.nextActionAt.getTime()),
      )
      .sort(
        (a, b) =>
          Number(b.dueAt?.getTime() === owner.nextActionAt?.getTime()) -
            Number(a.dueAt?.getTime() === owner.nextActionAt?.getTime()) ||
          a.id.localeCompare(b.id),
      )[0];
    if (!task) {
      task = {
        id: `next_${randomUUID()}`,
        opportunityId: owner.id,
        title: owner.nextAction,
        dueAt: owner.nextActionAt,
        estimatedMinutes: 30,
        status: 'todo',
        source: 'manual',
        isNextAction: true,
        createdAt: owner.createdAt,
        updatedAt: owner.updatedAt,
      };
      result.data.data.tasks.push(task);
    }
    task.isNextAction = true;
    task.dueAt ??= owner.nextActionAt;
    owner.nextActionAt = task.dueAt;
    for (const delivery of result.data.data.reminderDeliveries) {
      if (
        delivery.entityType !== 'nextAction' ||
        delivery.entityId !== owner.id
      )
        continue;
      const deliveryKey = `task:${task.id}:${delivery.scheduledFor.getTime()}`;
      if (
        !result.data.data.reminderDeliveries.some(
          (r) => r.deliveryKey === deliveryKey,
        )
      )
        result.data.data.reminderDeliveries.push({
          ...delivery,
          id: `compat_${randomUUID()}`,
          entityType: 'task',
          entityId: task.id,
          deliveryKey,
        });
    }
  }
  return result.data;
}

export async function readBackupRequest(request: Request) {
  const declaredLength = Number(request.headers.get('content-length'));
  if (declaredLength > MAX_BACKUP_BYTES)
    throw new BackupValidationError('备份超过 50 MB，当前数据未修改。');
  if (!request.body)
    throw new BackupValidationError('请选择有效的 JSON 备份，当前数据未修改。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BACKUP_BYTES) {
        await reader.cancel();
        throw new BackupValidationError('备份超过 50 MB，当前数据未修改。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks)
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    ) as unknown;
  } catch {
    throw new BackupValidationError(
      '文件不是有效的 JSON 备份，当前数据未修改。',
    );
  }
}

function readBackupData(client: Database.Database) {
  const db = drizzle(client);
  return {
    opportunities: db.select().from(tables.opportunities).all(),
    stageHistory: db.select().from(tables.stageHistory).all(),
    materials: db.select().from(tables.materials).all(),
    tasks: db.select().from(tables.tasks).all(),
    milestones: db.select().from(tables.milestones).all(),
    materialRequirements: db.select().from(tables.materialRequirements).all(),
    activities: db.select().from(tables.activities).all(),
    extractionDrafts: db.select().from(tables.extractionDrafts).all(),
    reminderDeliveries: db.select().from(tables.reminderDeliveries).all(),
    settings: db.select().from(tables.settings).all(),
  };
}

export function createJsonBackup(client: Database.Database) {
  return client.transaction(() => ({
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    data: readBackupData(client),
  }))();
}

// Parents first on insert, children first on delete. Names/columns only come from the trusted Drizzle schema.
const restoreTables = [
  { key: 'opportunities', table: tables.opportunities },
  { key: 'stageHistory', table: tables.stageHistory },
  { key: 'materials', table: tables.materials },
  { key: 'tasks', table: tables.tasks },
  { key: 'milestones', table: tables.milestones },
  { key: 'materialRequirements', table: tables.materialRequirements },
  { key: 'activities', table: tables.activities },
  { key: 'extractionDrafts', table: tables.extractionDrafts },
  { key: 'reminderDeliveries', table: tables.reminderDeliveries },
  { key: 'settings', table: tables.settings },
] as const;

function replaceRows(client: Database.Database, data: BackupData) {
  for (const { table } of [...restoreTables].reverse())
    client.prepare(`DELETE FROM "${getTableName(table)}"`).run();
  for (const { key, table } of restoreTables) {
    const columns = Object.entries(getTableColumns(table));
    const insert = client.prepare(
      `INSERT INTO "${getTableName(table)}" (${columns.map(([, column]) => `"${column.name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    );
    for (const row of data[key]) {
      const values = columns.map(([name, column]) => {
        const value = (row as Record<string, unknown>)[name];
        return value === null ? null : column.mapToDriverValue(value);
      });
      insert.run(...values);
    }
  }
}

function canonicalRows(data: BackupData) {
  return Object.fromEntries(
    Object.entries(data).map(([key, rows]) => [
      key,
      [...rows].sort((a, b) => {
        const aId = 'id' in a ? a.id : a.key;
        const bId = 'id' in b ? b.id : b.key;
        return aId < bId ? -1 : aId > bId ? 1 : 0;
      }),
    ]),
  );
}

function verifyRestore(client: Database.Database, expected: BackupData) {
  if ((client.pragma('foreign_key_check') as unknown[]).length)
    throw new Error('恢复后外键核对失败');
  const actual = parseBackup({ version: 1, data: readBackupData(client) }).data;
  if (!isDeepStrictEqual(canonicalRows(actual), canonicalRows(expected)))
    throw new Error('恢复后字段核对失败');
}

function createStagingDatabase(client: Database.Database) {
  const staging = new Database(':memory:');
  try {
    staging.pragma('foreign_keys = ON');
    const names = new Set<string>(
      restoreTables.map(({ table }) => getTableName(table)),
    );
    // Reuse the live DDL, not its serialized WAL-mode file header. An in-memory
    // database cannot open the WAL files described by such a header.
    for (const name of names) {
      const row = client
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name) as { sql: string } | undefined;
      if (!row) throw new Error('恢复所需数据表不存在');
      staging.exec(row.sql);
    }
    const indexes = client
      .prepare(
        "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
      )
      .all() as { tbl_name: string; sql: string }[];
    for (const index of indexes)
      if (names.has(index.tbl_name)) staging.exec(index.sql);
    return staging;
  } catch (error) {
    staging.close();
    throw error;
  }
}

function writeDurableFile(filename: string, contents: string | Buffer) {
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function saveRecoverySnapshot(client: Database.Database, snapshotDir: string) {
  fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  const stem = `before-restore-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
  const sqlitePath = path.join(snapshotDir, `${stem}.sqlite`);
  // serialize() includes committed WAL contents; never copy an open app.db file alone.
  writeDurableFile(sqlitePath, client.serialize());
  let json: string;
  try {
    const backup = createJsonBackup(client);
    parseBackup(backup);
    json = JSON.stringify(backup, null, 2);
  } catch {
    // A damaged current JSON field must not prevent recovery from a good backup.
    return { snapshotPath: sqlitePath, recoveryBackupPath: sqlitePath };
  }
  const jsonPath = path.join(snapshotDir, `${stem}.json`);
  writeDurableFile(jsonPath, json);
  return { snapshotPath: sqlitePath, recoveryBackupPath: jsonPath };
}

export function restoreBackup(
  client: Database.Database,
  input: unknown,
  snapshotDir: string,
) {
  const { data } = parseBackup(input);
  if (
    client.pragma('foreign_keys', { simple: true }) !== 1 ||
    client.inTransaction
  )
    throw new Error('恢复需要启用外键的独立事务');
  const staging = createStagingDatabase(client);
  try {
    staging.transaction(() => {
      replaceRows(staging, data);
      verifyRestore(staging, data);
    })();
  } finally {
    staging.close();
  }
  // Keep the live connection and publish all tables in one commit. Swapping app.db
  // while other routes hold SQLite connections would leave them using the old file.
  return client
    .transaction(() => {
      const snapshot = saveRecoverySnapshot(client, snapshotDir);
      replaceRows(client, data);
      // Keep old request IDs as tombstones: delayed pre-restore retries must
      // not execute against the restored dataset. Receipts are not in JSON.
      if (
        client
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mutation_receipts'",
          )
          .get()
      )
        client.prepare('UPDATE mutation_receipts SET invalidated = 1').run();
      verifyRestore(client, data);
      return { restored: true as const, ...snapshot };
    })
    .immediate();
}
