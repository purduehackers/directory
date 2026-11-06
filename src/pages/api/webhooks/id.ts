import crypto from 'node:crypto';
import type { APIRoute } from 'astro';
import { config } from '../../../lib/server/config';
import { invalidateDirectoryCache } from '../../../lib/server/id-directory';
import { readBodyWithLimit } from '../profile';

const MAX_WEBHOOK_BYTES = 64 * 1024; // 64 KB

function safeCompareSecret(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export const POST: APIRoute = async ({ request }) => {
  const expectedSecret = config.webhookSecret;

  // Fail closed if WEBHOOK_SECRET is not configured
  if (!expectedSecret) {
    console.error('[Webhook] Rejected webhook: WEBHOOK_SECRET is not configured');
    return new Response(JSON.stringify({ error: 'webhook_not_configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const authHeader = request.headers.get('authorization') || '';
  const secretHeader = request.headers.get('x-webhook-secret') || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '');

  const isAuthorized =
    safeCompareSecret(bearerToken, expectedSecret) ||
    safeCompareSecret(secretHeader, expectedSecret);

  if (!isAuthorized) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const raw = await readBodyWithLimit(request, MAX_WEBHOOK_BYTES);
    const payload = raw ? JSON.parse(raw) : {};
    console.log('[Webhook] Received ID webhook event:', payload.event || 'unspecified');
    invalidateDirectoryCache();

    return new Response(JSON.stringify({ ok: true, invalidated: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[Webhook] Failed to process webhook:', err);
    return new Response(JSON.stringify({ error: 'bad_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
