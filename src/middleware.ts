import { defineMiddleware } from 'astro:middleware';
import { clearSession, getSession, sanitizeReturnTo } from './lib/server/session';
import { ensureMemberActive } from './lib/server/id-directory';

const PUBLIC_EXACT_PATHS = new Set([
  '/login',
  '/logout',
  '/auth/login',
  '/auth/callback',
  '/api/webhooks/id',
  '/robots.txt',
]);

const PUBLIC_DIR_PREFIXES = ['/_astro/', '/favicon'];

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, cookies, locals, redirect } = context;
  const pathname = url.pathname;
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  const session = await getSession(cookies);
  locals.user = session?.user ?? null;

  const isPublic =
    PUBLIC_EXACT_PATHS.has(normalizedPath) ||
    PUBLIC_DIR_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));

  if (isPublic) {
    // If already logged in and visiting /login, redirect safely
    if (normalizedPath === '/login' && session?.user) {
      const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'));
      return redirect(returnTo);
    }
    return next();
  }

  // Protected route: require active session
  if (!session?.user) {
    const returnTo = encodeURIComponent(sanitizeReturnTo(pathname + url.search));
    return redirect(`/login?returnTo=${returnTo}`);
  }

  // Active revocation check: ensure member is active and not removed/banned
  if ((await ensureMemberActive(session.user.sub)) === false) {
    clearSession(cookies);
    return redirect('/login?error=account_suspended');
  }

  const response = await next();
  // Prevent browser disk/shared proxy caching of authenticated member PII
  response.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  return response;
});
