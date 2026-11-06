import type { AstroCookies } from 'astro';
import { config } from './config';

export type SessionUser = {
  sub: string;
  preferred_username: string;
  name: string;
  picture?: string;
  roles?: string[];
  email?: string;
  graduation_year?: number | null;
};

export type SessionData = {
  user: SessionUser;
  exp: number; // unix timestamp in seconds
};

export type OAuthStateData = {
  state: string;
  verifier: string;
  returnTo?: string;
  exp: number;
};

const SESSION_COOKIE_BASE = 'ph_dir_session';
const STATE_COOKIE_BASE = 'ph_oauth_state';
const SEVEN_DAYS = 7 * 24 * 60 * 60;
const TEN_MINUTES = 10 * 60;

export function getSessionCookieName(): string {
  const isHttps = config.publicUrl.startsWith('https://');
  return isHttps ? `__Host-${SESSION_COOKIE_BASE}` : SESSION_COOKIE_BASE;
}

export function getStateCookieName(): string {
  const isHttps = config.publicUrl.startsWith('https://');
  return isHttps ? `__Host-${STATE_COOKIE_BASE}` : STATE_COOKIE_BASE;
}

let cachedHmacKey: { secret: string; key: CryptoKey } | null = null;

const DISALLOWED_RETURN_PREFIXES = ['/login', '/auth/', '/logout'];

/**
 * Prevents Open Redirect vulnerabilities by ensuring returnTo is a safe, relative path.
 * Hardened against WHATWG dot-segment normalizations (e.g. `/.//evil.com`) and auth loops.
 */
export function sanitizeReturnTo(input: string | null | undefined): string {
  if (!input) return '/';
  const trimmed = input.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return '/';
  }
  try {
    const url = new URL(trimmed, 'http://localhost');
    if (url.origin !== 'http://localhost') return '/';
    // Reject paths that normalize into protocol-relative URLs (e.g. /.//evil.com -> //evil.com)
    if (
      !url.pathname.startsWith('/') ||
      url.pathname.startsWith('//') ||
      url.pathname.startsWith('/\\')
    ) {
      return '/';
    }
    // Disallow redirecting into auth/login/logout endpoints to prevent redirect loops
    if (
      DISALLOWED_RETURN_PREFIXES.some(
        (prefix) => url.pathname === prefix || url.pathname.startsWith(prefix)
      )
    ) {
      return '/';
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

function b64urlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const m = str.length % 4;
  const base64 = (str + (m === 2 ? '==' : m === 3 ? '=' : ''))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function randomString(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return b64urlEncode(digest);
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  if (cachedHmacKey && cachedHmacKey.secret === secret) {
    return cachedHmacKey.key;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  cachedHmacKey = { secret, key };
  return key;
}

async function signString(str: string, secret: string): Promise<string> {
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(str));
  return b64urlEncode(sig);
}

async function verifySignature(str: string, sigB64: string, secret: string): Promise<boolean> {
  try {
    const key = await getHmacKey(secret);
    const sig = b64urlDecode(sigB64);
    return await crypto.subtle.verify('HMAC', key, sig as any, new TextEncoder().encode(str));
  } catch {
    return false;
  }
}

export async function signPayload<T>(
  payload: T,
  secret: string,
  purpose = 'general'
): Promise<string> {
  const jsonStr = JSON.stringify({ ...payload, _typ: purpose });
  const dataB64 = b64urlEncode(new TextEncoder().encode(jsonStr));
  const sigB64 = await signString(`${purpose}:${dataB64}`, secret);
  return `${dataB64}.${sigB64}`;
}

export async function verifyPayload<T>(
  token: string,
  secret: string,
  purpose = 'general'
): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [dataB64, sigB64] = parts;
  if (!dataB64 || !sigB64) return null;
  const valid = await verifySignature(`${purpose}:${dataB64}`, sigB64, secret);
  if (!valid) return null;
  try {
    const jsonStr = new TextDecoder().decode(b64urlDecode(dataB64));
    const data = JSON.parse(jsonStr) as T & { _typ?: string };
    if (data._typ !== purpose) return null;
    return data;
  } catch {
    return null;
  }
}

export async function getSession(cookies: AstroCookies): Promise<SessionData | null> {
  const name = getSessionCookieName();
  const cookie = cookies.get(name)?.value;
  if (!cookie) return null;

  const data = await verifyPayload<SessionData>(cookie, config.sessionSecret, 'session');
  if (!data) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!data.exp || data.exp < now) {
    clearSession(cookies);
    return null;
  }

  return data;
}

export async function setSession(
  cookies: AstroCookies,
  user: SessionUser
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const data: SessionData = {
    user: {
      sub: user.sub,
      preferred_username: user.preferred_username,
      name: user.name,
      picture: user.picture,
      roles: user.roles,
      email: user.email,
      graduation_year: user.graduation_year,
    },
    exp: now + SEVEN_DAYS,
  };

  const token = await signPayload(data, config.sessionSecret, 'session');
  const isHttps = config.publicUrl.startsWith('https://');
  const cookieName = getSessionCookieName();

  cookies.set(cookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: SEVEN_DAYS,
  });
}

export function clearSession(cookies: AstroCookies): void {
  cookies.delete(getSessionCookieName(), { path: '/' });
  cookies.delete(SESSION_COOKIE_BASE, { path: '/' });
}

export async function setOAuthState(
  cookies: AstroCookies,
  state: string,
  verifier: string,
  returnTo?: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const data: OAuthStateData = {
    state,
    verifier,
    returnTo: sanitizeReturnTo(returnTo),
    exp: now + TEN_MINUTES,
  };

  const token = await signPayload(data, config.sessionSecret, 'oauth_state');
  const isHttps = config.publicUrl.startsWith('https://');
  const cookieName = getStateCookieName();

  cookies.set(cookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: TEN_MINUTES,
  });
}

export async function getAndClearOAuthState(cookies: AstroCookies): Promise<OAuthStateData | null> {
  const name = getStateCookieName();
  const cookie = cookies.get(name)?.value;
  cookies.delete(name, { path: '/' });
  cookies.delete(STATE_COOKIE_BASE, { path: '/' });
  if (!cookie) return null;

  const data = await verifyPayload<OAuthStateData>(cookie, config.sessionSecret, 'oauth_state');
  if (!data) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!data.exp || data.exp < now) return null;

  return data;
}
