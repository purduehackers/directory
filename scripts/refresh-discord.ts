import { config } from '../src/lib/server/config';
import { ensureDbInitialized } from '../src/lib/server/db';
import { discordProfiles, type DiscordProfileRow } from '../src/lib/server/db/schema';
import {
  formatDiscordUsername,
  buildAvatarUrl,
} from '../src/lib/server/discord-resolver';

async function main() {
  console.log('[Refresh Discord] Initializing database...');
  const db = await ensureDbInitialized();

  if (!config.discordBotToken) {
    console.error('[Refresh Discord] Error: DISCORD_BOT_TOKEN is not configured.');
    process.exit(1);
  }

  const now = Date.now();
  const expiresAt = now + config.discordCacheTtlMs;

  console.log('[Refresh Discord] Clearing old discord_profiles cache...');
  await db.delete(discordProfiles);

  let totalGuildHydrated = 0;
  let totalWithNicknames = 0;

  if (config.discordGuildId) {
    console.log(`[Refresh Discord] Fetching members from guild ${config.discordGuildId}...`);
    let after: string | undefined = undefined;

    while (true) {
      const url = new URL(`https://discord.com/api/v10/guilds/${config.discordGuildId}/members`);
      url.searchParams.set('limit', '1000');
      if (after) {
        url.searchParams.set('after', after);
      }

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bot ${config.discordBotToken}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[Refresh Discord] Guild fetch failed (${res.status}): ${text}`);
        break;
      }

      const members = (await res.json()) as Array<{
        user?: {
          id: string;
          username: string;
          discriminator?: string;
          global_name?: string | null;
          avatar?: string | null;
        };
        nick?: string | null;
      }>;

      if (!members || members.length === 0) break;

      for (const m of members) {
        const user = m.user;
        if (!user || !user.id || !user.username) continue;

        if (m.nick) {
          totalWithNicknames++;
        }

        const row: DiscordProfileRow = {
          discordId: user.id,
          username: formatDiscordUsername(user),
          globalName: user.global_name ?? null,
          guildNickname: m.nick ?? null,
          avatarUrl: buildAvatarUrl(user),
          status: 'resolved',
          fetchedAt: now,
          expiresAt,
        };

        await db
          .insert(discordProfiles)
          .values(row)
          .onConflictDoUpdate({
            target: discordProfiles.discordId,
            set: {
              username: row.username,
              globalName: row.globalName,
              guildNickname: row.guildNickname,
              avatarUrl: row.avatarUrl,
              status: row.status,
              fetchedAt: row.fetchedAt,
              expiresAt: row.expiresAt,
            },
          });

        totalGuildHydrated++;
      }

      if (members.length < 1000) {
        break; // Reached end of guild members
      }
      after = members[members.length - 1].user?.id;
    }
  }

  console.log(`[Refresh Discord] Successfully refreshed ${totalGuildHydrated} Discord profiles!`);
  console.log(`[Refresh Discord] Members with guild nicknames: ${totalWithNicknames}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[Refresh Discord] Fatal error:', err);
  process.exit(1);
});
