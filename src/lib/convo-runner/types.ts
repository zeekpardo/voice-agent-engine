import type { AgentConfigT, ContactStateEntryT, FlowNode } from "@voice-engine/shared/agent-config";

/**
 * Tool row as loaded from the gateway DB WITH its per-tool `secret` — the shape
 * the worker's ToolDef carries. Used by the turn-runner's write-tool layer
 * (objective field writes, set_field, modify_tags) to sign webhook POSTs.
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

/** Per-objective progress, persisted in conversation.state for the current node. */
export interface ObjectiveProgress {
	met: boolean;
	rating?: number;
	answer?: string;
	/** User turns spent while this was still unmet. */
	attempts: number;
	/** maxAttempts exhausted — stops gating the exit, stays unmet. */
	skipped: boolean;
}

/** Per-call-class token usage, mirroring the worker's UsageByClass (Phase 4). */
export interface UsageByClass {
	respond: { tokens_in: number; tokens_out: number; calls: number };
	judge: { tokens_in: number; tokens_out: number; calls: number };
	summary: { tokens_in: number; tokens_out: number; calls: number };
	router: { tokens_in: number; tokens_out: number; calls: number };
}

export type UsageClass = keyof UsageByClass;

/**
 * The full persisted conversation state (conversations.state JSONB). Everything
 * a turn needs to resume with no room and no worker: known-contact data, the
 * rolling summary, the in-node objective progress, and a running usage total.
 */
export interface ConversationState {
	variables: Record<string, string>;
	contactState: ContactStateEntryT[];
	contactTags: string[];
	rollingSummary: string;
	/** User (inbound) turns seen so far — drives the rolling-summary interval. */
	turnCount: number;
	/** Node id the `objectives` map was armed for; a mismatch forces a re-arm. */
	objectivesNode?: string;
	objectives: Record<string, ObjectiveProgress>;
	usage: UsageByClass;
}

/** A minimal transcript turn the judge / router / responder read from. */
export interface ConvTurn {
	role: "user" | "agent" | "system";
	text: string;
}

/** An event to persist into conversation_events at the end of the turn. */
export interface ConvEvent {
	type: string;
	payload: Record<string, unknown>;
}

/**
 * Everything a single turn's helpers (prompt, judge, router, memory, tools)
 * operate on — threaded explicitly, the same explicit-deps style the worker's
 * flow modules use. Mutable fields (contactState, contactTags, rollingSummary,
 * objectives, usage, events) are updated in place over the turn and persisted
 * by the orchestrator afterward.
 */
export interface TurnContext {
	conversationId: string;
	project: string;
	agentId: string;
	config: AgentConfigT;
	metadata: Record<string, unknown>;
	nodesById: Map<string, FlowNode>;
	tools: ToolDef[];
	state: ConversationState;
	/** Live tag set (seeded from state.contactTags), grown by modify_tags. */
	tagSet: Set<string>;
	/** Full message history for this conversation, oldest first. */
	turns: ConvTurn[];
	/** Collected over the turn, flushed to conversation_events on persist. */
	events: ConvEvent[];
}

/** Where a flow exit lands after following routers/statements/write nodes. */
export type ResolvedTarget =
	| { kind: "agent"; id: string; saySoFar: string[] }
	| { kind: "end"; saySoFar: string[] }
	| { kind: "unsupported"; nodeId: string; reason: string; saySoFar: string[] };

export function newUsageByClass(): UsageByClass {
	return {
		respond: { tokens_in: 0, tokens_out: 0, calls: 0 },
		judge: { tokens_in: 0, tokens_out: 0, calls: 0 },
		summary: { tokens_in: 0, tokens_out: 0, calls: 0 },
		router: { tokens_in: 0, tokens_out: 0, calls: 0 },
	};
}

/** Record one LLM call's usage under a class (mirrors the worker's recordUsage). */
export function recordUsage(state: ConversationState, cls: UsageClass, tokensIn: number, tokensOut: number): void {
	const c = state.usage[cls];
	c.tokens_in += tokensIn;
	c.tokens_out += tokensOut;
	c.calls += 1;
}
