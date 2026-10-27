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
INSERT INTO `proposal_images` (`poll_id`, `position`, `name`, `image`, `content_type`, `expression_id`)
SELECT `poll_id`, 0, `name`, `image`, `content_type`, `expression_id` FROM `proposals`;
--> statement-breakpoint
ALTER TABLE `proposals` DROP COLUMN `image`;--> statement-breakpoint
ALTER TABLE `proposals` DROP COLUMN `content_type`;--> statement-breakpoint
ALTER TABLE `proposals` DROP COLUMN `expression_id`;