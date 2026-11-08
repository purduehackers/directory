import { describe, expect, test, beforeEach } from 'bun:test';
import { isLocalSqliteUrl } from '../src/lib/server/db';
import { runtimeCache, resetRuntimeCacheForTesting } from '../src/lib/server/runtime-cache';
import {
  resolveDiscordProfiles,
  upsertDiscordProfileRow,
  resetDiscordResolverForTesting,
} from '../src/lib/server/discord-resolver';
import { isNoStoreRoute, onRequest as middlewareOnRequest } from '../src/middleware';
import { POST as logoutPost } from '../src/pages/logout';
import { ensureMemberActive } from '../src/lib/server/id-directory';

describe('Serverless Architecture Verification', () => {
  beforeEach(() => {
    resetRuntimeCacheForTesting();
    resetDiscordResolverForTesting();
  });

  test('isLocalSqliteUrl distinguishes local file/memory URLs from remote Turso URLs', () => {
    expect(isLocalSqliteUrl('file:./data/directory.db')).toBe(true);
    expect(isLocalSqliteUrl(':memory:')).toBe(true);
    expect(isLocalSqliteUrl('libsql://directory-purduehackers.turso.io')).toBe(false);
    expect(isLocalSqliteUrl('https://directory-purduehackers.turso.io')).toBe(false);
  });

  test('runtimeCache supports getOrSet singleflight and expireTag invalidation', async () => {
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, count: fetchCount };
    };

    const [r1, r2] = await Promise.all([
      runtimeCache.getOrSet('test:key:1', fetcher, { ttlMs: 60_000, tags: ['tag-a'] }),
      runtimeCache.getOrSet('test:key:1', fetcher, { ttlMs: 60_000, tags: ['tag-a'] }),
    ]);

    expect(fetchCount).toBe(1);
    expect(r1).toEqual({ ok: true, count: 1 });
    expect(r2).toEqual({ ok: true, count: 1 });

    await runtimeCache.expireTag('tag-a');
    const afterExpire = await runtimeCache.get('test:key:1');
    expect(afterExpire).toBeUndefined();
  });

  test('Discord resolver caches 404 tombstones and resolved rows in runtimeCache without DB table', async () => {
    const now = Date.now();
    await upsertDiscordProfileRow({
      discordId: '111111111111111111',
      username: null,
      globalName: null,
      guildNickname: null,
      avatarUrl: null,
      status: 'not_found',
      fetchedAt: now,
      expiresAt: now + 60_000,
    });

    await upsertDiscordProfileRow({
      discordId: '222222222222222222',
      username: 'purduehacker',
      globalName: 'Purdue Hacker',
      guildNickname: 'Boiler',
      avatarUrl: null,
      status: 'resolved',
      fetchedAt: now,
      expiresAt: now + 60_000,
    });

    const map = await resolveDiscordProfiles(
      ['111111111111111111', '222222222222222222'],
      { seedMocks: false }
    );

    expect(map.has('111111111111111111')).toBe(false);
    expect(map.get('222222222222222222')?.username).toBe('purduehacker');
    expect(map.get('222222222222222222')?.guildNickname).toBe('Boiler');
  });

  test('isNoStoreRoute classifies read vs edit/API routes accurately and handles case-insensitivity', () => {
    expect(isNoStoreRoute('GET', '/', new URLSearchParams())).toBe(false);
    expect(isNoStoreRoute('GET', '/u/testy', new URLSearchParams())).toBe(false);
    expect(isNoStoreRoute('GET', '/SETTINGS', new URLSearchParams())).toBe(true);
    expect(isNoStoreRoute('GET', '/profile/edit', new URLSearchParams())).toBe(true);
    expect(isNoStoreRoute('GET', '/u/testy', new URLSearchParams('edit=1'))).toBe(true);
    expect(isNoStoreRoute('GET', '/api/profile', new URLSearchParams())).toBe(true);
    expect(isNoStoreRoute('GET', '/api', new URLSearchParams())).toBe(true);
    expect(isNoStoreRoute('POST', '/', new URLSearchParams())).toBe(true);
  });

  test('POST /logout sets Clear-Site-Data and no-store headers', async () => {
    const req = new Request('http://localhost:4321/logout', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:4321',
      },
    });

    const deletedCookies: string[] = [];
    const mockCookies = {
      delete: (name: string) => {
        deletedCookies.push(name);
      },
      get: () => undefined,
      set: () => {},
    };

    const res = await logoutPost({
      request: req,
      url: new URL('http://localhost:4321/logout'),
      cookies: mockCookies as any,
      redirect: (path: string) =>
        new Response(null, {
          status: 302,
          headers: new Headers({ Location: path }),
        }),
    } as any);

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
    expect(res.headers.get('Clear-Site-Data')).toBe('"cache", "cookies", "storage"');
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache, no-store, must-revalidate');
    expect(deletedCookies.length).toBeGreaterThan(0);
  });

  test('middleware sets Cache-Control: private, no-cache, no-store on public auth pages', async () => {
    const mockContext = {
      request: new Request('http://localhost:4321/login'),
      url: new URL('http://localhost:4321/login'),
      cookies: { get: () => undefined },
      locals: {},
      redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
    };

    const next = async () => new Response('<html>Login</html>', { status: 200 });
    const res = await middlewareOnRequest(mockContext, next);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache, no-store, must-revalidate');
  });

  test('ensureMemberActive validates active state against snapshot', async () => {
    const { getDirectorySnapshot } = await import('../src/lib/server/id-directory');
    const snapshot = await getDirectorySnapshot();
    const validSub = snapshot.members[0]?.sub;
    if (validSub) {
      const active = await ensureMemberActive(validSub);
      expect(active).toBe(true);
    }

    const inactive = await ensureMemberActive('non-existent-sub-999999');
    expect(inactive).toBe(false);
  });

  test('Vercel and package.json configurations properly target the Bun runtime', async () => {
    const fs = await import('node:fs');
    const vercelJson = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
    expect(vercelJson.bunVersion).toBe('1.x');
    expect(vercelJson.runtime).toBeUndefined();

    const pkgJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(pkgJson.engines?.bun).toBe('>=1.2.0');
    expect(pkgJson.scripts?.build).toContain('--bun');
    expect(pkgJson.scripts?.dev).toContain('--bun');
    expect(pkgJson.scripts?.preview).toContain('--bun');

    const astroConfigText = fs.readFileSync('astro.config.mjs', 'utf8');
    expect(astroConfigText).toContain('@libsql/isomorphic-ws/web.');
    expect(astroConfigText).toContain('@vercel/oidc/node_modules/jose/dist/browser/');
  });
});
