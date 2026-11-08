import { describe, expect, it } from 'bun:test';
import {
  buildDirectorySnapshot,
  getVisiblePhone,
  getVisibleEmails,
  type DirectoryMember,
} from './id-directory';
import { filterAndSearchMembers } from './search';
import { readBodyWithLimit } from '../../pages/api/profile';
import { sanitizeHttpUrl, normalizeSocialLink } from './profile-validation';
import { signPayload, verifyPayload } from './session';

describe('Security Audit Fix Verifications', () => {
  it('F-01: buildDirectorySnapshot strips hidden emails, phone numbers and visibility maps from public members', () => {
    const rawMember: DirectoryMember = {
      sub: 'sub-sec-01',
      preferred_username: 'sechacker',
      name: 'Sec Hacker',
      given_name: 'Sec',
      family_name: 'Hacker',
      picture: 'https://example.com/avatar.png',
      roles: ['member'],
      graduation_year: 2025,
      banned: false,
      phone_number: '+17655559999',
      emails: [
        { email: 'public@purdue.edu', primary: true, verified: true },
        { email: 'secret-secondary@gmail.com', primary: false, verified: true },
      ],
      profile: {
        sub: 'sub-sec-01',
        headline: 'Security Researcher',
        major: 'Computer Science',
        bio: 'Auditing code',
        location: 'West Lafayette, IN',
        timezone: 'America/New_York',
        websiteUrl: 'https://example.com',
        socials: {},
        customLinks: [],
        contactVisibility: {
          emails: {
            'public@purdue.edu': true,
            'secret-secondary@gmail.com': false,
          },
          phone: false, // Hidden phone
        },
        updatedAt: Date.now(),
      },
    };

    const snapshot = buildDirectorySnapshot([rawMember]);
    const publicMember = snapshot.members[0];

    // Phone number should be stripped (null)
    expect(publicMember.phone_number).toBeNull();

    // Hidden secondary email should be completely absent from emails array
    expect(publicMember.emails).toHaveLength(1);
    expect(publicMember.emails?.[0].email).toBe('public@purdue.edu');

    // contactVisibility map should be wiped from public member profile to prevent email key harvesting
    expect(publicMember.profile?.contactVisibility).toEqual({});

    // Internal indexing text fields must NOT exist on public member object
    expect((publicMember as any).phoneText).toBeUndefined();
    expect((publicMember as any).discordText).toBeUndefined();
    expect((publicMember as any).rolesText).toBeUndefined();
    expect((publicMember as any).emailsText).toBeUndefined();

    // Searching for the visible primary email should find the member
    const search1 = filterAndSearchMembers(snapshot, { query: 'public@purdue.edu' });
    expect(search1).toHaveLength(1);

    // Searching for the hidden secondary email should NOT find the member
    const search2 = filterAndSearchMembers(snapshot, { query: 'secret-secondary@gmail.com' });
    expect(search2).toHaveLength(0);
  });

  it('F-01-fix: preserves public phone numbers and secondary emails on sanitized public members', () => {
    const rawMember: DirectoryMember = {
      sub: 'sub-sec-visible',
      preferred_username: 'visiblehacker',
      name: 'Visible Hacker',
      given_name: 'Visible',
      family_name: 'Hacker',
      picture: 'https://example.com/avatar.png',
      roles: ['member'],
      graduation_year: 2026,
      banned: false,
      phone_number: '+17655551234',
      emails: [
        { email: 'primary@purdue.edu', primary: true, verified: true },
        { email: 'secondary-visible@purduehackers.com', primary: false, verified: true },
      ],
      profile: {
        sub: 'sub-sec-visible',
        headline: 'Public Info',
        major: null,
        bio: 'Sharing contact info',
        location: 'West Lafayette, IN',
        timezone: 'America/New_York',
        websiteUrl: 'https://example.com',
        socials: {},
        customLinks: [],
        contactVisibility: {
          emails: {
            'primary@purdue.edu': true,
            'secondary-visible@purduehackers.com': true,
          },
          phone: true, // Public phone!
        },
        updatedAt: Date.now(),
      },
    };

    const snapshot = buildDirectorySnapshot([rawMember]);
    const publicMember = snapshot.members[0];

    // Phone number should be preserved on public member
    expect(publicMember.phone_number).toBe('+17655551234');
    expect(getVisiblePhone(publicMember)).toBe('+17655551234');

    // Both primary and public secondary emails should be present
    expect(publicMember.emails).toHaveLength(2);
    expect(getVisibleEmails(publicMember)).toHaveLength(2);

    // contactVisibility map is still wiped on public DTO
    expect(publicMember.profile?.contactVisibility).toEqual({});

    // Searching by phone number must work
    const phoneSearch = filterAndSearchMembers(snapshot, { query: '5551234' });
    expect(phoneSearch).toHaveLength(1);
    expect(phoneSearch[0].sub).toBe('sub-sec-visible');
  });

  it('F-05: readBodyWithLimit rejects oversized payloads and streaming chunks', async () => {
    // 1. Oversized via Content-Length header
    const req1 = new Request('http://localhost:4321/api/profile', {
      method: 'POST',
      headers: { 'content-length': '20000' },
      body: 'x'.repeat(20000),
    });
    expect(readBodyWithLimit(req1, 16384)).rejects.toThrow('PAYLOAD_TOO_LARGE');

    // 2. Oversized without Content-Length (chunked simulation)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'.repeat(10000)));
        controller.enqueue(new TextEncoder().encode('b'.repeat(10000)));
        controller.close();
      },
    });
    const req2 = new Request('http://localhost:4321/api/profile', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as any);
    expect(readBodyWithLimit(req2, 16384)).rejects.toThrow('PAYLOAD_TOO_LARGE');

    // 3. Valid bounded payload succeeds
    const req3 = new Request('http://localhost:4321/api/profile', {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
    });
    const body = await readBodyWithLimit(req3, 16384);
    expect(JSON.parse(body)).toEqual({ ok: true });
  });

  it('F-08: Cryptographic purpose separation prevents token type confusion', async () => {
    const secret = 'super-secret-key-32-chars-minimum-length!';
    const sessionToken = await signPayload({ user: { sub: 'u1' } }, secret, 'session');
    const oauthStateToken = await signPayload({ state: 's1' }, secret, 'oauth_state');

    // Attempting to use sessionToken where oauth_state is expected must fail
    expect(await verifyPayload(sessionToken, secret, 'oauth_state')).toBeNull();

    // Attempting to use oauthStateToken where session is expected must fail
    expect(await verifyPayload(oauthStateToken, secret, 'session')).toBeNull();

    // Correct purpose succeeds
    expect(await verifyPayload(sessionToken, secret, 'session')).not.toBeNull();
    expect(await verifyPayload(oauthStateToken, secret, 'oauth_state')).not.toBeNull();
  });

  it('F-09: sanitizeHttpUrl rejects bracketed IPv6 loopbacks, RFC 1918 and link-local addresses', () => {
    // Bracketed IPv6 loopbacks
    expect(sanitizeHttpUrl('http://[::1]/admin').url).toBeNull();
    expect(sanitizeHttpUrl('http://[::1]:8080').url).toBeNull();

    // Internal and cloud metadata IP ranges
    expect(sanitizeHttpUrl('http://127.0.0.1').url).toBeNull();
    expect(sanitizeHttpUrl('http://127.0.0.2').url).toBeNull();
    expect(sanitizeHttpUrl('http://0.0.0.0').url).toBeNull();
    expect(sanitizeHttpUrl('http://169.254.169.254/latest/meta-data').url).toBeNull();
    expect(sanitizeHttpUrl('http://10.0.0.1').url).toBeNull();
    expect(sanitizeHttpUrl('http://192.168.1.1').url).toBeNull();
    expect(sanitizeHttpUrl('http://172.16.0.1').url).toBeNull();
    expect(sanitizeHttpUrl('http://test.localhost').url).toBeNull();

    // Valid public domains allowed
    expect(sanitizeHttpUrl('https://purduehackers.com').url).toBe('https://purduehackers.com/');
    expect(sanitizeHttpUrl('github.com/purduehackers').url).toBe('https://github.com/purduehackers');
  });

  it('F-09: normalizeSocialLink rejects arbitrary URLs for Mastodon and strips query strings', () => {
    // Arbitrary domain without user profile path rejected
    expect(normalizeSocialLink('mastodon', 'https://evil.com/malware.exe').value).toBeUndefined();
    expect(normalizeSocialLink('mastodon', 'https://mastodon.social/explore').value).toBeUndefined();

    // Valid user profile paths accepted and normalized
    expect(normalizeSocialLink('mastodon', 'https://fosstodon.org/@alice').value).toBe('https://fosstodon.org/@alice');
    expect(normalizeSocialLink('mastodon', 'https://mastodon.social/users/bob').value).toBe('https://mastodon.social/users/bob');
    expect(normalizeSocialLink('mastodon', '@charlie@hachyderm.io').value).toBe('https://hachyderm.io/@charlie');

    // Query strings stripped for social links to prevent open redirect abuse
    expect(normalizeSocialLink('youtube', 'https://youtube.com/@purduehackers?redirect=evil.com').value).toBe('https://youtube.com/@purduehackers');
  });
});
