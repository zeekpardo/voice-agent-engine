import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-types.js";
import { jsonb, sql } from "../db/index.js";
import { AppError, badRequest } from "../lib/errors.js";
import { parseBody } from "../lib/http.js";
import { newId } from "../lib/id.js";
import { safeHttpUrl } from "@voice-engine/shared/safe-url";

/**
 * /v1/tools — tools-as-webhooks registration (spec §8). The engine executes
 * no business logic; during a call the worker POSTs tool invocations to
 * endpoint_url signed with the per-tool secret, and feeds the JSON result
 * back to the LLM.
 */
export const tools = new Hono<AppEnv>();

const notFound = () => new AppError(404, "not_found", "Tool not found");

const ToolBody = z.object({
	name: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z0-9_-]+$/, "letters, digits, _ and - only (used as the LLM function name)"),
	description: z.string().min(1),
	json_schema: z.record(z.unknown()), // JSON Schema for the LLM arguments
	// SSRF guard: https-only, no localhost / RFC1918 / link-local / metadata hosts.
	endpoint_url: safeHttpUrl(),
	timeout_ms: z.number().int().min(500).max(30_000).default(4000),
	enabled: z.boolean().default(true),
});

/** Secret is returned in full on create and to the internal worker route only. */
const PUBLIC_COLS = sql`id, name, description, json_schema, endpoint_url, timeout_ms, enabled, created_at, updated_at`;

tools.post("/tools", async (c) => {
	const key = c.get("apiKey");
	const t = await parseBody(
		c,
		ToolBody,
		(issue) => `Invalid tool: ${issue?.path.join(".")} — ${issue?.message}`,
	);
	const id = newId("tool");
	const secret = `whsec_${randomBytes(24).toString("base64url")}`;

	const existing = await sql`
		SELECT id FROM tools WHERE project = ${key.project} AND name = ${t.name}`;
	if (existing.length > 0) throw badRequest(`A tool named "${t.name}" already exists`);

	await sql`
		INSERT INTO tools (id, project, name, description, json_schema, endpoint_url, secret, timeout_ms, enabled)
		VALUES (${id}, ${key.project}, ${t.name}, ${t.description}, ${jsonb(t.json_schema)},
		        ${t.endpoint_url}, ${secret}, ${t.timeout_ms}, ${t.enabled})`;

	const rows = await sql`SELECT ${PUBLIC_COLS} FROM tools WHERE id = ${id}`;
	// The signing secret is shown ONCE — the consuming app verifies invocations with it.
	return c.json({ ...rows[0], secret }, 201);
});

tools.get("/tools", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT ${PUBLIC_COLS} FROM tools WHERE project = ${key.project} ORDER BY created_at DESC`;
	return c.json({ tools: rows });
});

tools.get("/tools/:id", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT ${PUBLIC_COLS} FROM tools WHERE id = ${c.req.param("id")} AND project = ${key.project}`;
	if (!rows[0]) throw notFound();
	return c.json(rows[0]);
});

tools.patch("/tools/:id", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT id FROM tools WHERE id = ${c.req.param("id")} AND project = ${key.project}`;
	if (!rows[0]) throw notFound();

	const t = await parseBody(
		c,
		ToolBody.partial(),
		(issue) => `Invalid tool patch: ${issue?.path.join(".")} — ${issue?.message}`,
	);

	await sql`
		UPDATE tools SET
			name         = COALESCE(${t.name ?? null}, name),
			description  = COALESCE(${t.description ?? null}, description),
			json_schema  = COALESCE(${t.json_schema ? jsonb(t.json_schema) : null}, json_schema),
			endpoint_url = COALESCE(${t.endpoint_url ?? null}, endpoint_url),
			timeout_ms   = COALESCE(${t.timeout_ms ?? null}, timeout_ms),
			enabled      = COALESCE(${t.enabled ?? null}, enabled),
			updated_at   = now()
		WHERE id = ${c.req.param("id")}`;

	const updated = await sql`SELECT ${PUBLIC_COLS} FROM tools WHERE id = ${c.req.param("id")}`;
	return c.json(updated[0]);
});

tools.delete("/tools/:id", async (c) => {
	const key = c.get("apiKey");
	const id = c.req.param("id");
	const rows = await sql`SELECT id FROM tools WHERE id = ${id} AND project = ${key.project}`;
	if (!rows[0]) throw notFound();

	// Refuse deletion while an active agent references the tool.
	const referencing = await sql`
		SELECT id, name FROM agents
		WHERE project = ${key.project} AND status != 'deleted'
		  AND config->'toolIds' @> ${sql.json([id])}`;
	if (referencing.length > 0) {
		throw badRequest(
			`Tool is attached to agent(s): ${referencing.map((a) => a.name).join(", ")} — detach first`,
		);
	}

	await sql`DELETE FROM tools WHERE id = ${id}`;
	return c.json({ deleted: true, id });
});
