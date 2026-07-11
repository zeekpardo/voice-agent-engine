import type { JobContext } from "@livekit/agents";
import { inference, llm, voice } from "@livekit/agents";
import type { JSONSchema7 } from "json-schema";
import type { AgentBundle, AgentConfig, ContactStateEntryT, DispatchMetadata } from "../gateway.js";
import { buildTools } from "../tools.js";
import { createAgentBuilder } from "./agent-builder.js";
import {
	type FlowRuntimeContext,
	type FlowRuntimeState,
	type ResolvedModels,
	type Turn,
	buildTts,
	collectMissingVars,
	findToolDef,
	inferenceModel,
	interpolate,
	interpolateSpoken,
} from "./context.js";
import type { Handoff } from "./handoff.js";
import { createMemoryTracker } from "./memory.js";
import { type ObjectivesTracker, createObjectivesTracker } from "./objectives.js";
import { createRouter } from "./router.js";
import { createTransfer } from "./transfer.js";

/**
 * Per-config agent assembly (extracted from main.ts's entry closure). Given an
 * agent bundle (config + resolved tools) and the call-wide shared state, this
 * builds the active voice.Agent — a flow graph (one agent per node, wired
 * through router / transfer / agent-builder / objectives / memory) or a single
 * agent — plus the per-caller-turn hooks (objective judge + rolling memory) that
 * session-lifecycle fires.
 *
 * WHY a factory: the agent-handoff node (flow `handoff`) continues the SAME call
 * under a DIFFERENT published agent. That target has its OWN config/flow/tools,
 * so it needs its own full flow runtime built against the same live session and
 * the same shared per-call state (transcript, contactState, tags, usage). main.ts
 * calls this once for the call's own agent; flow/handoff calls it again per
 * handoff, carrying the conversation context into the target's entry agent.
 */

/** Call-wide state shared across every assembled agent on one call — the same
 * references thread through handoffs so the transcript, known-contact data, tag
 * set, rolling summary and usage all stay continuous. */
export interface AssembleShared {
	job: JobContext;
	/** The ORIGINAL call dispatch (callId, projectId, variables). Per-target
	 * agentId/agentVersion are passed via AssembleParams.dispatch. */
	dispatch: DispatchMetadata;
	variables: Record<string, string>;
	turns: Turn[];
	contactState: ContactStateEntryT[];
	contactTags: Set<string>;
	rollingSummary: { text: string };
	state: FlowRuntimeState;
	EMPTY_PARAMS: JSONSchema7;
}

export interface AssembleParams {
	bundle: AgentBundle;
	/** Dispatch for THIS agent (target agentId/agentVersion swapped in on handoff;
	 * same callId/projectId/variables/metadata/contactState/tags/channel). */
	dispatch: DispatchMetadata;
	/** The handoff controller — assembled flow modules call it when a `handoff`
	 * node is reached. Shared across the whole call (holds the handoff counter). */
	handoff: Handoff;
	/** Carried conversation context for the entry agent (excludeInstructions
	 * copy). Present on a handoff so the caller isn't re-greeted; omitted for the
	 * call's first agent (fresh session). */
	entryChatCtx?: llm.ChatContext;
}

export interface AssembledAgent {
	agent: voice.Agent;
	config: AgentConfig;
	/** Fired after each caller turn (objective judging) — absent for a
	 * single-agent (no-flow) config. */
	objectiveUserTurnHook?: () => void;
	/** Fired after each caller turn (rolling-summary refresh) — absent for a
	 * single-agent config or when memory is disabled. */
	memoryUserTurnHook?: () => void;
}

export function assembleAgent(shared: AssembleShared, params: AssembleParams): AssembledAgent {
	const { job: ctx, variables, turns, contactState, contactTags, rollingSummary, state, EMPTY_PARAMS } = shared;
	const { bundle, dispatch, handoff, entryChatCtx } = params;
	const config: AgentConfig = bundle.agent.config;

	const endCallEnabled = config.endCall?.enabled !== false;
	const memory = {
		enabled: config.memory?.enabled !== false,
		intervalTurns: config.memory?.intervalTurns ?? 10,
		windowTurns: config.memory?.windowTurns ?? 20,
		model: config.memory?.model,
	};
	const models: ResolvedModels = config.models ?? {};

	// Global blocks shared by every node/agent (inherited so node prompts stay lean).
	const globalInstructions = interpolate(config.instructions, variables);
	const prohibited =
		(config.prohibitedWords ?? []).length > 0
			? `\n\n## PROHIBITED WORDS\nNever say any of these words or phrases, in any form: ${config.prohibitedWords!.join(", ")}.`
			: "";
	const endCallGuidance = endCallEnabled
		? "\n\nOnly the end_call tool actually ends the call — and only at the true end of the conversation: purpose complete (or the caller asked to stop), they need nothing else, and you've said a brief goodbye. Never call it early or after a single short reply."
		: "";
	const pacingRules =
		"\n\n## PACING\nThis is a live phone call: ask at most ONE question per reply, then stop and wait for the caller to answer. Never ask a follow-up question in the same reply, never assume or invent an answer the caller has not actually said, and never save a value with a tool unless the caller explicitly provided it. After a tool returns, if you still need information from the caller, ask your single next question and wait.";

	const missingVars = new Set<string>();
	collectMissingVars(config.instructions, variables, missingVars);
	collectMissingVars(config.greeting, variables, missingVars);
	for (const n of config.flow?.nodes ?? []) {
		collectMissingVars(n.instructions, variables, missingVars);
		collectMissingVars(n.entryInstructions, variables, missingVars);
		collectMissingVars(n.statement?.say, variables, missingVars);
	}
	const missingNote =
		missingVars.size > 0
			? `\n\n## MISSING CONTEXT\nThese context values were NOT provided for this call: ${[...missingVars].join(", ")}. Their {{placeholders}} may appear in your notes — NEVER say a placeholder token aloud. Speak naturally without the value, and if you genuinely need it (like the caller's name or their property address), simply ask the caller.`
			: "";

	const instructions = globalInstructions + pacingRules + endCallGuidance + missingNote + prohibited;

	const endCallTool = llm.tool({
		description:
			"Hang up the phone. Use ONLY when the conversation is fully over: you completed the purpose of the call, the caller confirmed they need nothing else, and you already said goodbye. Never use it early in the call or in reaction to a short, unclear, or ambiguous remark.",
		parameters: EMPTY_PARAMS,
		execute: async (_args, { ctx: runCtx }) => {
			const userTurns = turns.filter((t) => t.role === "user").length;
			if (userTurns < 2) {
				return {
					error: "too_early",
					message:
						"The conversation just started — do not hang up. Continue helping the caller and only end the call once its purpose is complete and the caller confirms they need nothing else.",
				};
			}
			await runCtx.waitForPlayout().catch(() => {});
			await state.hangUp("agent_hangup");
			return "call ended";
		},
	});

	const buildLlm = (over?: { model?: string; temperature?: number; maxTokens?: number }) =>
		new inference.LLM({
			model: inferenceModel(over?.model ?? config.llm.model, "xai", "xai/grok-4-fast"),
			modelOptions: {
				temperature: over?.temperature ?? config.llm.temperature,
				max_completion_tokens: over?.maxTokens ?? config.llm.maxTokens,
			},
		});
	const defaultLlm = buildLlm({ model: models.respond });

	if (!config.flow) {
		// Single agent (no flow). On a handoff the carried chatCtx keeps the
		// conversation continuous (no re-greeting); the call's first agent gets none.
		const tools = buildTools(bundle.tools, dispatch);
		if (endCallEnabled) tools.end_call = endCallTool;
		const agent = new voice.Agent({
			instructions,
			llm: defaultLlm,
			tools,
			...(entryChatCtx ? { chatCtx: entryChatCtx } : {}),
		});
		return { agent, config };
	}

	const flow = config.flow;
	const nodesById = new Map(flow.nodes.map((n) => [n.id, n]));
	const fieldWriteDef = findToolDef(bundle.tools, config.fieldWriteToolId ?? "update_contact");
	const tagWriteDef = findToolDef(bundle.tools, config.tagWriteToolId ?? "add_tag");
	const tagRemoveDef = findToolDef(bundle.tools, config.tagRemoveToolId ?? "remove_tag");
	const resolveToolDef = (toolId: string | undefined, fallback: typeof fieldWriteDef) =>
		findToolDef(bundle.tools, toolId) ?? fallback;

	const flowCtx: FlowRuntimeContext = {
		job: ctx,
		dispatch,
		config,
		bundle,
		variables,
		endCallEnabled,
		flow,
		nodesById,
		turns,
		contactState,
		contactTags,
		rollingSummary,
		memory,
		get session() {
			return state.session!;
		},
		hangUp: (reason: string) => state.hangUp(reason),
		isCompleted: () => state.completed,
		state,
		interpolate: (t: string) => interpolate(t, variables),
		interpolateSpoken: (t: string) => interpolateSpoken(t, variables),
		buildLlm,
		defaultLlm,
		buildTts,
		recordUsage: (cls, inTok, outTok) => state.usage.record(cls, inTok, outTok),
		models,
		globalInstructions,
		pacingRules,
		missingNote,
		prohibited,
		fieldWriteDef,
		tagWriteDef,
		tagRemoveDef,
		resolveToolDef,
		endCallTool,
		EMPTY_PARAMS,
	};

	// Wire the flow modules against this config. The handoff controller is shared
	// across the whole call; the other modules are fresh per assembled agent.
	const { resolveTarget } = createRouter(flowCtx);
	let objectivesTracker: ObjectivesTracker;
	const { startTransfer, runTransfer } = createTransfer(flowCtx, {
		resolveTarget,
		buildFlowAgent: (id, chatCtx) => buildFlowAgent(id, chatCtx),
		startHandoff: handoff.startHandoff,
	});
	const { buildFlowAgent } = createAgentBuilder(flowCtx, {
		resolveTarget,
		runTransfer,
		runHandoff: handoff.runHandoff,
		getObjectivesTracker: () => objectivesTracker,
	});
	objectivesTracker = createObjectivesTracker({
		dispatch,
		turns,
		contactState,
		get session() {
			return state.session!;
		},
		buildLlm,
		fieldWriteDef,
		resolveTarget,
		buildFlowAgent,
		startTransfer,
		startHandoff: handoff.startHandoff,
		hangUp: (reason: string) => state.hangUp(reason),
		isCompleted: () => state.completed,
		judgeModel: models.judge,
		recordUsage: (inTok, outTok) => state.usage.record("judge", inTok, outTok),
	});
	const objectiveUserTurnHook = () => objectivesTracker.onUserTurn();

	let memoryUserTurnHook: (() => void) | undefined;
	if (memory.enabled) {
		const memoryTracker = createMemoryTracker({
			dispatch,
			turns,
			rollingSummary,
			memory,
			buildLlm,
			getSession: () => state.session,
			summaryModel: models.summary,
			recordUsage: (inTok, outTok) => state.usage.record("summary", inTok, outTok),
		});
		memoryUserTurnHook = () => memoryTracker.onUserTurn();
	}

	const agent = buildFlowAgent(flow.entry, entryChatCtx);
	return { agent, config, objectiveUserTurnHook, memoryUserTurnHook };
}
