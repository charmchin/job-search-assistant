CREATE TABLE IF NOT EXISTS `mutation_receipts` (
	`request_id` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`invalidated` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
