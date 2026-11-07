import crypto from 'node:crypto';

function getEnv(key: string, fallback = ''): string {
  // Check import.meta.env (Vite/Astro) then process.env (Node/Bun)
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env[key]) {
      return String(import.meta.env[key]);
    }
  } catch {}
  return process.env[key] || fallback;
}

const isProd =
  (typeof import.meta !== 'undefined' &&
    ((import.meta.env?.PROD as unknown) === true ||
      String(import.meta.env?.PROD) === 'true' ||
      import.meta.env?.MODE === 'production')) ||
  process.env.NODE_ENV === 'production';

// Ephemeral random secret for local dev/testing only so no static secret exists in source code
const devFallbackSessionSecret = crypto.randomBytes(32).toString('hex');

export const config = {
  get isProduction(): boolean {
    return isProd;
  },
  get useMockDirectory(): boolean {
    return !isProd && getEnv('USE_MOCK_DIRECTORY', 'true') === 'true';
  },
  get idBase(): string {
    return (getEnv('ID_BASE') || 'https://id.purduehackers.com').replace(/\/+$/, '');
  },
  get clientId(): string {
    return getEnv('CLIENT_ID', 'directory-service');
  },
  get clientSecret(): string {
    const secret = getEnv('CLIENT_SECRET', '');
    if (isProd && !secret) {
      throw new Error('[Config] CRITICAL: CLIENT_SECRET environment variable must be set in production.');
    }
    return secret;
  },
  get publicUrl(): string {
    const raw = (getEnv('PUBLIC_URL', isProd ? '' : 'http://localhost:4321')).replace(/\/+$/, '');
    if (isProd) {
      if (!raw) {
        throw new Error('[Config] CRITICAL: PUBLIC_URL environment variable must be set in production.');
      }
      if (!raw.startsWith('https://')) {
        throw new Error('[Config] CRITICAL: PUBLIC_URL must start with https:// in production.');
      }
    }
    return raw;
  },
  get sessionSecret(): string {
    const secret = getEnv('SESSION_SECRET', '');
    if (isProd) {
      if (!secret || secret.length < 32) {
        throw new Error(
          '[Config] CRITICAL: SESSION_SECRET must be set and at least 32 characters in production.'
        );
      }
      return secret;
    }
    return secret || devFallbackSessionSecret;
  },
  get webhookSecret(): string {
    return getEnv('WEBHOOK_SECRET', '');
  },
  get redirectUri(): string {
    return `${this.publicUrl}/auth/callback`;
  },
  get databaseUrl(): string {
    const url = (
      getEnv('TURSO_DATABASE_URL') ||
      getEnv('DATABASE_URL') ||
      (isProd ? '' : 'file:./data/directory.db')
    ).trim();
    if (isProd) {
      if (!url) {
        throw new Error(
          '[Config] CRITICAL: TURSO_DATABASE_URL (or DATABASE_URL) must be set in production.'
        );
      }
      if (url === ':memory:' || url.startsWith('file:')) {
        throw new Error(
          '[Config] CRITICAL: Local file: or :memory: SQLite URLs are not supported in production serverless environments. Use a remote Turso (libsql:// or https://) URL.'
        );
      }
    }
    return url;
  },
  get databaseAuthToken(): string | undefined {
    const token = getEnv('TURSO_AUTH_TOKEN') || getEnv('DATABASE_AUTH_TOKEN');
    if (isProd && !token && !this.databaseUrl.startsWith('file:')) {
      throw new Error(
        '[Config] CRITICAL: TURSO_AUTH_TOKEN (or DATABASE_AUTH_TOKEN) must be set in production.'
      );
    }
    return token || undefined;
  },
  get discordBotToken(): string {
    return getEnv('DISCORD_BOT_TOKEN', '');
  },
  get discordGuildId(): string {
    return getEnv('DISCORD_GUILD_ID', '');
  },
  get discordCacheTtlMs(): number {
    const val = Number(getEnv('DISCORD_CACHE_TTL_MS'));
    return Number.isFinite(val) && val > 0 ? val : 7 * 24 * 60 * 60 * 1000;
  },
};
