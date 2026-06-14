CREATE TABLE `instance_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`secret` text,
	`events` text NOT NULL,
	`bot_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`last_fired_at` text,
	`last_error` text,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
