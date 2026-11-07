import { describe, expect, it } from 'bun:test';
import {
  filterAndSearchMembers,
  getAvailableGradYears,
  groupMembersByCategory,
} from './search';
import { buildDirectorySnapshot, type DirectoryMember } from './id-directory';

const mockMembers: DirectoryMember[] = [
  {
    sub: '1',
    preferred_username: 'alice',
    name: 'Alice Johnson',
    given_name: 'Alice',
    family_name: 'Johnson',
    picture: '',
    roles: ['organizer'],
    graduation_year: 2025,
    banned: false,
    email: 'alice@purdue.edu',
    phone_number: '+1 (765) 555-0199',
    discord_id: '111',
    profile: {
      sub: '1',
      headline: null,
      bio: null,
      location: null,
      timezone: null,
      websiteUrl: null,
      socials: {},
      customLinks: [],
      contactVisibility: { phone: true },
      updatedAt: 0,
    },
  },
  {
    sub: '2',
    preferred_username: 'bob',
    name: 'Bob Smith',
    given_name: 'Bob',
    family_name: 'Smith',
    picture: '',
    roles: ['alumni'],
    graduation_year: 2023,
    banned: false,
    email: 'bob@gmail.com',
    phone_number: '+12482839772',
    discord_id: '222',
    profile: {
      sub: '2',
      headline: null,
      bio: null,
      location: null,
      timezone: null,
      websiteUrl: null,
      socials: {},
      customLinks: [],
      contactVisibility: { phone: true },
      updatedAt: 0,
    },
  },
  {
    sub: '3',
    preferred_username: 'charlie',
    name: 'Charlie Brown',
    given_name: 'Charlie',
    family_name: 'Brown',
    picture: '',
    roles: [],
    graduation_year: 2026,
    banned: false,
    email: 'charlie@purdue.edu',
    phone_number: '+1 (765) 555-4321',
    discord_id: null,
  },
  {
    sub: '4',
    preferred_username: 'aaron',
    name: 'Aaron testy-fan',
    given_name: 'Aaron',
    family_name: 'Test',
    picture: '',
    roles: [],
    graduation_year: 2024,
    banned: false,
    email: 'aaron@purdue.edu',
    discord_id: null,
  },
  {
    sub: '5',
    preferred_username: 'testy',
    name: 'Zach Testy',
    given_name: 'Zach',
    family_name: 'Testy',
    picture: '',
    roles: ['organizer'],
    graduation_year: 2026,
    banned: false,
    email: 'testy@purdue.edu',
    discord_id: null,
  },
];

describe('Search and Filter Engine', () => {
  it('returns all members when no filters provided and sorts by organizers, members, then alumni', () => {
    const res = filterAndSearchMembers(mockMembers);
    expect(res.length).toBe(5);
    expect(res.map((m) => m.preferred_username)).toEqual([
      'alice',
      'testy',
      'aaron',
      'charlie',
      'bob',
    ]);
  });

  it('groups members into Organizers, Members, and Alumni sections in order', () => {
    const sorted = filterAndSearchMembers(mockMembers);
    const groups = groupMembersByCategory(sorted);
    expect(groups.map((g) => g.label)).toEqual(['Organizers', 'Members', 'Alumni']);
    expect(groups[0].members.map((m) => m.preferred_username)).toEqual(['alice', 'testy']);
    expect(groups[1].members.map((m) => m.preferred_username)).toEqual(['aaron', 'charlie']);
    expect(groups[2].members.map((m) => m.preferred_username)).toEqual(['bob']);
  });

  it('filters by role correctly', () => {
    const organizers = filterAndSearchMembers(mockMembers, { role: 'organizer' });
    expect(organizers.length).toBe(2);

    const alumni = filterAndSearchMembers(mockMembers, { role: 'alumni' });
    expect(alumni.length).toBe(1);
    expect(alumni[0].preferred_username).toBe('bob');

    const generalMembers = filterAndSearchMembers(mockMembers, { role: 'member' });
    expect(generalMembers.length).toBe(2);
  });

  it('filters by graduation year', () => {
    const res = filterAndSearchMembers(mockMembers, { gradYear: 2026 });
    expect(res.length).toBe(2);
  });

  it('searches by name, username, and discord ID', () => {
    const byName = filterAndSearchMembers(mockMembers, { query: 'Alice' });
    expect(byName.length).toBe(1);
    expect(byName[0].sub).toBe('1');

    const byUser = filterAndSearchMembers(mockMembers, { query: 'bob' });
    expect(byUser.length).toBe(1);
    expect(byUser[0].sub).toBe('2');

    const byDiscord = filterAndSearchMembers(mockMembers, { query: '111' });
    expect(byDiscord.length).toBe(1);
    expect(byDiscord[0].sub).toBe('1');

    // Test search with resolved Discord profile
    const memberWithDiscordProfile: DirectoryMember[] = [
      {
        ...mockMembers[0],
        discord_id: '123456789012345678',
        discord: {
          discordId: '123456789012345678',
          username: 'artusm',
          globalName: 'Artus Mosquet',
          guildNickname: 'artus-nickname',
          avatarUrl: null,
          fetchedAt: 1000,
          expiresAt: 2000,
        },
      },
    ];
    const byDiscordHandle = filterAndSearchMembers(memberWithDiscordProfile, { query: 'artusm' });
    expect(byDiscordHandle.length).toBe(1);
    expect(byDiscordHandle[0].sub).toBe('1');

    const byDiscordAtHandle = filterAndSearchMembers(memberWithDiscordProfile, { query: '@artusm' });
    expect(byDiscordAtHandle.length).toBe(1);
    expect(byDiscordAtHandle[0].sub).toBe('1');

    const byGuildNick = filterAndSearchMembers(memberWithDiscordProfile, { query: 'artus-nickname' });
    expect(byGuildNick.length).toBe(1);
    expect(byGuildNick[0].sub).toBe('1');

    const byPhoneFormatted = filterAndSearchMembers(mockMembers, { query: '765' });
    expect(byPhoneFormatted.length).toBe(1);
    expect(byPhoneFormatted[0].sub).toBe('1');

    const byPhoneDigits = filterAndSearchMembers(mockMembers, { query: '5550199' });
    expect(byPhoneDigits.length).toBe(1);
    expect(byPhoneDigits[0].sub).toBe('1');

    const byE164AreaCode = filterAndSearchMembers(mockMembers, { query: '248' });
    expect(byE164AreaCode.length).toBe(1);
    expect(byE164AreaCode[0].sub).toBe('2');

    const byE164Last4 = filterAndSearchMembers(mockMembers, { query: '9772' });
    expect(byE164Last4.length).toBe(1);
    expect(byE164Last4[0].sub).toBe('2');

    // Untoggled phone number (Charlie) is hidden by default and not searchable
    const untoggledPhone = filterAndSearchMembers(mockMembers, { query: '5554321' });
    expect(untoggledPhone.length).toBe(0);
  });

  it('preserves search relevance scoring over alphabetical sorting when query is present', () => {
    // When searching 'testy', user with preferred_username 'testy' (boost 4) should rank FIRST,
    // ahead of 'Aaron' (name matches 'testy-fan'), even though Aaron comes earlier alphabetically.
    const res = filterAndSearchMembers(mockMembers, { query: 'testy' });
    expect(res.length).toBe(2);
    expect(res[0].preferred_username).toBe('testy');
    expect(res[1].preferred_username).toBe('aaron');
  });

  it('accepts DirectorySnapshot with pre-built search index', () => {
    const snapshot = buildDirectorySnapshot(mockMembers);
    const res = filterAndSearchMembers(snapshot, { query: 'charlie' });
    expect(res.length).toBe(1);
    expect(res[0].preferred_username).toBe('charlie');
  });

  it('extracts unique sorted graduation years', () => {
    const years = getAvailableGradYears(mockMembers);
    expect(years).toEqual([2026, 2025, 2024, 2023]);
  });
});
