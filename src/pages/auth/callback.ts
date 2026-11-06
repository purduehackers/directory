import type { APIRoute } from 'astro';
import { config } from '../../lib/server/config';
import {
  getAndClearOAuthState,
  sanitizeReturnTo,
  setSession,
} from '../../lib/server/session';
import {
  exchangeCodeForTokens,
  fetchUserInfo,
  verifyIdToken,
} from '../../lib/server/oidc';
import {
  getDirectorySnapshot,
  invalidateDirectoryCache,
  isMemberActiveInSnapshot,
} from '../../lib/server/id-directory';

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const error = url.searchParams.get('error');

  if (error) {
    console.error(`[Auth Callback] OAuth error from ID: ${error}`);
    const errorCode = error === 'access_denied' ? 'access_denied' : 'auth_failed';
    return redirect(`/login?error=${errorCode}`);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return redirect('/login?error=missing_code_or_state');
  }

  const savedState = await getAndClearOAuthState(cookies);
  if (!savedState || savedState.state !== state) {
    console.error('[Auth Callback] State mismatch or expired state cookie');
    return redirect('/login?error=invalid_state');
  }

  try {
    const tokens = await exchangeCodeForTokens(code, savedState.verifier);
    if (tokens.id_token) {
      const idPayload = await verifyIdToken(tokens.id_token);
      const user = await fetchUserInfo(tokens.access_token);
      if (user.sub.toLowerCase() !== idPayload.sub.toLowerCase()) {
        throw new Error('Mismatched sub claim between id_token and userinfo');
      }
      return await completeLogin(user);
    } else if (config.isProduction) {
      throw new Error('Missing id_token in token response');
    }

    const user = await fetchUserInfo(tokens.access_token);
    return await completeLogin(user);
  } catch (err: any) {
    console.error('[Auth Callback] Authentication flow failed:', err);
    const errorCode = err?.message === 'account_suspended' ? 'account_suspended' : 'auth_failed';
    return redirect(`/login?error=${errorCode}`);
  }

  async function completeLogin(user: any) {
    // If a new member registered and signs in while directory cache is warm,
    // invalidate and proactively refresh cache so they are immediately recognized
    if (isMemberActiveInSnapshot(user.sub) === false) {
      invalidateDirectoryCache();
      await getDirectorySnapshot(true).catch((err) => {
        console.warn('[Auth Callback] Proactive directory refresh failed:', err);
      });
    }

    // Store only minimal user claims in the signed cookie (least privilege, avoiding 4KB limit)
    await setSession(cookies, user);

    const returnTo = sanitizeReturnTo(savedState?.returnTo);
    return redirect(returnTo);
  }
};
