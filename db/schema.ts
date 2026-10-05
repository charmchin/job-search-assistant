import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const opportunities = sqliteTable(
  'opportunities',
  {
    id: text('id').primaryKey(),
    organization: text('organization').notNull(),
    role: text('role').notNull(),
    direction: text('direction').notNull().default(''),
    location: text('location').notNull().default(''),
    sourceName: text('source_name').notNull().default(''),
    sourceUrl: text('source_url').notNull().default(''),
    description: text('description').notNull().default(''),
    priority: text('priority', { enum: ['high', 'medium', 'low'] })
      .notNull()
      .default('medium'),
    stage: text('stage').notNull().default('evaluating'),
    closedReason: text('closed_reason', {
      enum: ['unknown', 'rejected', 'withdrawn'],
    })
      .notNull()
      .default('unknown'),
    deadline: integer('deadline', { mode: 'timestamp_ms' }),
    reminderDays: text('reminder_days', { mode: 'json' })
      .$type<number[]>()
      .notNull()
      .default(sql`'[7,3,1,0]'`),
    tags: text('tags', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    notes: text('notes').notNull().default(''),
    specialNotes: text('special_notes').notNull().default(''),
    decision: text('decision', {
      enum: ['undecided', 'pursue', 'hold', 'skip'],
    })
      .notNull()
      .default('undecided'),
    fitScore: integer('fit_score').notNull().default(0),
    interestScore: integer('interest_score').notNull().default(0),
    nextAction: text('next_action').notNull().default(''),
    nextActionAt: integer('next_action_at', { mode: 'timestamp_ms' }),
    highlights: text('highlights', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    risks: text('risks', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    review: text('review').notNull().default(''),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    lastActivityAt: integer('last_activity_at', {
      mode: 'timestamp_ms',
    }).notNull(),
  },
  (table) => [
    index('idx_opportunities_stage_updated').on(table.stage, table.updatedAt),
    index('idx_opportunities_deadline').on(table.deadline),
    index('idx_opportunities_last_activity').on(table.lastActivityAt),
  ],
);

export const stageHistory = sqliteTable(
  'stage_history',
  {
    id: text('id').primaryKey(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    fromStage: text('from_stage'),
    toStage: text('to_stage').notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull(),
    source: text('source', {
      enum: ['initial', 'transition', 'legacy', 'manual'],
    }).notNull(),
    valid: integer('valid', { mode: 'boolean' }).notNull().default(true),
    notes: text('notes').notNull().default(''),
  },
  (table) => [
    index('idx_stage_history_opportunity').on(
      table.opportunityId,
      table.recordedAt,
    ),
  ],
);

export const milestones = sqliteTable(
  'milestones',
  {
    id: text('id').primaryKey(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    scheduledAt: integer('scheduled_at', { mode: 'timestamp_ms' }),
    result: text('result').notNull().default(''),
    status: text('status', { enum: ['pending', 'done', 'skipped'] })
      .notNull()
      .default('pending'),
    reminderOffsets: text('reminder_offsets', { mode: 'json' })
      .$type<number[]>()
      .notNull()
      .default(sql`'[10080,4320,1440,0]'`),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('idx_milestones_opportunity_time').on(
      table.opportunityId,
      table.scheduledAt,
    ),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    dueAt: integer('due_at', { mode: 'timestamp_ms' }),
    estimatedMinutes: integer('estimated_minutes').notNull().default(30),
    status: text('status', { enum: ['todo', 'doing', 'done', 'skipped'] })
      .notNull()
      .default('todo'),
    source: text('source', { enum: ['manual', 'ai', 'rule'] })
      .notNull()
      .default('manual'),
    isNextAction: integer('is_next_action', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('idx_tasks_status_due').on(table.status, table.dueAt),
    index('idx_tasks_opportunity').on(table.opportunityId),
    uniqueIndex('idx_tasks_next_action')
      .on(table.opportunityId)
      .where(sql`${table.isNextAction} = 1`),
  ],
);

export const materials = sqliteTable('materials', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  filePath: text('file_path').notNull().default(''),
  version: text('version').notNull().default(''),
  category: text('category').notNull().default('其他'),
  notes: text('notes').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const materialRequirements = sqliteTable(
  'material_requirements',
  {
    id: text('id').primaryKey(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    materialId: text('material_id').references(() => materials.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    completed: integer('completed', { mode: 'boolean' })
      .notNull()
      .default(false),
    notes: text('notes').notNull().default(''),
  },
  (table) => [
    index('idx_material_requirements_opportunity').on(table.opportunityId),
  ],
);

export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('note'),
    content: text('content').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('idx_activities_opportunity_created').on(
      table.opportunityId,
      table.createdAt,
    ),
  ],
);

export const extractionDrafts = sqliteTable('extraction_drafts', {
  id: text('id').primaryKey(),
  sourceUrl: text('source_url').notNull().default(''),
  sourceText: text('source_text').notNull(),
  extractedJson: text('extracted_json', { mode: 'json' })
    .$type<Record<string, unknown>>()
    .notNull(),
  evidenceJson: text('evidence_json', { mode: 'json' })
    .$type<Record<string, string>>()
    .notNull()
    .default(sql`'{}'`),
  confidence: real('confidence').notNull().default(0),
  status: text('status', { enum: ['pending', 'confirmed', 'discarded'] })
    .notNull()
    .default('pending'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const reminderDeliveries = sqliteTable(
  'reminder_deliveries',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    scheduledFor: integer('scheduled_for', { mode: 'timestamp_ms' }).notNull(),
    deliveredAt: integer('delivered_at', { mode: 'timestamp_ms' }).notNull(),
    deliveryKey: text('delivery_key').notNull(),
  },
  (table) => [uniqueIndex('idx_reminder_delivery_key').on(table.deliveryKey)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// Internal receipts: no payloads or API keys, excluded from user JSON backups.
export const mutationReceipts = sqliteTable('mutation_receipts', {
  requestId: text('request_id').primaryKey(),
  requestHash: text('request_hash').notNull(),
  responseJson: text('response_json').notNull(),
  invalidated: integer('invalidated', { mode: 'boolean' })
    .notNull()
    .default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
