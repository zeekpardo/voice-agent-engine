import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-types.js";
import { sql } from "../db/index.js";
import { AppError, badRequest } from "../lib/errors.js";
import { parseBody } from "../lib/http.js";
import { newId } from "../lib/id.js";
import {
	purchasePhoneNumber,
	releasePhoneNumbers,
	searchPhoneNumbers,
	updatePhoneNumber,
} from "../lib/phone-numbers.js";
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
	/** Opaque tenant tag copied onto inbound calls for per-group usage attribution. */
	group_ref: z.string().max(256).optional(),
});

numbers.post("/numbers", async (c) => {
	const key = c.get("apiKey");
	const { e164, inbound_agent_id, group_ref } = await parseBody(
		c,
		NumberBody,
		(issue) => `Invalid number: ${issue?.message}`,
	);

	if (inbound_agent_id) {
		const agent = await getAgent(key.project, inbound_agent_id);
		if (!agent) throw badRequest("Unknown inbound_agent_id for this project");
	}
	const existing = await sql`SELECT id FROM phone_numbers WHERE e164 = ${e164}`;
	if (existing[0]) throw badRequest(`${e164} is already registered`);

	const id = newId("num");
	await sql`
		INSERT INTO phone_numbers (id, project, e164, provider_ref, inbound_agent_id, group_ref)
		VALUES (${id}, ${key.project}, ${e164}, 'telnyx', ${inbound_agent_id ?? null}, ${group_ref ?? null})`;
	const rows = await sql`SELECT * FROM phone_numbers WHERE id = ${id}`;
	return c.json(rows[0], 201);
});

numbers.get("/numbers", async (c) => {
	const key = c.get("apiKey");
	// LEFT JOIN the routed agent so the list is self-describing: callers get the
	// assigned agent's name without a second lookup, and a number routed to an
	// agent the caller can't otherwise see still renders a name.
	const rows = await sql`
		SELECT n.*, a.name AS inbound_agent_name
		FROM phone_numbers n
		LEFT JOIN agents a ON a.id = n.inbound_agent_id
		WHERE n.project = ${key.project}
		ORDER BY n.created_at DESC`;
	return c.json({ numbers: rows });
});

/**
 * Programmatic provisioning via LiveKit's Phone Numbers API (Twirp). These
 * routes are CRM-neutral — they search/buy/release/route numbers and mirror the
 * result into the local `phone_numbers` registry. The SaaS owns any business
 * meaning (which source a number belongs to, etc.).
 */

// GET /v1/numbers/available?country=&area_code= — SearchPhoneNumbers.
numbers.get("/numbers/available", async (c) => {
	const country = c.req.query("country");
	const area_code = c.req.query("area_code");
	const contains = c.req.query("contains");
	const limitRaw = c.req.query("limit");
	const limit = limitRaw ? Number(limitRaw) : undefined;
	if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
		throw badRequest("limit must be a positive integer");
	}
	const result = await searchPhoneNumbers({ country, area_code, contains, limit });
	return c.json(result);
});

const PurchaseBody = z.object({
	number: z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +16615550142"),
	agentId: z.string().optional(),
	dispatchRuleId: z.string().optional(),
	/** Opaque tenant tag copied onto inbound calls for per-group usage attribution. */
	group_ref: z.string().max(256).optional(),
});

// POST /v1/numbers/purchase — PurchasePhoneNumber, then mirror into the registry.
numbers.post("/numbers/purchase", async (c) => {
	const key = c.get("apiKey");
	const { number, agentId, dispatchRuleId, group_ref } = await parseBody(
		c,
		PurchaseBody,
		(issue) => `Invalid purchase: ${issue?.message}`,
	);

	if (agentId) {
		const agent = await getAgent(key.project, agentId);
		if (!agent) throw badRequest("Unknown agentId for this project");
	}
	const existing = await sql`SELECT id FROM phone_numbers WHERE e164 = ${number}`;
	if (existing[0]) throw badRequest(`${number} is already registered`);

	const bought = await purchasePhoneNumber({
		phone_number: number,
		sip_dispatch_rule_id: dispatchRuleId,
	});
	// The API echoes the number; fall back to the requested value if absent.
	const e164 = bought.phone_number?.phone_number ?? number;
	const providerRef = bought.phone_number?.id ?? null;

	const id = newId("num");
	await sql`
		INSERT INTO phone_numbers (id, project, e164, provider_ref, inbound_agent_id, group_ref)
		VALUES (${id}, ${key.project}, ${e164}, ${providerRef}, ${agentId ?? null}, ${group_ref ?? null})`;
	const rows = await sql`
		SELECT n.*, a.name AS inbound_agent_name
		FROM phone_numbers n
		LEFT JOIN agents a ON a.id = n.inbound_agent_id
		WHERE n.id = ${id}`;
	return c.json({ ...rows[0], livekit: bought.phone_number }, 201);
});

// POST /v1/numbers/:id/release — ReleasePhoneNumbers, then drop the registry row.
numbers.post("/numbers/:id/release", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT * FROM phone_numbers WHERE id = ${c.req.param("id")} AND project = ${key.project}`;
	if (!rows[0]) throw notFound();

	const providerRef = rows[0].provider_ref as string | null;
	if (providerRef) await releasePhoneNumbers([providerRef]);
	await sql`DELETE FROM phone_numbers WHERE id = ${c.req.param("id")}`;
	return c.json({ released: true, id: c.req.param("id") });
});

const DispatchRuleBody = z.object({ dispatchRuleId: z.string().min(1) });

// PATCH /v1/numbers/:id/dispatch-rule — UpdatePhoneNumber (route inbound calls).
numbers.patch("/numbers/:id/dispatch-rule", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT * FROM phone_numbers WHERE id = ${c.req.param("id")} AND project = ${key.project}`;
	if (!rows[0]) throw notFound();

	const providerRef = rows[0].provider_ref as string | null;
	if (!providerRef) {
		throw badRequest("Number has no LiveKit provider reference; not provisioned via LiveKit");
	}
	const { dispatchRuleId } = await parseBody(
		c,
		DispatchRuleBody,
		(issue) => `Invalid dispatch rule: ${issue?.message}`,
	);
	const updated = await updatePhoneNumber({
		phone_number_id: providerRef,
		sip_dispatch_rule_id: dispatchRuleId,
	});
	return c.json(updated);
});

numbers.patch("/numbers/:id", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT * FROM phone_numbers WHERE id = ${c.req.param("id")} AND project = ${key.project}`;
	if (!rows[0]) throw notFound();

	const body = (await c.req.json().catch(() => ({}))) as {
		inbound_agent_id?: string | null;
		group_ref?: string | null;
	};
	if (body.inbound_agent_id) {
		const agent = await getAgent(key.project, body.inbound_agent_id);
		if (!agent) throw badRequest("Unknown inbound_agent_id for this project");
	}
	// group_ref is only touched when the key is present, so PATCHes that omit it
	// (e.g. a routing-only update) leave the existing tag intact.
	const patchGroupRef = "group_ref" in body;
	await sql`
		UPDATE phone_numbers SET
			inbound_agent_id = ${body.inbound_agent_id ?? null}
			${patchGroupRef ? sql`, group_ref = ${body.group_ref ?? null}` : sql``}
		WHERE id = ${c.req.param("id")}`;
	const updated = await sql`
		SELECT n.*, a.name AS inbound_agent_name
		FROM phone_numbers n
		LEFT JOIN agents a ON a.id = n.inbound_agent_id
		WHERE n.id = ${c.req.param("id")}`;
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
