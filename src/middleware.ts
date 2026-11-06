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

const NO_STORE_PATH_PREFIXES = ['/api', '/settings', '/profile', '/edit', '/account'];

export function isNoStoreRoute(method: string, normalizedPath: string, searchParams: URLSearchParams): boolean {
  if (method !== 'GET' && method !== 'HEAD') {
    return true;
  }
  const lower = normalizedPath.toLowerCase();
  if (
    NO_STORE_PATH_PREFIXES.some(
      (prefix) => lower === prefix || lower.startsWith(prefix + '/') || lower.startsWith(prefix)
    )
  ) {
    return true;
  }
  if (searchParams.has('edit')) {
    return true;
  }
  return false;
}

export const onRequest = async (context: any, next: any) => {
  const { request, url, cookies, locals, redirect } = context;
  const pathname = url.pathname;
  const normalizedPath = pathname.length > 1 ? pathname.toLowerCase().replace(/\/+$/, '') : pathname.toLowerCase();

  const session = await getSession(cookies);
  locals.user = session?.user ?? null;

  const isPublic =
    PUBLIC_EXACT_PATHS.has(normalizedPath) ||
    PUBLIC_DIR_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));

  if (isPublic) {
    // If already logged in and visiting /login, redirect safely
    if (normalizedPath === '/login' && session?.user) {
      const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'));
      const redir = redirect(returnTo);
      redir.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
      return redir;
    }
    const pubResponse = await next();
    if (
      !pubResponse.headers.has('Cache-Control') &&
      !PUBLIC_DIR_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))
    ) {
      pubResponse.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    }
    return pubResponse;
  }

  // Protected route: require active session
  if (!session?.user) {
    const returnTo = encodeURIComponent(sanitizeReturnTo(pathname + url.search));
    return redirect(`/login?returnTo=${returnTo}`);
  }

  // Active revocation check: ensure member is active and not removed/banned
  if ((await ensureMemberActive(session.user.sub)) === false) {
    clearSession(cookies);
    const suspendedRes = redirect('/login?error=account_suspended');
    suspendedRes.headers.set('Clear-Site-Data', '"cache", "cookies", "storage"');
    suspendedRes.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    return suspendedRes;
  }

  const response = await next();

  // Do not overwrite explicit Cache-Control headers set by downstream route handlers
  if (!response.headers.has('Cache-Control')) {
    if (isNoStoreRoute(request.method, normalizedPath, url.searchParams)) {
      response.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    } else {
      response.headers.set('Cache-Control', 'private, max-age=60, must-revalidate');
      response.headers.append('Vary', 'Cookie');
    }
  }

  return response;
};
