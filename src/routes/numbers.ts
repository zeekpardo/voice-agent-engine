import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-types.js";
import { sql } from "../db/index.js";
import { AppError, badRequest } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { getAgent } from "./agents.js";

/**
 * /v1/numbers — inbound number registry (spec §5).
 *
 * v1 registers numbers you've provisioned at the SIP provider (Telnyx) and
 * routed to LiveKit via scripts/setup-sip.ts. The inbound_agent_id mapping is
 * what the worker resolves when a call rings in. Programmatic purchasing can
 * layer on later without changing this contract.
 */
export const numbers = new Hono<AppEnv>();

const notFound = () => new AppError(404, "not_found", "Number not found");

const NumberBody = z.object({
	e164: z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +16615550142"),
	inbound_agent_id: z.string().optional(),
});

numbers.post("/numbers", async (c) => {
	const key = c.get("apiKey");
	const parsed = NumberBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		throw badRequest(`Invalid number: ${parsed.error.issues[0]?.message}`);
	}
	const { e164, inbound_agent_id } = parsed.data;

	if (inbound_agent_id) {
		const agent = await getAgent(key.project, inbound_agent_id);
		if (!agent) throw badRequest("Unknown inbound_agent_id for this project");
	}
	const existing = await sql`SELECT id FROM phone_numbers WHERE e164 = ${e164}`;
	if (existing[0]) throw badRequest(`${e164} is already registered`);

	const id = newId("num");
	await sql`
		INSERT INTO phone_numbers (id, project, e164, provider_ref, inbound_agent_id)
		VALUES (${id}, ${key.project}, ${e164}, 'telnyx', ${inbound_agent_id ?? null})`;
	const rows = await sql`SELECT * FROM phone_numbers WHERE id = ${id}`;
	return c.json(rows[0], 201);
});

numbers.get("/numbers", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT * FROM phone_numbers WHERE project = ${key.project} ORDER BY created_at DESC`;
	return c.json({ numbers: rows });
});

numbers.patch("/numbers/:id", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT * FROM phone_numbers WHERE id = ${c.req.param("id")} AND project = ${key.project}`;
	if (!rows[0]) throw notFound();

	const body = (await c.req.json().catch(() => ({}))) as { inbound_agent_id?: string | null };
	if (body.inbound_agent_id) {
		const agent = await getAgent(key.project, body.inbound_agent_id);
		if (!agent) throw badRequest("Unknown inbound_agent_id for this project");
	}
	await sql`
		UPDATE phone_numbers SET inbound_agent_id = ${body.inbound_agent_id ?? null}
		WHERE id = ${c.req.param("id")}`;
	const updated = await sql`SELECT * FROM phone_numbers WHERE id = ${c.req.param("id")}`;
	return c.json(updated[0]);
});

numbers.delete("/numbers/:id", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT id FROM phone_numbers WHERE id = ${c.req.param("id")} AND project = ${key.project}`;
	if (!rows[0]) throw notFound();
	await sql`DELETE FROM phone_numbers WHERE id = ${c.req.param("id")}`;
	return c.json({ deleted: true, id: c.req.param("id") });
});
