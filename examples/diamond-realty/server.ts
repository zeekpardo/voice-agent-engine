import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgent,
	createWebSession,
	type EngineEvent,
	listAgents,
	toolHandler,
	verifyWebhook,
} from "../../kit/src/agent/server.js";
import {
	type Buyer,
	emails,
	hours,
	LENDER_AGENT_CONFIG,
	type LogEntry,
	TIMESCALE,
} from "./workflow.js";

/**
 * Diamond Realty demo server — plays the role of the CONSUMING APP.
 * Owns the workflow state machine + timers; the engine owns the voice calls.
 *
 * Usage:
 *   GATEWAY_URL=http://localhost:8787 GATEWAY_KEY=vk_live_… \
 *     pnpm tsx examples/diamond-realty/server.ts
 *
 * Since outbound telephony is engine Phase 3, each "call to the lender" is a
 * browser session — YOU answer as the lender via the dashboard.
 */

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DIAMOND_PORT ?? 8891);
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8787";
const GATEWAY_KEY = process.env.GATEWAY_KEY ?? "";
const BASE_URL = `http://localhost:${PORT}`;
const gw = { gatewayUrl: GATEWAY_URL, apiKey: GATEWAY_KEY };

if (!GATEWAY_KEY) {
	console.error("Set GATEWAY_KEY (mint one: pnpm key:mint diamond-realty)");
	process.exit(1);
}

// ---------------------------------------------------------------- state

interface DemoState {
	agentId: string | null;
	webhookSecret: string | null;
	toolSecret: string | null;
	buyers: Buyer[];
}

const STATE_FILE = join(DIR, ".diamond-state.json");
const state: DemoState = existsSync(STATE_FILE)
	? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as DemoState)
	: { agentId: null, webhookSecret: null, toolSecret: null, buyers: [] };

/** Session creds are kept out of the persisted file — memory only. */
const sessionCreds = new Map<string, { room_url: string; token: string }>();

const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const log = (b: Buyer, kind: LogEntry["kind"], title: string, body?: string) => {
	b.log.unshift({ ts: new Date().toISOString(), kind, title, body });
	console.log(`[${b.name}] ${title}`);
};

// ---------------------------------------------------------------- provisioning

async function provision(): Promise<void> {
	// Agent: reuse by name so restarts don't multiply agents.
	if (!state.agentId) {
		const existing = (await listAgents(gw)).find((a) => a.name === LENDER_AGENT_CONFIG.name);
		state.agentId = existing?.id ?? (await createAgent({ ...LENDER_AGENT_CONFIG }, gw)).id;
	}

	// log_status tool — secret only returned on create, so persist it.
	if (!state.toolSecret) {
		const res = await fetch(`${GATEWAY_URL}/v1/tools`, {
			method: "POST",
			headers: { Authorization: `Bearer ${GATEWAY_KEY}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "log_status",
				description:
					"Record a confirmed status update for this buyer's approval process the moment the lender confirms it. Use for: contacted, appointment_scheduled, docs_submitted, approved, or a free-text note.",
				json_schema: {
					type: "object",
					properties: {
						status: { type: "string", description: "the confirmed status or note" },
						notes: { type: "string", description: "any extra detail the lender gave" },
					},
					required: ["status"],
				},
				endpoint_url: `${BASE_URL}/tools/log-status`,
				timeout_ms: 3000,
			}),
		});
		const tool = (await res.json()) as { id?: string; secret?: string; error?: { message?: string } };
		if (tool.secret) {
			state.toolSecret = tool.secret;
			// attach the tool to the agent
			await fetch(`${GATEWAY_URL}/v1/agents/${state.agentId}`, {
				method: "PATCH",
				headers: { Authorization: `Bearer ${GATEWAY_KEY}`, "Content-Type": "application/json" },
				body: JSON.stringify({ toolIds: [tool.id] }),
			});
		} else if (!res.ok) {
			console.warn(`tool provisioning: ${tool.error?.message} (continuing without tool)`);
			state.toolSecret = "unavailable";
		}
	}

	// Webhook endpoint for engine events.
	if (!state.webhookSecret) {
		const res = await fetch(`${GATEWAY_URL}/v1/webhooks`, {
			method: "POST",
			headers: { Authorization: `Bearer ${GATEWAY_KEY}`, "Content-Type": "application/json" },
			body: JSON.stringify({ url: `${BASE_URL}/webhooks/voice`, event_filter: ["call.completed"] }),
		});
		const wh = (await res.json()) as { secret?: string; error?: { message?: string } };
		if (!wh.secret) throw new Error(`webhook provisioning failed: ${wh.error?.message}`);
		state.webhookSecret = wh.secret;
	}

	save();
	console.log(`provisioned: agent ${state.agentId}`);
}

// ---------------------------------------------------------------- workflow engine

function schedule(b: Buyer, inHours: number, label: string): void {
	b.nextActionAt = Date.now() + hours(inHours);
	b.nextActionLabel = label;
}

async function placeCall(b: Buyer, stage: string): Promise<void> {
	const session = await createWebSession(
		{
			agentId: state.agentId!,
			variables: {
				buyer_name: b.name,
				buyer_phone: b.phone,
				property_address: b.property,
				lender_name: b.lenderName,
				stage,
			},
			metadata: { buyer_id: b.id },
		},
		gw,
	);
	sessionCreds.set(b.id, { room_url: session.room_url, token: session.token });
	b.pendingCall = {
		callId: session.call_id,
		joinUrl: `${BASE_URL}/call/${b.id}`,
		createdAt: new Date().toISOString(),
	};
	log(b, "call", `📞 Calling ${b.lenderName}'s office (${stage}) — answer as the lender from the dashboard`);
}

/** Fires whenever a buyer's timer is due. */
async function runDueAction(b: Buyer): Promise<void> {
	b.nextActionAt = null;
	b.nextActionLabel = null;

	if (b.status === "assigned") {
		// 2 unanswered follow-ups → escalate (AI rule: "escalate if no response after 2 follow-ups")
		if (b.followupsWithoutResponse >= 2) {
			b.status = "stalled";
			const e = emails.escalation(b);
			log(b, "escalation", e.title, e.body);
			save();
			return;
		}
		const e = b.followupsWithoutResponse === 0 ? emails.statusCheck24h(b) : emails.followUp48h(b);
		log(b, "email", e.title, e.body);
		await placeCall(b, b.followupsWithoutResponse === 0 ? "initial 24-hour status check" : "48-hour follow-up");
		b.followupsWithoutResponse += 1;
		schedule(b, 48, "next 48h follow-up (if no response)");
	} else if (b.status === "contacted") {
		const e = emails.docsCheck72h(b);
		log(b, "email", e.title, e.body);
		await placeCall(b, "72 hours after lender appointment — confirming documents were submitted");
		schedule(b, 48, "docs follow-up (if no response)");
	} else if (b.status === "docs_submitted") {
		const e = emails.approvalCheck48h(b);
		log(b, "email", e.title, e.body);
		await placeCall(b, "48 hours after documents submitted — confirming approval status");
		schedule(b, 48, "approval follow-up (if no response)");
	}
	save();
}

setInterval(() => {
	for (const b of state.buyers) {
		if (b.nextActionAt && Date.now() >= b.nextActionAt) {
			void runDueAction(b).catch((err) => console.error(`action failed for ${b.name}`, err));
		}
	}
}, 1000);

/** Advance the state machine from a call's extracted outcomes. */
function applyCallOutcome(b: Buyer, ev: EngineEvent): void {
	const x = (ev.extracted ?? {}) as Record<string, string>;
	b.pendingCall = null;
	sessionCreds.delete(b.id);

	log(
		b,
		"status",
		`✅ Call completed (${ev.duration_seconds}s) — ${ev.summary ?? "no summary"}`,
		`extracted: ${JSON.stringify(x)}`,
	);

	if (x.approved === "true") {
		b.status = "approved";
		b.nextActionAt = null;
		b.nextActionLabel = null;
		const e = emails.buyerApproved(b);
		log(b, "email", e.title, e.body); // "immediate notification to Miguel"
	} else if (x.docs_submitted === "true") {
		b.status = "docs_submitted";
		b.followupsWithoutResponse = 0;
		schedule(b, 48, "approval status check");
		log(b, "status", "📁 Docs confirmed submitted — approval check scheduled (+48h)");
	} else if (x.contact_made === "true" || x.appointment_scheduled === "true") {
		b.status = "contacted";
		b.followupsWithoutResponse = 0;
		schedule(b, 72, "document submission check");
		log(b, "status", "🤝 Contact confirmed — document check scheduled (+72h)");
	} else {
		// Call happened but nothing confirmed — keep status; follow-up timer already set.
		log(b, "status", "❓ Nothing confirmed on this call — follow-up remains scheduled");
	}
	if (x.expected_timeline && x.expected_timeline !== "unknown") {
		log(b, "status", `🕐 Lender's expected timeline: ${x.expected_timeline}`);
	}
	save();
}

// ---------------------------------------------------------------- http

const dashboardHtml = readFileSync(join(DIR, "index.html"));
const callHtml = readFileSync(join(DIR, "call.html"));

// Engine events in (HMAC-verified via the kit).
let webhookRoute: (req: Request) => Promise<Response>;
// Tool invocations in (HMAC-verified via the kit).
let toolRoute: (req: Request) => Promise<Response>;

function buildRoutes() {
	webhookRoute = verifyWebhook(state.webhookSecret!, (event) => {
		if (event.type !== "call.completed") return;
		const buyerId = (event.metadata as { buyer_id?: string } | undefined)?.buyer_id;
		const buyer = state.buyers.find((b) => b.id === buyerId);
		if (buyer) applyCallOutcome(buyer, event);
	});
	toolRoute = toolHandler<{ status: string; notes?: string }>(
		state.toolSecret ?? "unavailable",
		(inv) => {
			const buyer = state.buyers.find((b) => b.id === (inv.metadata as { buyer_id?: string })?.buyer_id);
			if (buyer) {
				log(buyer, "tool", `🔧 log_status: ${inv.arguments.status}`, inv.arguments.notes);
				save();
			}
			return { logged: true };
		},
	);
}

function addBuyer(input: Partial<Buyer>): Buyer {
	const b: Buyer = {
		id: randomUUID().slice(0, 8),
		name: input.name || "Maria Lopez",
		phone: input.phone || "661-555-0142",
		email: input.email || "maria.lopez@example.com",
		property: input.property || "1284 Oakridge Dr, Palmdale CA",
		lenderName: input.lenderName || "Karen at Sunrise Lending",
		lenderEmail: input.lenderEmail || "karen@sunriselending.com",
		status: "assigned",
		followupsWithoutResponse: 0,
		nextActionAt: null,
		nextActionLabel: null,
		pendingCall: null,
		log: [],
	};
	log(b, "status", `🏦 Buyer assigned to ${b.lenderName} — first status check in "24h"`);
	schedule(b, 24, "initial 24h lender status check");
	state.buyers.unshift(b);
	save();
	return b;
}

async function nodeReqToFetch(req: import("node:http").IncomingMessage): Promise<Request> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	return new Request(`${BASE_URL}${req.url}`, {
		method: req.method,
		headers: Object.fromEntries(
			Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
		),
		body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
	});
}

createServer(async (req, res) => {
	const url = req.url ?? "/";
	try {
		if (url === "/webhooks/voice" && req.method === "POST") {
			const r = await webhookRoute(await nodeReqToFetch(req));
			res.writeHead(r.status, { "Content-Type": "application/json" });
			res.end(await r.text());
		} else if (url === "/tools/log-status" && req.method === "POST") {
			const r = await toolRoute(await nodeReqToFetch(req));
			res.writeHead(r.status, { "Content-Type": "application/json" });
			res.end(await r.text());
		} else if (url === "/state") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ timescale: TIMESCALE, now: Date.now(), buyers: state.buyers }));
		} else if (url === "/buyers" && req.method === "POST") {
			const raw = await nodeReqToFetch(req);
			const body = (await raw.json().catch(() => ({}))) as Partial<Buyer>;
			res.writeHead(201, { "Content-Type": "application/json" });
			res.end(JSON.stringify(addBuyer(body)));
		} else if (url.startsWith("/call/") && url.endsWith("/creds")) {
			const id = url.split("/")[2]!;
			const creds = sessionCreds.get(id);
			res.writeHead(creds ? 200 : 404, { "Content-Type": "application/json" });
			res.end(JSON.stringify(creds ?? { error: "no pending call (token may have expired)" }));
		} else if (url.startsWith("/call/")) {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(callHtml);
		} else {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(dashboardHtml);
		}
	} catch (err) {
		console.error("request failed", err);
		res.writeHead(500);
		res.end("error");
	}
}).listen(PORT, async () => {
	await provision();
	buildRoutes();
	console.log(`🏦 Diamond Realty demo on ${BASE_URL}  (1 workflow-hour = ${TIMESCALE}s)`);
});
