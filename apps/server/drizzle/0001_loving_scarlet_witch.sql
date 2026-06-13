CREATE TABLE `pending_triggers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bot_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`chat_id` integer NOT NULL,
	`entry_node_id` text NOT NULL,
	`user_id` text,
	`item` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_triggers_chat_idx` ON `pending_triggers` (`bot_id`,`flow_id`,`chat_id`,`id`);--> statement-breakpoint
ALTER TABLE `flows` ADD `settings` text DEFAULT '{}' NOT NULL;