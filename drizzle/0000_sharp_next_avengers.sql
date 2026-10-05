CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`type` text DEFAULT 'note' NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_activities_opportunity_created` ON `activities` (`opportunity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `extraction_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`source_text` text NOT NULL,
	`extracted_json` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `material_requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`material_id` text,
	`name` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_material_requirements_opportunity` ON `material_requirements` (`opportunity_id`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`file_path` text DEFAULT '' NOT NULL,
	`version` text DEFAULT '' NOT NULL,
	`category` text DEFAULT '其他' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text NOT NULL,
	`title` text NOT NULL,
	`scheduled_at` integer,
	`result` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reminder_offsets` text DEFAULT '[10080,4320,1440,0]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_milestones_opportunity_time` ON `milestones` (`opportunity_id`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`organization` text NOT NULL,
	`role` text NOT NULL,
	`direction` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`source_name` text DEFAULT '' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`stage` text DEFAULT 'evaluating' NOT NULL,
	`deadline` integer,
	`tags` text DEFAULT '[]' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`special_notes` text DEFAULT '' NOT NULL,
	`review` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_opportunities_stage_updated` ON `opportunities` (`stage`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_opportunities_deadline` ON `opportunities` (`deadline`);--> statement-breakpoint
CREATE INDEX `idx_opportunities_last_activity` ON `opportunities` (`last_activity_at`);--> statement-breakpoint
CREATE TABLE `reminder_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`delivered_at` integer NOT NULL,
	`delivery_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reminder_delivery_key` ON `reminder_deliveries` (`delivery_key`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`opportunity_id` text,
	`title` text NOT NULL,
	`due_at` integer,
	`estimated_minutes` integer DEFAULT 30 NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status_due` ON `tasks` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_opportunity` ON `tasks` (`opportunity_id`);