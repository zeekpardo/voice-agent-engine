import { Hono } from "hono";
import type { AppEnv } from "../app-types.js";
import { jsonb, sql } from "../db/index.js";
import { AgentConfig, AgentConfigPatch, type AgentConfigT } from "../lib/agent-config.js";
import { AppError, badRequest } from "../lib/errors.js";
import { parseBody, parseOrThrow } from "../lib/http.js";
import { newId } from "../lib/id.js";
import { createWebSession } from "../lib/sessions.js";

/**
 * /v1/agents — agents are database rows, not deploys (spec §5).
 * Every update snapshots the previous config into agent_versions for
 * audit + rollback; live calls pin the version they started with.
 */
export const agents = new Hono<AppEnv>();

const notFound = () => new AppError(404, "not_found", "Agent not found");

export interface AgentRow {
	id: string;
	project: string;
	name: string;
	status: string;
	config: AgentConfigT;
	version: number;
	created_at: string;
	updated_at: string;
}

export async function getAgent(project: string, id: string): Promise<AgentRow | null> {
	const rows = await sql`
		SELECT * FROM agents
		WHERE id = ${id} AND project = ${project} AND status != 'deleted'`;
	return (rows[0] as unknown as AgentRow) ?? null;
}

/** Ensure every toolId in the config exists, is enabled, and belongs to the project. */
async function assertToolsOwned(project: string, toolIds: string[]): Promise<void> {
	if (toolIds.length === 0) return;
	const rows = await sql`
		SELECT id FROM tools WHERE project = ${project} AND id = ANY(${toolIds})`;
	const found = new Set(rows.map((r) => r.id as string));
	const missing = toolIds.filter((t) => !found.has(t));
	if (missing.length > 0) {
		throw badRequest(`Unknown tool id(s) for this project: ${missing.join(", ")}`);
	}
}

/**
 * The single update path shared by PATCH, publish, and restore: merge a partial
 * config over the agent's current config, re-validate the merged whole, snapshot
 * the new config into agent_versions and bump the agent's version. Optionally
 * clears the stored draft atomically (publish). Returns the fresh agent row.
 */
async function bumpAgentVersion(
	project: string,
	agent: AgentRow,
	patch: Record<string, unknown>,
	opts: { clearDraft?: boolean } = {},
): Promise<AgentRow | null> {
	// Merge the patch over the stored config, then re-validate the whole thing.
	const config = parseOrThrow(
		AgentConfig,
		{ ...agent.config, ...patch },
		(issue) => `Merged config invalid: ${issue?.path.join(".")} — ${issue?.message}`,
	);
	await assertToolsOwned(project, config.toolIds);

	const nextVersion = agent.version + 1;
	await sql.begin(async (tx) => {
		if (opts.clearDraft) {
			await tx`
				UPDATE agents
				SET config = ${jsonb(config)}, name = ${config.name},
				    version = ${nextVersion}, updated_at = now(),
				    draft = NULL, draft_updated_at = NULL
				WHERE id = ${agent.id}`;
		} else {
			await tx`
				UPDATE agents
				SET config = ${jsonb(config)}, name = ${config.name},
				    version = ${nextVersion}, updated_at = now()
				WHERE id = ${agent.id}`;
		}
		await tx`
			INSERT INTO agent_versions (agent_id, version, config)
			VALUES (${agent.id}, ${nextVersion}, ${jsonb(config)})`;
	});

	return getAgent(project, agent.id);
}

agents.post("/agents", async (c) => {
	const key = c.get("apiKey");
	const config = await parseBody(
		c,
		AgentConfig,
		(issue) => `Invalid agent config: ${issue?.path.join(".")} — ${issue?.message}`,
	);
	await assertToolsOwned(key.project, config.toolIds);

	const id = newId("agt");
	await sql.begin(async (tx) => {
		await tx`
			INSERT INTO agents (id, project, name, config, version)
			VALUES (${id}, ${key.project}, ${config.name}, ${jsonb(config)}, 1)`;
		await tx`
			INSERT INTO agent_versions (agent_id, version, config)
			VALUES (${id}, 1, ${jsonb(config)})`;
	});

	const agent = await getAgent(key.project, id);
	return c.json(agent, 201);
});

agents.get("/agents", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT id, name, status, version, config, created_at, updated_at
		FROM agents
		WHERE project = ${key.project} AND status != 'deleted'
		ORDER BY created_at DESC`;
	return c.json({ agents: rows });
});

agents.get("/agents/:id", async (c) => {
	const agent = await getAgent(c.get("apiKey").project, c.req.param("id"));
	if (!agent) throw notFound();
	return c.json(agent);
});

agents.patch("/agents/:id", async (c) => {
	const key = c.get("apiKey");
	const agent = await getAgent(key.project, c.req.param("id"));
	if (!agent) throw notFound();

	const patch = await parseBody(
		c,
		AgentConfigPatch,
		(issue) => `Invalid agent config patch: ${issue?.path.join(".")} — ${issue?.message}`,
	);

	return c.json(await bumpAgentVersion(key.project, agent, patch));
});

agents.delete("/agents/:id", async (c) => {
	const key = c.get("apiKey");
	const agent = await getAgent(key.project, c.req.param("id"));
	if (!agent) throw notFound();
	await sql`UPDATE agents SET status = 'deleted', updated_at = now() WHERE id = ${agent.id}`;
	return c.json({ deleted: true, id: agent.id });
});

// ── Drafts ──────────────────────────────────────────────────────────────────
// A draft is a gateway-internal PARTIAL config overlay the builder UI edits
// before publishing. It is stored as-is and is NEVER dispatched — dispatch
// reads agents.config only. Publishing merges the draft over the live config
// as a new version (the same path as PATCH) and clears the draft.

// Save/replace the working draft. Body is a partial config; stored as-is.
agents.put("/agents/:id/draft", async (c) => {
	const key = c.get("apiKey");
	const agent = await getAgent(key.project, c.req.param("id"));
	if (!agent) throw notFound();

	const draft = await parseBody(
		c,
		AgentConfigPatch,
		(issue) => `Invalid draft config: ${issue?.path.join(".")} — ${issue?.message}`,
	);

	const rows = await sql`
		UPDATE agents
		SET draft = ${jsonb(draft)}, draft_updated_at = now()
		WHERE id = ${agent.id}
		RETURNING draft_updated_at`;
	return c.json({ updated_at: rows[0]?.draft_updated_at });
});

agents.get("/agents/:id/draft", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT draft, draft_updated_at FROM agents
		WHERE id = ${c.req.param("id")} AND project = ${key.project} AND status != 'deleted'`;
	const row = rows[0];
	if (!row || row.draft == null) throw notFound();
	return c.json({ config: row.draft, updated_at: row.draft_updated_at });
});

// Idempotent: 200 even when there was no draft to discard.
agents.delete("/agents/:id/draft", async (c) => {
	const key = c.get("apiKey");
	const agent = await getAgent(key.project, c.req.param("id"));
	if (!agent) throw notFound();
	await sql`
		UPDATE agents SET draft = NULL, draft_updated_at = NULL WHERE id = ${agent.id}`;
	return c.json({ discarded: true });
});

// Publish the stored draft: merge it over the live config as a new version
// (same path as PATCH) and clear the draft. 409 when there is no draft.
agents.post("/agents/:id/publish", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT draft FROM agents
		WHERE id = ${c.req.param("id")} AND project = ${key.project} AND status != 'deleted'`;
	const agent = await getAgent(key.project, c.req.param("id"));
	if (!agent) throw notFound();
	const draft = rows[0]?.draft as Record<string, unknown> | null | undefined;
	if (draft == null) {
		throw new AppError(409, "no_draft", "No draft to publish");
	}
	return c.json(await bumpAgentVersion(key.project, agent, draft, { clearDraft: true }));
});

// ── Versions ────────────────────────────────────────────────────────────────

// Newest-first list, includes the current version.
agents.get("/agents/:id/versions", async (c) => {
	const key = c.get("apiKey");
	const agent = await getAgent(key.project, c.req.param("id"));
	if (!agent) throw notFound();
	const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
	const rows = await sql`
		SELECT version, created_at FROM agent_versions
		WHERE agent_id = ${agent.id}
		ORDER BY version DESC
		LIMIT ${limit}`;
	return c.json({ versions: rows });
});

agents.get("/agents/:id/versions/:v", async (c) => {
	const key = c.get("apiKey");
	const agent = await getAgent(key.project, c.req.param("id"));
	if (!agent) throw notFound();
	const rows = await sql`
		SELECT version, config, created_at FROM agent_versions
		WHERE agent_id = ${agent.id} AND version = ${Number(c.req.param("v"))}`;
	if (!rows[0]) throw notFound();
	return c.json(rows[0]);
});

// Restore a prior snapshot: apply its config through the same update path,
// producing a fresh version + snapshot.
agents.post("/agents/:id/versions/:v/restore", async (c) => {
	const key = c.get("apiKey");
	const agent = await getAgent(key.project, c.req.param("id"));
	if (!agent) throw notFound();
	const rows = await sql`
		SELECT config FROM agent_versions
		WHERE agent_id = ${agent.id} AND version = ${Number(c.req.param("v"))}`;
	if (!rows[0]) throw notFound();
	return c.json(
		await bumpAgentVersion(key.project, agent, rows[0].config as Record<string, unknown>),
	);
});

// Spin up a browser test session for this agent (returns room url + token).
agents.post("/agents/:id/test", async (c) => {
	const key = c.get("apiKey");
	const agent = await getAgent(key.project, c.req.param("id"));
	if (!agent) throw notFound();
	const session = await createWebSession({
		project: key.project,
		agent,
		metadata: { test: true },
	});
	return c.json(session, 201);
});
