import fs from 'node:fs';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { config } from '../config';
import * as schema from './schema';

let clientInstance: Client | null = null;
let dbInstance: LibSQLDatabase<typeof schema> | null = null;
let initPromise: Promise<void> | null = null;
let isLocalClient = false;

export function isLocalSqliteUrl(dbUrl: string): boolean {
  const trimmed = dbUrl.trim();
  return trimmed === ':memory:' || trimmed.startsWith('file:');
}

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
    isLocalClient = isLocalSqliteUrl(url);
    if (isLocalClient) {
      ensureLocalSqliteDir(url);
    }
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
        if (isLocalClient) {
          await clientInstance!.executeMultiple(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            DROP TABLE IF EXISTS discord_profiles;
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
          `);

          try {
            await clientInstance!.execute(
              "ALTER TABLE member_profiles ADD COLUMN contact_visibility_json TEXT NOT NULL DEFAULT '{}';"
            );
          } catch {
            // Column already exists on legacy local dev DB
          }
        } else {
          // Remote Turso: single idempotent DDL check, no failing ALTER TABLE round-trip
          await clientInstance!.execute(`
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
          `);
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
    isLocalClient = true;
    dbInstance = drizzle(clientInstance, { schema });
  } else if (clientInstance) {
    try {
      clientInstance.close();
    } catch {}
    clientInstance = null;
    dbInstance = null;
    isLocalClient = false;
  }
}
