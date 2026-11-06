import { describe, expect, it } from 'bun:test';
import {
  createCodeChallenge,
  randomString,
  setSession,
  getSession,
  clearSession,
  sanitizeReturnTo,
  signPayload,
  verifyPayload,
} from './session';

describe('Session and PKCE Helpers', () => {
  it('generates random strings of expected lengths', () => {
    const s1 = randomString(32);
    const s2 = randomString(32);
    expect(s1).not.toBe(s2);
    expect(s1.length).toBeGreaterThan(20);
  });

  it('computes S256 code challenge correctly', async () => {
    const verifier = 'test-code-verifier-string-123456';
    const challenge = await createCodeChallenge(verifier);
    expect(challenge).toBeString();
    expect(challenge.length).toBeGreaterThan(10);

    // Same verifier produces identical challenge
    const challenge2 = await createCodeChallenge(verifier);
    expect(challenge).toBe(challenge2);
  });

  it('signs and verifies session data in cookies', async () => {
    const cookieStore = new Map<string, string>();
    const mockCookies: any = {
      get: (name: string) => (cookieStore.has(name) ? { value: cookieStore.get(name) } : undefined),
      set: (name: string, val: string) => cookieStore.set(name, val),
      delete: (name: string) => cookieStore.delete(name),
    };

    const user = {
      sub: 'user-123',
      preferred_username: 'purduehacker',
      name: 'Purdue Hacker',
      roles: ['organizer'],
      graduation_year: 2026,
    };

    await setSession(mockCookies, user);
    expect(cookieStore.has('ph_dir_session')).toBe(true);

    const session = await getSession(mockCookies);
    expect(session).not.toBeNull();
    expect(session?.user.sub).toBe('user-123');
    expect(session?.user.preferred_username).toBe('purduehacker');
    expect(session?.user.roles).toEqual(['organizer']);

    // Tampered cookie check
    const rawVal = cookieStore.get('ph_dir_session')!;
    cookieStore.set('ph_dir_session', rawVal.slice(0, -4) + 'abcd');
    const tampered = await getSession(mockCookies);
    expect(tampered).toBeNull();

    // Clear session
    clearSession(mockCookies);
    expect(cookieStore.has('ph_dir_session')).toBe(false);
  });

  it('enforces token purpose separation and rejects crossed tokens', async () => {
    const sessionToken = await signPayload({ user: { sub: 'test' } }, 'test-secret', 'session');
    const stateToken = await signPayload({ state: 'xyz' }, 'test-secret', 'oauth_state');

    // Attempt to verify session token with oauth_state purpose
    const crossed1 = await verifyPayload(sessionToken, 'test-secret', 'oauth_state');
    expect(crossed1).toBeNull();

    // Attempt to verify oauth_state token with session purpose
    const crossed2 = await verifyPayload(stateToken, 'test-secret', 'session');
    expect(crossed2).toBeNull();
  });

  it('sanitizes returnTo parameter to prevent open redirect vulnerabilities', () => {
    // Valid relative internal paths
    expect(sanitizeReturnTo('/')).toBe('/');
    expect(sanitizeReturnTo('/u/artus')).toBe('/u/artus');
    expect(sanitizeReturnTo('/u/artus?tab=contact')).toBe('/u/artus?tab=contact');
    expect(sanitizeReturnTo('/?role=organizer&gradYear=2026')).toBe('/?role=organizer&gradYear=2026');

    // Dangerous external and protocol-relative URLs
    expect(sanitizeReturnTo('https://evil.com')).toBe('/');
    expect(sanitizeReturnTo('http://evil.com/phish')).toBe('/');
    expect(sanitizeReturnTo('//evil.com')).toBe('/');
    expect(sanitizeReturnTo('/\\evil.com')).toBe('/');
    expect(sanitizeReturnTo('javascript:alert(1)')).toBe('/');
    expect(sanitizeReturnTo(null)).toBe('/');
    expect(sanitizeReturnTo(undefined)).toBe('/');
    expect(sanitizeReturnTo('')).toBe('/');

    // WHATWG dot-segment normalization bypass vectors (SEC-NEW-01)
    expect(sanitizeReturnTo('/.//evil.com')).toBe('/');
    expect(sanitizeReturnTo('/..//evil.com')).toBe('/');
    expect(sanitizeReturnTo('/./..//evil.com')).toBe('/');

    // Auth endpoint loop prevention
    expect(sanitizeReturnTo('/login')).toBe('/');
    expect(sanitizeReturnTo('/logout')).toBe('/');
    expect(sanitizeReturnTo('/auth/login')).toBe('/');
    expect(sanitizeReturnTo('/auth/callback')).toBe('/');
  });
});
