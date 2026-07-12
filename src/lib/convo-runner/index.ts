import type { AgentConfigT, FlowNode } from "@voice-engine/shared/agent-config";
import { interpolate, pruneFlowForChannel } from "@voice-engine/shared/agent-config";
import { jsonb, sql } from "../../db/index.js";
import { logConversationEvent } from "../conversation-events.js";
import { resolveGroupRef } from "../group-ref.js";
import { newId } from "../id.js";
import { env } from "../../env.js";
import { anthropicComplete, type ChatMessage, chatComplete } from "../llm.js";
import { recordUsage as meterUsage } from "../usage.js";
import { aiTurnEvent, providerFromModel } from "./ai-log.js";
import { allRequiredMet, armObjectives, judgeObjectives } from "./judge.js";
import { maybeRefreshSummary, memorySettings } from "./memory.js";
import { buildResponderMessages, buildSystemPrompt, CONTINUATION_DIRECTIVE, WRAP_UP_DIRECTIVE } from "./prompt.js";
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
import { isDisengageSignal, tagRulesSatisfied } from "./util.js";

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
	/**
	 * The agent messages produced this turn, in order. Usually a single element
	 * (equal to `reply`); an ANNOUNCED agent handoff emits two — the source
	 * bridge then the target's entry greeting — so a text/SMS consumer can send
	 * them as back-to-back messages. `reply` remains the "\n\n"-joined form for
	 * backward compatibility.
	 */
	messages?: string[];
	/** Set when this turn handed the conversation to a different agent. */
	agent_id?: string;
	agent_version?: number;
}

/** Config + resolved tools (with secrets) for a pinned agent version. */
interface AgentBundle {
	project: string;
	config: AgentConfigT;
	tools: ToolDef[];
}

const RESPONDER_TIMEOUT_MS = 30_000;

/**
 * Soft output ceiling for the TEXT respond call (Phase 2 SMS shaping). Text
 * replies should stay tight (1–3 short sentences ≈ a single SMS segment); the
 * "## TEXTING STYLE" directive does the real work, but capping max output tokens
 * is a cheap, low-risk guard against a runaway wall-of-text reply. It only ever
 * LOWERS the effective ceiling (min with the configured value), so an agent that
 * deliberately sets a smaller maxTokens keeps it. No hard truncation of the text
 * is done anywhere — that would cut mid-sentence. ~180 tokens ≈ 700–800 chars,
 * comfortably above a normal texty reply while still discouraging essays.
 */
const TEXT_RESPOND_MAX_TOKENS = 180;

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
	const config = textFlowConfig(snap[0].config as AgentConfigT);
	const toolIds = config.toolIds ?? [];
	const tools =
		toolIds.length > 0
			? ((await sql`
				SELECT id, name, description, json_schema, endpoint_url, secret, timeout_ms
				FROM tools WHERE project = ${agent.project as string} AND id = ANY(${toolIds}) AND enabled`) as unknown as ToolDef[])
			: [];
	return { project: agent.project as string, config, tools };
}

/**
 * Return `config` with its flow pruned to the TEXT channel. The convo-runner is
 * the room-less text/SMS surface (the voice worker runs the full flow), and the
 * gateway serves BOTH channels from the same published `config.flow` — so voice-
 * only nodes (e.g. `transfer`, which the SaaS compiler always marks voice-only:
 * announcement + hold music + voice swap / SIP forward, with no text equivalent)
 * are stripped here and their edges spliced through, rather than dead-ending the
 * conversation on `conversation.unsupported_node`. A flow with no channel marks
 * is returned by reference unchanged, so this is zero-cost for the common case.
 */
function textFlowConfig(config: AgentConfigT): AgentConfigT {
	if (!config.flow) return config;
	const flow = pruneFlowForChannel(config.flow, "text");
	return flow === config.flow ? config : { ...config, flow };
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

	// Text/SMS surface: run the text-pruned flow (see textFlowConfig) so the
	// entry + greeting resolve past any voice-only entry-adjacent nodes.
	const config = textFlowConfig(agent.config as AgentConfigT);
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

	// `bundle` is reassigned by an agent handoff mid-turn (the target's config
	// takes over the reply).
	let bundle = await loadBundle(conversation.agent_id, conversation.agent_version);
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
	// "Keep the conversation going" (config.continueConversation, default off).
	// A conversation is PAST TERMINAL when it has a flow but no active node — the
	// flow already ran to its end on an earlier turn and we've been holding it open
	// for rapport/upsell. `inContinuation` marks the reply as a continuation turn
	// (append the directive); `wrapUp` means "generate ONE graceful goodbye and
	// then end" (used when the contact disengages).
	const continuationOn = bundle.config.continueConversation === true;
	const wasPastTerminal = !!bundle.config.flow && !nodeId;
	let wrapUp = false;
	let inContinuation = false;
	const saySoFar: string[] = [];
	// Agent-handoff bookkeeping: the active agent id/version can change mid-turn.
	let agentId = conversation.agent_id;
	let agentVersion = conversation.agent_version;
	// Separate agent messages emitted by an ANNOUNCED handoff (bridge, greeting);
	// when set they REPLACE the normal responder for this turn.
	const handoffMessages: string[] = [];
	let skipResponder = false;

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
					if (continuationOn && !isDisengageSignal(text)) {
						// Toggle ON: hold the conversation open for rapport/upsell
						// instead of ending. The responder below generates a
						// continuation turn (flow-less prompt + CONTINUATION_DIRECTIVE).
						inContinuation = true;
						ctx.events.push({ type: "conversation.continuation", payload: { trigger: "flow_end" } });
					} else {
						status = "ended";
						ended = true;
						// Toggle ON but the terminating message already disengaged:
						// still send ONE graceful goodbye, then end.
						if (continuationOn) {
							inContinuation = true;
							wrapUp = true;
						}
					}
				} else if (resolved.kind === "handoff") {
					// Agent handoff (text): swap the active agent to the target and
					// continue. Announced → bridge + target entry greeting (two
					// messages, no hold music — text has none). Seamless → swap
					// silently; the responder below generates a continuation under
					// the target's config.
					const swapped = await performHandoff(ctx, bundle, node, resolved);
					if (!swapped) {
						// Missing / cross-project / deleted target — end gracefully.
						node = undefined;
						nodeId = resolved.nodeId;
						status = "ended";
						ended = true;
					} else {
						bundle = swapped.bundle;
						agentId = swapped.agentId;
						agentVersion = swapped.version;
						node = swapped.entryNode;
						nodeId = swapped.entryNode?.id ?? null;
						if (swapped.messages.length > 0) {
							handoffMessages.push(...swapped.messages);
							skipResponder = true;
						}
					}
				} else {
					// unsupported (transfer): end with a clear event.
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
	} else if (continuationOn && wasPastTerminal) {
		// Subsequent continuation turn: the flow already ended on an earlier turn
		// and we've been holding the conversation open (toggle ON). Keep the
		// rapport/upsell going, or — on a clear disengage signal — send one
		// graceful goodbye and end.
		inContinuation = true;
		if (isDisengageSignal(text)) {
			wrapUp = true;
			status = "ended";
			ended = true;
			ctx.events.push({ type: "conversation.continuation_end", payload: { reason: "disengaged" } });
		}
	}

	// ── generate the reply from the resulting node (unless ended, or the reply
	// was already produced by a handoff bridge/greeting) ─
	// When in continuation mode we still generate a reply even though `ended` is
	// set for a wrap-up — that's the graceful goodbye.
	let reply: string | null = null;
	if ((!ended || wrapUp) && !skipResponder) {
		let system = buildSystemPrompt(ctx, node);
		if (inContinuation) system += wrapUp ? WRAP_UP_DIRECTIVE : CONTINUATION_DIRECTIVE;
		const messages = buildResponderMessages(system, ctx.turns, memorySettings(ctx).windowTurns);
		reply = await respond(ctx, bundle, node, messages);
	}

	// Assemble this turn's agent messages, in order. An ANNOUNCED handoff emits
	// its own message(s) — the bridge then the target greeting — INSTEAD of the
	// responder; otherwise the statement lines collected while advancing precede
	// the generated reply, joined into a single message (unchanged behavior).
	let agentReplies: string[];
	if (handoffMessages.length > 0) {
		agentReplies = saySoFar.length > 0 ? [saySoFar.join("\n\n"), ...handoffMessages] : [...handoffMessages];
	} else {
		const combined = [...saySoFar, ...(reply ? [reply] : [])].join("\n\n");
		agentReplies = combined ? [combined] : [];
	}
	reply = agentReplies.length > 0 ? agentReplies.join("\n\n") : null;

	// Reflect the emitted agent messages into the buffer before summarizing.
	for (const m of agentReplies) ctx.turns.push({ role: "agent", text: m });

	// Rolling-summary refresh at the interval boundary (uses the updated turnCount).
	await maybeRefreshSummary(ctx);

	// ── persist everything atomically ────────────────────────────────────────
	await sql.begin(async (tx) => {
		await tx`
			INSERT INTO conversation_messages (id, conversation_id, role, text, created_at)
			VALUES (${newId("cmsg")}, ${conversation.id}, 'user', ${text}, clock_timestamp())`;
		// Each agent message persists as its own row (an announced handoff writes
		// two — bridge, then target greeting), ordered by clock_timestamp().
		for (const m of agentReplies) {
			await tx`
				INSERT INTO conversation_messages (id, conversation_id, role, text, created_at)
				VALUES (${newId("cmsg")}, ${conversation.id}, 'agent', ${m}, clock_timestamp())`;
		}
		// Reflect the (possibly grown) tag set back into persisted state.
		state.contactTags = [...ctx.tagSet];
		await tx`
			UPDATE conversations SET
				state = ${jsonb(state)}, node_id = ${nodeId}, status = ${status},
				agent_id = ${agentId}, agent_version = ${agentVersion}, updated_at = now()
			WHERE id = ${conversation.id}`;
		for (const ev of ctx.events) {
			await logConversationEvent(tx, { conversationId: conversation.id, type: ev.type, payload: ev.payload });
		}
	});

	meterTurn(conversation.project, conversation.id, usageBefore, state.usage);

	return {
		reply,
		status,
		node_id: nodeId,
		ended,
		messages: agentReplies.length > 0 ? agentReplies : undefined,
		agent_id: agentId,
		agent_version: agentVersion,
	};
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

// ── responder ────────────────────────────────────────────────────────────────

/**
 * Generate one agent reply from `node` under `bundle`'s config, recording usage
 * and an ai.turn event. Channel-aware model selection for the TEXT respond role:
 *   1. an explicit per-agent models.respond override always wins (operator's
 *      choice, via the xAI-compatible path);
 *   2. else, if ANTHROPIC_API_KEY is set, Claude (ANTHROPIC_TEXT_MODEL) generates
 *      it — text reads warmer on Claude and this path has no latency budget;
 *   3. else the agent's default xAI model (pre-key behavior).
 * `title` overrides the ai.turn label (e.g. a handoff bridge/greeting).
 */
async function respond(
	ctx: TurnContext,
	bundle: AgentBundle,
	node: FlowNode | undefined,
	messages: ChatMessage[],
	title?: string,
): Promise<string | null> {
	const respondOverride = bundle.config.models?.respond;
	const useClaude = !respondOverride && !!env.ANTHROPIC_API_KEY;
	const respondModel = respondOverride ?? (useClaude ? env.ANTHROPIC_TEXT_MODEL : bundle.config.llm.model);
	try {
		const complete = useClaude ? anthropicComplete : chatComplete;
		// Text is the only channel here, so cap output at the SMS ceiling (only ever
		// lowers the configured value — see TEXT_RESPOND_MAX_TOKENS).
		const configuredMaxTokens = node?.llm?.maxTokens ?? bundle.config.llm.maxTokens;
		const res = await complete({
			model: respondModel,
			temperature: node?.llm?.temperature ?? bundle.config.llm.temperature,
			maxTokens: Math.min(configuredMaxTokens, TEXT_RESPOND_MAX_TOKENS),
			messages,
			timeoutMs: RESPONDER_TIMEOUT_MS,
		});
		recordUsage(ctx.state, "respond", res.usage.promptTokens, res.usage.completionTokens);
		ctx.events.push(
			aiTurnEvent({
				cls: "respond",
				title: title ?? (node?.name ? `Agent Node — ${node.name}` : "Agent Node"),
				provider: useClaude ? "Anthropic" : providerFromModel(respondModel),
				model: respondModel,
				promptTokens: res.usage.promptTokens,
				completionTokens: res.usage.completionTokens,
				request: messages,
				response: res.text,
				node: node?.id,
			}),
		);
		return res.text.trim() || null;
	} catch (err) {
		ctx.events.push({ type: "conversation.responder_error", payload: { error: err instanceof Error ? err.message : String(err) } });
		return null;
	}
}

// ── agent handoff (text) ─────────────────────────────────────────────────────

/**
 * Resolve an agent-handoff target: load the target published agent's CURRENT
 * version + config + tools, scoped to `project`. A cross-project or
 * missing/deleted target returns null (the text analogue of the voice worker's
 * cross-project refusal — the query's `project =` predicate is the boundary).
 */
async function loadTargetBundle(project: string, agentId: string): Promise<{ bundle: AgentBundle; version: number } | null> {
	const rows = await sql`
		SELECT version FROM agents WHERE id = ${agentId} AND project = ${project} AND status != 'deleted'`;
	if (!rows[0]) return null;
	const version = Number(rows[0].version);
	const bundle = await loadBundle(agentId, version);
	if (!bundle) return null;
	return { bundle, version };
}

/**
 * Perform an agent handoff over the text turn path. Loads the target, swaps the
 * turn's ctx (config/tools/nodes/agentId) to it, exposes the target's name as
 * {{agent_name}}, and resets objective progress for the target's flow. For
 * ANNOUNCED mode it returns the bridge (source agent's persona) + the target's
 * entry greeting as separate messages; SEAMLESS returns none (the orchestrator's
 * responder then continues under the target). No hold music — text has none.
 * Returns null when the target is missing / cross-project / deleted.
 */
async function performHandoff(
	ctx: TurnContext,
	sourceBundle: AgentBundle,
	sourceNode: FlowNode | undefined,
	resolved: Extract<ResolvedTarget, { kind: "handoff" }>,
): Promise<{ bundle: AgentBundle; agentId: string; version: number; entryNode: FlowNode | undefined; messages: string[] } | null> {
	const loaded = await loadTargetBundle(ctx.project, resolved.agentId);
	if (!loaded) {
		ctx.events.push({
			type: "conversation.handoff_failed",
			payload: { from: resolved.nodeId, toAgentId: resolved.agentId, reason: "target_unavailable" },
		});
		return null;
	}
	const { bundle: targetBundle, version } = loaded;
	const targetName = targetBundle.config.name;
	const mode = resolved.mode;
	const window = memorySettings(ctx).windowTurns;
	const messages: string[] = [];

	// Expose {{agent_name}} up front so both the bridge ("passing you to
	// {{agent_name}}") and the target greeting ("Hi, this is {{agent_name}}")
	// resolve it.
	ctx.state.variables.agent_name = targetName;

	// ANNOUNCED bridge — built while ctx still reflects the SOURCE agent (the
	// bridge speaks in the source persona).
	if (mode === "announced" && resolved.say?.trim()) {
		const say = interpolate(resolved.say.trim(), ctx.state.variables);
		if (resolved.generate) {
			const system = `${buildSystemPrompt(ctx, sourceNode)}\n\nSend ONE short message, in the language the person is using, telling them you're passing them to a teammate — vary the phrasing so it never sounds scripted. Base it on: ${say}`;
			const bridge = await respond(ctx, sourceBundle, sourceNode, buildResponderMessages(system, ctx.turns, window), "Handoff bridge");
			if (bridge) messages.push(bridge);
		} else {
			messages.push(say);
		}
	}

	// Swap ctx to the TARGET agent.
	ctx.config = targetBundle.config;
	ctx.tools = targetBundle.tools;
	ctx.agentId = resolved.agentId;
	ctx.nodesById = nodesByIdOf(targetBundle.config);
	ctx.state.objectives = {};
	ctx.state.objectivesNode = undefined;

	const targetFlow = targetBundle.config.flow;
	const entryNode = targetFlow ? targetFlow.nodes.find((n) => n.id === targetFlow.entry) : undefined;

	ctx.events.push({
		type: "conversation.handoff",
		payload: { from: resolved.nodeId, toAgentId: resolved.agentId, toVersion: version, mode },
	});

	// ANNOUNCED greeting — the target opens with its entry greeting (the entry
	// node's entryInstructions as a direction, else a generic self-intro). SEAMLESS
	// skips it: the orchestrator's responder continues under the target instead.
	if (mode === "announced") {
		const opening = entryNode?.entryInstructions?.trim();
		const greetInstr = opening
			? `You have just taken over this same ongoing conversation. ${interpolate(opening, ctx.state.variables)} Greet the person and introduce yourself. Do not recap what was already covered. Reply in the language the person is using.`
			: `You have just taken over this same ongoing conversation. Briefly introduce yourself as ${targetName} and greet the person warmly. Do not recap what was already covered. Reply in the language the person is using.`;
		const system = `${buildSystemPrompt(ctx, entryNode)}\n\n${greetInstr}`;
		const greeting = await respond(ctx, targetBundle, entryNode, buildResponderMessages(system, ctx.turns, window), "Handoff greeting");
		if (greeting) messages.push(greeting);
	}

	return { bundle: targetBundle, agentId: resolved.agentId, version, entryNode, messages };
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
