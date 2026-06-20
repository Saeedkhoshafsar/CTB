CREATE TABLE `api_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_id` text,
	`bot_id` text,
	`action` text NOT NULL,
	`method` text NOT NULL,
	`route` text NOT NULL,
	`target_id` text,
	`status` integer NOT NULL,
	`ts` text NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `api_audit_ts_idx` ON `api_audit` (`ts`);--> statement-breakpoint
CREATE INDEX `api_audit_token_idx` ON `api_audit` (`token_id`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `rate_limit_per_min` integer DEFAULT 120 NOT NULL;