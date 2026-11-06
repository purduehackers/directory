import fs from 'node:fs';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { config } from '../config';
import * as schema from './schema';

let clientInstance: Client | null = null;
let dbInstance: LibSQLDatabase<typeof schema> | null = null;
let initPromise: Promise<void> | null = null;

function ensureLocalSqliteDir(dbUrl: string): void {
  if (!dbUrl.startsWith('file:')) return;
  const rawPath = dbUrl.slice('file:'.length).split('?')[0];
  if (!rawPath || rawPath === ':memory:') return;
  const resolvedDir = path.dirname(path.resolve(rawPath));
  try {
    fs.mkdirSync(resolvedDir, { recursive: true });
  } catch (err) {
    console.error('[DB] Failed to create database directory:', err);
  }
}

export function getDb(): LibSQLDatabase<typeof schema> {
  if (!dbInstance) {
    const url = config.databaseUrl;
    ensureLocalSqliteDir(url);
    clientInstance = createClient({
      url,
      authToken: config.databaseAuthToken,
    });
    dbInstance = drizzle(clientInstance, { schema });
  }
  return dbInstance;
}

export async function ensureDbInitialized(): Promise<LibSQLDatabase<typeof schema>> {
  const db = getDb();
  if (!initPromise) {
    initPromise = (async () => {
      try {
        await clientInstance!.executeMultiple(`
          PRAGMA journal_mode = WAL;
          PRAGMA busy_timeout = 5000;
          CREATE TABLE IF NOT EXISTS member_profiles (
            sub TEXT PRIMARY KEY NOT NULL,
            headline TEXT,
            bio TEXT,
            location TEXT,
            timezone TEXT,
            website_url TEXT,
            socials_json TEXT NOT NULL DEFAULT '{}',
            custom_links_json TEXT NOT NULL DEFAULT '[]',
            contact_visibility_json TEXT NOT NULL DEFAULT '{}',
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS discord_profiles (
            discord_id TEXT PRIMARY KEY NOT NULL,
            username TEXT,
            global_name TEXT,
            guild_nickname TEXT,
            avatar_url TEXT,
            status TEXT NOT NULL DEFAULT 'resolved',
            fetched_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_discord_profiles_expires_at ON discord_profiles(expires_at);
        `);
        try {
          await clientInstance!.execute(
            "ALTER TABLE member_profiles ADD COLUMN contact_visibility_json TEXT NOT NULL DEFAULT '{}';"
          );
        } catch {
          // Column already exists
        }
        try {
          await clientInstance!.execute(
            'ALTER TABLE discord_profiles ADD COLUMN guild_nickname TEXT;'
          );
        } catch {
          // Column already exists
        }
      } catch (err) {
        initPromise = null;
        throw err;
      }
    })();
  }
  await initPromise;
  return db;
}

export async function resetDbForTesting(clientOverride?: Client): Promise<void> {
  initPromise = null;
  if (clientOverride) {
    clientInstance = clientOverride;
    dbInstance = drizzle(clientInstance, { schema });
  } else if (clientInstance) {
    try {
      clientInstance.close();
    } catch {}
    clientInstance = null;
    dbInstance = null;
  }
}
