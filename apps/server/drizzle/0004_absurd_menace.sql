CREATE TABLE `ai_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bot_id` text NOT NULL,
	`flow_id` text,
	`execution_id` text,
	`credential_id` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`day` text NOT NULL,
	`ts` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_usage_bot_day_idx` ON `ai_usage` (`bot_id`,`day`);--> statement-breakpoint
CREATE INDEX `ai_usage_bot_cred_idx` ON `ai_usage` (`bot_id`,`credential_id`);