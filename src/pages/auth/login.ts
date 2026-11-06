import type { APIRoute } from 'astro';
import {
  createCodeChallenge,
  randomString,
  sanitizeReturnTo,
  setOAuthState,
} from '../../lib/server/session';
import { getAuthorizationUrl } from '../../lib/server/oidc';

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'));
  const state = randomString(32);
  const verifier = randomString(32);
  const codeChallenge = await createCodeChallenge(verifier);

  await setOAuthState(cookies, state, verifier, returnTo);

  try {
    const authUrl = await getAuthorizationUrl(state, codeChallenge);
    return redirect(authUrl);
  } catch (err) {
    console.error('[Auth Login] Failed to generate auth URL:', err);
    return redirect('/login?error=auth_unavailable');
  }
};
