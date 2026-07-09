import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * @noba/voice-kit/agent/server — backend helpers for the voice agent engine.
 * These hold the gateway key and talk to agent-gateway; the browser never
 * sees it. Wire-up checklist for a new app (spec §10): mint key → create
 * agent → add webhook route → (optional) implement tools → dispatch calls
 * or drop in useVoiceAgent().
 */

export interface GatewayConfig {
	/** Base URL of the agent-gateway, e.g. "http://localhost:8787". */
	gatewayUrl: string;
	/** An issued gateway key (vk_live_...). */
	apiKey: string;
}

async function gw<T>(
	cfg: GatewayConfig,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`${cfg.gatewayUrl.replace(/\/$/, "")}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${cfg.apiKey}`,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	const data = (await res.json().catch(() => ({}))) as T & {
		error?: { code?: string; message?: string };
	};
	if (!res.ok) {
		throw new Error(data.error?.message ?? `agent-gateway request failed (${res.status})`);
	}
	return data;
}

// ---------------------------------------------------------------- agents

export interface AgentSummary {
	id: string;
	name: string;
	version: number;
	status: string;
	config: Record<string, unknown>;
}

export const createAgent = (config: Record<string, unknown>, cfg: GatewayConfig) =>
	gw<AgentSummary>(cfg, "POST", "/v1/agents", config);

export const listAgents = (cfg: GatewayConfig) =>
	gw<{ agents: AgentSummary[] }>(cfg, "GET", "/v1/agents").then((r) => r.agents);

export const updateAgent = (id: string, patch: Record<string, unknown>, cfg: GatewayConfig) =>
	gw<AgentSummary>(cfg, "PATCH", `/v1/agents/${id}`, patch);

export const deleteAgent = (id: string, cfg: GatewayConfig) =>
	gw<{ deleted: boolean }>(cfg, "DELETE", `/v1/agents/${id}`);

// ---------------------------------------------------------------- sessions & calls

export interface WebSession {
	call_id: string;
	room_name: string;
	room_url: string;
	token: string;
	agent_id: string;
	agent_version: number;
}

/** Browser voice session — hand { room_url, token } to useVoiceAgent(). */
export const createWebSession = (
	input: { agentId: string; variables?: Record<string, string>; metadata?: Record<string, unknown> },
	cfg: GatewayConfig,
) =>
	gw<WebSession>(cfg, "POST", "/v1/sessions", {
		agent_id: input.agentId,
		variables: input.variables,
		metadata: input.metadata,
	});

/** Outbound phone call (engine Phase 3 — the gateway 501s until telephony ships). */
export const dispatchCall = (
	input: {
		agentId: string;
		to: string;
		from?: string;
		scheduledAt?: string;
		variables?: Record<string, string>;
		metadata?: Record<string, unknown>;
	},
	cfg: GatewayConfig,
) =>
	gw<{ id: string; status: string }>(cfg, "POST", "/v1/calls", {
		agent_id: input.agentId,
		to: input.to,
		from: input.from,
		scheduled_at: input.scheduledAt,
		variables: input.variables,
		metadata: input.metadata,
	});

export const getCall = (id: string, cfg: GatewayConfig) =>
	gw<Record<string, unknown>>(cfg, "GET", `/v1/calls/${id}`);

export const getTranscript = (id: string, cfg: GatewayConfig) =>
	gw<{
		call_id: string;
		turns: { role: string; text: string; ts?: number }[];
		summary: string | null;
		extracted: Record<string, string> | null;
	}>(cfg, "GET", `/v1/calls/${id}/transcript`);

// ---------------------------------------------------------------- signature verification

const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Verify an engine signature (webhooks and tool invocations share the scheme). */
export function verifySignature(
	secret: string,
	timestamp: string | null,
	signatureHeader: string | null,
	rawBody: string,
): boolean {
	if (!timestamp || !signatureHeader) return false;
	const age = Math.abs(Date.now() / 1000 - Number(timestamp));
	if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;
	const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
	const received = signatureHeader.replace(/^hmac-sha256=/, "");
	if (expected.length !== received.length) return false;
	return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export interface EngineEvent {
	event_id: string;
	type: string;
	call_id?: string;
	agent_id?: string;
	metadata?: Record<string, unknown>;
	summary?: string | null;
	extracted?: Record<string, string> | null;
	duration_seconds?: number;
	end_reason?: string;
	[key: string]: unknown;
}

/**
 * Wrap a fetch-style route handler (Next.js App Router, Hono, Remix…) that
 * receives engine events:
 *
 *   export const POST = verifyWebhook(secret, async (event) => {
 *     if (event.type === "call.completed") await updateCrm(event);
 *   });
 */
export function verifyWebhook(
	secret: string,
	handler: (event: EngineEvent) => Promise<void> | void,
): (req: Request) => Promise<Response> {
	return async (req: Request) => {
		const raw = await req.text();
		const ok = verifySignature(
			secret,
			req.headers.get("x-voice-timestamp"),
			req.headers.get("x-voice-signature"),
			raw,
		);
		if (!ok) return Response.json({ error: "invalid signature" }, { status: 401 });
		await handler(JSON.parse(raw) as EngineEvent);
		return Response.json({ received: true });
	};
}

export interface ToolInvocation<Args = Record<string, unknown>> {
	tool: string;
	call_id: string;
	agent_id: string;
	metadata: Record<string, unknown>;
	arguments: Args;
}

/**
 * Wrap a fetch-style route handler that implements an engine tool (spec §8).
 * Return value becomes { result } — serialized into the agent's LLM turn.
 * Tool endpoints are hot paths: the agent is mid-sentence while this runs.
 */
export function toolHandler<Args = Record<string, unknown>>(
	secret: string,
	handler: (invocation: ToolInvocation<Args>) => Promise<unknown> | unknown,
): (req: Request) => Promise<Response> {
	return async (req: Request) => {
		const raw = await req.text();
		const ok = verifySignature(
			secret,
			req.headers.get("x-voice-timestamp"),
			req.headers.get("x-voice-signature"),
			raw,
		);
		if (!ok) return Response.json({ error: "invalid signature" }, { status: 401 });
		const result = await handler(JSON.parse(raw) as ToolInvocation<Args>);
		return Response.json({ result });
	};
}
