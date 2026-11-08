import MiniSearch from 'minisearch';
import { formatPhone } from '../phone';
import { config } from './config';
import { getOpenIdConfiguration } from './oidc';
import type { DiscordProfile, MemberProfile } from './db/schema';
import { getCachedProfilesMap, loadAllProfilesMap } from './profile-store';
import {
  enqueueDiscordResolutions,
  getCachedDiscordProfilesMap,
  loadAllDiscordProfilesMap,
  registerDiscordUpdateListener,
} from './discord-resolver';
import { runtimeCache } from './runtime-cache';
import { waitUntil } from '@vercel/functions';

export const DIRECTORY_UPSTREAM_TAG = 'directory-upstream';
export const DIRECTORY_PROFILES_TAG = 'directory-profiles';
const UPSTREAM_MEMBERS_CACHE_KEY = 'directory:upstream-members:v1';
const DIRECTORY_SYNC_META_KEY = 'directory:sync-meta:v1';

type UpstreamMembersCachePayload = {
  members: DirectoryMember[];
  fetchedAt: number;
};

type DirectorySyncMeta = {
  upstreamFetchedAt: number;
  profilesUpdatedAt: number;
};

let localProfilesUpdatedAt = 0;

export type DirectoryMemberEmail = {
  email: string;
  primary?: boolean;
  verified?: boolean;
};

export type DirectoryMember = {
  sub: string;
  preferred_username: string;
  name: string;
  given_name: string | null;
  family_name: string | null;
  picture: string;
  roles: string[];
  graduation_year: number | null;
  banned: boolean;
  email?: string;
  email_verified?: boolean;
  emails?: DirectoryMemberEmail[];
  phone_number?: string | null;
  discord_id?: string | null;
  discord?: DiscordProfile | null;
  profile?: MemberProfile | null;
};

export function isEmailVisible(
  email: string,
  profile?: MemberProfile | null,
  isPrimary = true
): boolean {
  if (!email) return false;
  const key = email.toLowerCase().trim();
  const setting = profile?.contactVisibility?.emails?.[key];
  if (setting !== undefined) {
    return setting;
  }
  return isPrimary;
}

export function isPhoneVisible(profile?: MemberProfile | null): boolean {
  return profile?.contactVisibility?.phone === true;
}

export function getVisibleEmails(member: DirectoryMember): DirectoryMemberEmail[] {
  const rawList: DirectoryMemberEmail[] =
    member.emails && member.emails.length > 0
      ? member.emails
      : member.email
        ? [{ email: member.email, primary: true, verified: member.email_verified }]
        : [];

  // If the profile has an explicit contactVisibility configuration (raw member), filter through visibility rules:
  if (
    member.profile?.contactVisibility &&
    ('phone' in member.profile.contactVisibility || 'emails' in member.profile.contactVisibility)
  ) {
    return rawList.filter((item) =>
      isEmailVisible(item.email, member.profile, Boolean(item.primary))
    );
  }

  // If member has no profile at all (unsanitized raw member from ID), only primary email is visible:
  if (!member.profile) {
    return rawList.filter((item) => Boolean(item.primary));
  }

  // On a sanitized public member (where contactVisibility was wiped to {}), rawList has already been filtered:
  return rawList;
}

export function getVisiblePhone(member: DirectoryMember): string | null {
  if (!member.phone_number) return null;
  // If the profile has an explicit contactVisibility setting for phone (raw member), respect it:
  if (member.profile?.contactVisibility && 'phone' in member.profile.contactVisibility) {
    return member.profile.contactVisibility.phone ? member.phone_number : null;
  }
  // If the member has no profile at all (unsanitized raw member from ID), phone defaults to hidden:
  if (!member.profile) {
    return null;
  }
  // If the member has a sanitized profile (contactVisibility map was wiped for public DTO),
  // member.phone_number was already verified visible during buildDirectorySnapshot:
  return member.phone_number;
}

export type IndexedMember = DirectoryMember & {
  id: string;
  rolesText: string;
  gradYearText: string;
  phoneText: string;
  discordText: string;
  locationText: string;
  headlineText: string;
  majorText: string;
  bioText: string;
  linksText: string;
  emailsText: string;
};

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

export type DirectorySnapshot = {
  members: DirectoryMember[];
  byUsername: Map<string, DirectoryMember>;
  bySub: Map<string, DirectoryMember>;
  searchIndex: MiniSearch<IndexedMember>;
  gradYears: number[];
  locations: string[];
  fetchedAt: number;
};

let tokenCache: TokenCache | null = null;
let inFlightTokenPromise: Promise<string> | null = null;

let upstreamMembersCache: { members: DirectoryMember[]; fetchedAt: number } | null = null;
let directoryCache: DirectorySnapshot | null = null;
let inFlightDirectoryPromise: Promise<DirectorySnapshot> | null = null;
let inFlightEpoch = 0;
let invalidationEpoch = 0;

const DIRECTORY_SCOPES = 'directory:roles directory:contact directory:discord';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PAGES = 100;

export function getRawMemberBySub(sub: string): DirectoryMember | null {
  if (!upstreamMembersCache?.members) {
    if (config.useMockDirectory) {
      const mock = getDevMockMembers();
      return mock.find((m) => m.sub.toLowerCase() === sub.toLowerCase()) ?? null;
    }
    return null;
  }
  const target = sub.toLowerCase();
  return upstreamMembersCache.members.find((m) => m.sub.toLowerCase() === target) ?? null;
}

export function buildIndexedDoc(
  m: DirectoryMember,
  profile: MemberProfile | null,
  resolvedDiscordMap: ReadonlyMap<string, DiscordProfile>
): { doc: IndexedMember; publicMember: DirectoryMember } {
  const cleanDiscordId = m.discord_id?.trim() || null;
  const discord = cleanDiscordId
    ? (resolvedDiscordMap.get(cleanDiscordId) ?? m.discord ?? null)
    : null;

  const rawForContact: DirectoryMember = { ...m, profile };
  const visibleEmails = getVisibleEmails(rawForContact);
  const visiblePhone = getVisiblePhone(rawForContact);

  const rawPhone = visiblePhone ?? '';
  const formattedPhone = formatPhone(rawPhone);
  const digitsPhone = rawPhone.replace(/\D/g, '');
  const phoneParts = [rawPhone, formattedPhone];
  if (digitsPhone) {
    phoneParts.push(digitsPhone);
    if (digitsPhone.length === 11 && digitsPhone.startsWith('1')) {
      phoneParts.push(digitsPhone.slice(1));
      phoneParts.push(digitsPhone.slice(1, 4));
      phoneParts.push(digitsPhone.slice(4));
      phoneParts.push(digitsPhone.slice(7));
    } else if (digitsPhone.length === 10) {
      phoneParts.push(digitsPhone.slice(0, 3));
      phoneParts.push(digitsPhone.slice(3));
      phoneParts.push(digitsPhone.slice(6));
    } else if (digitsPhone.length >= 7) {
      phoneParts.push(digitsPhone.slice(-4));
    }
  }
  const phoneText = [...new Set(phoneParts.filter(Boolean))].join(' ');

  const discordParts: string[] = [];
  if (cleanDiscordId) discordParts.push(cleanDiscordId);
  if (discord?.username) {
    discordParts.push(discord.username);
    discordParts.push(`@${discord.username}`);
  }
  if (discord?.globalName) discordParts.push(discord.globalName);
  if (discord?.guildNickname) discordParts.push(discord.guildNickname);
  const discordText = discordParts.join(' ');

  const linksList: string[] = [];
  if (profile?.websiteUrl) linksList.push(profile.websiteUrl);
  if (profile?.socials) {
    for (const val of Object.values(profile.socials)) {
      if (val) linksList.push(val);
    }
  }
  if (profile?.customLinks) {
    for (const cl of profile.customLinks) {
      if (cl.label) linksList.push(cl.label);
      if (cl.url) linksList.push(cl.url);
    }
  }
  const linksText = linksList.join(' ');
  const visibleEmailsText = visibleEmails.map((e) => e.email).join(' ');

  const sanitizedProfile: MemberProfile | null = profile
    ? { ...profile, contactVisibility: {} }
    : null;

  const publicMember: DirectoryMember = {
    sub: m.sub,
    preferred_username: m.preferred_username,
    name: m.name,
    given_name: m.given_name,
    family_name: m.family_name,
    picture: m.picture,
    roles: m.roles,
    graduation_year: m.graduation_year,
    banned: m.banned,
    email: visibleEmails[0]?.email,
    emails: visibleEmails,
    phone_number: visiblePhone,
    discord_id: cleanDiscordId,
    discord,
    profile: sanitizedProfile,
  };

  const doc: IndexedMember = {
    ...publicMember,
    id: m.sub,
    rolesText: (m.roles || []).join(' '),
    gradYearText: m.graduation_year ? String(m.graduation_year) : '',
    phoneText,
    discordText,
    locationText: profile?.location ?? '',
    headlineText: profile?.headline ?? '',
    majorText: profile?.major ?? '',
    bioText: profile?.bio ?? '',
    linksText,
    emailsText: visibleEmailsText,
  };

  return { doc, publicMember };
}

export function buildDirectorySnapshot(
  members: DirectoryMember[],
  fetchedAt = Date.now(),
  profilesBySub?: ReadonlyMap<string, MemberProfile>,
  discordById?: ReadonlyMap<string, DiscordProfile>
): DirectorySnapshot {
  const byUsername = new Map<string, DirectoryMember>();
  const bySub = new Map<string, DirectoryMember>();
  const years = new Set<number>();
  const locationsMap = new Map<string, string>();
  const publicMembers: DirectoryMember[] = [];
  const indexedItems: IndexedMember[] = [];

  const resolvedDiscordMap = discordById ?? getCachedDiscordProfilesMap();

  for (const m of members) {
    if (!m || typeof m.sub !== 'string' || typeof m.preferred_username !== 'string') continue;

    const profile = profilesBySub?.get(m.sub.toLowerCase()) ?? m.profile ?? null;
    const { doc, publicMember } = buildIndexedDoc(m, profile, resolvedDiscordMap);

    byUsername.set(m.preferred_username.toLowerCase(), publicMember);
    bySub.set(m.sub.toLowerCase(), publicMember);
    publicMembers.push(publicMember);
    indexedItems.push(doc);

    if (m.graduation_year) {
      years.add(m.graduation_year);
    }

    if (profile?.location) {
      const trimmed = profile.location.trim();
      const key = trimmed.toLowerCase();
      if (trimmed && !locationsMap.has(key)) {
        locationsMap.set(key, trimmed);
      }
    }
  }

  const searchIndex = new MiniSearch<IndexedMember>({
    fields: [
      'name',
      'preferred_username',
      'locationText',
      'headlineText',
      'majorText',
      'bioText',
      'linksText',
      'emailsText',
      'phoneText',
      'discordText',
      'rolesText',
      'gradYearText',
    ],
    storeFields: ['sub'],
    searchOptions: {
      combineWith: 'AND',
      prefix: true,
      fuzzy: (term) => (term.length >= 3 && term.length <= 24 ? 0.2 : false),
      maxFuzzy: 2,
      boost: {
        preferred_username: 4,
        name: 3,
        locationText: 2.5,
        discordText: 2.5,
        headlineText: 2.0,
        majorText: 2.0,
        emailsText: 2.0,
        phoneText: 2.0,
        rolesText: 1.5,
        bioText: 1.0,
        linksText: 1.0,
      },
    },
  });

  searchIndex.addAll(indexedItems);

  return {
    members: publicMembers,
    byUsername,
    bySub,
    searchIndex,
    gradYears: [...years].sort((a, b) => b - a),
    locations: [...locationsMap.values()].sort((a, b) => a.localeCompare(b)),
    fetchedAt,
  };
}

export async function getClientCredentialsToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 30_000) {
    return tokenCache.accessToken;
  }

  if (inFlightTokenPromise) {
    return inFlightTokenPromise;
  }

  inFlightTokenPromise = (async () => {
    try {
      const { token_endpoint } = await getOpenIdConfiguration();

      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: DIRECTORY_SCOPES,
        resource: `${config.idBase}/api/directory`,
      });

      const res = await fetch(token_endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        if (res.status === 401) {
          tokenCache = null;
        }
        const text = await res.text();
        throw new Error(`client_credentials token request failed (${res.status}): ${text}`);
      }

      const data = (await res.json()) as {
        access_token: string;
        token_type: string;
        expires_in?: number;
      };

      const expiresIn = data.expires_in ?? 3600;
      tokenCache = {
        accessToken: data.access_token,
        expiresAt: Date.now() + expiresIn * 1000,
      };

      return data.access_token;
    } finally {
      inFlightTokenPromise = null;
    }
  })();

  return inFlightTokenPromise;
}

export async function refreshDirectorySnapshotProfiles(
  targetSub?: string
): Promise<DirectorySnapshot | null> {
  if (!upstreamMembersCache) {
    if (config.useMockDirectory) {
      upstreamMembersCache = {
        members: getDevMockMembers(),
        fetchedAt: Date.now(),
      };
    } else {
      return null;
    }
  }

  const profilesMap = getCachedProfilesMap();
  const discordMap = getCachedDiscordProfilesMap();
  localProfilesUpdatedAt = Date.now();

  // Await L2 sync metadata update so Vercel does not freeze the isolate before L2 commits
  const syncPromise = runtimeCache.set<DirectorySyncMeta>(
    DIRECTORY_SYNC_META_KEY,
    {
      upstreamFetchedAt: upstreamMembersCache.fetchedAt,
      profilesUpdatedAt: localProfilesUpdatedAt,
    },
    { ttlMs: CACHE_TTL_MS, tags: [DIRECTORY_UPSTREAM_TAG, DIRECTORY_PROFILES_TAG] }
  );
  try {
    waitUntil(syncPromise);
  } catch {
    // Fallback if outside Vercel request context
  }
  await syncPromise;

  // Fast-path: single member profile update
  if (targetSub && directoryCache && directoryCache.searchIndex) {
    const key = targetSub.toLowerCase();
    const rawMember = upstreamMembersCache.members.find((m) => m.sub.toLowerCase() === key);
    if (rawMember) {
      const updatedProfile = profilesMap.get(key) ?? null;
      const { doc, publicMember } = buildIndexedDoc(rawMember, updatedProfile, discordMap);

      directoryCache.bySub.set(key, publicMember);
      directoryCache.byUsername.set(rawMember.preferred_username.toLowerCase(), publicMember);
      const idx = directoryCache.members.findIndex((m) => m.sub.toLowerCase() === key);
      if (idx !== -1) {
        directoryCache.members[idx] = publicMember;
      }
      directoryCache.searchIndex.replace(doc);
      const locMap = new Map<string, string>();
      for (const m of directoryCache.members) {
        const loc = m.profile?.location?.trim();
        if (loc && !locMap.has(loc.toLowerCase())) {
          locMap.set(loc.toLowerCase(), loc);
        }
      }
      directoryCache.locations = [...locMap.values()].sort((a, b) => a.localeCompare(b));
      return directoryCache;
    }
  }

  const isInvalidated = directoryCache?.fetchedAt === 0;
  directoryCache = buildDirectorySnapshot(
    upstreamMembersCache.members,
    upstreamMembersCache.fetchedAt,
    profilesMap,
    discordMap
  );
  if (isInvalidated) {
    directoryCache.fetchedAt = 0;
  }
  return directoryCache;
}

registerDiscordUpdateListener(() => {
  refreshDirectorySnapshotProfiles();
});

export async function getDirectorySnapshot(forceRefresh = false): Promise<DirectorySnapshot> {
  const now = Date.now();

  if (
    !forceRefresh &&
    directoryCache &&
    directoryCache.fetchedAt > 0 &&
    now - directoryCache.fetchedAt < CACHE_TTL_MS
  ) {
    // Verify against L2 sync metadata so cross-isolate webhooks or profile updates are respected
    const syncMeta = await runtimeCache.get<DirectorySyncMeta>(DIRECTORY_SYNC_META_KEY);
    // Only trust L1 directoryCache if syncMeta exists AND upstreamFetchedAt matches our L1 snapshot
    if (syncMeta && syncMeta.upstreamFetchedAt === directoryCache.fetchedAt) {
      if (syncMeta.profilesUpdatedAt > localProfilesUpdatedAt && upstreamMembersCache) {
        const freshProfiles = await loadAllProfilesMap(true);
        localProfilesUpdatedAt = syncMeta.profilesUpdatedAt;
        directoryCache = buildDirectorySnapshot(
          upstreamMembersCache.members,
          directoryCache.fetchedAt,
          freshProfiles,
          getCachedDiscordProfilesMap()
        );
      }
      return directoryCache;
    }
  }

  while (inFlightDirectoryPromise) {
    if (!forceRefresh && inFlightEpoch >= invalidationEpoch) {
      return inFlightDirectoryPromise;
    }
    // Await currently in-flight request, then re-evaluate state in loop
    await inFlightDirectoryPromise.catch(() => {});
    const afterWaitNow = Date.now();
    if (
      !forceRefresh &&
      directoryCache &&
      directoryCache.fetchedAt > 0 &&
      afterWaitNow - directoryCache.fetchedAt < CACHE_TTL_MS
    ) {
      return directoryCache;
    }
    forceRefresh = false;
  }

  inFlightEpoch = invalidationEpoch;
  const startEpoch = invalidationEpoch;

  inFlightDirectoryPromise = (async () => {
    try {
      if (config.useMockDirectory) {
        const mockMembers = getDevMockMembers();
        const discordIds = mockMembers
          .map((m) => m.discord_id?.trim())
          .filter((id): id is string => Boolean(id));
        const [profilesMap, discordMap] = await Promise.all([
          loadAllProfilesMap(),
          loadAllDiscordProfilesMap(forceRefresh, true, discordIds),
        ]);
        const fetchedAt = Date.now();
        upstreamMembersCache = {
          members: mockMembers,
          fetchedAt,
        };
        localProfilesUpdatedAt = fetchedAt;
        await runtimeCache.set<DirectorySyncMeta>(
          DIRECTORY_SYNC_META_KEY,
          { upstreamFetchedAt: fetchedAt, profilesUpdatedAt: localProfilesUpdatedAt },
          { ttlMs: CACHE_TTL_MS, tags: [DIRECTORY_UPSTREAM_TAG, DIRECTORY_PROFILES_TAG] }
        );
        const snapshot = buildDirectorySnapshot(mockMembers, fetchedAt, profilesMap, discordMap);
        directoryCache = snapshot;
        return directoryCache;
      }

      // Check L2 Runtime Cache for upstream Purdue Hackers ID members before paginating ID API
      let cachedUpstream = !forceRefresh
        ? await runtimeCache.get<UpstreamMembersCachePayload>(UPSTREAM_MEMBERS_CACHE_KEY)
        : undefined;

      if (!cachedUpstream || Date.now() - cachedUpstream.fetchedAt >= CACHE_TTL_MS) {
        const token = await getClientCredentialsToken();
        const allMembers: DirectoryMember[] = [];
        let cursor: string | null = null;
        let page = 0;

        do {
          page++;
          if (page > MAX_PAGES) {
            throw new Error('Directory pagination exceeded safety threshold of 100 pages');
          }

          const url = new URL(`${config.idBase}/api/directory/users`);
          url.searchParams.set('limit', '100');
          if (cursor) {
            url.searchParams.set('cursor', cursor);
          }

          const res = await fetch(url.toString(), {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });

          if (!res.ok) {
            const text = await res.text();
            throw new Error(`Directory query failed (${res.status}): ${text}`);
          }

          const data = (await res.json()) as {
            users: DirectoryMember[];
            next_cursor: string | null;
          };

          for (const user of data.users) {
            if (!user.banned) {
              const publicRoles = (user.roles || []).filter((r) => r.toLowerCase() !== 'admin');
              allMembers.push({
                ...user,
                roles: publicRoles,
              });
            }
          }

          cursor = data.next_cursor;
        } while (cursor);

        cachedUpstream = {
          members: allMembers,
          fetchedAt: Date.now(),
        };

        await runtimeCache.set<UpstreamMembersCachePayload>(
          UPSTREAM_MEMBERS_CACHE_KEY,
          cachedUpstream,
          {
            ttlMs: CACHE_TTL_MS,
            tags: [DIRECTORY_UPSTREAM_TAG],
            name: 'directory-upstream-members',
          }
        );
      }

      upstreamMembersCache = {
        members: cachedUpstream.members,
        fetchedAt: cachedUpstream.fetchedAt,
      };

      const discordIds = cachedUpstream.members
        .map((m) => m.discord_id?.trim())
        .filter((id): id is string => Boolean(id));

      const [profilesMap, discordMap] = await Promise.all([
        loadAllProfilesMap(true),
        loadAllDiscordProfilesMap(forceRefresh, false, discordIds),
      ]);

      localProfilesUpdatedAt = Date.now();
      await runtimeCache.set<DirectorySyncMeta>(
        DIRECTORY_SYNC_META_KEY,
        {
          upstreamFetchedAt: cachedUpstream.fetchedAt,
          profilesUpdatedAt: localProfilesUpdatedAt,
        },
        { ttlMs: CACHE_TTL_MS, tags: [DIRECTORY_UPSTREAM_TAG, DIRECTORY_PROFILES_TAG] }
      );

      const snapshot = buildDirectorySnapshot(
        cachedUpstream.members,
        cachedUpstream.fetchedAt,
        profilesMap,
        discordMap
      );
      if (invalidationEpoch !== startEpoch) {
        snapshot.fetchedAt = 0;
      }
      directoryCache = snapshot;
      return directoryCache;
    } catch (err) {
      console.error('[Directory API] Failed to fetch directory members:', err);

      if (directoryCache) {
        console.warn('[Directory API] Returning stale directory snapshot');
        directoryCache = {
          ...directoryCache,
          fetchedAt: Date.now() - CACHE_TTL_MS + 15_000,
        };
        return directoryCache;
      }

      if (config.useMockDirectory) {
        console.warn('[Directory API] Development fallback: returning mock member list');
        const [profilesMap, discordMap] = await Promise.all([
          loadAllProfilesMap().catch(() => new Map()),
          loadAllDiscordProfilesMap().catch(() => new Map()),
        ]);
        const mockMembers = getDevMockMembers();
        upstreamMembersCache = {
          members: mockMembers,
          fetchedAt: Date.now(),
        };
        directoryCache = buildDirectorySnapshot(mockMembers, Date.now(), profilesMap, discordMap);
        return directoryCache;
      }

      throw err;
    } finally {
      inFlightDirectoryPromise = null;
    }
  })();

  return inFlightDirectoryPromise;
}

export async function fetchAllDirectoryMembers(forceRefresh = false): Promise<DirectoryMember[]> {
  const snapshot = await getDirectorySnapshot(forceRefresh);
  return snapshot.members;
}

export async function getMemberByUsername(username: string): Promise<DirectoryMember | null> {
  const snapshot = await getDirectorySnapshot();
  const lower = username.toLowerCase();
  return snapshot.byUsername.get(lower) ?? snapshot.bySub.get(lower) ?? null;
}

export function isMemberActiveInSnapshot(sub: string): boolean | null {
  if (
    !directoryCache ||
    directoryCache.members.length === 0 ||
    directoryCache.fetchedAt === 0 ||
    Date.now() - directoryCache.fetchedAt >= CACHE_TTL_MS
  ) {
    return null;
  }
  return directoryCache.bySub.has(sub.toLowerCase());
}

export async function ensureMemberActive(sub: string): Promise<boolean | null> {
  try {
    // Always go through getDirectorySnapshot so L2 DIRECTORY_SYNC_META_KEY is checked across isolates
    const snapshot = await getDirectorySnapshot(directoryCache?.fetchedAt === 0);
    if (!snapshot || snapshot.members.length === 0) {
      return null;
    }
    return snapshot.bySub.has(sub.toLowerCase());
  } catch {
    if (!directoryCache || directoryCache.members.length === 0) {
      return null;
    }
    return directoryCache.bySub.has(sub.toLowerCase());
  }
}

export async function invalidateDirectoryCache(): Promise<void> {
  invalidationEpoch++;
  // Keep tokenCache intact - M2M client_credentials token is still valid for 1 hour
  // Retain upstreamMembersCache until new members are fetched so getRawMemberBySub doesn't drop to null during revalidation
  if (directoryCache) {
    directoryCache = {
      ...directoryCache,
      fetchedAt: 0,
    };
  }
  await Promise.all([
    runtimeCache.expireTag(DIRECTORY_UPSTREAM_TAG),
    runtimeCache.delete(UPSTREAM_MEMBERS_CACHE_KEY),
    runtimeCache.delete(DIRECTORY_SYNC_META_KEY),
  ]);
  console.log('[Directory API] Directory snapshot marked stale for revalidation');
}

export function getDevMockMembers(): DirectoryMember[] {
  return [
    {
      sub: '01a1a7a2-31ea-7610-9e1d-be737abbeb97',
      preferred_username: 'testy',
      name: 'Artus Mosquet',
      given_name: 'Artus',
      family_name: 'Mosquet',
      picture: 'https://github.com/purduehackers.png',
      roles: ['organizer'],
      graduation_year: 2026,
      banned: false,
      email: 'testy@purduehackers.com',
      email_verified: true,
      emails: [
        { email: 'testy@purduehackers.com', primary: true, verified: true },
        { email: 'artus@purdue.edu', primary: false, verified: true },
      ],
      phone_number: '+1 (765) 555-0199',
      discord_id: '123456789012345678',
    },
    {
      sub: '01a1a761-8139-7553-bdba-b5385b625b5e',
      preferred_username: 'test',
      name: 'Test Life',
      given_name: 'Test',
      family_name: 'Life',
      picture: 'https://github.com/purduehackers.png',
      roles: ['alumni'],
      graduation_year: 2024,
      banned: false,
      email: 'test@lxoxl.us',
      email_verified: true,
      emails: [{ email: 'test@lxoxl.us', primary: true, verified: true }],
      phone_number: '+1 (248) 283-9772',
      discord_id: null,
    },
    {
      sub: '01a1a7c3-42eb-7711-9e2d-cf848bbcea01',
      preferred_username: 'clara',
      name: 'Clara Oswald',
      given_name: 'Clara',
      family_name: 'Oswald',
      picture: 'https://github.com/purduehackers.png',
      roles: ['organizer'],
      graduation_year: 2025,
      banned: false,
      email: 'clara@purduehackers.com',
      email_verified: true,
      emails: [
        { email: 'clara@purduehackers.com', primary: true, verified: true },
        { email: 'clara@oswald.io', primary: false, verified: true },
      ],
      phone_number: '+1 (765) 555-0142',
      discord_id: '987654321098765432',
    },
    {
      sub: '01a1a7d4-53fc-8822-af3e-df959ccdfb12',
      preferred_username: 'alex',
      name: 'Alex Chen',
      given_name: 'Alex',
      family_name: 'Chen',
      picture: 'https://github.com/purduehackers.png',
      roles: [],
      graduation_year: 2027,
      banned: false,
      email: 'alex@purdue.edu',
      email_verified: true,
      emails: [{ email: 'alex@purdue.edu', primary: true, verified: true }],
      phone_number: null,
      discord_id: '456123789456123789',
    },
  ];
}
