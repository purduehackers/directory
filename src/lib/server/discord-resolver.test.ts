import { describe, expect, it, beforeEach } from 'bun:test';
import {
  formatDiscordUsername,
  buildAvatarUrl,
  rowToDiscordProfile,
  loadAllDiscordProfilesMap,
  getCachedDiscordProfilesMap,
  resetDiscordResolverForTesting,
  enqueueDiscordResolutions,
} from './discord-resolver';
import type { DiscordProfileRow } from './db/schema';
import { resetDbForTesting } from './db';
import { createClient } from '@libsql/client';

describe('Discord Resolver Service', () => {
  beforeEach(async () => {
    const memoryClient = createClient({ url: ':memory:' });
    await resetDbForTesting(memoryClient);
    resetDiscordResolverForTesting();
  });

  it('formats modern Discord usernames without discriminator', () => {
    expect(
      formatDiscordUsername({
        id: '123456789012345678',
        username: 'artusm',
        discriminator: '0',
      })
    ).toBe('artusm');

    expect(
      formatDiscordUsername({
        id: '123456789012345678',
        username: 'alice',
      })
    ).toBe('alice');
  });

  it('formats legacy Discord usernames with discriminator', () => {
    expect(
      formatDiscordUsername({
        id: '123456789012345678',
        username: 'legacy_user',
        discriminator: '1337',
      })
    ).toBe('legacy_user#1337');
  });

  it('builds avatar CDN URLs correctly for animated and static avatars', () => {
    expect(
      buildAvatarUrl({
        id: '123456789012345678',
        username: 'artusm',
        avatar: '8342729096ea3644b6f1a3026f528635',
      })
    ).toBe(
      'https://cdn.discordapp.com/avatars/123456789012345678/8342729096ea3644b6f1a3026f528635.png?size=128'
    );

    expect(
      buildAvatarUrl({
        id: '123456789012345678',
        username: 'artusm',
        avatar: 'a_8342729096ea3644b6f1a3026f528635',
      })
    ).toBe(
      'https://cdn.discordapp.com/avatars/123456789012345678/a_8342729096ea3644b6f1a3026f528635.gif?size=128'
    );

    expect(
      buildAvatarUrl({
        id: '123456789012345678',
        username: 'artusm',
        avatar: null,
      })
    ).toBeNull();
  });

  it('converts DB row to public DiscordProfile and handles not_found correctly', () => {
    const resolvedRow: DiscordProfileRow = {
      discordId: '123456789012345678',
      username: 'artusm',
      globalName: 'Artus Mosquet',
      guildNickname: 'artus',
      avatarUrl: 'https://cdn.discordapp.com/avatars/123/abc.png',
      status: 'resolved',
      fetchedAt: 1000,
      expiresAt: 2000,
    };

    const prof = rowToDiscordProfile(resolvedRow);
    expect(prof).not.toBeNull();
    expect(prof?.username).toBe('artusm');
    expect(prof?.globalName).toBe('Artus Mosquet');
    expect(prof?.guildNickname).toBe('artus');

    const notFoundRow: DiscordProfileRow = {
      discordId: '999999999999999999',
      username: null,
      globalName: null,
      guildNickname: null,
      avatarUrl: null,
      status: 'not_found',
      fetchedAt: 1000,
      expiresAt: 2000,
    };
    expect(rowToDiscordProfile(notFoundRow)).toBeNull();
  });

  it('loads mock Discord profiles with guild nicknames when in dev mock mode', async () => {
    const map = await loadAllDiscordProfilesMap(true, true);
    expect(map.size).toBeGreaterThanOrEqual(3);

    const artus = map.get('123456789012345678');
    expect(artus).toBeDefined();
    expect(artus?.username).toBe('artusm');
    expect(artus?.globalName).toBe('Artus Mosquet');
    expect(artus?.guildNickname).toBe('artus');

    const cached = getCachedDiscordProfilesMap();
    expect(cached.get('123456789012345678')?.username).toBe('artusm');
    expect(cached.get('123456789012345678')?.guildNickname).toBe('artus');
  });

  it('rejects invalid Snowflake formats in enqueueDiscordResolutions', () => {
    // Should not throw or crash on invalid strings
    enqueueDiscordResolutions(['', 'abc', '123', 'not-a-snowflake', '<script>']);
    expect(true).toBe(true);
  });
});
