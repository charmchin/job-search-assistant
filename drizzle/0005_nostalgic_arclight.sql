CREATE TABLE IF NOT EXISTS `stage_history` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`from_stage` text,
	`to_stage` text NOT NULL,
	`occurred_at` integer,
	`recorded_at` integer NOT NULL,
	`source` text NOT NULL,
	`valid` integer DEFAULT true NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_stage_history_opportunity` ON `stage_history` (`opportunity_id`,`recorded_at`);--> statement-breakpoint
ALTER TABLE `opportunities` ADD `closed_reason` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
UPDATE opportunities SET closed_reason = 'withdrawn'
WHERE stage = 'closed' AND decision = 'skip' AND closed_reason = 'unknown';
--> statement-breakpoint
-- Older databases know only the current stage, not when it was entered or any prior stages.
INSERT INTO stage_history (id, opportunity_id, from_stage, to_stage, occurred_at, recorded_at, source, valid, notes)
SELECT 'legacy_' || o.id, o.id, NULL, o.stage, NULL, o.updated_at, 'legacy', 1,
       '旧数据当前阶段快照；进入时间及此前经历未知。'
FROM opportunities o WHERE NOT EXISTS (SELECT 1 FROM stage_history h WHERE h.opportunity_id = o.id);
