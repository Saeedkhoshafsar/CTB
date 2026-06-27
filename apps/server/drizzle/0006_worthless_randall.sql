CREATE TABLE `panel_admins` (
	`tg_user_id` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'admin' NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL
);
