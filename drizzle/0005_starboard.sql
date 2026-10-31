DROP TABLE `board_entries`;--> statement-breakpoint
DROP TABLE `board_opt_outs`;--> statement-breakpoint
CREATE TABLE `starboard_entries` (
	`message_id` text PRIMARY KEY NOT NULL,
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
CREATE INDEX `starboard_entries_author_id_idx` ON `starboard_entries` (`author_id`);--> statement-breakpoint
CREATE TABLE `starboard_opt_outs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`opted_out_at` integer NOT NULL
);
