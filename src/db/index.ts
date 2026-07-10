import postgres from "postgres";
import { env } from "../env.js";

/**
 * Postgres connection (migrated from SQLite — see scripts/migrate-sqlite-to-pg.ts
 * for the one-time data import). All queries go through this tagged-template
 * client; JSONB columns round-trip as plain objects.
 */
export const sql = postgres(env.DATABASE_URL, {
	max: 10,
	onnotice: () => {}, // silence NOTICE chatter (e.g. IF NOT EXISTS)
});

/** sql.json with a relaxed input type — for Record<string, unknown> payloads. */
export const jsonb = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);

/**
 * Ordered migrations. Each entry runs once, recorded in schema_migrations.
 * Add new entries at the end; never edit an applied one.
 */
const MIGRATIONS: { version: number; name: string; up: string }[] = [
	{
		version: 1,
		name: "initial-schema",
		up: `
		CREATE TABLE IF NOT EXISTS api_keys (
			id           TEXT PRIMARY KEY,
			project      TEXT NOT NULL,
			prefix       TEXT NOT NULL,
			key_hash     TEXT NOT NULL UNIQUE,
			internal     BOOLEAN NOT NULL DEFAULT FALSE,
			created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
			last_used_at TIMESTAMPTZ,
			revoked_at   TIMESTAMPTZ
		);

		CREATE TABLE IF NOT EXISTS usage_events (
			id          TEXT PRIMARY KEY,
			api_key_id  TEXT,
			project     TEXT,
			endpoint    TEXT NOT NULL,
			provider    TEXT,
			kind        TEXT,             -- http | stt_seconds | tts_characters | llm_tokens_in | llm_tokens_out | call_minutes
			quantity    DOUBLE PRECISION, -- unit depends on kind
			call_id     TEXT,
			bytes       BIGINT,
			status      INTEGER,
			latency_ms  INTEGER,
			created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS idx_usage_key  ON usage_events(api_key_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_usage_proj ON usage_events(project, created_at);
		CREATE INDEX IF NOT EXISTS idx_usage_call ON usage_events(call_id);

		CREATE TABLE IF NOT EXISTS agents (
			id         TEXT PRIMARY KEY,
			project    TEXT NOT NULL,
			name       TEXT NOT NULL,
			status     TEXT NOT NULL DEFAULT 'active',   -- active | deleted
			config     JSONB NOT NULL,
			version    INTEGER NOT NULL DEFAULT 1,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project) WHERE status = 'active';

		CREATE TABLE IF NOT EXISTS agent_versions (
			agent_id   TEXT NOT NULL REFERENCES agents(id),
			version    INTEGER NOT NULL,
			config     JSONB NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			PRIMARY KEY (agent_id, version)
		);

		CREATE TABLE IF NOT EXISTS tools (
			id           TEXT PRIMARY KEY,
			project      TEXT NOT NULL,
			name         TEXT NOT NULL,
			description  TEXT NOT NULL,
			json_schema  JSONB NOT NULL,
			endpoint_url TEXT NOT NULL,
			secret       TEXT NOT NULL,
			timeout_ms   INTEGER NOT NULL DEFAULT 4000,
			enabled      BOOLEAN NOT NULL DEFAULT TRUE,
			created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
			UNIQUE (project, name)
		);

		CREATE TABLE IF NOT EXISTS phone_numbers (
			id               TEXT PRIMARY KEY,
			project          TEXT NOT NULL,
			e164             TEXT NOT NULL UNIQUE,
			provider_ref     TEXT,
			inbound_agent_id TEXT REFERENCES agents(id),
			created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
		);

		CREATE TABLE IF NOT EXISTS calls (
			id               TEXT PRIMARY KEY,
			project          TEXT NOT NULL,
			agent_id         TEXT NOT NULL REFERENCES agents(id),
			agent_version    INTEGER NOT NULL,
			direction        TEXT NOT NULL,                    -- inbound | outbound | web
			status           TEXT NOT NULL DEFAULT 'queued',   -- queued|scheduled|dialing|active|completed|failed|no_answer|canceled
			to_number        TEXT,
			from_number      TEXT,
			room_name        TEXT,
			scheduled_at     TIMESTAMPTZ,
			started_at       TIMESTAMPTZ,
			ended_at         TIMESTAMPTZ,
			duration_seconds INTEGER,
			end_reason       TEXT,
			metadata         JSONB NOT NULL DEFAULT '{}',
			variables        JSONB NOT NULL DEFAULT '{}',
			summary          TEXT,
			extracted        JSONB,
			created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS idx_calls_project ON calls(project, created_at);
		CREATE INDEX IF NOT EXISTS idx_calls_agent   ON calls(agent_id, created_at);

		CREATE TABLE IF NOT EXISTS call_events (
			id         TEXT PRIMARY KEY,
			call_id    TEXT NOT NULL REFERENCES calls(id),
			type       TEXT NOT NULL,
			payload    JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS idx_call_events ON call_events(call_id, created_at);

		CREATE TABLE IF NOT EXISTS transcripts (
			call_id    TEXT PRIMARY KEY REFERENCES calls(id),
			turns      JSONB NOT NULL DEFAULT '[]',
			summary    TEXT,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);

		CREATE TABLE IF NOT EXISTS webhook_endpoints (
			id           TEXT PRIMARY KEY,
			project      TEXT NOT NULL,
			url          TEXT NOT NULL,
			secret       TEXT NOT NULL,
			event_filter TEXT[] NOT NULL DEFAULT '{}',   -- empty = all events
			enabled      BOOLEAN NOT NULL DEFAULT TRUE,
			created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
		);

		CREATE TABLE IF NOT EXISTS webhook_deliveries (
			id              TEXT PRIMARY KEY,
			webhook_id      TEXT NOT NULL REFERENCES webhook_endpoints(id),
			event_id        TEXT NOT NULL,
			event_type      TEXT NOT NULL,
			payload         JSONB NOT NULL,
			status          TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | failed
			attempts        INTEGER NOT NULL DEFAULT 0,
			last_status     INTEGER,
			next_attempt_at TIMESTAMPTZ,
			created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS idx_deliveries_pending
			ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
		`,
	},
	{
		version: 2,
		name: "calls-contact-state",
		// Per-call known-contact data (Phase 1). Nullable: old rows / calls
		// created without contactState stay NULL and dispatch omits the field.
		up: `ALTER TABLE calls ADD COLUMN IF NOT EXISTS contact_state JSONB;`,
	},
	{
		version: 3,
		name: "usage-events-breakdown",
		// Per-class LLM usage breakdown (Phase 4). Nullable JSONB carried on the
		// llm_tokens_in/out rows: { respond|judge|summary|router -> tokens+calls }.
		// A single flexible column instead of a fixed set of per-class columns, so
		// new call classes don't require a schema change.
		up: `ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS breakdown JSONB;`,
	},
	{
		version: 4,
		name: "calls-contact-tags",
		// Per-call CRM tag names (Phase 5b — tag-driven exit routing seed).
		// Nullable: old rows / calls dispatched without tags stay NULL and dispatch
		// omits the field.
		up: `ALTER TABLE calls ADD COLUMN IF NOT EXISTS contact_tags JSONB;`,
	},
	{
		version: 5,
		name: "calls-channel",
		// Session channel (Phase 6 — channel abstraction): 'voice' (audio, today's
		// default) or 'text' (lk.chat text streams). NOT NULL DEFAULT 'voice' so
		// every existing row backfills to voice and old dispatches are unaffected.
		up: `ALTER TABLE calls ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'voice';`,
	},
	{
		version: 6,
		name: "agents-draft",
		// Gateway-internal draft overlay for the builder UI (never dispatched).
		// A partial config the SaaS PUTs while editing; publish merges it over the
		// live config as a new version and clears these columns. Nullable: agents
		// without an in-progress draft stay NULL and dispatch reads `config` only.
		up: `ALTER TABLE agents ADD COLUMN IF NOT EXISTS draft JSONB, ADD COLUMN IF NOT EXISTS draft_updated_at TIMESTAMPTZ;`,
	},
];

/** Apply pending migrations on boot. */
export async function migrate(): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			name       TEXT NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`;

	const applied = new Set(
		(await sql`SELECT version FROM schema_migrations`).map((r) => Number(r.version)),
	);

	for (const m of MIGRATIONS) {
		if (applied.has(m.version)) continue;
		await sql.begin(async (tx) => {
			await tx.unsafe(m.up);
			await tx`INSERT INTO schema_migrations (version, name) VALUES (${m.version}, ${m.name})`;
		});
		console.log(`db: applied migration ${m.version} (${m.name})`);
	}
}
