import { describe, expect, it, beforeEach } from 'bun:test';
import {
  getMemberProfileBySub,
  upsertMemberProfile,
  loadAllProfilesMap,
} from './profile-store';
import {
  buildDirectorySnapshot,
  refreshDirectorySnapshotProfiles,
  getVisibleEmails,
  getVisiblePhone,
  type DirectoryMember,
} from './id-directory';
import { filterAndSearchMembers } from './search';

describe('profile-store & snapshot merge', () => {
  it('upserts a member profile and retrieves it by sub', async () => {
    const sub = 'test-sub-12345';
    const profile = await upsertMemberProfile(sub, {
      headline: 'FPGA & Compilers hacker',
      major: 'Computer Science',
      bio: 'Building toy hardware and compilers.',
      location: 'West Lafayette, IN',
      timezone: 'America/Indiana/Indianapolis',
      timeFormat: '24h',
      websiteUrl: 'https://purduehackers.com',
      socials: {
        github: 'https://github.com/purduehackers',
        x: 'https://x.com/purduehackers',
      },
      customLinks: [{ label: 'Hardware Repo', url: 'https://github.com/example/fpga' }],
      contactVisibility: { phone: false },
    });

    expect(profile.sub).toBe(sub);
    expect(profile.location).toBe('West Lafayette, IN');
    expect(profile.major).toBe('Computer Science');
    expect(profile.timeFormat).toBe('24h');

    const fetched = await getMemberProfileBySub(sub);
    expect(fetched).not.toBeNull();
    expect(fetched?.sub).toBe(sub);
    expect(fetched?.headline).toBe('FPGA & Compilers hacker');
    expect(fetched?.major).toBe('Computer Science');
    expect(fetched?.timeFormat).toBe('24h');
  });

  it('indexes profile fields into MiniSearch and allows searching by location and headline/bio', () => {
    const members: DirectoryMember[] = [
      {
        sub: 'sub-sf',
        preferred_username: 'sfhacker',
        name: 'Bay Hacker',
        given_name: 'Bay',
        family_name: 'Hacker',
        picture: '',
        roles: [],
        graduation_year: 2024,
        banned: false,
        profile: {
          sub: 'sub-sf',
          headline: 'Storage engines dev',
          major: 'Computer Science',
          bio: 'Living in SF',
          location: 'San Francisco, CA',
          timezone: 'America/Los_Angeles',
          websiteUrl: null,
          socials: {},
          customLinks: [],
          contactVisibility: { phone: false },
          updatedAt: Date.now(),
        },
      },
      {
        sub: 'sub-wl',
        preferred_username: 'purduekid',
        name: 'Boiler Maker',
        given_name: 'Boiler',
        family_name: 'Maker',
        picture: '',
        roles: [],
        graduation_year: 2026,
        banned: false,
        profile: {
          sub: 'sub-wl',
          headline: 'Hardware club lead',
          major: null,
          bio: 'Campus organizer',
          location: 'West Lafayette, IN',
          timezone: 'America/Indiana/Indianapolis',
          websiteUrl: null,
          socials: {},
          customLinks: [],
          contactVisibility: { phone: false },
          updatedAt: Date.now(),
        },
      },
    ];

    const snapshot = buildDirectorySnapshot(members);

    // 1. Search by location: "San Francisco"
    const sfResults = filterAndSearchMembers(snapshot, { query: 'San Francisco' });
    expect(sfResults).toHaveLength(1);
    expect(sfResults[0].preferred_username).toBe('sfhacker');

    // 2. Search by headline / bio: "Hardware club"
    const hardwareResults = filterAndSearchMembers(snapshot, { query: 'Hardware club' });
    expect(hardwareResults).toHaveLength(1);
    expect(hardwareResults[0].preferred_username).toBe('purduekid');

    // 3. Search by location: "West Lafayette"
    const wlResults = filterAndSearchMembers(snapshot, { query: 'West Lafayette' });
    expect(wlResults).toHaveLength(1);
    expect(wlResults[0].preferred_username).toBe('purduekid');

    // 4. Search by major: "Computer Science"
    const majorResults = filterAndSearchMembers(snapshot, { query: 'Computer Science' });
    expect(majorResults).toHaveLength(1);
    expect(majorResults[0].preferred_username).toBe('sfhacker');
  });

  it('persists contact visibility settings and respects them in directory search', async () => {
    const sub = 'sub-contact-privacy';
    await upsertMemberProfile(sub, {
      headline: 'Privacy Advocate',
      major: null,
      bio: '',
      location: null,
      timezone: null,
      websiteUrl: null,
      socials: {},
      customLinks: [],
      contactVisibility: {
        emails: {
          'hidden@purdue.edu': false,
          'visible@purdue.edu': true,
        },
        phone: false,
      },
    });

    const fetched = await getMemberProfileBySub(sub);
    expect(fetched?.contactVisibility?.phone).toBe(false);
    expect(fetched?.contactVisibility?.emails?.['hidden@purdue.edu']).toBe(false);
    expect(fetched?.contactVisibility?.emails?.['visible@purdue.edu']).toBe(true);

    const members: DirectoryMember[] = [
      {
        sub,
        preferred_username: 'privatemember',
        name: 'Private Member',
        given_name: 'Private',
        family_name: 'Member',
        picture: '',
        roles: [],
        phone_number: '+17655551234',
        emails: [
          { email: 'hidden@purdue.edu', primary: true, verified: true },
          { email: 'visible@purdue.edu', primary: false, verified: true },
        ],
        graduation_year: 2025,
        banned: false,
        profile: fetched,
      },
    ];

    const snapshot = buildDirectorySnapshot(members);

    // Searching for the hidden email should NOT return results
    const hiddenEmailSearch = filterAndSearchMembers(snapshot, { query: 'hidden@purdue.edu' });
    expect(hiddenEmailSearch).toHaveLength(0);

    // Searching for the hidden phone should NOT return results
    const hiddenPhoneSearch = filterAndSearchMembers(snapshot, { query: '5551234' });
    expect(hiddenPhoneSearch).toHaveLength(0);

    // Searching for the visible email SHOULD return results
    const visibleEmailSearch = filterAndSearchMembers(snapshot, { query: 'visible@purdue.edu' });
    expect(visibleEmailSearch).toHaveLength(1);
    expect(visibleEmailSearch[0].preferred_username).toBe('privatemember');
  });

  it('defaults untoggled primary emails to visible and secondary emails and phone numbers to hidden', () => {
    const member: DirectoryMember = {
      sub: 'sub-defaults',
      preferred_username: 'defaultuser',
      name: 'Default User',
      given_name: 'Default',
      family_name: 'User',
      picture: '',
      roles: [],
      graduation_year: 2026,
      banned: false,
      phone_number: '+17655558888',
      emails: [
        { email: 'main@purdue.edu', primary: true, verified: true },
        { email: 'recovery@gmail.com', primary: false, verified: true },
      ],
      profile: null, // No profile configured yet
    };

    const visibleEmails = getVisibleEmails(member);
    expect(visibleEmails).toHaveLength(1);
    expect(visibleEmails[0].email).toBe('main@purdue.edu');
    expect(visibleEmails[0].primary).toBe(true);

    // Phone number should be hidden by default
    expect(getVisiblePhone(member)).toBeNull();

    const snapshot = buildDirectorySnapshot([member]);
    const mainSearch = filterAndSearchMembers(snapshot, { query: 'main@purdue.edu' });
    expect(mainSearch).toHaveLength(1);

    const secondarySearch = filterAndSearchMembers(snapshot, { query: 'recovery@gmail.com' });
    expect(secondarySearch).toHaveLength(0);

    const phoneSearch = filterAndSearchMembers(snapshot, { query: '5558888' });
    expect(phoneSearch).toHaveLength(0);
  });
});
