import { ContactState, ContactTags } from "@voice-engine/shared/agent-config";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-types.js";
import { sql } from "../db/index.js";
import { AppError } from "../lib/errors.js";
import { parseBody } from "../lib/http.js";
import {
	createConversation,
	endConversation,
	getConversation,
	getConversationByExternalRef,
	listMessages,
	runTurn,
} from "../lib/convo-runner/index.js";

/**
 * /v1/conversations — room-less, turn-based text conversations (Wave 1b).
 *
 * The async, one-turn-at-a-time analogue of /v1/sessions: no LiveKit room, no
 * worker. Each inbound message runs ONE gateway-side agent turn (LLM + flow
 * node logic + objectives judge + rolling memory) and returns the reply.
 * Engine-neutral — a "conversation" is a generic surface; the consuming SaaS
 * gives external_ref / group_ref / metadata their meaning.
 */
export const conversations = new Hono<AppEnv>();

const notFound = () => new AppError(404, "not_found", "Conversation not found");

const CreateBody = z.object({
	agent_id: z.string().min(1),
	external_ref: z.string().min(1).optional(),
	group_ref: z.string().min(1).optional(),
	variables: z.record(z.string()).optional(),
	contactState: ContactState.optional(),
	contactTags: ContactTags.optional(),
	metadata: z.record(z.unknown()).optional(),
});

const MessageBody = z.object({
	text: z.string().min(1),
});

/** Serialize a conversation row for API responses (state.usage is the only
 * inner field worth surfacing; the rest of state is engine-internal). */
function present(row: Awaited<ReturnType<typeof getConversation>>) {
	if (!row) return null;
	return {
		id: row.id,
		agent_id: row.agent_id,
		agent_version: row.agent_version,
		status: row.status,
		node_id: row.node_id,
		external_ref: row.external_ref,
		group_ref: row.group_ref,
		metadata: row.metadata,
		usage: row.state?.usage ?? null,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

// Create — pins the agent's CURRENT published version; returns the row plus a
// greeting turn when config.greeting is set.
conversations.post("/conversations", async (c) => {
	const key = c.get("apiKey");
	const body = await parseBody(c, CreateBody, (issue) => `Invalid conversation: ${issue?.path.join(".")} — ${issue?.message}`);

	// Enforce external_ref uniqueness up front for a clean 409 (the DB unique
	// index is the real guard against races).
	if (body.external_ref) {
		const existing = await getConversationByExternalRef(key.project, body.external_ref);
		if (existing) throw new AppError(409, "external_ref_conflict", "A conversation with this external_ref already exists");
	}

	try {
		const { conversation, greeting } = await createConversation({
			project: key.project,
			agentId: body.agent_id,
			externalRef: body.external_ref,
			groupRef: body.group_ref,
			variables: body.variables,
			contactState: body.contactState,
			contactTags: body.contactTags,
			metadata: body.metadata,
		});
		return c.json({ conversation: present(conversation), greeting }, 201);
	} catch (err) {
		if (err instanceof Error && err.message === "agent_not_found") {
			throw new AppError(404, "not_found", "Agent not found");
		}
		throw err;
	}
});

// Resolve by external_ref (must precede the /:id route so it isn't shadowed).
conversations.get("/conversations", async (c) => {
	const key = c.get("apiKey");
	const externalRef = c.req.query("external_ref");
	if (!externalRef) throw new AppError(400, "bad_request", "Provide ?external_ref=… to look up a conversation");
	const row = await getConversationByExternalRef(key.project, externalRef);
	if (!row) throw notFound();
	return c.json({ conversation: present(row) });
});

conversations.get("/conversations/:id", async (c) => {
	const key = c.get("apiKey");
	const row = await getConversation(key.project, c.req.param("id"));
	if (!row) throw notFound();
	const messages = await listMessages(row.id);
	return c.json({ conversation: present(row), messages });
});

// Per-turn engine trace — the AI/tool/http diagnostics the convo-runner writes
// to conversation_events (ai.turn respond/judge/summary/router, tool.*,
// http.request, flow breadcrumbs). Mirrors GET /v1/calls/:id/events: same auth,
// same limit/newest-kept semantics, returns the chronological events array.
conversations.get("/conversations/:id/events", async (c) => {
	const key = c.get("apiKey");
	const row = await getConversation(key.project, c.req.param("id"));
	if (!row) throw notFound();
	// Bounded: ai.turn events carry prompt/completion payloads, so an unbounded
	// read of a long conversation could be several MB. Chronological; the newest
	// rows win when the cap bites (they're shown first in the AI-logs panel).
	const limit = Math.min(Number(c.req.query("limit") ?? 500) || 500, 2000);
	const rows = await sql`
		SELECT type, payload, created_at FROM conversation_events
		WHERE conversation_id = ${row.id}
		ORDER BY created_at DESC LIMIT ${limit}`;
	return c.json({ conversation_id: row.id, events: rows.reverse() });
});

// Append a user message and run one turn.
conversations.post("/conversations/:id/messages", async (c) => {
	const key = c.get("apiKey");
	const row = await getConversation(key.project, c.req.param("id"));
	if (!row) throw notFound();
	const { text } = await parseBody(c, MessageBody, () => "Body must be { text }");

	try {
		const result = await runTurn(row, text);
		return c.json(result);
	} catch (err) {
		if (err instanceof Error && err.message === "conversation_ended") {
			throw new AppError(409, "conversation_ended", "Conversation has ended");
		}
		if (err instanceof Error && err.message === "agent_config_unavailable") {
			throw new AppError(409, "agent_unavailable", "The pinned agent version is no longer available");
		}
		throw err;
	}
});

conversations.post("/conversations/:id/end", async (c) => {
	const key = c.get("apiKey");
	const row = await getConversation(key.project, c.req.param("id"));
	if (!row) throw notFound();
	await endConversation(row);
	const fresh = await getConversation(key.project, row.id);
	return c.json({ conversation: present(fresh) });
});
