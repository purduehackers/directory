import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export type SocialLinks = {
  github?: string;
  x?: string;
  linkedin?: string;
  instagram?: string;
  youtube?: string;
  bluesky?: string;
  mastodon?: string;
};

export type CustomLink = {
  label: string;
  url: string;
};

export type ContactVisibility = {
  emails?: Record<string, boolean>; // email -> boolean (true = visible, false = hidden)
  phone?: boolean; // default true
};

export const memberProfiles = sqliteTable('member_profiles', {
  sub: text('sub').primaryKey(),
  headline: text('headline'),
  bio: text('bio'),
  location: text('location'),
  timezone: text('timezone'),
  websiteUrl: text('website_url'),
  socialsJson: text('socials_json').notNull().default('{}'),
  customLinksJson: text('custom_links_json').notNull().default('[]'),
  contactVisibilityJson: text('contact_visibility_json').notNull().default('{}'),
  updatedAt: integer('updated_at').notNull(),
});

export type MemberProfileRow = typeof memberProfiles.$inferSelect;

export type MemberProfile = {
  sub: string;
  headline: string | null;
  bio: string | null;
  location: string | null;
  timezone: string | null;
  websiteUrl: string | null;
  socials: SocialLinks;
  customLinks: CustomLink[];
  contactVisibility: ContactVisibility;
  updatedAt: number;
};

export type DiscordResolutionStatus = 'resolved' | 'not_found' | 'error';

export type DiscordProfileRow = {
  discordId: string;
  username: string | null;
  globalName: string | null;
  guildNickname: string | null;
  avatarUrl: string | null;
  status: DiscordResolutionStatus;
  fetchedAt: number;
  expiresAt: number;
};

export type DiscordProfile = {
  discordId: string;
  username: string;
  globalName: string | null;
  guildNickname: string | null;
  avatarUrl: string | null;
  fetchedAt: number;
  expiresAt: number;
};

