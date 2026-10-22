CREATE TABLE `emoji_proposals` (
	`poll_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`image` blob NOT NULL,
	`content_type` text NOT NULL,
	`proposer_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision` text,
	`decided_by` text,
	`reason` text,
	`emoji_id` text,
	`error` text,
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `emoji_proposals_status_idx` ON `emoji_proposals` (`status`);--> statement-breakpoint
CREATE TABLE `polls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
CREATE UNIQUE INDEX `polls_message_id_idx` ON `polls` (`message_id`);--> statement-breakpoint
CREATE INDEX `polls_status_closes_at_idx` ON `polls` (`status`,`closes_at`);--> statement-breakpoint
CREATE TABLE `votes` (
	`poll_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`option_key` text NOT NULL,
	`voted_at` integer NOT NULL,
	PRIMARY KEY(`poll_id`, `user_id`, `option_key`),
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE cascade
);
