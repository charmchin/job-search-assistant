import fs from 'node:fs';
import { asc, count, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { isStale, compareTasks } from './domain';
import {
  deleteVersion,
  opportunityDeleteVersion,
  materialDeleteVersion,
} from './delete-version';

export function groupByOpportunity<T extends { opportunityId: string | null }>(
  rows: T[],
) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const owner = row.opportunityId;
    if (!owner) continue;
    const group = grouped.get(owner);
    if (group) group.push(row);
    else grouped.set(owner, [row]);
  }
  return grouped;
}

// A synchronous read transaction gives all tables one SQLite snapshot.
// History bodies and extraction bodies are loaded only through paged reads.
export function readWorkspaceState(
  db: BetterSQLite3Database<typeof schema>,
  now = new Date(),
  fileExists = (file: string) => fs.existsSync(file),
) {
  const {
    opportunities,
    tasks,
    milestones,
    materials,
    materialRequirements,
    settings,
    extractionDrafts,
    stageHistory,
    activities,
  } = schema;
  const rows = db.transaction((tx) => ({
    opportunities: tx
      .select()
      .from(opportunities)
      .orderBy(desc(opportunities.updatedAt))
      .all(),
    tasks: tx.select().from(tasks).orderBy(asc(tasks.dueAt)).all(),
    milestones: tx
      .select()
      .from(milestones)
      .orderBy(asc(milestones.scheduledAt))
      .all(),
    materials: tx
      .select()
      .from(materials)
      .orderBy(desc(materials.updatedAt))
      .all(),
    requirements: tx.select().from(materialRequirements).all(),
    settings: tx.select().from(settings).all(),
    stageHistory: tx
      .select()
      .from(stageHistory)
      .orderBy(desc(stageHistory.recordedAt), desc(stageHistory.id))
      .all(),
    pendingDraftCount: tx
      .select({ value: count() })
      .from(extractionDrafts)
      .where(eq(extractionDrafts.status, 'pending'))
      .get()!.value,
    activityCounts: tx
      .select({ opportunityId: activities.opportunityId, value: count() })
      .from(activities)
      .groupBy(activities.opportunityId)
      .all(),
  }));
  const opportunityMap = new Map(
    rows.opportunities.map((item) => [item.id, item]),
  );
  const taskMap = groupByOpportunity(rows.tasks);
  const milestoneMap = groupByOpportunity(rows.milestones);
  const requirementMap = groupByOpportunity(rows.requirements);
  const historyMap = groupByOpportunity(rows.stageHistory);
  const activityCounts = new Map(
    rows.activityCounts.map((row) => [row.opportunityId, row.value]),
  );
  const requirements = rows.requirements.map((item) => ({
    ...item,
    deleteVersion: deleteVersion(item),
  }));
  const requirementViews = new Map(requirements.map((item) => [item.id, item]));
  const materialLinks = new Map<string, typeof rows.requirements>();
  for (const row of rows.requirements)
    if (row.materialId) {
      const links = materialLinks.get(row.materialId);
      if (links) links.push(row);
      else materialLinks.set(row.materialId, [row]);
    }
  const settingMap = Object.fromEntries(
    rows.settings.map((item) => [item.key, item.value]),
  );
  const configured = Number(settingMap.staleDays || 5);
  const staleDays =
    Number.isInteger(configured) && configured >= 1 && configured <= 30
      ? configured
      : 5;
  const fileCache = new Map<string, boolean>();
  return {
    now: now.toISOString(),
    opportunities: rows.opportunities.map((item) => ({
      ...item,
      deleteVersion: opportunityDeleteVersion(
        item,
        taskMap.get(item.id) ?? [],
        milestoneMap.get(item.id) ?? [],
        requirementMap.get(item.id) ?? [],
        historyMap.get(item.id) ?? [],
        activityCounts.get(item.id) ?? 0,
      ),
      stageHistory: historyMap.get(item.id) ?? [],
      stale: isStale(
        item.lastActivityAt,
        item.stage,
        now,
        staleDays,
        item.decision,
      ),
      tasks: taskMap.get(item.id) ?? [],
      milestones: milestoneMap.get(item.id) ?? [],
      requirements: (requirementMap.get(item.id) ?? []).map((row) =>
        requirementViews.get(row.id)!,
      ),
      activities: [], // Compatibility field; use section=activities for records.
    })),
    tasks: rows.tasks
      .map((task) => ({
        ...task,
        opportunity: task.opportunityId
          ? (opportunityMap.get(task.opportunityId) ?? null)
          : null,
      }))
      .sort((a, b) => compareTasks(a, b, now)),
    milestones: rows.milestones,
    materials: rows.materials.map((material) => {
      const file = material.filePath;
      if (!fileCache.has(file))
        fileCache.set(file, Boolean(file && fileExists(file)));
      return {
        ...material,
        fileExists: fileCache.get(file)!,
        deleteVersion: materialDeleteVersion(
          material,
          materialLinks.get(material.id) ?? [],
        ),
      };
    }),
    requirements,
    drafts: [], // Bodies are intentionally absent from periodic state refreshes.
    pendingDraftCount: rows.pendingDraftCount,
    settings: settingMap,
  };
}
