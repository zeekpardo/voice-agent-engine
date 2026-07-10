import { env } from "./env.js";

/**
 * Gateway internal-API client. The worker is stateless: agent configs come
 * from here (cached ~60s so config fetch never delays job pickup), and every
 * lifecycle event / transcript / meter goes back through here.
 */

export interface DispatchMetadata {
	projectId: string;
	agentId: string;
	agentVersion: number;
	callId: string;
	variables: Record<string, string>;
	metadata: Record<string, unknown>;
}

export interface ToolDef {
	id: string;
	name: string;
	description: string;
	json_schema: Record<string, unknown>;
	endpoint_url: string;
	secret: string;
	timeout_ms: number;
}

export interface AgentConfig {
	name: string;
	instructions: string;
	greeting?: string;
	language: string;
	fallbackLanguage?: string;
	llm: { model: string; temperature: number; maxTokens: number };
	stt: { provider: string; model?: string; diarize: boolean };
	tts: { provider: string; voice: string; speed: number };
	turnDetection: {
		mode: "vad" | "semantic";
		endpointingMs: number;
		allowInterruptions: boolean;
		preemptiveGeneration?: boolean;
	};
	timeouts: { maxCallSeconds: number; silenceHangupSeconds: number; noAnswerSeconds: number };
	toolIds: string[];
	/**
	 * Config-designated write tools (engine neutrality). Resolved to a ToolDef
	 * by name (then id). Optional on the wire; the worker defaults them to the
	 * historical CRM names so pre-existing pinned configs are unchanged.
	 * @see fieldWriteToolId/tagWriteToolId in src/lib/agent-config.ts
	 */
	fieldWriteToolId?: string;
	tagWriteToolId?: string;
	prohibitedWords?: string[];
	flow?: {
		entry: string;
		nodes: FlowNode[];
		/** Global detect-and-jump rules — one extra exit tool per scenario on every agent node. */
		scenarios?: FlowScenario[];
	};
	endCall?: { enabled: boolean };
	transfer?: { enabled: boolean; numbers: { label: string; e164: string }[] };
	voicemail?: { detect: boolean; onVoicemail: "hangup" | "leave_message"; message?: string };
	compliance: {
		aiDisclosure: boolean;
		disclosureText?: string;
		record: boolean;
		recordingConsentPrompt?: string;
	};
	postCall: { summarize: boolean; extract?: Record<string, string> };
}

export interface FlowScenario {
	name: string;
	/** When to jump — becomes the scenario exit tool's description. */
	description: string;
	/** Node id the flow jumps to (any kind; routers/statements resolve inline). */
	target: string;
}

export interface FlowObjective {
	/** Slug, unique within the node. */
	key: string;
	/** What must be learned from the caller — the judge evaluates against this. */
	description: string;
	/** Field name auto-written (via config.fieldWriteToolId) when met. */
	field?: string;
	/** Allowed values (picklist) — the judge coerces the answer to one of these. */
	options?: string[];
	/** Required objectives gate the node's primary exit. Default true. */
	required?: boolean;
	/** Give up after this many caller turns spent on the objective — it stops
	 * gating the exit (CloseBot "Max Attempts"). Omit = keep trying. */
	maxAttempts?: number;
	/** Judge strictness 0-100: the rating required to mark the objective met
	 * (CloseBot "Sensitivity"). Default 90 — strict, because a wrong "met" on
	 * a voice call can advance or end the conversation audibly. */
	sensitivity?: number;
}

export interface FlowNode {
	id: string;
	name?: string;
	/** "agent" (default) converses; "router" silently branches via one LLM
	 * evaluation; "statement" speaks a fixed line and immediately moves on;
	 * "transfer" plays hold music and switches voice — a simulated warm
	 * transfer to a different "person". */
	kind?: "agent" | "router" | "statement" | "transfer" | "set_field" | "modify_tags";
	/** Router-only: statement/question evaluated against the conversation so far. */
	router?: { condition: string };
	/** Statement-only: the exact line spoken ({{variables}} interpolated). */
	statement?: { say: string };
	/** set_field-only: deterministically write one field ({{variables}} interpolated in
	 * value). `toolId` names the config tool that writes it; omit → config.fieldWriteToolId. */
	setField?: { field: string; value: string; toolId?: string };
	/** modify_tags-only: deterministically add/remove tags. `toolId` names the config
	 * tool that adds tags; omit → config.tagWriteToolId. */
	modifyTags?: { add?: string[]; remove?: string[]; toolId?: string };
	/** Transfer-only: announcement (pre-transfer voice), hold-music length,
	 * and the voice used from here on (omitted = keep current voice). */
	transfer?: {
		say?: string;
		holdSeconds: number;
		voice?: { provider: string; voice: string; speed?: number };
	};
	instructions: string;
	entryInstructions?: string;
	toolIds: string[];
	llm?: { model: string; temperature?: number; maxTokens?: number };
	exits: { name: string; description: string; target?: string }[];
	/** Agent-only: engine-verified data goals. When present, the node's primary
	 * exit (exits[0]) is taken by the ENGINE once a judge pass confirms every
	 * required objective — the conversational LLM gets no exit tool for it. */
	objectives?: FlowObjective[];
	/** Model override for the objective judge (default: cheap fast model). */
	judge?: { model: string; temperature?: number };
}

export interface AgentBundle {
	agent: { id: string; project: string; name: string; version: number; config: AgentConfig };
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
