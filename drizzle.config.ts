import { defineConfig } from 'drizzle-kit';

// Production/preview run `drizzle-kit migrate` against Turso at build time
// (see the build script). Local dev and tests fall back to the local SQLite file.
const url =
	process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || 'file:./data/directory.db';
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN;

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'turso',
	dbCredentials: {
		url,
		...(authToken ? { authToken } : {})
	},
	verbose: true,
	strict: true
});
