import type { AgentConfigT, FlowNode } from "@voice-engine/shared/agent-config";
import { interpolate } from "@voice-engine/shared/agent-config";
import { jsonb, sql } from "../../db/index.js";
import { logConversationEvent } from "../conversation-events.js";
import { resolveGroupRef } from "../group-ref.js";
import { newId } from "../id.js";
import { env } from "../../env.js";
import { anthropicComplete, chatComplete } from "../llm.js";
import { recordUsage as meterUsage } from "../usage.js";
import { aiTurnEvent, providerFromModel } from "./ai-log.js";
import { allRequiredMet, armObjectives, judgeObjectives } from "./judge.js";
import { maybeRefreshSummary, memorySettings } from "./memory.js";
import { buildResponderMessages, buildSystemPrompt } from "./prompt.js";
import { resolveTarget } from "./router.js";
import {
	type ConversationState,
	type ConvTurn,
	newUsageByClass,
	recordUsage,
	type ResolvedTarget,
	type ToolDef,
	type TurnContext,
	type UsageByClass,
} from "./types.js";
import { tagRulesSatisfied } from "./util.js";

/**
 * Room-less, turn-based conversation runner (Wave 1b).
 *
 * DESIGN CHOICE (a): a minimal turn-runner ported INTO the gateway rather than
 * extracting shared pure logic from the worker. The worker's flow modules are
 * welded to LiveKit media primitives (voice.AgentSession, llm.ChatContext,
 * generateReply, waitForPlayout, RunContext) — extracting them cleanly would be
 * a large, risky refactor of live voice code. This module reuses the same
 * CONCEPTS (prompt composition, objective judge, router chain, rolling memory)
 * against the OpenAI-compatible chat API the gateway already speaks (lib/llm.ts,
 * same XAI env as post-call). Nothing here touches LiveKit; the voice path is
 * untouched.
 *
 * A turn: append the inbound message → judge the current node's objectives over
 * the transcript (auto-writing verified fields via config.fieldWriteToolId) →
 * if every required objective is met, follow the primary exit through
 * routers/statements/write-nodes to the next agent node (or end) → generate ONE
 * reply from the resulting node → persist state + messages + events + usage.
 *
 * v1 DEFERS (documented): model-callable node/scenario exits (no tools beyond
 * the write tools), transfer/handoff nodes (→ conversation.unsupported_node),
 * objective corrections, aggregate objectives, and streaming.
 */

export interface ConversationRow {
	id: string;
	project: string;
	agent_id: string;
	agent_version: number;
	group_ref: string | null;
	status: string;
	node_id: string | null;
	state: ConversationState;
	external_ref: string | null;
	metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

export interface ConversationMessage {
	id: string;
	role: "user" | "agent" | "system";
	text: string;
	created_at: string;
}

export interface TurnResult {
	reply: string | null;
	status: string;
	node_id: string | null;
	ended: boolean;
}

/** Config + resolved tools (with secrets) for a pinned agent version. */
interface AgentBundle {
	project: string;
	config: AgentConfigT;
	tools: ToolDef[];
}

const RESPONDER_TIMEOUT_MS = 30_000;

// ── loaders ──────────────────────────────────────────────────────────────────

export async function getConversation(project: string, id: string): Promise<ConversationRow | null> {
	const rows = await sql`SELECT * FROM conversations WHERE id = ${id} AND project = ${project}`;
	return (rows[0] as unknown as ConversationRow) ?? null;
}

export async function getConversationByExternalRef(project: string, externalRef: string): Promise<ConversationRow | null> {
	const rows = await sql`
		SELECT * FROM conversations WHERE project = ${project} AND external_ref = ${externalRef}`;
	return (rows[0] as unknown as ConversationRow) ?? null;
}

export async function listMessages(conversationId: string): Promise<ConversationMessage[]> {
	const rows = await sql`
		SELECT id, role, text, created_at FROM conversation_messages
		WHERE conversation_id = ${conversationId}
		ORDER BY created_at ASC`;
	return rows as unknown as ConversationMessage[];
}

async function loadBundle(agentId: string, version: number): Promise<AgentBundle | null> {
	const agents = await sql`SELECT project FROM agents WHERE id = ${agentId} AND status != 'deleted'`;
	const agent = agents[0];
	if (!agent) return null;
	const snap = await sql`
		SELECT config FROM agent_versions WHERE agent_id = ${agentId} AND version = ${version}`;
	if (!snap[0]) return null;
	const config = snap[0].config as AgentConfigT;
	const toolIds = config.toolIds ?? [];
	const tools =
		toolIds.length > 0
			? ((await sql`
				SELECT id, name, description, json_schema, endpoint_url, secret, timeout_ms
				FROM tools WHERE project = ${agent.project as string} AND id = ANY(${toolIds}) AND enabled`) as unknown as ToolDef[])
			: [];
	return { project: agent.project as string, config, tools };
}

function nodesByIdOf(config: AgentConfigT): Map<string, FlowNode> {
	const map = new Map<string, FlowNode>();
	for (const n of config.flow?.nodes ?? []) map.set(n.id, n);
	return map;
}

/** The current agent node for a conversation, or undefined for a flow-less config. */
function currentNode(config: AgentConfigT, nodeId: string | null): FlowNode | undefined {
	if (!config.flow || !nodeId) return undefined;
	return config.flow.nodes.find((n) => n.id === nodeId);
}

// ── create ───────────────────────────────────────────────────────────────────

export interface CreateConversationInput {
	project: string;
	agentId: string;
	externalRef?: string;
	groupRef?: string;
	variables?: Record<string, string>;
	contactState?: ConversationState["contactState"];
	contactTags?: string[];
	metadata?: Record<string, unknown>;
}

/**
 * Create a conversation pinned to the agent's CURRENT published version. If the
 * config carries a greeting, it is interpolated, recorded as the first agent
 * message, and returned as the greeting turn.
 */
export async function createConversation(
	input: CreateConversationInput,
): Promise<{ conversation: ConversationRow; greeting: string | null }> {
	const agents = await sql`
		SELECT id, project, version, config FROM agents
		WHERE id = ${input.agentId} AND project = ${input.project} AND status != 'deleted'`;
	const agent = agents[0];
	if (!agent) return Promise.reject(new Error("agent_not_found"));

	const config = agent.config as AgentConfigT;
	const version = Number(agent.version);
	const metadata = input.metadata ?? {};
	const groupRef = resolveGroupRef(input.groupRef, metadata);
	const nodeId = config.flow?.entry ?? null;

	const state: ConversationState = {
		variables: input.variables ?? {},
		contactState: input.contactState ?? [],
		contactTags: input.contactTags ?? [],
		rollingSummary: "",
		turnCount: 0,
		objectives: {},
		usage: newUsageByClass(),
	};

	const id = newId("cnv");
	const greeting = config.greeting ? interpolate(config.greeting, state.variables) : null;

	await sql.begin(async (tx) => {
		await tx`
			INSERT INTO conversations (id, project, agent_id, agent_version, group_ref, status, node_id, state, external_ref, metadata)
			VALUES (${id}, ${input.project}, ${input.agentId}, ${version}, ${groupRef ?? null}, 'active',
			        ${nodeId}, ${jsonb(state)}, ${input.externalRef ?? null}, ${jsonb(metadata)})`;
		if (greeting) {
			await tx`
				INSERT INTO conversation_messages (id, conversation_id, role, text, created_at)
				VALUES (${newId("cmsg")}, ${id}, 'agent', ${greeting}, clock_timestamp())`;
		}
		await logConversationEvent(tx, {
			conversationId: id,
			type: "conversation.created",
			payload: { agent_id: input.agentId, agent_version: version, node: nodeId, greeting: greeting != null },
		});
	});

	const conversation = (await getConversation(input.project, id))!;
	return { conversation, greeting };
}

// ── run one turn ─────────────────────────────────────────────────────────────

/** Take the primary (first non-tag-gated) exit of an agent node, if any. */
function primaryExitTarget(node: FlowNode, tagSet: Set<string>): string | undefined {
	const exit = node.exits.find((e) => tagRulesSatisfied(e.tagRules, tagSet));
	return exit?.target;
}

/**
 * Run one turn against an ACTIVE conversation. Appends `text` as a user message,
 * advances the flow, and returns the reply. Throws "conversation_ended" if the
 * conversation is already ended (the route maps it to 409).
 */
export async function runTurn(conversation: ConversationRow, text: string): Promise<TurnResult> {
	if (conversation.status !== "active") return Promise.reject(new Error("conversation_ended"));

	const bundle = await loadBundle(conversation.agent_id, conversation.agent_version);
	if (!bundle) return Promise.reject(new Error("agent_config_unavailable"));

	// Normalize a possibly-partial persisted state (older rows / defaults).
	const state: ConversationState = {
		variables: conversation.state.variables ?? {},
		contactState: conversation.state.contactState ?? [],
		contactTags: conversation.state.contactTags ?? [],
		rollingSummary: conversation.state.rollingSummary ?? "",
		turnCount: conversation.state.turnCount ?? 0,
		objectivesNode: conversation.state.objectivesNode,
		objectives: conversation.state.objectives ?? {},
		usage: conversation.state.usage ?? newUsageByClass(),
	};

	const priorTurns = (await listMessages(conversation.id)).map((m) => ({ role: m.role, text: m.text }) as ConvTurn);
	const userTurn: ConvTurn = { role: "user", text };
	const turns = [...priorTurns, userTurn];

	const ctx: TurnContext = {
		conversationId: conversation.id,
		project: conversation.project,
		agentId: conversation.agent_id,
		config: bundle.config,
		metadata: conversation.metadata ?? {},
		nodesById: nodesByIdOf(bundle.config),
		tools: bundle.tools,
		state,
		tagSet: new Set(state.contactTags),
		turns,
		events: [],
	};

	const usageBefore = structuredClone(state.usage);
	state.turnCount += 1;

	let nodeId = conversation.node_id;
	let node = currentNode(bundle.config, nodeId);
	let status = "active";
	let ended = false;
	const saySoFar: string[] = [];

	// ── objectives judge + node advancement ─────────────────────────────────
	if (node) {
		// (Re)arm objectives when entering a node (or resuming a fresh one).
		if (state.objectivesNode !== node.id) armObjectives(ctx, node);
		const objectives = node.objectives ?? [];
		const isConversationNode = !!node.conversation;

		if (objectives.length > 0) {
			await judgeObjectives(ctx, node);
			if (allRequiredMet(node, ctx)) {
				ctx.events.push({ type: "conversation.objectives_met", payload: { node: node.id } });
				const resolved = await advance(ctx, node);
				saySoFar.push(...resolved.saySoFar);
				if (resolved.kind === "agent") {
					node = ctx.nodesById.get(resolved.id)!;
					nodeId = node.id;
				} else if (resolved.kind === "end") {
					node = undefined;
					nodeId = null;
					status = "ended";
					ended = true;
				} else {
					// unsupported (transfer/handoff): end with a clear event.
					ctx.events.push({
						type: "conversation.unsupported_node",
						payload: { node: resolved.nodeId, reason: resolved.reason },
					});
					node = undefined;
					nodeId = resolved.nodeId;
					status = "ended";
					ended = true;
				}
			}
		} else if (isConversationNode) {
			// Conversation-mode nodes are objective-less and self-close via a
			// model-driven wrapUp exit — deferred in v1; they just converse.
		}
	}

	// ── generate the reply from the resulting node (unless ended with a statement) ─
	let reply: string | null = null;
	if (!ended) {
		const system = buildSystemPrompt(ctx, node);
		const messages = buildResponderMessages(system, ctx.turns, memorySettings(ctx).windowTurns);
		// Channel-aware model selection for the TEXT respond role:
		//   1. an explicit per-agent models.respond override always wins (operator's
		//      choice, generated via the xAI-compatible path as before);
		//   2. otherwise, if ANTHROPIC_API_KEY is set, Claude (ANTHROPIC_TEXT_MODEL)
		//      generates the reply — text reads warmer on Claude and this path has
		//      no real-time latency budget;
		//   3. otherwise fall back to the agent's default xAI model (pre-key behavior).
		const respondOverride = bundle.config.models?.respond;
		const useClaude = !respondOverride && !!env.ANTHROPIC_API_KEY;
		const respondModel = respondOverride ?? (useClaude ? env.ANTHROPIC_TEXT_MODEL : bundle.config.llm.model);
		try {
			const complete = useClaude ? anthropicComplete : chatComplete;
			const res = await complete({
				model: respondModel,
				temperature: node?.llm?.temperature ?? bundle.config.llm.temperature,
				maxTokens: node?.llm?.maxTokens ?? bundle.config.llm.maxTokens,
				messages,
				timeoutMs: RESPONDER_TIMEOUT_MS,
			});
			recordUsage(state, "respond", res.usage.promptTokens, res.usage.completionTokens);
			ctx.events.push(
				aiTurnEvent({
					cls: "respond",
					title: node?.name ? `Agent Node — ${node.name}` : "Agent Node",
					provider: useClaude ? "Anthropic" : providerFromModel(respondModel),
					model: respondModel,
					promptTokens: res.usage.promptTokens,
					completionTokens: res.usage.completionTokens,
					request: messages,
					response: res.text,
					node: node?.id,
				}),
			);
			reply = res.text.trim() || null;
		} catch (err) {
			ctx.events.push({ type: "conversation.responder_error", payload: { error: err instanceof Error ? err.message : String(err) } });
			reply = null;
		}
	}

	// Statement lines collected while advancing precede the generated reply.
	if (saySoFar.length > 0) {
		reply = [...saySoFar, ...(reply ? [reply] : [])].join("\n\n");
	}

	// Reflect the full turn (incl. reply) into the buffer before summarizing.
	if (reply) ctx.turns.push({ role: "agent", text: reply });

	// Rolling-summary refresh at the interval boundary (uses the updated turnCount).
	await maybeRefreshSummary(ctx);

	// ── persist everything atomically ────────────────────────────────────────
	await sql.begin(async (tx) => {
		await tx`
			INSERT INTO conversation_messages (id, conversation_id, role, text, created_at)
			VALUES (${newId("cmsg")}, ${conversation.id}, 'user', ${text}, clock_timestamp())`;
		if (reply) {
			await tx`
				INSERT INTO conversation_messages (id, conversation_id, role, text, created_at)
				VALUES (${newId("cmsg")}, ${conversation.id}, 'agent', ${reply}, clock_timestamp())`;
		}
		// Reflect the (possibly grown) tag set back into persisted state.
		state.contactTags = [...ctx.tagSet];
		await tx`
			UPDATE conversations SET
				state = ${jsonb(state)}, node_id = ${nodeId}, status = ${status}, updated_at = now()
			WHERE id = ${conversation.id}`;
		for (const ev of ctx.events) {
			await logConversationEvent(tx, { conversationId: conversation.id, type: ev.type, payload: ev.payload });
		}
	});

	meterTurn(conversation.project, conversation.id, usageBefore, state.usage);

	return { reply, status, node_id: nodeId, ended };
}

/**
 * Advance from an agent node whose required objectives are all met: follow the
 * primary exit through routers/statements/write-nodes, then keep advancing while
 * each landed agent node's required objectives are ALSO already satisfied
 * (skipIfKnown chains). Bounded to a few hops so a fully-known flow can't loop.
 */
async function advance(ctx: TurnContext, fromNode: FlowNode): Promise<ResolvedTarget> {
	const saySoFar: string[] = [];
	let resolved = await resolveTarget(ctx, primaryExitTarget(fromNode, ctx.tagSet));
	saySoFar.push(...resolved.saySoFar);
	for (let hop = 0; hop < 5 && resolved.kind === "agent"; hop++) {
		const node = ctx.nodesById.get(resolved.id)!;
		armObjectives(ctx, node);
		if ((node.objectives ?? []).length === 0 || !allRequiredMet(node, ctx)) break;
		ctx.events.push({ type: "conversation.objectives_met", payload: { node: node.id, chained: true } });
		const next = await resolveTarget(ctx, primaryExitTarget(node, ctx.tagSet));
		saySoFar.push(...next.saySoFar);
		resolved = next;
	}
	return { ...resolved, saySoFar } as ResolvedTarget;
}

// ── end ──────────────────────────────────────────────────────────────────────

export async function endConversation(conversation: ConversationRow, reason = "ended_by_consumer"): Promise<void> {
	if (conversation.status !== "active") return;
	await sql.begin(async (tx) => {
		await tx`UPDATE conversations SET status = 'ended', updated_at = now() WHERE id = ${conversation.id}`;
		await logConversationEvent(tx, { conversationId: conversation.id, type: "conversation.ended", payload: { reason } });
	});
}

// ── metering ─────────────────────────────────────────────────────────────────

/**
 * Record this turn's LLM usage into usage_events, mirroring the call path
 * (endpoint "agent.conversation", one llm_tokens_in + one llm_tokens_out row
 * carrying the per-class breakdown). Deltas are computed against the pre-turn
 * usage so summed rows equal the conversation total.
 */
function meterTurn(project: string, conversationId: string, before: UsageByClass, after: UsageByClass): void {
	const classes = ["respond", "judge", "summary", "router"] as const;
	const deltaIn: Record<string, number> = {};
	const deltaOut: Record<string, number> = {};
	const deltaCalls: Record<string, number> = {};
	let totalIn = 0;
	let totalOut = 0;
	for (const c of classes) {
		deltaIn[c] = after[c].tokens_in - before[c].tokens_in;
		deltaOut[c] = after[c].tokens_out - before[c].tokens_out;
		deltaCalls[c] = after[c].calls - before[c].calls;
		totalIn += deltaIn[c];
		totalOut += deltaOut[c];
	}
	if (totalIn === 0 && totalOut === 0) return;
	void meterUsage({
		apiKeyId: null,
		project,
		endpoint: "agent.conversation",
		provider: "xai",
		bytes: null,
		status: 200,
		latencyMs: 0,
		kind: "llm_tokens_in",
		quantity: totalIn,
		callId: conversationId,
		breakdown: { ...deltaIn, calls: deltaCalls },
	});
	void meterUsage({
		apiKeyId: null,
		project,
		endpoint: "agent.conversation",
		provider: "xai",
		bytes: null,
		status: 200,
		latencyMs: 0,
		kind: "llm_tokens_out",
		quantity: totalOut,
		callId: conversationId,
		breakdown: { ...deltaOut, calls: deltaCalls },
	});
}
