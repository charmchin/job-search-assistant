ALTER TABLE `tasks` ADD `is_next_action` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_tasks_next_action` ON `tasks` (`opportunity_id`) WHERE "tasks"."is_next_action" = 1;
--> statement-breakpoint
UPDATE tasks SET is_next_action = 1 WHERE id IN (
 SELECT (SELECT t.id FROM tasks t WHERE t.opportunity_id=o.id AND t.status IN ('todo','doing') AND t.title=o.next_action
 AND (t.due_at IS o.next_action_at OR t.due_at IS NULL OR o.next_action_at IS NULL)
 ORDER BY (t.due_at IS o.next_action_at) DESC, t.id LIMIT 1)
 FROM opportunities o WHERE trim(o.next_action) <> '' AND NOT EXISTS (SELECT 1 FROM tasks WHERE opportunity_id=o.id AND is_next_action=1)
);
--> statement-breakpoint
INSERT INTO tasks (id, opportunity_id, title, due_at, estimated_minutes, status, source, is_next_action, created_at, updated_at)
 SELECT 'next_' || lower(hex(randomblob(16))), o.id, o.next_action, o.next_action_at, 30, 'todo', 'manual', 1, o.created_at, o.updated_at
 FROM opportunities o WHERE trim(o.next_action) <> '' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.opportunity_id=o.id AND t.is_next_action=1);
--> statement-breakpoint
UPDATE tasks SET due_at=(SELECT next_action_at FROM opportunities WHERE id=tasks.opportunity_id)
 WHERE is_next_action=1 AND due_at IS NULL;
--> statement-breakpoint
UPDATE opportunities SET next_action_at=(SELECT due_at FROM tasks WHERE opportunity_id=opportunities.id AND is_next_action=1)
 WHERE EXISTS (SELECT 1 FROM tasks WHERE opportunity_id=opportunities.id AND is_next_action=1);
--> statement-breakpoint
INSERT OR IGNORE INTO reminder_deliveries (id,entity_type,entity_id,scheduled_for,delivered_at,delivery_key)
 SELECT 'compat_' || lower(hex(randomblob(16))), 'task', t.id, r.scheduled_for, r.delivered_at, 'task:' || t.id || ':' || r.scheduled_for
 FROM reminder_deliveries r JOIN tasks t ON t.opportunity_id=r.entity_id AND t.is_next_action=1
 WHERE r.entity_type='nextAction';
