CREATE TABLE `stored_images` (
	`id` text PRIMARY KEY NOT NULL,
	`image` blob NOT NULL,
	`content_type` text NOT NULL,
	`stored_at` integer NOT NULL
);
