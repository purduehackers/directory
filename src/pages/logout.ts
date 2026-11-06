import type { APIRoute } from 'astro';
import { clearSession } from '../lib/server/session';
import { isSameOrigin } from './api/profile';

export const POST: APIRoute = async ({ request, url, cookies, redirect }) => {
  if (!isSameOrigin(request, url)) {
    return new Response(JSON.stringify({ error: 'CSRF verification failed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  clearSession(cookies);
  return redirect('/login');
};

export const GET: APIRoute = async ({ redirect }) => {
  return redirect('/');
};
