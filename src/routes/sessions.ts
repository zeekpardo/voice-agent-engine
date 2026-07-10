import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-types.js";
import { AppError } from "../lib/errors.js";
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

	const session = await createWebSession({
		project: key.project,
		agent,
		variables: body.variables,
		metadata: body.metadata,
	});
	return c.json(session, 201);
});
