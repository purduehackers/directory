import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config';
import type { SessionUser } from './session';

let jwksCache: { jwks: ReturnType<typeof createRemoteJWKSet>; uri: string } | null = null;

function getJwks(jwksUri: string) {
  if (!jwksCache || jwksCache.uri !== jwksUri) {
    jwksCache = {
      jwks: createRemoteJWKSet(new URL(jwksUri)),
      uri: jwksUri,
    };
  }
  return jwksCache.jwks;
}

export async function verifyIdToken(idToken: string): Promise<{ sub: string; [key: string]: any }> {
  const openidConfig = await getOpenIdConfiguration();
  const JWKS = getJwks(openidConfig.jwks_uri);
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: openidConfig.issuer,
    audience: config.clientId,
  });
  if (!payload.sub) {
    throw new Error('id_token missing sub claim');
  }
  return payload as { sub: string; [key: string]: any };
}

type OpenIdConfiguration = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
};

let discoveryCache: { config: OpenIdConfiguration; expiresAt: number } | null = null;
const FETCH_TIMEOUT_MS = 8_000;

export async function getOpenIdConfiguration(): Promise<OpenIdConfiguration> {
  const now = Date.now();
  if (discoveryCache && discoveryCache.expiresAt > now) {
    return discoveryCache.config;
  }

  const discoveryUrl = `${config.idBase}/api/auth/.well-known/openid-configuration`;
  try {
    const res = await fetch(discoveryUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch OpenID configuration: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as OpenIdConfiguration;
    if (
      !data ||
      typeof data.issuer !== 'string' ||
      typeof data.authorization_endpoint !== 'string' ||
      typeof data.token_endpoint !== 'string' ||
      typeof data.userinfo_endpoint !== 'string' ||
      typeof data.jwks_uri !== 'string'
    ) {
      throw new Error('Malformed OpenID configuration payload');
    }
    discoveryCache = {
      config: data,
      expiresAt: now + 60 * 60 * 1000, // 1 hour cache
    };
    return data;
  } catch (err) {
    // Fallback to standard Purdue Hackers ID paths if discovery fails
    console.warn(`[OIDC] Discovery failed at ${discoveryUrl}, using standard endpoints fallback:`, err);
    return {
      issuer: `${config.idBase}/api/auth`,
      authorization_endpoint: `${config.idBase}/api/auth/oauth2/authorize`,
      token_endpoint: `${config.idBase}/api/auth/oauth2/token`,
      userinfo_endpoint: `${config.idBase}/api/auth/oauth2/userinfo`,
      jwks_uri: `${config.idBase}/api/auth/jwks`,
    };
  }
}

export async function getAuthorizationUrl(state: string, codeChallenge: string): Promise<string> {
  const { authorization_endpoint } = await getOpenIdConfiguration();
  const url = new URL(authorization_endpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email roles phone');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
};

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const { token_endpoint } = await getOpenIdConfiguration();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // RFC 6749 Section 2.3: Use exactly one client authentication method.
  // Confidential clients use HTTP Basic; public clients pass client_id in the body.
  if (config.clientSecret) {
    headers['Authorization'] = `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
  } else {
    body.set('client_id', config.clientId);
  }

  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return (await res.json()) as TokenResponse;
}

export async function fetchUserInfo(accessToken: string): Promise<SessionUser> {
  const { userinfo_endpoint } = await getOpenIdConfiguration();

  const res = await fetch(userinfo_endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Userinfo request failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as Record<string, any>;
  const sub = data.sub || data.id;
  if (!sub) {
    throw new Error('Missing sub claim in userinfo response');
  }
  if (data.banned) {
    throw new Error('account_suspended');
  }

  return {
    sub,
    preferred_username: data.preferred_username || data.username || data.email?.split('@')[0] || 'member',
    name: data.name || data.preferred_username || 'Purdue Hacker',
    picture: data.picture || data.image,
    roles: Array.isArray(data.roles) ? data.roles : [],
    email: data.email,
    graduation_year: data.graduation_year ?? null,
  };
}
