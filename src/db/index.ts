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
	{
		version: 7,
		name: "calls-recording",
		// Call recording (LiveKit Egress, Tier-2 #10). recording_url is the
		// deterministic S3 object reference (s3://bucket/{room_name}.ogg) captured
		// when egress starts; recording_egress_id is LiveKit's egress id, retained
		// so a future webhook receiver can correlate completion/failure updates.
		// Both nullable: recording is per-agent opt-in, so most rows stay NULL.
		up: `ALTER TABLE calls
			ADD COLUMN IF NOT EXISTS recording_url TEXT,
			ADD COLUMN IF NOT EXISTS recording_egress_id TEXT;`,
	},
	{
		version: 8,
		name: "usage-attribution-group-ref",
		// Per-group usage attribution (client-1 gate). `group_ref` is an OPAQUE
		// tenant tag the consuming SaaS gives meaning to — the engine stays
		// CRM-neutral and never interprets it. Nullable: unattributed calls /
		// numbers stay NULL and are excluded from attribution rollups.
		//
		// Indexes are designed for BOTH the attribution query (built now) and the
		// future per-group concurrency limiter (multi-account plan §2):
		//   - idx_calls_group (project, group_ref, created_at): the usage endpoint
		//     scans project-equality + optional group_ref-equality + created_at
		//     range, grouping by group_ref. Leading with `project` matches the
		//     always-project-scoped WHERE; created_at trailing serves the range.
		//   - idx_calls_group_active (project, group_ref) WHERE status='active': a
		//     small partial index for the future limiter's hot path — count live
		//     calls per group without scanning historical rows.
		up: `
		ALTER TABLE calls ADD COLUMN IF NOT EXISTS group_ref TEXT;
		ALTER TABLE phone_numbers ADD COLUMN IF NOT EXISTS group_ref TEXT;
		CREATE INDEX IF NOT EXISTS idx_calls_group
			ON calls(project, group_ref, created_at);
		CREATE INDEX IF NOT EXISTS idx_calls_group_active
			ON calls(project, group_ref) WHERE status = 'active';
		`,
	},
	{
		version: 9,
		name: "conversations",
		// Room-less, turn-based text conversations (Wave 1b). A conversation is the
		// async, one-turn-at-a-time analogue of a call: state lives here in Postgres
		// (no LiveKit room, no worker), and each inbound message runs ONE gateway-side
		// agent turn. `node_id` is the current flow position (NULL for single-agent
		// configs); `state` JSONB holds objective progress, rolling summary, variables,
		// contactState, contactTags, turn count, and a usage aggregate. `external_ref`
		// is an OPAQUE consumer key (e.g. a CRM conversation id) — UNIQUE per project
		// when set, so the consuming SaaS can resolve its own conversation by it.
		up: `
		CREATE TABLE IF NOT EXISTS conversations (
			id            TEXT PRIMARY KEY,
			project       TEXT NOT NULL,
			agent_id      TEXT NOT NULL REFERENCES agents(id),
			agent_version INTEGER NOT NULL,
			group_ref     TEXT,
			status        TEXT NOT NULL DEFAULT 'active',   -- active | ended
			node_id       TEXT,
			state         JSONB NOT NULL DEFAULT '{}',
			external_ref  TEXT,
			metadata      JSONB NOT NULL DEFAULT '{}',
			created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project, created_at);
		CREATE INDEX IF NOT EXISTS idx_conversations_agent   ON conversations(agent_id, created_at);
		-- external_ref is unique WITHIN a project, but only when set.
		CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_external_ref
			ON conversations(project, external_ref) WHERE external_ref IS NOT NULL;

		CREATE TABLE IF NOT EXISTS conversation_messages (
			id              TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			role            TEXT NOT NULL,   -- user | agent | system
			text            TEXT NOT NULL,
			created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS idx_conversation_messages
			ON conversation_messages(conversation_id, created_at);

		-- Parallel to call_events: call_events.call_id has a FK to calls(id), so a
		-- conversation id can't reuse it. A sibling table is the smaller change than
		-- dropping that FK. Same shape (id, ref, type, payload, created_at).
		CREATE TABLE IF NOT EXISTS conversation_events (
			id              TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			type            TEXT NOT NULL,
			payload         JSONB NOT NULL DEFAULT '{}',
			created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS idx_conversation_events
			ON conversation_events(conversation_id, created_at);
		`,
	},
	{
		version: 10,
		name: "concurrency-limits",
		// Per-tenant concurrent-call caps (multi-account plan §2). One row per
		// (project, scope, ref): scope is 'project' | 'agent' | 'group', ref is ''
		// for project scope and the agent id / opaque group_ref otherwise. Absence
		// of a row = unlimited for that scope (project falls back to the
		// DEFAULT_MAX_CONCURRENT_CALLS env). `queued_reason` on calls distinguishes
		// a capacity-parked outbound ('capacity') from an ordinary about-to-dial
		// 'queued' row, so the drainer only ever touches its own parked calls.
		//
		// Indexes:
		//   - idx_calls_active_scope (project, agent_id, group_ref) WHERE status IN
		//     ('dialing','active'): the limiter's live-count query scans project-
		//     equality + FILTERs on agent_id/group_ref over only in-flight rows.
		//   - idx_calls_queued_capacity (created_at) WHERE queued+capacity: the
		//     drainer picks oldest-first and expires stale rows off this partial set.
		up: `
		CREATE TABLE IF NOT EXISTS concurrency_limits (
			project        TEXT NOT NULL,
			scope          TEXT NOT NULL,              -- project | agent | group
			ref            TEXT NOT NULL DEFAULT '',   -- '' for project; agent id / group_ref otherwise
			max_concurrent INTEGER NOT NULL,
			updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
			UNIQUE (project, scope, ref)
		);
		ALTER TABLE calls ADD COLUMN IF NOT EXISTS queued_reason TEXT;
		CREATE INDEX IF NOT EXISTS idx_calls_active_scope
			ON calls(project, agent_id, group_ref) WHERE status IN ('dialing', 'active');
		CREATE INDEX IF NOT EXISTS idx_calls_queued_capacity
			ON calls(created_at) WHERE status = 'queued' AND queued_reason = 'capacity';
		`,
	},
	{
		version: 11,
		name: "daily-call-limits",
		// Per-org rolling-24h call-count ceiling (spend backstop). Sibling of
		// concurrency_limits, same admin/route shape, kept in its own table so an
		// admin can set a daily cap WITHOUT also having to set a concurrency cap
		// (concurrency_limits.max_concurrent is NOT NULL). One row per
		// (project, scope, ref): scope is 'project' | 'group', ref is '' for
		// project scope and the opaque group_ref otherwise. Absence of a row =>
		// the DEFAULT_MAX_CALLS_PER_DAY env default (never unlimited-by-accident).
		//
		// The rolling-24h count reuses the existing idx_calls_group
		// (project, group_ref, created_at) — no new index is needed.
		up: `
		CREATE TABLE IF NOT EXISTS daily_call_limits (
			project      TEXT NOT NULL,
			scope        TEXT NOT NULL,              -- project | group
			ref          TEXT NOT NULL DEFAULT '',   -- '' for project; opaque group_ref otherwise
			max_per_day  INTEGER NOT NULL,
			updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
			UNIQUE (project, scope, ref)
		);
		`,
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
