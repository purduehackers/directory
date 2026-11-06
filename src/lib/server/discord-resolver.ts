import { eq, sql } from 'drizzle-orm';
import { config } from './config';
import { ensureDbInitialized } from './db';
import {
  discordProfiles,
  type DiscordProfile,
  type DiscordProfileRow,
} from './db/schema';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const SNOWFLAKE_REGEX = /^\d{17,20}$/;

const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for 404 Not Found
const ERROR_BACKOFF_TTL_MS = 15 * 60 * 1000; // 15 minutes for 5xx / network errors
const FETCH_TIMEOUT_MS = 6_000;
const MIN_REQUEST_INTERVAL_MS = 150; // ~6.6 req/sec baseline pacing
const SNAPSHOT_NOTIFY_DEBOUNCE_MS = 2_500;

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
let inFlightLoadPromise: Promise<ReadonlyMap<string, DiscordProfile>> | null = null;

const pendingQueue = new Set<string>();
const inFlightIds = new Set<string>();
let workerRunning = false;
let guildWarmupAttempted = false;
let missingTokenWarned = false;
let devSeeded = false;

let onProfilesUpdatedCallback: (() => void) | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

export function registerDiscordUpdateListener(cb: () => void): void {
  onProfilesUpdatedCallback = cb;
}

function scheduleSnapshotNotification(immediate = false): void {
  if (!onProfilesUpdatedCallback) return;
  if (immediate) {
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    onProfilesUpdatedCallback();
    return;
  }
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    onProfilesUpdatedCallback?.();
  }, SNAPSHOT_NOTIFY_DEBOUNCE_MS);
}

function computeResolvedExpiry(now = Date.now()): number {
  // Add ±12 hours random jitter to prevent synchronized cache stampedes
  const jitterMs = Math.floor((Math.random() - 0.5) * 24 * 60 * 60 * 1000);
  return now + config.discordCacheTtlMs + jitterMs;
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

function rebuildPublicProfilesCache(): Map<string, DiscordProfile> {
  const result = new Map<string, DiscordProfile>();
  if (memoryRowsCache) {
    for (const [id, row] of memoryRowsCache.entries()) {
      const publicProf = rowToDiscordProfile(row);
      if (publicProf) {
        result.set(id, publicProf);
      }
    }
  }
  publicProfilesCache = result;
  return result;
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
  return rebuildPublicProfilesCache();
}

export async function loadAllDiscordProfilesMap(
  forceReload = false,
  seedMocks = config.useMockDirectory
): Promise<ReadonlyMap<string, DiscordProfile>> {
  if (publicProfilesCache && !forceReload) {
    return publicProfilesCache;
  }

  if (inFlightLoadPromise && !forceReload) {
    return inFlightLoadPromise;
  }

  inFlightLoadPromise = (async () => {
    try {
      const db = await ensureDbInitialized();
      let rows = await db.select().from(discordProfiles);

      if (rows.length === 0 && seedMocks && !devSeeded) {
        devSeeded = true;
        const mockRows = getDevMockDiscordProfiles();
        for (const r of mockRows.values()) {
          try {
            await db
              .insert(discordProfiles)
              .values(r)
              .onConflictDoUpdate({
                target: discordProfiles.discordId,
                set: {
                  username: r.username,
                  globalName: r.globalName,
                  guildNickname: r.guildNickname,
                  avatarUrl: r.avatarUrl,
                  status: r.status,
                  fetchedAt: r.fetchedAt,
                  expiresAt: r.expiresAt,
                },
              });
          } catch {}
        }
        rows = await db.select().from(discordProfiles);
      }

      const nextRowsMap = new Map<string, DiscordProfileRow>();
      for (const row of rows) {
        nextRowsMap.set(row.discordId, row);
      }

      // Preserve any newer in-memory rows from concurrent worker updates
      if (memoryRowsCache) {
        for (const [id, existing] of memoryRowsCache.entries()) {
          const loaded = nextRowsMap.get(id);
          if (!loaded || existing.fetchedAt > loaded.fetchedAt) {
            nextRowsMap.set(id, existing);
          }
        }
      }

      memoryRowsCache = nextRowsMap;
      return rebuildPublicProfilesCache();
    } catch (err) {
      console.error('[Discord Resolver] Failed to load discord profiles from DB:', err);
      return publicProfilesCache ?? new Map();
    } finally {
      inFlightLoadPromise = null;
    }
  })();

  return inFlightLoadPromise;
}

export async function upsertDiscordProfileRow(row: DiscordProfileRow): Promise<void> {
  if (!memoryRowsCache) {
    memoryRowsCache = new Map();
  }
  memoryRowsCache.set(row.discordId, row);

  if (!publicProfilesCache) {
    publicProfilesCache = new Map();
  }
  const publicProf = rowToDiscordProfile(row);
  if (publicProf) {
    publicProfilesCache.set(row.discordId, publicProf);
  } else {
    publicProfilesCache.delete(row.discordId);
  }

  try {
    const db = await ensureDbInitialized();
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
  } catch (err) {
    console.error(`[Discord Resolver] Failed to persist profile for ${row.discordId}:`, err);
  }
}

async function upsertDiscordProfileRowsBatch(rows: DiscordProfileRow[]): Promise<void> {
  if (rows.length === 0) return;
  if (!memoryRowsCache) {
    memoryRowsCache = new Map();
  }
  if (!publicProfilesCache) {
    publicProfilesCache = new Map();
  }

  for (const row of rows) {
    memoryRowsCache.set(row.discordId, row);
    const publicProf = rowToDiscordProfile(row);
    if (publicProf) {
      publicProfilesCache.set(row.discordId, publicProf);
    } else {
      publicProfilesCache.delete(row.discordId);
    }
  }

  try {
    const db = await ensureDbInitialized();
    const CHUNK_SIZE = 100;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      await db
        .insert(discordProfiles)
        .values(chunk)
        .onConflictDoUpdate({
          target: discordProfiles.discordId,
          set: {
            username: sql`excluded.username`,
            globalName: sql`excluded.global_name`,
            guildNickname: sql`excluded.guild_nickname`,
            avatarUrl: sql`excluded.avatar_url`,
            status: sql`excluded.status`,
            fetchedAt: sql`excluded.fetched_at`,
            expiresAt: sql`excluded.expires_at`,
          },
        });
    }
  } catch (err) {
    console.error(`[Discord Resolver] Failed to persist batch of ${rows.length} profiles:`, err);
  }
}

export function enqueueDiscordResolutions(discordIds: string[]): void {
  const now = Date.now();
  let added = 0;

  for (const rawId of discordIds) {
    if (!rawId) continue;
    const id = rawId.trim();
    if (!SNOWFLAKE_REGEX.test(id)) continue;
    if (pendingQueue.has(id) || inFlightIds.has(id)) continue;

    const cached = memoryRowsCache?.get(id);
    if (cached && cached.expiresAt > now) {
      continue; // Fresh cache hit (resolved, not_found, or backoff window)
    }

    pendingQueue.add(id);
    added++;
  }

  if (added > 0 && !workerRunning) {
    void processResolutionQueue();
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryGuildBulkWarmup(): Promise<number> {
  if (guildWarmupAttempted || !config.discordGuildId || !config.discordBotToken) {
    return 0;
  }
  guildWarmupAttempted = true;

  try {
    const url = `${DISCORD_API_BASE}/guilds/${encodeURIComponent(config.discordGuildId)}/members?limit=1000`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      return 0;
    }

    const members = (await res.json()) as DiscordApiGuildMember[];
    const now = Date.now();
    let hydratedCount = 0;
    const rowsToUpsert: DiscordProfileRow[] = [];

    for (const m of members) {
      const user = m.user;
      if (!user || !user.id || !user.username) continue;

      const row: DiscordProfileRow = {
        discordId: user.id,
        username: formatDiscordUsername(user),
        globalName: user.global_name ?? null,
        guildNickname: m.nick ?? null,
        avatarUrl: buildAvatarUrl(user),
        status: 'resolved',
        fetchedAt: now,
        expiresAt: computeResolvedExpiry(now),
      };

      rowsToUpsert.push(row);
      if (pendingQueue.delete(user.id)) {
        hydratedCount++;
      }
    }

    if (rowsToUpsert.length > 0) {
      await upsertDiscordProfileRowsBatch(rowsToUpsert);
    }

    if (hydratedCount > 0) {
      console.log(`[Discord Resolver] Hydrated ${hydratedCount} Discord profiles via Guild bulk warmup`);
    }
    return hydratedCount;
  } catch (err) {
    console.warn('[Discord Resolver] Guild bulk warmup skipped:', err);
    return 0;
  }
}

async function processResolutionQueue(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  let updatedAny = false;

  try {
    if (!config.discordBotToken) {
      if (!missingTokenWarned && !config.useMockDirectory) {
        missingTokenWarned = true;
        console.warn(
          '[Discord Resolver] DISCORD_BOT_TOKEN is not set; skipping live Discord user resolution.'
        );
      }
      pendingQueue.clear();
      return;
    }

    // If multiple IDs are queued and DISCORD_GUILD_ID is configured, try guild bulk warmup first
    if (pendingQueue.size >= 5 && !guildWarmupAttempted) {
      const hydrated = await tryGuildBulkWarmup();
      if (hydrated > 0) {
        updatedAny = true;
        scheduleSnapshotNotification();
      }
    }

    while (pendingQueue.size > 0) {
      const nextId = pendingQueue.values().next().value;
      if (!nextId) break;

      pendingQueue.delete(nextId);
      inFlightIds.add(nextId);

      try {
        const now = Date.now();
        let targetUser: DiscordApiUser | null = null;
        let guildNickname: string | null = null;
        let lastResponse: Response | null = null;

        // 1. If DISCORD_GUILD_ID is configured, try fetching guild member first to capture server nickname
        if (config.discordGuildId) {
          try {
            const guildUrl = `${DISCORD_API_BASE}/guilds/${encodeURIComponent(config.discordGuildId)}/members/${encodeURIComponent(nextId)}`;
            const guildRes = await fetch(guildUrl, {
              headers: {
                Authorization: `Bot ${config.discordBotToken}`,
                Accept: 'application/json',
              },
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            lastResponse = guildRes;

            if (guildRes.status === 429) {
              const parsedRetry = parseFloat(guildRes.headers.get('Retry-After') || '1');
              const retryAfterSec = Number.isFinite(parsedRetry) && parsedRetry > 0 ? parsedRetry : 1;
              const delayMs = Math.min(Math.ceil(retryAfterSec * 1000) + 250, 60_000);
              console.warn(`[Discord Resolver] Rate limited on guild member (429); pausing for ${delayMs}ms`);
              pendingQueue.add(nextId);
              await sleep(delayMs);
              continue;
            }

            if (guildRes.ok) {
              const memberData = (await guildRes.json()) as DiscordApiGuildMember;
              if (memberData.user && memberData.user.username) {
                targetUser = memberData.user;
                guildNickname = memberData.nick ?? null;
              }
            }
          } catch (err) {
            console.warn(`[Discord Resolver] Guild member fetch error for ${nextId}:`, err);
          }
        }

        // 2. If not found in guild or guild lookup not configured, fall back to global /users/:id
        if (!targetUser) {
          const url = `${DISCORD_API_BASE}/users/${encodeURIComponent(nextId)}`;
          const res = await fetch(url, {
            headers: {
              Authorization: `Bot ${config.discordBotToken}`,
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          lastResponse = res;

          if (res.status === 429) {
            const parsedRetry = parseFloat(res.headers.get('Retry-After') || '1');
            const retryAfterSec = Number.isFinite(parsedRetry) && parsedRetry > 0 ? parsedRetry : 1;
            const delayMs = Math.min(Math.ceil(retryAfterSec * 1000) + 250, 60_000);
            console.warn(`[Discord Resolver] Rate limited (429); pausing for ${delayMs}ms`);
            pendingQueue.add(nextId);
            await sleep(delayMs);
            continue;
          }

          if (res.status === 404) {
            // Negative cache for deleted / non-existent users
            const notFoundRow: DiscordProfileRow = {
              discordId: nextId,
              username: null,
              globalName: null,
              guildNickname: null,
              avatarUrl: null,
              status: 'not_found',
              fetchedAt: now,
              expiresAt: now + NEGATIVE_CACHE_TTL_MS,
            };
            await upsertDiscordProfileRow(notFoundRow);
            await sleep(MIN_REQUEST_INTERVAL_MS);
            continue;
          }

          if (res.status === 401 || res.status === 403) {
            console.error('[Discord Resolver] DISCORD_BOT_TOKEN is invalid or lacks access. Stopping queue.');
            pendingQueue.clear();
            break;
          }

          if (!res.ok) {
            console.warn(`[Discord Resolver] Unexpected status ${res.status} resolving ${nextId}`);
            const existing = memoryRowsCache?.get(nextId);
            const errRow: DiscordProfileRow = existing
              ? { ...existing, expiresAt: now + ERROR_BACKOFF_TTL_MS }
              : {
                  discordId: nextId,
                  username: null,
                  globalName: null,
                  guildNickname: null,
                  avatarUrl: null,
                  status: 'error',
                  fetchedAt: now,
                  expiresAt: now + ERROR_BACKOFF_TTL_MS,
                };
            if (!memoryRowsCache) memoryRowsCache = new Map();
            memoryRowsCache.set(nextId, errRow);
            await sleep(1_000);
            continue;
          }

          const data = (await res.json()) as DiscordApiUser;
          if (!data || !data.username) {
            continue;
          }
          targetUser = data;
        }

        const row: DiscordProfileRow = {
          discordId: nextId,
          username: formatDiscordUsername(targetUser),
          globalName: targetUser.global_name ?? null,
          guildNickname,
          avatarUrl: buildAvatarUrl(targetUser),
          status: 'resolved',
          fetchedAt: now,
          expiresAt: computeResolvedExpiry(now),
        };

        await upsertDiscordProfileRow(row);
        updatedAny = true;
        scheduleSnapshotNotification();

        // Respect proactive rate limit headers if bucket is nearly exhausted
        const remaining = lastResponse?.headers.get('X-RateLimit-Remaining');
        const resetAfter = lastResponse?.headers.get('X-RateLimit-Reset-After');
        if (remaining === '0' && resetAfter) {
          const parsed = parseFloat(resetAfter);
          const resetMs = Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed * 1000) + 150 : MIN_REQUEST_INTERVAL_MS;
          await sleep(Math.min(resetMs, 10_000));
        } else {
          await sleep(MIN_REQUEST_INTERVAL_MS);
        }
      } catch (err) {
        console.warn(`[Discord Resolver] Network error resolving ${nextId}:`, err);
        const now = Date.now();
        const existing = memoryRowsCache?.get(nextId);
        const errRow: DiscordProfileRow = existing
          ? { ...existing, expiresAt: now + ERROR_BACKOFF_TTL_MS }
          : {
              discordId: nextId,
              username: null,
              globalName: null,
              guildNickname: null,
              avatarUrl: null,
              status: 'error',
              fetchedAt: now,
              expiresAt: now + ERROR_BACKOFF_TTL_MS,
            };
        if (!memoryRowsCache) memoryRowsCache = new Map();
        memoryRowsCache.set(nextId, errRow);
        await sleep(1_000);
      } finally {
        inFlightIds.delete(nextId);
      }
    }
  } finally {
    workerRunning = false;
    if (updatedAny) {
      scheduleSnapshotNotification(true);
    }
  }
}

export function resetDiscordResolverForTesting(): void {
  memoryRowsCache = null;
  publicProfilesCache = null;
  inFlightLoadPromise = null;
  pendingQueue.clear();
  inFlightIds.clear();
  workerRunning = false;
  guildWarmupAttempted = false;
  missingTokenWarned = false;
  devSeeded = false;
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  onProfilesUpdatedCallback = null;
}
