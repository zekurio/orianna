CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`changed_at` integer NOT NULL,
	`changed_by` text,
	`source` text NOT NULL,
	`sections` text NOT NULL,
	`before` text,
	`after` text NOT NULL
);
