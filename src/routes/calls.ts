import { ContactState } from "@voice-engine/shared/agent-config";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-types.js";
import { jsonb, sql } from "../db/index.js";
import { logCallEvent } from "../lib/call-events.js";
import { AppError } from "../lib/errors.js";
import { parseBody } from "../lib/http.js";
import { createOutboundCall } from "../lib/outbound.js";
import { agentRuntime } from "../providers/agent-runtime/index.js";
import { getAgent } from "./agents.js";

/**
 * /v1/calls — outbound dispatch, status, transcripts, cancel (spec §5).
 */
export const calls = new Hono<AppEnv>();

const notFound = () => new AppError(404, "not_found", "Call not found");

async function getCall(project: string, id: string) {
	const rows = await sql`SELECT * FROM calls WHERE id = ${id} AND project = ${project}`;
	return rows[0] ?? null;
}

const OutboundBody = z.object({
	agent_id: z.string().min(1),
	to: z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +16615550142"),
	from: z
		.string()
		.regex(/^\+[1-9]\d{6,14}$/)
		.optional(),
	scheduled_at: z.string().datetime({ offset: true }).optional(),
	variables: z.record(z.string()).optional(),
	metadata: z.record(z.unknown()).optional(),
	contactState: ContactState.optional(),
});

calls.post("/calls", async (c) => {
	const key = c.get("apiKey");
	const body = await parseBody(
		c,
		OutboundBody,
		(issue) => `Invalid call: ${issue?.path.join(".")} — ${issue?.message}`,
	);

	const agent = await getAgent(key.project, body.agent_id);
	if (!agent) throw new AppError(404, "not_found", "Agent not found");

	const call = await createOutboundCall({
		project: key.project,
		agent,
		to: body.to,
		from: body.from,
		scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : undefined,
		variables: body.variables,
		metadata: body.metadata,
		contactState: body.contactState,
	});
	return c.json(call, 201);
});

calls.get("/calls", async (c) => {
	const key = c.get("apiKey");
	const agentId = c.req.query("agent_id");
	const status = c.req.query("status");
	const from = c.req.query("from");
	const to = c.req.query("to");
	const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);

	const rows = await sql`
		SELECT id, agent_id, agent_version, direction, status, room_name,
		       from_number, to_number, summary, extracted,
		       started_at, ended_at, duration_seconds, end_reason, metadata, created_at
		FROM calls
		WHERE project = ${key.project}
		  ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
		  ${status ? sql`AND status = ${status}` : sql``}
		  ${from ? sql`AND created_at >= ${from}` : sql``}
		  ${to ? sql`AND created_at < ${to}` : sql``}
		ORDER BY created_at DESC
		LIMIT ${limit}`;
	return c.json({ calls: rows });
});

calls.get("/calls/:id", async (c) => {
	const call = await getCall(c.get("apiKey").project, c.req.param("id"));
	if (!call) throw notFound();
	return c.json(call);
});

const MetadataPatch = z.object({
	metadata: z.record(z.unknown()),
});

/**
 * Merge keys into a call's metadata after the fact — how consuming apps
 * attach late-resolved context (e.g. the CRM contact matched by phone once
 * the post-call sync runs). Merge-only: keys can be added/overwritten, never
 * removed.
 */
calls.patch("/calls/:id/metadata", async (c) => {
	const key = c.get("apiKey");
	const call = await getCall(key.project, c.req.param("id"));
	if (!call) throw notFound();

	const patch = await parseBody(c, MetadataPatch, () => "Body must be { metadata: object }");

	const merged = { ...((call.metadata as Record<string, unknown>) ?? {}), ...patch.metadata };
	await sql`
		UPDATE calls SET metadata = ${jsonb(merged)}, updated_at = now() WHERE id = ${call.id as string}`;
	return c.json({ id: call.id, metadata: merged });
});

calls.get("/calls/:id/transcript", async (c) => {
	const key = c.get("apiKey");
	const call = await getCall(key.project, c.req.param("id"));
	if (!call) throw notFound();
	const rows = await sql`SELECT turns, summary, updated_at FROM transcripts WHERE call_id = ${call.id as string}`;
	return c.json({
		call_id: call.id,
		turns: rows[0]?.turns ?? [],
		summary: rows[0]?.summary ?? call.summary ?? null,
		extracted: call.extracted ?? null,
	});
});

/**
 * Per-call usage rows, including the Phase 4 per-class LLM breakdown. The
 * llm_tokens_in/out rows carry a `breakdown` JSONB { respond|judge|summary|router
 * -> tokens (+ a nested `calls` count map) }, so consuming apps can see where the
 * model spend went per call without a separate analytics pipeline.
 */
calls.get("/calls/:id/usage", async (c) => {
	const key = c.get("apiKey");
	const call = await getCall(key.project, c.req.param("id"));
	if (!call) throw notFound();
	const rows = await sql`
		SELECT kind, quantity, breakdown, created_at FROM usage_events
		WHERE call_id = ${call.id as string} ORDER BY kind`;
	return c.json({ call_id: call.id, usage: rows });
});

calls.get("/calls/:id/events", async (c) => {
	const key = c.get("apiKey");
	const call = await getCall(key.project, c.req.param("id"));
	if (!call) throw notFound();
	const rows = await sql`
		SELECT type, payload, created_at FROM call_events
		WHERE call_id = ${call.id as string} ORDER BY created_at`;
	return c.json({ call_id: call.id, events: rows });
});

calls.post("/calls/:id/cancel", async (c) => {
	const key = c.get("apiKey");
	const call = await getCall(key.project, c.req.param("id"));
	if (!call) throw notFound();

	const cancelable = ["queued", "scheduled", "dialing", "active"];
	if (!cancelable.includes(call.status as string)) {
		throw new AppError(409, "not_cancelable", `Call is ${call.status}`);
	}

	if (call.room_name) await agentRuntime.cancelCall(call.room_name as string);
	await sql`
		UPDATE calls SET status = 'canceled', ended_at = now(), end_reason = 'canceled', updated_at = now()
		WHERE id = ${call.id as string}`;
	await logCallEvent(sql, { callId: call.id as string, type: "call.canceled" });
	return c.json({ canceled: true, id: call.id });
});
