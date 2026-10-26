CREATE TABLE `polls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text,
	`question` text NOT NULL,
	`description` text,
	`options` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`closes_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `polls_slug_idx` ON `polls` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `polls_message_id_idx` ON `polls` (`message_id`);--> statement-breakpoint
CREATE INDEX `polls_status_closes_at_idx` ON `polls` (`status`,`closes_at`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`poll_id` integer PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`image` blob NOT NULL,
	`content_type` text NOT NULL,
	`proposer_id` text NOT NULL,
	`required_yes` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision` text,
	`decided_by` text,
	`reason` text,
	`expression_id` text,
	`error` text,
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proposals_type_status_idx` ON `proposals` (`type`,`status`);--> statement-breakpoint
CREATE TABLE `role_menu_reactions` (
	`menu` text NOT NULL,
	`role_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`menu`, `role_id`, `user_id`),
	FOREIGN KEY (`menu`) REFERENCES `role_menus`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `role_menu_reactions_user_id_idx` ON `role_menu_reactions` (`user_id`);--> statement-breakpoint
CREATE TABLE `role_menus` (
	`name` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`rendered` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_menus_message_id_idx` ON `role_menus` (`message_id`);--> statement-breakpoint
CREATE TABLE `votes` (
	`poll_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`option_key` text NOT NULL,
	`voted_at` integer NOT NULL,
	PRIMARY KEY(`poll_id`, `user_id`, `option_key`),
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE cascade
);
