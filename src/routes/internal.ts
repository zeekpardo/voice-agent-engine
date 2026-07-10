import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-types.js";
import { sql } from "../db/index.js";
import { env } from "../env.js";
import { logCallEvent } from "../lib/call-events.js";
import { badRequest, unauthorized } from "../lib/errors.js";
import { parseBody } from "../lib/http.js";
import { newId } from "../lib/id.js";
import { type PostCallConfig, summarizeAndExtract } from "../lib/postcall.js";
import { recordUsage, type UsageKind } from "../lib/usage.js";
import { emitEvent } from "../lib/webhooks.js";

/**
 * /internal — the agent-worker's private surface (spec §7). Authenticated by
 * the INTERNAL_KEY shared secret; never exposed to consuming apps. The worker
 * fetches agent config here, reports lifecycle events during the call, and
 * flushes transcript + usage at the end. The gateway turns those reports into
 * call rows, meters, and webhook fan-out — the worker stays stateless.
 */
export const internal = new Hono<AppEnv>();

internal.use("*", async (c, next) => {
	if (!env.INTERNAL_KEY) throw unauthorized("Internal API disabled (set INTERNAL_KEY)");
	const header = c.req.header("Authorization") ?? "";
	const m = header.match(/^Bearer\s+(.+)$/i);
	const token = m ? m[1]!.trim() : c.req.header("x-internal-key");
	if (!token || token !== env.INTERNAL_KEY) throw unauthorized("Invalid internal key");
	await next();
});

/** Agent config + resolved tools, pinned to a version — shared by config fetch and inbound. */
async function buildAgentBundle(agentId: string, version?: number) {
	const agents = await sql`SELECT * FROM agents WHERE id = ${agentId}`;
	const agent = agents[0];
	if (!agent) throw badRequest("Unknown agent id");

	let config = agent.config;
	let resolvedVersion = Number(agent.version);
	if (version != null && version !== resolvedVersion) {
		const snap = await sql`
			SELECT config, version FROM agent_versions WHERE agent_id = ${agentId} AND version = ${version}`;
		if (!snap[0]) throw badRequest(`Unknown version ${version} for agent ${agentId}`);
		config = snap[0].config;
		resolvedVersion = Number(snap[0].version);
	}

	const toolIds = ((config as { toolIds?: string[] }).toolIds ?? []) as string[];
	const tools =
		toolIds.length > 0
			? await sql`
				SELECT id, name, description, json_schema, endpoint_url, secret, timeout_ms
				FROM tools
				WHERE project = ${agent.project as string} AND id = ANY(${toolIds}) AND enabled`
			: [];

	return {
		agent: {
			id: agent.id,
			project: agent.project,
			name: agent.name,
			version: resolvedVersion,
			config,
		},
		tools,
	};
}

internal.get("/agents/:id", async (c) => {
	const version = c.req.query("version") ? Number(c.req.query("version")) : undefined;
	return c.json(await buildAgentBundle(c.req.param("id"), version));
});

const InboundBody = z.object({
	to_number: z.string().min(1), // the number that was called (routes to an agent)
	from_number: z.string().min(1), // the caller
	room_name: z.string().min(1),
});

/**
 * Inbound call resolution: the worker gets a SIP job with no per-call
 * dispatch metadata, so it asks the gateway "who answers this number?".
 * Creates the call row and returns the pinned agent bundle in one round trip.
 */
internal.post("/calls/inbound", async (c) => {
	const { to_number, from_number, room_name } = await parseBody(
		c,
		InboundBody,
		() => "Body must be { to_number, from_number, room_name }",
	);

	// SIP layers vary on the leading "+" — match either representation.
	const digits = to_number.replace(/[^\d]/g, "");
	const candidates = [`+${digits}`, digits];
	const nums = await sql`
		SELECT * FROM phone_numbers WHERE e164 = ANY(${candidates}) AND inbound_agent_id IS NOT NULL`;
	const number = nums[0];
	if (!number) throw badRequest(`No agent is routed to ${to_number}`);

	const bundle = await buildAgentBundle(number.inbound_agent_id as string);

	const callId = newId("call");
	await sql`
		INSERT INTO calls (id, project, agent_id, agent_version, direction, status,
		                   to_number, from_number, room_name, started_at)
		VALUES (${callId}, ${number.project as string}, ${bundle.agent.id as string},
		        ${bundle.agent.version}, 'inbound', 'active',
		        ${to_number}, ${from_number}, ${room_name}, now())`;
	await logCallEvent(
		sql,
		{ callId, type: "call.started", payload: { direction: "inbound", from: from_number } },
		{
			project: number.project as string,
			event: {
				type: "call.started",
				call_id: callId,
				agent_id: bundle.agent.id as string,
				direction: "inbound",
				from_number,
				to_number,
			},
		},
	);

	return c.json({ call_id: callId, ...bundle });
});

const EventBody = z.object({
	type: z.string().min(1), // call.started | tool.invoked | tool.failed | call.transferred | …
	payload: z.record(z.unknown()).default({}),
});

/** Mid-call lifecycle reporting: appended to call_events + fanned out. */
internal.post("/calls/:id/events", async (c) => {
	const callId = c.req.param("id");
	const rows = await sql`SELECT id, project, agent_id, status, metadata FROM calls WHERE id = ${callId}`;
	const call = rows[0];
	if (!call) throw badRequest("Unknown call id");

	const { type, payload } = await parseBody(c, EventBody, () => "Body must be { type, payload? }");

	if (type === "call.started") {
		await sql`
			UPDATE calls SET status = 'active', started_at = COALESCE(started_at, now()), updated_at = now()
			WHERE id = ${callId}`;
	}

	await logCallEvent(
		sql,
		{ callId, type, payload },
		{
			project: call.project as string,
			event: {
				type,
				call_id: callId,
				agent_id: call.agent_id as string,
				metadata: call.metadata,
				...payload,
			},
		},
	);
	return c.json({ ok: true });
});

const Turn = z.object({
	role: z.enum(["agent", "user", "system"]),
	text: z.string(),
	ts: z.number().optional(),
	speaker: z.string().optional(),
});

const ClassUsage = z.object({
	tokens_in: z.number().nonnegative(),
	tokens_out: z.number().nonnegative(),
	calls: z.number().int().nonnegative(),
});

const CompleteBody = z.object({
	status: z.enum(["completed", "failed", "no_answer", "voicemail"]).default("completed"),
	end_reason: z.string().default("unknown"),
	duration_seconds: z.number().int().nonnegative().optional(),
	summary: z.string().optional(),
	extracted: z.record(z.string()).optional(),
	transcript: z.object({ turns: z.array(Turn) }).optional(),
	usage: z
		.array(
			z.object({
				kind: z.enum([
					"stt_seconds",
					"tts_characters",
					"llm_tokens_in",
					"llm_tokens_out",
					"call_minutes",
				]),
				quantity: z.number().nonnegative(),
			}),
		)
		.default([]),
	// Per-class LLM usage breakdown (Phase 4). Optional: old workers omit it. The
	// per-direction tokens sum to the flat llm_tokens_in/out meters; stored as a
	// JSONB breakdown on those rows so per-class cost is queryable.
	usage_by_class: z
		.object({
			respond: ClassUsage,
			judge: ClassUsage,
			summary: ClassUsage,
			router: ClassUsage,
		})
		.optional(),
});

/**
 * End-of-call flush: transcript, summary/extract, meters, final status —
 * one request from the worker, then the gateway fans out call.completed.
 */
internal.post("/calls/:id/complete", async (c) => {
	const callId = c.req.param("id");
	const rows = await sql`SELECT * FROM calls WHERE id = ${callId}`;
	const call = rows[0];
	if (!call) throw badRequest("Unknown call id");

	const body = await parseBody(
		c,
		CompleteBody,
		(issue) => `Invalid completion: ${issue?.path.join(".")} — ${issue?.message}`,
	);

	const duration =
		body.duration_seconds ??
		(call.started_at
			? Math.max(0, Math.round((Date.now() - new Date(call.started_at as string).getTime()) / 1000))
			: 0);

	await sql.begin(async (tx) => {
		await tx`
			UPDATE calls SET
				status = ${body.status}, end_reason = ${body.end_reason},
				ended_at = COALESCE(ended_at, now()), duration_seconds = ${duration},
				summary = ${body.summary ?? null},
				extracted = ${body.extracted ? tx.json(body.extracted) : null},
				updated_at = now()
			WHERE id = ${callId}`;

		if (body.transcript) {
			await tx`
				INSERT INTO transcripts (call_id, turns, summary)
				VALUES (${callId}, ${tx.json(body.transcript.turns)}, ${body.summary ?? null})
				ON CONFLICT (call_id) DO UPDATE
					SET turns = EXCLUDED.turns, summary = EXCLUDED.summary, updated_at = now()`;
		}

		await logCallEvent(tx, {
			callId,
			type: "call." + body.status,
			payload: { end_reason: body.end_reason, duration_seconds: duration },
		});
	});

	// Per-class breakdown (Phase 4): attach to the llm token rows so each row's
	// breakdown values (respond/judge/summary/router) sum to that row's quantity.
	const ubc = body.usage_by_class;
	const classCalls = ubc
		? { respond: ubc.respond.calls, judge: ubc.judge.calls, summary: ubc.summary.calls, router: ubc.router.calls }
		: null;
	const breakdownFor = (kind: UsageKind): Record<string, unknown> | null => {
		if (!ubc) return null;
		if (kind === "llm_tokens_in")
			return { respond: ubc.respond.tokens_in, judge: ubc.judge.tokens_in, summary: ubc.summary.tokens_in, router: ubc.router.tokens_in, calls: classCalls };
		if (kind === "llm_tokens_out")
			return { respond: ubc.respond.tokens_out, judge: ubc.judge.tokens_out, summary: ubc.summary.tokens_out, router: ubc.router.tokens_out, calls: classCalls };
		return null;
	};

	for (const u of body.usage) {
		void recordUsage({
			apiKeyId: null,
			project: call.project as string,
			endpoint: "agent.call",
			provider: "livekit",
			bytes: null,
			status: 200,
			latencyMs: 0,
			kind: u.kind as UsageKind,
			quantity: u.quantity,
			callId,
			breakdown: breakdownFor(u.kind as UsageKind),
		});
	}

	// Respond IMMEDIATELY once the transcript + status are durable. The worker
	// flushes right before it tears the room down and its process dies within
	// milliseconds of this response — the LLM summarize/extract pass (up to
	// 45s) and the webhook fan-out continue here, gateway-side, detached.
	void (async () => {
		let summary = body.summary ?? null;
		let extracted = body.extracted ?? null;
		if (!summary && body.transcript && body.transcript.turns.length > 0) {
			const versions = await sql`
				SELECT config FROM agent_versions
				WHERE agent_id = ${call.agent_id as string} AND version = ${call.agent_version as number}`;
			const postCall = (versions[0]?.config as { postCall?: PostCallConfig } | undefined)?.postCall;
			if (postCall && (postCall.summarize || postCall.extract)) {
				try {
					const result = await summarizeAndExtract(postCall, body.transcript.turns);
					summary = result.summary ?? summary;
					extracted = result.extracted ?? extracted;
					await sql`
						UPDATE calls SET summary = ${summary}, extracted = ${extracted ? sql.json(extracted) : null},
						                 updated_at = now()
						WHERE id = ${callId}`;
					await sql`UPDATE transcripts SET summary = ${summary}, updated_at = now() WHERE call_id = ${callId}`;
				} catch (err) {
					console.error(`post-call extraction failed for ${callId}:`, err);
				}
			}
		}

		const eventType = body.status === "completed" ? "call.completed" : `call.${body.status}`;
		void emitEvent(call.project as string, {
			type: eventType,
			call_id: callId,
			agent_id: call.agent_id as string,
			metadata: call.metadata,
			direction: call.direction,
			from_number: call.from_number,
			to_number: call.to_number,
			duration_seconds: duration,
			end_reason: body.end_reason,
			summary,
			extracted,
			recording_url: (call.recording_url as string | null) ?? null,
		});
		if (body.transcript) {
			void emitEvent(call.project as string, {
				type: "transcript.final",
				call_id: callId,
				agent_id: call.agent_id as string,
				metadata: call.metadata,
				turns: body.transcript.turns,
			});
		}
		if (body.usage.length > 0) {
			void emitEvent(call.project as string, {
				type: "usage.recorded",
				call_id: callId,
				agent_id: call.agent_id as string,
				usage: body.usage,
			});
		}
	})().catch((err) => console.error(`post-completion pipeline failed for ${callId}:`, err));

	return c.json({ ok: true, duration_seconds: duration });
});
