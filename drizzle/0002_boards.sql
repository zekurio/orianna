CREATE TABLE `board_entries` (
	`message_id` text NOT NULL,
	`board` text NOT NULL,
	`channel_id` text NOT NULL,
	`author_id` text NOT NULL,
	`post_channel_id` text,
	`post_id` text,
	`count` integer NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	`posted_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `board`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_entries_post_id_idx` ON `board_entries` (`post_id`);--> statement-breakpoint
CREATE INDEX `board_entries_board_author_id_idx` ON `board_entries` (`board`,`author_id`);--> statement-breakpoint
CREATE TABLE `board_opt_outs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`opted_out_at` integer NOT NULL
);
