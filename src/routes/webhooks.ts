import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-types.js";
import { sql } from "../db/index.js";
import { AppError } from "../lib/errors.js";
import { parseBody } from "../lib/http.js";
import { newId } from "../lib/id.js";

/**
 * /v1/webhooks — where the consuming app receives engine events (spec §8.1).
 * The signing secret is returned once at registration.
 */
export const webhooks = new Hono<AppEnv>();

const KNOWN_EVENTS = [
	"call.queued",
	"call.scheduled",
	"call.started",
	"call.transferred",
	"call.completed",
	"call.failed",
	"call.no_answer",
	"call.voicemail",
	"call.canceled",
	"tool.invoked",
	"tool.failed",
	"transcript.final",
	"usage.recorded",
] as const;

const WebhookBody = z.object({
	url: z.string().url(),
	/** Empty / omitted = receive all events. */
	event_filter: z.array(z.enum(KNOWN_EVENTS)).default([]),
});

webhooks.post("/webhooks", async (c) => {
	const key = c.get("apiKey");
	const body = await parseBody(
		c,
		WebhookBody,
		(issue) => `Invalid webhook: ${issue?.path.join(".")} — ${issue?.message}`,
	);
	const id = newId("wh");
	const secret = `whsec_${randomBytes(24).toString("base64url")}`;
	await sql`
		INSERT INTO webhook_endpoints (id, project, url, secret, event_filter)
		VALUES (${id}, ${key.project}, ${body.url}, ${secret}, ${body.event_filter})`;
	return c.json({ id, url: body.url, event_filter: body.event_filter, secret }, 201);
});

webhooks.get("/webhooks", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT id, url, event_filter, enabled, created_at
		FROM webhook_endpoints WHERE project = ${key.project} ORDER BY created_at DESC`;
	return c.json({ webhooks: rows });
});

webhooks.delete("/webhooks/:id", async (c) => {
	const key = c.get("apiKey");
	const id = c.req.param("id");
	const rows = await sql`
		SELECT id FROM webhook_endpoints WHERE id = ${id} AND project = ${key.project}`;
	if (!rows[0]) throw new AppError(404, "not_found", "Webhook not found");
	await sql`DELETE FROM webhook_deliveries WHERE webhook_id = ${id}`;
	await sql`DELETE FROM webhook_endpoints WHERE id = ${id}`;
	return c.json({ deleted: true, id });
});
