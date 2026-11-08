CREATE TABLE IF NOT EXISTS `member_profiles` (
	`sub` text PRIMARY KEY NOT NULL,
	`headline` text,
	`bio` text,
	`location` text,
	`timezone` text,
	`website_url` text,
	`socials_json` text DEFAULT '{}' NOT NULL,
	`custom_links_json` text DEFAULT '[]' NOT NULL,
	`contact_visibility_json` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
