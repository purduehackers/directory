import { config } from './config';
import type { DiscordProfile, DiscordProfileRow } from './db/schema';
import { runtimeCache, resetRuntimeCacheForTesting } from './runtime-cache';
import { waitUntil } from '@vercel/functions';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const SNOWFLAKE_REGEX = /^\d{17,20}$/;

export const DISCORD_CACHE_TAG = 'discord-profiles';
const DISCORD_USER_KEY_PREFIX = 'discord:user:v1:';
const DISCORD_GUILD_WARMUP_PREFIX = 'discord:guild-warmup:v1:';

const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for 404 Not Found tombstones
const ERROR_BACKOFF_TTL_MS = 15 * 60 * 1000; // 15 minutes for 5xx / network / rate-limit errors
const GUILD_WARMUP_TTL_MS = 60 * 60 * 1000; // 1 hour marker for bulk guild member warmup
const FETCH_TIMEOUT_MS = 4_000;

// Serverless safety budgets so cold starts never exceed function timeout
const MAX_CONCURRENCY = 4;
const MAX_LIVE_FETCHES_PER_REQUEST = 15;
const MAX_RESOLUTION_BUDGET_MS = 3_500;

type DiscordApiUser = {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  avatar?: string | null;
};

type DiscordApiGuildMember = {
  user?: DiscordApiUser;
  nick?: string | null;
};

let memoryRowsCache: Map<string, DiscordProfileRow> | null = null;
let publicProfilesCache: Map<string, DiscordProfile> | null = null;
let missingTokenWarned = false;
let devSeeded = false;
let onProfilesUpdatedCallback: (() => void) | null = null;

export function registerDiscordUpdateListener(cb: () => void): void {
  onProfilesUpdatedCallback = cb;
}

function getUserCacheKey(discordId: string): string {
  return `${DISCORD_USER_KEY_PREFIX}${discordId}`;
}

function getGuildWarmupKey(guildId: string): string {
  return `${DISCORD_GUILD_WARMUP_PREFIX}${guildId}`;
}

function computeResolvedExpiry(now = Date.now()): number {
  // ±12 hours random jitter (clamped to at least 1 hour) to avoid synchronized cache stampedes
  const jitterMs = Math.floor((Math.random() - 0.5) * 24 * 60 * 60 * 1000);
  const ttlMs = Math.max(60 * 60 * 1000, config.discordCacheTtlMs + jitterMs);
  return now + ttlMs;
}

export function formatDiscordUsername(user: DiscordApiUser): string {
  if (user.discriminator && user.discriminator !== '0') {
    return `${user.username}#${user.discriminator}`;
  }
  return user.username;
}

export function buildAvatarUrl(user: DiscordApiUser): string | null {
  if (!user.avatar) return null;
  const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

export function rowToDiscordProfile(row: DiscordProfileRow | undefined): DiscordProfile | null {
  if (!row || row.status !== 'resolved' || !row.username) {
    return null;
  }
  return {
    discordId: row.discordId,
    username: row.username,
    globalName: row.globalName ?? null,
    guildNickname: row.guildNickname ?? null,
    avatarUrl: row.avatarUrl ?? null,
    fetchedAt: row.fetchedAt,
    expiresAt: row.expiresAt,
  };
}

function ensureL1Maps(): {
  rows: Map<string, DiscordProfileRow>;
  publicMap: Map<string, DiscordProfile>;
} {
  if (!memoryRowsCache) {
    memoryRowsCache = new Map();
  }
  if (!publicProfilesCache) {
    publicProfilesCache = new Map();
  }
  return { rows: memoryRowsCache, publicMap: publicProfilesCache };
}

function setL1Row(row: DiscordProfileRow): void {
  const { rows, publicMap } = ensureL1Maps();
  rows.set(row.discordId, row);
  const pub = rowToDiscordProfile(row);
  if (pub) {
    publicMap.set(row.discordId, pub);
  } else {
    publicMap.delete(row.discordId);
  }
}

export function getDevMockDiscordProfiles(): Map<string, DiscordProfileRow> {
  const now = Date.now();
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
  return new Map<string, DiscordProfileRow>([
    [
      '123456789012345678',
      {
        discordId: '123456789012345678',
        username: 'artusm',
        globalName: 'Artus Mosquet',
        guildNickname: 'artus',
        avatarUrl: null,
        status: 'resolved',
        fetchedAt: now,
        expiresAt,
      },
    ],
    [
      '987654321098765432',
      {
        discordId: '987654321098765432',
        username: 'clara.oswald',
        globalName: 'Clara Oswald',
        guildNickname: 'The Impossible Girl',
        avatarUrl: null,
        status: 'resolved',
        fetchedAt: now,
        expiresAt,
      },
    ],
    [
      '456123789456123789',
      {
        discordId: '456123789456123789',
        username: 'alexc',
        globalName: 'Alex Chen',
        guildNickname: null,
        avatarUrl: null,
        status: 'resolved',
        fetchedAt: now,
        expiresAt,
      },
    ],
  ]);
}

export function getCachedDiscordProfilesMap(): ReadonlyMap<string, DiscordProfile> {
  if (publicProfilesCache) return publicProfilesCache;
  if (!memoryRowsCache) return new Map();
  const result = new Map<string, DiscordProfile>();
  for (const [id, row] of memoryRowsCache.entries()) {
    const pub = rowToDiscordProfile(row);
    if (pub) result.set(id, pub);
  }
  publicProfilesCache = result;
  return result;
}

export async function upsertDiscordProfileRow(row: DiscordProfileRow): Promise<void> {
  setL1Row(row);
  const ttlMs = Math.max(1_000, row.expiresAt - Date.now());
  await runtimeCache.set(getUserCacheKey(row.discordId), row, {
    ttlMs,
    tags: [DISCORD_CACHE_TAG, `discord-user:${row.discordId}`],
    name: `discord-profile:${row.discordId}`,
  });
}

async function upsertDiscordProfileRowsBatch(rows: DiscordProfileRow[]): Promise<void> {
  if (rows.length === 0) return;
  const now = Date.now();
  await Promise.all(
    rows.map((row) => {
      setL1Row(row);
      const ttlMs = Math.max(1_000, row.expiresAt - now);
      return runtimeCache.set(getUserCacheKey(row.discordId), row, {
        ttlMs,
        tags: [DISCORD_CACHE_TAG, `discord-user:${row.discordId}`],
        name: `discord-profile:${row.discordId}`,
      });
    })
  );
}

async function tryGuildBulkWarmup(force = false, targetIds?: ReadonlySet<string>): Promise<number> {
  const guildId = config.discordGuildId;
  const botToken = config.discordBotToken;
  if (!guildId || !botToken) return 0;

  const warmupKey = getGuildWarmupKey(guildId);
  if (!force) {
    const alreadyWarmed = await runtimeCache.get<boolean>(warmupKey);
    if (alreadyWarmed) return 0;
  }

  try {
    const url = `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}/members?limit=1000`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bot ${botToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      await runtimeCache.set(warmupKey, true, {
        ttlMs: ERROR_BACKOFF_TTL_MS,
        tags: [DISCORD_CACHE_TAG],
        name: 'discord-guild-warmup-backoff',
      });
      return 0;
    }

    const members = (await res.json()) as DiscordApiGuildMember[];
    const now = Date.now();
    const rowsToPersist: DiscordProfileRow[] = [];

    for (const m of members) {
      const user = m.user;
      if (!user || !user.id || !user.username) continue;
      // Only persist L2 entries for Discord accounts that actually belong to directory members
      if (targetIds && !targetIds.has(user.id)) continue;
      rowsToPersist.push({
        discordId: user.id,
        username: formatDiscordUsername(user),
        globalName: user.global_name ?? null,
        guildNickname: m.nick ?? null,
        avatarUrl: buildAvatarUrl(user),
        status: 'resolved',
        fetchedAt: now,
        expiresAt: computeResolvedExpiry(now),
      });
    }

    await upsertDiscordProfileRowsBatch(rowsToPersist);
    await runtimeCache.set(warmupKey, true, {
      ttlMs: GUILD_WARMUP_TTL_MS,
      tags: [DISCORD_CACHE_TAG],
      name: 'discord-guild-warmup',
    });

    return rowsToPersist.length;
  } catch (err) {
    console.warn('[Discord Resolver] Guild bulk warmup failed:', err);
    return 0;
  }
}

async function fetchSingleDiscordProfileReadThrough(
  discordId: string
): Promise<{ row: DiscordProfileRow; rateLimited: boolean }> {
  const now = Date.now();
  const botToken = config.discordBotToken;
  const guildId = config.discordGuildId;

  // 1. Try Guild Member endpoint first if DISCORD_GUILD_ID is configured (captures server nickname)
  if (guildId) {
    try {
      const guildUrl = `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordId)}`;
      const guildRes = await fetch(guildUrl, {
        headers: {
          Authorization: `Bot ${botToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (guildRes.status === 429) {
        const existing = memoryRowsCache?.get(discordId);
        const backoffRow: DiscordProfileRow = existing
          ? { ...existing, expiresAt: now + ERROR_BACKOFF_TTL_MS }
          : {
              discordId,
              username: null,
              globalName: null,
              guildNickname: null,
              avatarUrl: null,
              status: 'error',
              fetchedAt: now,
              expiresAt: now + ERROR_BACKOFF_TTL_MS,
            };
        await upsertDiscordProfileRow(backoffRow);
        return { row: backoffRow, rateLimited: true };
      }

      if (guildRes.ok) {
        const memberData = (await guildRes.json()) as DiscordApiGuildMember;
        if (memberData.user && memberData.user.username) {
          const resolvedRow: DiscordProfileRow = {
            discordId,
            username: formatDiscordUsername(memberData.user),
            globalName: memberData.user.global_name ?? null,
            guildNickname: memberData.nick ?? null,
            avatarUrl: buildAvatarUrl(memberData.user),
            status: 'resolved',
            fetchedAt: now,
            expiresAt: computeResolvedExpiry(now),
          };
          await upsertDiscordProfileRow(resolvedRow);
          return { row: resolvedRow, rateLimited: false };
        }
      }
    } catch (err) {
      console.warn(`[Discord Resolver] Guild member lookup error for ${discordId}:`, err);
    }
  }

  // 2. Fallback to global /users/:id endpoint
  try {
    const userUrl = `${DISCORD_API_BASE}/users/${encodeURIComponent(discordId)}`;
    const userRes = await fetch(userUrl, {
      headers: {
        Authorization: `Bot ${botToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (userRes.status === 429) {
      const existing = memoryRowsCache?.get(discordId);
      const backoffRow: DiscordProfileRow = existing
        ? { ...existing, expiresAt: now + ERROR_BACKOFF_TTL_MS }
        : {
            discordId,
            username: null,
            globalName: null,
            guildNickname: null,
            avatarUrl: null,
            status: 'error',
            fetchedAt: now,
            expiresAt: now + ERROR_BACKOFF_TTL_MS,
          };
      await upsertDiscordProfileRow(backoffRow);
      return { row: backoffRow, rateLimited: true };
    }

    if (userRes.status === 404) {
      // 24-hour Negative Cache Tombstone for non-existent / deleted Discord accounts
      const tombstoneRow: DiscordProfileRow = {
        discordId,
        username: null,
        globalName: null,
        guildNickname: null,
        avatarUrl: null,
        status: 'not_found',
        fetchedAt: now,
        expiresAt: now + NEGATIVE_CACHE_TTL_MS,
      };
      await upsertDiscordProfileRow(tombstoneRow);
      return { row: tombstoneRow, rateLimited: false };
    }

    if (!userRes.ok) {
      const existing = memoryRowsCache?.get(discordId);
      const errRow: DiscordProfileRow = existing
        ? { ...existing, expiresAt: now + ERROR_BACKOFF_TTL_MS }
        : {
            discordId,
            username: null,
            globalName: null,
            guildNickname: null,
            avatarUrl: null,
            status: 'error',
            fetchedAt: now,
            expiresAt: now + ERROR_BACKOFF_TTL_MS,
          };
      await upsertDiscordProfileRow(errRow);
      return { row: errRow, rateLimited: userRes.status === 401 || userRes.status === 403 };
    }

    const userData = (await userRes.json()) as DiscordApiUser;
    const resolvedRow: DiscordProfileRow = {
      discordId,
      username: formatDiscordUsername(userData),
      globalName: userData.global_name ?? null,
      guildNickname: null,
      avatarUrl: buildAvatarUrl(userData),
      status: 'resolved',
      fetchedAt: now,
      expiresAt: computeResolvedExpiry(now),
    };
    await upsertDiscordProfileRow(resolvedRow);
    return { row: resolvedRow, rateLimited: false };
  } catch (err) {
    console.warn(`[Discord Resolver] Network error resolving ${discordId}:`, err);
    const existing = memoryRowsCache?.get(discordId);
    const errRow: DiscordProfileRow = existing
      ? { ...existing, expiresAt: now + ERROR_BACKOFF_TTL_MS }
      : {
          discordId,
          username: null,
          globalName: null,
          guildNickname: null,
          avatarUrl: null,
          status: 'error',
          fetchedAt: now,
          expiresAt: now + ERROR_BACKOFF_TTL_MS,
        };
    await upsertDiscordProfileRow(errRow);
    return { row: errRow, rateLimited: false };
  }
}

/**
 * Resolves a list of Discord snowflake IDs using the two-tier Read-Through Cache:
 * L1 (isolate Map) -> L2 (Vercel Runtime Cache) -> Guild Bulk Warmup -> Bounded Live Fetch.
 */
export async function resolveDiscordProfiles(
  discordIds: string[],
  options: { forceRefresh?: boolean; seedMocks?: boolean } = {}
): Promise<ReadonlyMap<string, DiscordProfile>> {
  const { forceRefresh = false, seedMocks = config.useMockDirectory } = options;
  const now = Date.now();
  ensureL1Maps();

  if (seedMocks && !devSeeded) {
    devSeeded = true;
    const mocks = getDevMockDiscordProfiles();
    await upsertDiscordProfileRowsBatch([...mocks.values()]);
  }

  const validIds = [
    ...new Set(
      discordIds
        .map((id) => id?.trim())
        .filter((id): id is string => Boolean(id && SNOWFLAKE_REGEX.test(id)))
    ),
  ];

  if (validIds.length === 0) {
    return getCachedDiscordProfilesMap();
  }

  // Step 1: Identify L1 misses or expired rows
  const l1Misses: string[] = [];
  for (const id of validIds) {
    const l1Row = memoryRowsCache?.get(id);
    if (forceRefresh || !l1Row || l1Row.expiresAt <= now) {
      l1Misses.push(id);
    }
  }

  if (l1Misses.length === 0) {
    return getCachedDiscordProfilesMap();
  }

  // Step 2: Check L2 Vercel Runtime Cache in parallel for L1 misses
  const l2Misses: string[] = [];
  if (!forceRefresh) {
    const l2Results = await Promise.all(
      l1Misses.map(async (id) => ({
        id,
        row: await runtimeCache.get<DiscordProfileRow>(getUserCacheKey(id)),
      }))
    );

    for (const { id, row } of l2Results) {
      if (row && row.expiresAt > now) {
        setL1Row(row);
      } else {
        l2Misses.push(id);
      }
    }
  } else {
    l2Misses.push(...l1Misses);
  }

  if (l2Misses.length === 0) {
    return getCachedDiscordProfilesMap();
  }

  // Step 3: Live Discord API resolution (if DISCORD_BOT_TOKEN is configured)
  if (!config.discordBotToken) {
    if (!missingTokenWarned && !config.useMockDirectory) {
      missingTokenWarned = true;
      console.warn(
        '[Discord Resolver] DISCORD_BOT_TOKEN is not set; skipping live Discord user resolution.'
      );
    }
    return getCachedDiscordProfilesMap();
  }

  // Step 3a: Try Guild Bulk Warmup first if DISCORD_GUILD_ID is configured
  if (config.discordGuildId && l2Misses.length >= 2) {
    await tryGuildBulkWarmup(forceRefresh, new Set(validIds));
  }

  // Re-filter remaining misses after Guild Bulk Warmup
  const remainingMisses = l2Misses.filter((id) => {
    const row = memoryRowsCache?.get(id);
    return !row || row.expiresAt <= Date.now();
  });

  if (remainingMisses.length === 0) {
    return getCachedDiscordProfilesMap();
  }

  // Step 3b: Bounded read-through resolution for remaining IDs
  const deadline = Date.now() + MAX_RESOLUTION_BUDGET_MS;
  const boundedTargetIds = remainingMisses.slice(0, MAX_LIVE_FETCHES_PER_REQUEST);
  let cursor = 0;
  let rateLimitedAbort = false;

  async function runWorker(): Promise<void> {
    while (!rateLimitedAbort && Date.now() < deadline) {
      const idx = cursor++;
      if (idx >= boundedTargetIds.length) break;
      const targetId = boundedTargetIds[idx];
      const { rateLimited } = await fetchSingleDiscordProfileReadThrough(targetId);
      if (rateLimited) {
        rateLimitedAbort = true;
        break;
      }
    }
  }

  const workerCount = Math.min(MAX_CONCURRENCY, boundedTargetIds.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return getCachedDiscordProfilesMap();
}

export async function loadAllDiscordProfilesMap(
  forceReload = false,
  seedMocks = config.useMockDirectory,
  discordIds: string[] = []
): Promise<ReadonlyMap<string, DiscordProfile>> {
  return resolveDiscordProfiles(discordIds, {
    forceRefresh: forceReload,
    seedMocks,
  });
}

/**
 * Retained for backward compatibility with synchronous callers.
 * Triggers read-through resolution and notifies any registered snapshot listener on completion.
 */
export function enqueueDiscordResolutions(discordIds: string[]): void {
  if (!discordIds || discordIds.length === 0) return;
  const task = resolveDiscordProfiles(discordIds).then(() => {
    onProfilesUpdatedCallback?.();
  });
  try {
    waitUntil(task);
  } catch {
    // No-op outside Vercel request context
  }
}

export function resetDiscordResolverForTesting(): void {
  memoryRowsCache = null;
  publicProfilesCache = null;
  missingTokenWarned = false;
  devSeeded = false;
  onProfilesUpdatedCallback = null;
  resetRuntimeCacheForTesting();
}
