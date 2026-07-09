import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { migrate, sql } from "../src/db/index.js";
import { env } from "../src/env.js";

/**
 * One-time data import: legacy SQLite (env.DB_PATH) → Postgres (env.DATABASE_URL).
 * Idempotent — rows already present (by primary key) are skipped.
 *
 * Usage: pnpm tsx scripts/migrate-sqlite-to-pg.ts
 */
if (!existsSync(env.DB_PATH)) {
	console.error(`No SQLite database at ${env.DB_PATH} — nothing to migrate.`);
	process.exit(1);
}

await migrate();
const sqlite = new Database(env.DB_PATH, { readonly: true });

interface LegacyKey {
	id: string;
	project: string;
	prefix: string;
	key_hash: string;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

interface LegacyUsage {
	id: string;
	api_key_id: string | null;
	project: string | null;
	endpoint: string;
	provider: string | null;
	bytes: number | null;
	status: number | null;
	latency_ms: number | null;
	created_at: string;
}

const keys = sqlite.prepare("SELECT * FROM api_keys").all() as LegacyKey[];
let keysImported = 0;
for (const k of keys) {
	const res = await sql`
		INSERT INTO api_keys (id, project, prefix, key_hash, internal, created_at, last_used_at, revoked_at)
		VALUES (${k.id}, ${k.project}, ${k.prefix}, ${k.key_hash}, FALSE,
		        ${k.created_at}, ${k.last_used_at}, ${k.revoked_at})
		ON CONFLICT (id) DO NOTHING`;
	keysImported += res.count;
}

const usage = sqlite.prepare("SELECT * FROM usage_events").all() as LegacyUsage[];
let usageImported = 0;
for (const u of usage) {
	const res = await sql`
		INSERT INTO usage_events (id, api_key_id, project, endpoint, provider, kind, bytes, status, latency_ms, created_at)
		VALUES (${u.id}, ${u.api_key_id}, ${u.project}, ${u.endpoint}, ${u.provider}, 'http',
		        ${u.bytes}, ${u.status}, ${u.latency_ms}, ${u.created_at})
		ON CONFLICT (id) DO NOTHING`;
	usageImported += res.count;
}

console.log(`✅ Migrated ${keysImported}/${keys.length} api_keys, ${usageImported}/${usage.length} usage_events`);
console.log("   (rows already in Postgres were skipped)");
sqlite.close();
await sql.end();
