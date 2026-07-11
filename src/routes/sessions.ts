import { Channel, ContactState, ContactTags } from "@voice-engine/shared/agent-config";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-types.js";
import { checkCapacity } from "../lib/concurrency.js";
import { AppError } from "../lib/errors.js";
import { resolveGroupRef } from "../lib/group-ref.js";
import { parseBody } from "../lib/http.js";
import { createWebSession } from "../lib/sessions.js";
import { getAgent } from "./agents.js";

/**
 * POST /v1/sessions — voice agent in the browser, no phone (spec §5).
 * The consuming app's backend calls this, hands { room_url, token } to the
 * kit's useVoiceAgent(); the browser joins LiveKit directly and the worker
 * is dispatched to the room.
 */
export const sessions = new Hono<AppEnv>();

const SessionBody = z.object({
	agent_id: z.string().min(1),
	variables: z.record(z.string()).optional(),
	metadata: z.record(z.unknown()).optional(),
	/** Per-call known-contact data (Phase 1): sibling of variables/metadata,
	 * built by the SaaS from the caller's CRM record. Optional. */
	contactState: ContactState.optional(),
	/** Per-call CRM tag names (Phase 5b): sibling of contactState. Optional. */
	contactTags: ContactTags.optional(),
	/** Session channel (Phase 6): "voice" (default, audio) or "text" (lk.chat
	 * text streams, no audio). Sibling of contactState/contactTags. Optional. */
	channel: Channel.optional(),
	/** Opaque tenant tag for per-group usage attribution; falls back to
	 * metadata.source_id server-side when absent. */
	group_ref: z.string().max(256).optional(),
});

sessions.post("/sessions", async (c) => {
	const key = c.get("apiKey");
	const body = await parseBody(
		c,
		SessionBody,
		(issue) => `Invalid body: ${issue?.message ?? "expected JSON"}`,
	);

	const agent = await getAgent(key.project, body.agent_id);
	if (!agent) throw new AppError(404, "not_found", "Agent not found");

	// Concurrency cap (multi-account plan §2). Voice web sessions hold a live media
	// session, so they count against the caps; a blocked session is refused 429 with
	// the blocking scope so the SaaS can surface it. Text sessions never open a room
	// but are still session-based, so they are gated the same way.
	const groupRef = resolveGroupRef(body.group_ref, body.metadata);
	const capacity = await checkCapacity({ project: key.project, agentId: agent.id, groupRef });
	if (!capacity.allowed) {
		return c.json(
			{
				error: { code: "capacity_reached", message: "Concurrency limit reached" },
				blockedBy: capacity.blockedBy,
				current: capacity.current,
				limit: capacity.limit,
			},
			429,
		);
	}

	const session = await createWebSession({
		project: key.project,
		agent,
		variables: body.variables,
		metadata: body.metadata,
		contactState: body.contactState,
		contactTags: body.contactTags,
		channel: body.channel,
		groupRef: body.group_ref,
	});
	return c.json(session, 201);
});
