import type { APIRoute } from 'astro';
import { config } from '../../lib/server/config';
import {
  ensureMemberActive,
  refreshDirectorySnapshotProfiles,
} from '../../lib/server/id-directory';
import { getMemberProfileBySub, upsertMemberProfile } from '../../lib/server/profile-store';
import { validateProfileInput } from '../../lib/server/profile-validation';

const MAX_BODY_BYTES = 16 * 1024; // 16 KB
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_WRITES = 20;

const writeTimestampsBySub = new Map<string, number[]>();

export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > maxBytes) {
    throw new Error('PAYLOAD_TOO_LARGE');
  }

  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error('PAYLOAD_TOO_LARGE');
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(combined);
}

export function checkRateLimit(sub: string): boolean {
  const key = sub.toLowerCase();
  const now = Date.now();
  const recent = (writeTimestampsBySub.get(key) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT_MAX_WRITES) {
    writeTimestampsBySub.set(key, recent);
    return false;
  }
  recent.push(now);
  writeTimestampsBySub.set(key, recent);

  // Periodically prune stale entries to prevent unbounded memory growth
  if (writeTimestampsBySub.size > 500) {
    for (const [k, timestamps] of writeTimestampsBySub.entries()) {
      if (timestamps.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) {
        writeTimestampsBySub.delete(k);
      }
    }
  }
  return true;
}

export function isSameOrigin(request: Request, requestUrl: URL): boolean {
  const origin = request.headers.get('origin');
  if (!origin) {
    const fetchSite = request.headers.get('sec-fetch-site');
    if (fetchSite === 'same-origin') return true;
    if (!config.isProduction) return true;
    return false;
  }
  try {
    const allowed = new Set<string>();
    allowed.add(new URL(config.publicUrl).origin);
    // In dev only, allow requestUrl.origin
    if (!config.isProduction) {
      allowed.add(requestUrl.origin);
    }
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user?.sub) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const profile = await getMemberProfileBySub(locals.user.sub);
  return Response.json({ profile });
};

export const POST: APIRoute = async ({ request, locals, url }) => {
  const user = locals.user;
  if (!user?.sub) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isSameOrigin(request, url)) {
    return Response.json({ error: 'Invalid request origin (CSRF check failed)' }, { status: 403 });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return Response.json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }

  if (!checkRateLimit(user.sub)) {
    return Response.json(
      { error: 'Too many profile updates. Please wait a moment and try again.' },
      { status: 429 }
    );
  }

  const activeStatus = await ensureMemberActive(user.sub);
  if (activeStatus === false) {
    return Response.json({ error: 'Account suspended' }, { status: 403 });
  }
  if (activeStatus === null) {
    return Response.json(
      { error: 'Unable to verify account status. Please try again shortly.' },
      { status: 503 }
    );
  }

  let rawBody: string;
  try {
    rawBody = await readBodyWithLimit(request, MAX_BODY_BYTES);
  } catch (err: any) {
    if (err?.message === 'PAYLOAD_TOO_LARGE') {
      return Response.json({ error: 'Payload too large (max 16KB)' }, { status: 413 });
    }
    return Response.json({ error: 'Failed to read request body' }, { status: 400 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return Response.json({ error: 'Invalid profile object' }, { status: 400 });
  }

  const validation = validateProfileInput(parsedBody as Record<string, unknown>);
  if (!validation.ok) {
    return Response.json(
      { error: 'Validation failed', fieldErrors: validation.errors },
      { status: 422 }
    );
  }

  try {
    const saved = await upsertMemberProfile(user.sub, validation.data);
    await refreshDirectorySnapshotProfiles(user.sub);
    const res = Response.json({ ok: true, profile: saved });
    res.headers.set('Clear-Site-Data', '"cache"');
    return res;
  } catch (err) {
    console.error('[Profile API] Failed to save profile:', err);
    return Response.json(
      { error: 'Database error while saving profile. Please try again.' },
      { status: 500 }
    );
  }
};
