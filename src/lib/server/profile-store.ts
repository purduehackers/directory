import { sql } from 'drizzle-orm';
import { config } from './config';
import { ensureDbInitialized } from './db';
import {
  memberProfiles,
  type ContactVisibility,
  type CustomLink,
  type MemberProfile,
  type MemberProfileRow,
  type SocialLinks,
} from './db/schema';
import type { ValidatedProfileData } from './profile-validation';

let cachedProfilesBySub: Map<string, MemberProfile> | null = null;
let inFlightLoadPromise: Promise<Map<string, MemberProfile>> | null = null;
let devSeeded = false;

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToMemberProfile(row: MemberProfileRow): MemberProfile {
  return {
    sub: row.sub,
    headline: row.headline ?? null,
    bio: row.bio ?? null,
    location: row.location ?? null,
    timezone: row.timezone ?? null,
    websiteUrl: row.websiteUrl ?? null,
    socials: safeJsonParse<SocialLinks>(row.socialsJson, {}),
    customLinks: safeJsonParse<CustomLink[]>(row.customLinksJson, []),
    contactVisibility: safeJsonParse<ContactVisibility>(row.contactVisibilityJson, {}),
    updatedAt: row.updatedAt,
  };
}

export function getCachedProfilesMap(): ReadonlyMap<string, MemberProfile> {
  return cachedProfilesBySub ?? new Map();
}

export async function loadAllProfilesMap(
  forceReload = false
): Promise<ReadonlyMap<string, MemberProfile>> {
  if (cachedProfilesBySub && !forceReload) {
    return cachedProfilesBySub;
  }

  if (inFlightLoadPromise && !forceReload) {
    return inFlightLoadPromise;
  }

  inFlightLoadPromise = (async () => {
    try {
      const db = await ensureDbInitialized();
      const selectStartedAt = Date.now();
      let rows = await db.select().from(memberProfiles);

      if (rows.length === 0 && config.useMockDirectory && !devSeeded) {
        devSeeded = true;
        await seedDevMockProfilesInternal();
        rows = await db.select().from(memberProfiles);
      }

      const nextMap = new Map<string, MemberProfile>();
      for (const row of rows) {
        nextMap.set(row.sub.toLowerCase(), rowToMemberProfile(row));
      }

      // Preserve any newer concurrent writes that completed while SELECT was in flight
      if (cachedProfilesBySub) {
        for (const [k, existing] of cachedProfilesBySub.entries()) {
          const loaded = nextMap.get(k);
          if (!loaded) {
            // Only preserve if written after query started (never resurrect previously deleted rows)
            if (existing.updatedAt >= selectStartedAt) {
              nextMap.set(k, existing);
            }
          } else if (existing.updatedAt > loaded.updatedAt) {
            nextMap.set(k, existing);
          }
        }
      }

      cachedProfilesBySub = nextMap;
      return cachedProfilesBySub;
    } catch (err) {
      console.error('[Profile Store] Failed to load member profiles from DB:', err);
      return cachedProfilesBySub ?? new Map();
    } finally {
      inFlightLoadPromise = null;
    }
  })();

  return inFlightLoadPromise;
}

export async function getMemberProfileBySub(sub: string): Promise<MemberProfile | null> {
  const map = await loadAllProfilesMap();
  return map.get(sub.toLowerCase()) ?? null;
}

async function writeProfileToDb(
  sub: string,
  data: ValidatedProfileData
): Promise<MemberProfile> {
  const db = await ensureDbInitialized();
  const now = Date.now();
  const normalizedSub = sub.trim().toLowerCase();

  const rowValues: MemberProfileRow = {
    sub: normalizedSub,
    headline: data.headline,
    bio: data.bio,
    location: data.location,
    timezone: data.timezone,
    websiteUrl: data.websiteUrl,
    socialsJson: JSON.stringify(data.socials),
    customLinksJson: JSON.stringify(data.customLinks),
    contactVisibilityJson: JSON.stringify(data.contactVisibility),
    updatedAt: now,
  };

  await db
    .insert(memberProfiles)
    .values(rowValues)
    .onConflictDoUpdate({
      target: memberProfiles.sub,
      set: {
        headline: rowValues.headline,
        bio: rowValues.bio,
        location: rowValues.location,
        timezone: rowValues.timezone,
        websiteUrl: rowValues.websiteUrl,
        socialsJson: rowValues.socialsJson,
        customLinksJson: rowValues.customLinksJson,
        contactVisibilityJson: rowValues.contactVisibilityJson,
        updatedAt: rowValues.updatedAt,
      },
      where: sql`${rowValues.updatedAt} >= ${memberProfiles.updatedAt}`,
    });

  return rowToMemberProfile(rowValues);
}

export async function upsertMemberProfile(
  sub: string,
  data: ValidatedProfileData
): Promise<MemberProfile> {
  const key = sub.trim().toLowerCase();
  // Ensure existing profiles are loaded first so we never poison cachedProfilesBySub with a partial Map
  await loadAllProfilesMap();

  const savedProfile = await writeProfileToDb(key, data);

  if (!cachedProfilesBySub) {
    cachedProfilesBySub = new Map();
  }
  const current = cachedProfilesBySub.get(key);
  if (!current || savedProfile.updatedAt >= current.updatedAt) {
    cachedProfilesBySub.set(key, savedProfile);
  }
  return cachedProfilesBySub.get(key)!;
}

async function seedDevMockProfilesInternal(): Promise<void> {
  try {
    await writeProfileToDb('01a1a7a2-31ea-7610-9e1d-be737abbeb97', {
      headline: 'Building custom keyboards & distributed systems',
      bio: 'Purdue Hackers organizer. Obsessed with low-level systems, NixOS, and late-night Hack Night hardware builds.',
      location: 'West Lafayette, IN',
      timezone: 'America/Indiana/Indianapolis',
      websiteUrl: 'https://purduehackers.com',
      socials: {
        github: 'https://github.com/purduehackers',
        x: 'https://x.com/purduehackers',
      },
      customLinks: [{ label: 'Hack Night Notes', url: 'https://blog.purduehackers.com' }],
      contactVisibility: { emails: {}, phone: true },
    });

    await writeProfileToDb('01a1a761-8139-7553-bdba-b5385b625b5e', {
      headline: 'Systems engineer in SF • Purdue Hackers Alum',
      bio: 'Former Hack Night regular. Now working on storage engines in the Bay Area. Always happy to chat with Purdue folks visiting SF!',
      location: 'San Francisco, CA',
      timezone: 'America/Los_Angeles',
      websiteUrl: 'https://example.com',
      socials: {
        github: 'https://github.com/torvalds',
      },
      customLinks: [],
      contactVisibility: { emails: {}, phone: true },
    });
  } catch (err) {
    console.warn('[Profile Store] Failed to seed dev mock profiles:', err);
  }
}
