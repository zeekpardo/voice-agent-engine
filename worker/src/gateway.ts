import { env } from "./env.js";

/**
 * Gateway internal-API client. The worker is stateless: agent configs come
 * from here (cached ~60s so config fetch never delays job pickup), and every
 * lifecycle event / transcript / meter goes back through here.
 */

/**
 * Agent-document types come from the vendored copy of the canonical zod schema
 * (packages/shared/src/agent-config.ts → worker/src/vendor/agent-config.ts via
 * `pnpm sync:worker`). Deriving them from the schema via z.infer means the
 * worker's view of the config shape can no longer drift from the gateway's —
 * there's nothing hand-written to keep in step. `AgentConfigT` is re-exported
 * under the worker-local name `AgentConfig` (the type the worker has always used).
 */
export type {
	AgentConfigT as AgentConfig,
	FlowNode,
	FlowScenario,
	FlowObjective,
	ContactStateEntryT,
} from "./vendor/agent-config.js";
import type { AgentConfigT, ContactStateEntryT } from "./vendor/agent-config.js";

export interface DispatchMetadata {
	projectId: string;
	agentId: string;
	agentVersion: number;
	callId: string;
	variables: Record<string, string>;
	metadata: Record<string, unknown>;
	/** Per-call known-contact data (Phase 1). Optional: old dispatches omit it.
	 * Opaque generic key/label/value — the engine never reads CRM meaning into it. */
	contactState?: ContactStateEntryT[];
}

/**
 * Tool row as served by the gateway's worker-only `/internal` API (see
 * src/routes/internal.ts): the persisted tool columns plus the per-tool
 * `secret`. This is the internal wire contract between gateway and worker, not
 * part of the AgentConfig document, so it stays defined here.
 */
export interface ToolDef {
	id: string;
	name: string;
	description: string;
	json_schema: Record<string, unknown>;
	endpoint_url: string;
	secret: string;
	timeout_ms: number;
}

export interface AgentBundle {
	agent: { id: string; project: string; name: string; version: number; config: AgentConfigT };
	tools: ToolDef[];
}

const cache = new Map<string, { bundle: AgentBundle; expires: number }>();
const CACHE_TTL_MS = 60_000;

async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${env.GATEWAY_URL.replace(/\/$/, "")}${path}`, {
		...init,
		headers: {
			"x-internal-key": env.GATEWAY_INTERNAL_KEY,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
}

export async function fetchAgentBundle(agentId: string, version: number): Promise<AgentBundle> {
	const key = `${agentId}@${version}`;
	const hit = cache.get(key);
	if (hit && hit.expires > Date.now()) return hit.bundle;

	const res = await gatewayFetch(`/internal/agents/${agentId}?version=${version}`);
	if (!res.ok) {
		throw new Error(`gateway agent fetch failed (${res.status}): ${await res.text()}`);
	}
	const bundle = (await res.json()) as AgentBundle;
	cache.set(key, { bundle, expires: Date.now() + CACHE_TTL_MS });
	return bundle;
}

/** Fire-and-forget lifecycle event (call.started, tool.invoked, …). */
export function reportEvent(callId: string, type: string, payload: Record<string, unknown> = {}): void {
	void gatewayFetch(`/internal/calls/${callId}/events`, {
		method: "POST",
		body: JSON.stringify({ type, payload }),
	}).catch((err) => console.error(`event report failed (${type})`, err));
}

export interface CompletionReport {
	status?: "completed" | "failed" | "no_answer" | "voicemail";
	end_reason: string;
	duration_seconds?: number;
	transcript?: { turns: { role: "agent" | "user" | "system"; text: string; ts?: number }[] };
	usage: { kind: string; quantity: number }[];
}

/** End-of-call flush — the gateway takes it from here (summary, extraction, fan-out). */
export async function reportCompletion(callId: string, report: CompletionReport): Promise<void> {
	const res = await gatewayFetch(`/internal/calls/${callId}/complete`, {
		method: "POST",
		body: JSON.stringify(report),
	});
	if (!res.ok) {
		console.error(`completion report failed (${res.status}): ${await res.text()}`);
	}
}

/** Inbound SIP call: resolve which agent answers this number + create the call row. */
export async function resolveInbound(input: {
	to_number: string;
	from_number: string;
	room_name: string;
}): Promise<{ call_id: string } & AgentBundle> {
	const res = await gatewayFetch("/internal/calls/inbound", {
		method: "POST",
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		throw new Error(`inbound resolution failed (${res.status}): ${await res.text()}`);
	}
	return (await res.json()) as { call_id: string } & AgentBundle;
}
