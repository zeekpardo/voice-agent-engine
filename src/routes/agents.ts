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

	// Merge the patch over the stored config, then re-validate the whole thing.
	const config = parseOrThrow(
		AgentConfig,
		{ ...agent.config, ...patch },
		(issue) => `Merged config invalid: ${issue?.path.join(".")} — ${issue?.message}`,
	);
	await assertToolsOwned(key.project, config.toolIds);

	const nextVersion = agent.version + 1;
	await sql.begin(async (tx) => {
		await tx`
			UPDATE agents
			SET config = ${jsonb(config)}, name = ${config.name},
			    version = ${nextVersion}, updated_at = now()
			WHERE id = ${agent.id}`;
		await tx`
			INSERT INTO agent_versions (agent_id, version, config)
			VALUES (${agent.id}, ${nextVersion}, ${jsonb(config)})`;
	});

	return c.json(await getAgent(key.project, agent.id));
});

agents.delete("/agents/:id", async (c) => {
	const key = c.get("apiKey");
	const agent = await getAgent(key.project, c.req.param("id"));
	if (!agent) throw notFound();
	await sql`UPDATE agents SET status = 'deleted', updated_at = now() WHERE id = ${agent.id}`;
	return c.json({ deleted: true, id: agent.id });
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
