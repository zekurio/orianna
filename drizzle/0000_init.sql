CREATE TABLE `karma` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`value` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `karma_guild_id_value_idx` ON `karma` (`guild_id`,`value`);--> statement-breakpoint
CREATE TABLE `karma_bonuses` (
	`message_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`amount` integer NOT NULL,
	`given_at` integer NOT NULL,
	`revoked` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `karma_votes` (
	`message_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`author_id` text NOT NULL,
	`value` integer NOT NULL,
	`voted_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `voter_id`)
);
--> statement-breakpoint
CREATE INDEX `karma_votes_guild_id_voter_id_voted_at_idx` ON `karma_votes` (`guild_id`,`voter_id`,`voted_at`);--> statement-breakpoint
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
CREATE INDEX `polls_guild_id_kind_idx` ON `polls` (`guild_id`,`kind`);--> statement-breakpoint
CREATE TABLE `proposal_images` (
	`poll_id` integer NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`image` blob NOT NULL,
	`content_type` text NOT NULL,
	`expression_id` text,
	PRIMARY KEY(`poll_id`, `position`),
	FOREIGN KEY (`poll_id`) REFERENCES `proposals`(`poll_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`poll_id` integer PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`proposer_id` text NOT NULL,
	`required_yes` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision` text,
	`decided_by` text,
	`reason` text,
	`error` text,
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proposals_guild_id_type_status_idx` ON `proposals` (`guild_id`,`type`,`status`);--> statement-breakpoint
CREATE TABLE `role_menu_reactions` (
	`guild_id` text NOT NULL,
	`menu` text NOT NULL,
	`role_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`guild_id`, `menu`, `role_id`, `user_id`),
	FOREIGN KEY (`guild_id`,`menu`) REFERENCES `role_menus`(`guild_id`,`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `role_menu_reactions_guild_id_user_id_idx` ON `role_menu_reactions` (`guild_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `role_menus` (
	`guild_id` text NOT NULL,
	`name` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`rendered` text NOT NULL,
	PRIMARY KEY(`guild_id`, `name`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_menus_message_id_idx` ON `role_menus` (`message_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`changed_at` integer NOT NULL,
	`changed_by` text,
	`source` text NOT NULL,
	`sections` text NOT NULL,
	`before` text,
	`after` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `settings_changes_guild_id_idx` ON `settings_changes` (`guild_id`);--> statement-breakpoint
CREATE TABLE `starboard_entries` (
	`message_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`author_id` text NOT NULL,
	`post_channel_id` text,
	`post_id` text,
	`count` integer NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	`posted_at` integer NOT NULL,
	`content` text,
	`author_name` text,
	`author_avatar` text,
	`media` text,
	`sent_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `starboard_entries_post_id_idx` ON `starboard_entries` (`post_id`);--> statement-breakpoint
CREATE INDEX `starboard_entries_guild_id_author_id_idx` ON `starboard_entries` (`guild_id`,`author_id`);--> statement-breakpoint
CREATE INDEX `starboard_entries_guild_id_posted_at_idx` ON `starboard_entries` (`guild_id`,`posted_at`);--> statement-breakpoint
CREATE TABLE `starboard_opt_outs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`opted_out_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stored_images` (
	`id` text PRIMARY KEY NOT NULL,
	`image` blob NOT NULL,
	`content_type` text NOT NULL,
	`stored_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `votes` (
	`poll_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`option_key` text NOT NULL,
	`voted_at` integer NOT NULL,
	PRIMARY KEY(`poll_id`, `user_id`, `option_key`),
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `web_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `web_sessions_expires_at_idx` ON `web_sessions` (`expires_at`);