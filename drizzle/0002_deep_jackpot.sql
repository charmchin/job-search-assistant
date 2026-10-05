ALTER TABLE `opportunities` ADD `decision` text DEFAULT 'undecided' NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `fit_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `interest_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `next_action` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `next_action_at` integer;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `highlights` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `risks` text DEFAULT '[]' NOT NULL;