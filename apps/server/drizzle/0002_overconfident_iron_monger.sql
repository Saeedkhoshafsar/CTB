CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`bot_id` text,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_unique` ON `api_tokens` (`token_hash`);