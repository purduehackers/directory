import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient as createWebClient, type Client } from '@libsql/client/web';
import { drizzle } from 'drizzle-orm/libsql/web';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { readMigrationFiles } from 'drizzle-orm/migrator';
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

export async function getDb(): Promise<LibSQLDatabase<typeof schema>> {
  if (!dbInstance) {
    const url = config.databaseUrl;
    isLocalClient = isLocalSqliteUrl(url);
    if (isLocalClient) {
      ensureLocalSqliteDir(url);
      const { createClient: createLocalClient } = await import('@libsql/client/sqlite3');
      clientInstance = createLocalClient({
        url,
        authToken: config.databaseAuthToken,
      });
    } else {
      clientInstance = createWebClient({
        url,
        authToken: config.databaseAuthToken,
      });
    }
    dbInstance = drizzle(clientInstance, { schema });
  }
  return dbInstance;
}

// Ledger layout is identical to what drizzle-kit itself creates, so local
// runtime migrations and build-time `drizzle-kit migrate` agree on what has
// been applied.
const MIGRATIONS_LEDGER_TABLE = '__drizzle_migrations';

async function applyLocalMigrations(client: Client, migrationsFolder: string): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_LEDGER_TABLE} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    );
  `);
  const applied = await client.execute(
    `SELECT created_at FROM ${MIGRATIONS_LEDGER_TABLE} ORDER BY created_at DESC LIMIT 1`
  );
  const lastAppliedAt = applied.rows[0]?.created_at;

  const migrations = readMigrationFiles({ migrationsFolder });
  for (const migration of migrations) {
    if (lastAppliedAt !== undefined && Number(lastAppliedAt) >= migration.folderMillis) continue;
    await client.batch(
      [
        ...migration.sql.map((stmt) => ({ sql: stmt })),
        {
          sql: `INSERT INTO ${MIGRATIONS_LEDGER_TABLE} (hash, created_at) VALUES (?, ?);`,
          args: [migration.hash, migration.folderMillis],
        },
      ],
      'write'
    );
    console.log(`[DB] Applied local migration (${migration.folderMillis})`);
  }
}

export async function ensureDbInitialized(): Promise<LibSQLDatabase<typeof schema>> {
  const db = await getDb();
  if (!initPromise) {
    initPromise = (async () => {
      try {
        if (isLocalClient) {
          await clientInstance!.executeMultiple(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            DROP TABLE IF EXISTS discord_profiles;
          `);
          // Local dev/test databases are migrated at runtime from the versioned
          // drizzle migrations in ./drizzle. Production (remote Turso) is
          // migrated at build time via `drizzle-kit migrate` (see build script).
          const migrationsFolder = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../../../drizzle'
          );
          await applyLocalMigrations(clientInstance!, migrationsFolder);
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
