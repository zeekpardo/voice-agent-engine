import type { JobContext } from "@livekit/agents";
import { inference, llm, voice } from "@livekit/agents";
import { LLM as AnthropicLLM } from "@livekit/agents-plugin-anthropic";
import type { JSONSchema7 } from "json-schema";
import { env } from "../env.js";
import { type AgentBundle, type AgentConfig, type ContactStateEntryT, type DispatchMetadata, reportEvent } from "../gateway.js";
import { buildTools } from "../tools.js";
import { createAgentBuilder } from "./agent-builder.js";
import {
	type FlowRuntimeContext,
	type FlowRuntimeState,
	type ResolvedModels,
	type Turn,
	anthropicRespondModel,
	buildTts,
	collectMissingVars,
	findToolDef,
	VOICE_RESPOND_DEFAULT_MODEL,
	inferenceModel,
	interpolate,
	interpolateSpoken,
	nodeResultVarName,
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
	/** Fired from the assembled ENTRY agent's onEnter — i.e. once its activity is
	 * actually live on the session. flow/handoff uses it to nudge the handed-off
	 * target to speak first: issuing generateReply right after updateAgent races
	 * the activity swap (the reply lands on the old, draining activity and is
	 * dropped), while onEnter runs inside the NEW activity's startup. Omitted for
	 * the call's first agent (the greeting covers the opening). */
	entryOnEnter?: () => void;
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
	const { bundle, dispatch, handoff, entryChatCtx, entryOnEnter } = params;
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
	// Default lead-and-vary conversational behavior, applied to EVERY generation
	// (voice + text) — independent of the optional per-agent responseStyle. Without
	// it a minimal responder templates every objective turn identically ("Thanks.
	// Could you tell me your <X>?"); this makes it acknowledge the last answer and
	// vary its phrasing like a real person leading the call. Model-agnostic; keeps
	// the hard PACING rules (one question, don't invent, don't announce stages) intact.
	const conversationStyle =
		'\n\n## CONVERSATIONAL STYLE\nSound like a warm, real person leading this call — not a form that reads off fields. Before you ask the next thing, briefly and SPECIFICALLY acknowledge what the caller just said (react to their actual answer), then lead naturally into your next question. Do NOT template your replies: never open consecutive replies with the same word (especially not "Thanks." every turn), and never reuse a fixed scaffold like "Could you tell me your ___". Vary your acknowledgements and sentence openers each turn, and weave the next question in conversationally instead of reciting the field name (e.g. "Perfect — and what city and zip is that in?", "Got it. Do you happen to know the square footage?"). Still ask only ONE thing per reply, never invent or assume an answer the caller did not give, and never announce stage changes.';
	// Premature-wrap-up guard (default-on, voice + text) — injected on every
	// NON-terminal flow node. The classic regression: an assistant-style model
	// (e.g. gpt-4o) treats the caller saying "that's all / nothing else" as
	// permission to end the intake, so it closes and loops goodbyes while stages
	// and objectives are still pending. This keeps the model LEADING until the flow
	// actually reaches its final stage. Model-agnostic; sits alongside (not over)
	// the hard PACING rules (one question, don't invent answers).
	const noEarlyWrapUp =
		'\n\n## KEEP LEADING — DO NOT WRAP UP YET\nThis intake is NOT finished — there are more stages and details still to cover. Until the flow reaches its final stage, you must NOT wrap up: never say goodbye, never thank-and-close, never ask "is there anything else" or "can I help with anything else", and never try to end the call. If the caller says "that\'s all", "nothing else", or "no more questions", that only answers your CURRENT question — it is NOT permission to end the intake, so keep going. Your job is to keep leading: ask this stage\'s next question until its goal is captured, then take the exit. Only the final stage closes the call and says goodbye.';
	// Mid-conversation language alignment, LLM leg. Unconditional, no config needed
	// (default-on for every agent). Voice gets the spoken wording; text/SMS gets a
	// writing-appropriate wording so the model mirrors whatever language the user
	// TYPES instead of defaulting to English or refusing other languages. On voice
	// the STT leg also lives in session-lifecycle's language aligner.
	const languageRules =
		shared.dispatch.channel === "text"
			? "\n\n## LANGUAGE\nDetect the language the user is writing in and ALWAYS reply in that same language. Support any language. If the user switches languages mid-conversation, switch with them immediately and continue in the new language, without commenting on the change. Only use English if the user is writing in English."
			: "\n\n## LANGUAGE\nAlways reply in the language the caller is currently speaking. If they switch languages mid-conversation, switch with them immediately — same voice, no comment about the change — and stay in the new language until they switch again.";
	// Text channel: the user TYPES their answers, so read-back confirmations that
	// make sense on a voice call (spelling out a phone number or email digit by
	// digit) are pointless and awkward. Suppress them on text only; voice keeps the
	// current read-back behavior (confirming critical fields aloud is correct there).
	const textRules =
		shared.dispatch.channel === "text"
			? "\n\n## TEXT CHAT\nThis is a text chat, not a phone call. The user TYPED their answers, so you already have their EXACT spelling — there is no transcription error to correct. NEVER phonetically spell out or read back a value character by character, digit by digit, or word by word (do NOT turn \"bmoore@gmail.com\" into \"b moore at g mail dot com\"). NEVER echo a phone number, email, or address back for confirmation, and do NOT ask the user to confirm ANY value they just typed — take typed values exactly as given. Skip voice-style read-back confirmations entirely; only re-ask when a value is genuinely missing or truly ambiguous."
			: "";
	// SMS/text-native message shaping (Phase 2). Text-channel only (voice untouched);
	// additive to responseStyle. Mirrors the convo-runner's TEXT_STYLE so the widget/
	// test text surface shapes replies the same way the omnichannel SMS path does.
	const textStyle =
		shared.dispatch.channel === "text"
			? '\n\n## TEXTING STYLE\nThis is a text message conversation. Keep replies short and conversational, like real texting — usually 1–3 short sentences. Don\'t use phone or IVR phrasing ("press 1", "stay on the line", "one moment"). No markdown formatting. Emojis are OK if the person uses them, sparingly. Never send a wall of text; if you must cover multiple points, keep it tight.'
			: "";

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
	// Per-agent phrasing/tone directive (distinct from persona identity): when set,
	// it rides on EVERY generated message so replies stay varied and natural.
	// Empty/unset → inject nothing, so existing agents talk exactly as before.
	const responseStyle =
		(config.responseStyle ?? "").trim().length > 0
			? `\n\n## RESPONSE STYLE\n${config.responseStyle!.trim()}`
			: "";

	const instructions =
		globalInstructions +
		pacingRules +
		conversationStyle +
		languageRules +
		textRules +
		textStyle +
		responseStyle +
		endCallGuidance +
		missingNote +
		prohibited;

	const endCallTool = llm.tool({
		description:
			"Hang up the phone. Use ONLY when the conversation is fully over: you completed the purpose of the call, the caller confirmed they need nothing else, and you already said goodbye. Never use it early in the call or in reaction to a short, unclear, or ambiguous remark.",
		parameters: EMPTY_PARAMS,
		execute: async (_args, { ctx: runCtx }) => {
			// Every refusal is observable (reason + nodeId + terminality) so a call that
			// won't end is diagnosable from events instead of guessed at from the loop.
			const refuse = (reason: string, message: string) => {
				reportEvent(dispatch.callId, "flow.end_call_refused", {
					reason,
					node: state.session?.currentAgent?.id ?? null,
					currentNodeTerminal: state.currentNodeTerminal,
					objectivesComplete: state.currentNodeObjectivesComplete ?? false,
				});
				return { error: reason, message };
			};
			const userTurns = turns.filter((t) => t.role === "user").length;
			if (userTurns < 2) {
				return refuse(
					"too_early",
					"The conversation just started — do not hang up. Continue helping the caller and only end the call once its purpose is complete and the caller confirms they need nothing else.",
				);
			}
			// Mixed-turn guard: models emit end_call IN THE SAME TURN as an exit /
			// transfer / handoff tool (parallel tool calls), which would kill the
			// call mid-transition (observed live: the flow exited to its next node
			// and end_call hung up before the node ever entered). Refuse while a
			// transfer is in flight, while an exit to a real next node is committed
			// but not yet entered (transitionPending — covers the objectives judge's
			// idle-wait, where the lastTransitionAt window has long since lapsed), or
			// within a short window of any completed node swap.
			const sinceTransition = Date.now() - (state.lastTransitionAt ?? 0);
			if (state.transferInFlight || state.transitionPending || sinceTransition < 5000) {
				return refuse(
					"transition_in_progress",
					"The call just moved to a new stage — do not hang up. Continue the conversation at the current stage; only end the call after its purpose is complete and you've said goodbye.",
				);
			}
			// Terminal-node gate (the robust fix): the model repeatedly decides the
			// call is "done" mid-flow and hangs up while stages remain (observed live
			// on both a voice call at the transition and a text call a turn later).
			// end_call is only legitimate on a terminal node — one with no forward exit
			// to a next stage. On a non-terminal stage, refuse and steer the model to
			// take its exit instead. currentNodeTerminal defaults true, so a
			// single-agent (no-flow) config is unaffected. SECOND terminal signal: once
			// the current node's objectives are all met/skipped it is terminal-for-end_call
			// too, so a satisfied node whose transition somehow stalls can still close.
			if (state.currentNodeTerminal === false && state.currentNodeObjectivesComplete !== true) {
				// Goodbye-loop backstop: a model that keeps deciding the call is "done"
				// mid-flow emits end_call over and over. The FIRST refusal steers it (below,
				// unchanged). But if it just loops goodbyes, nothing advances and the line
				// hangs open until the caller gives up. Track consecutive refused end_calls
				// on the SAME non-terminal node; after the 2nd, AUTO-ADVANCE down this node's
				// forward exit (installed by buildFlowAgent onEnter) instead of refusing
				// again. The node/count reset on the next node's entry. Terminal nodes never
				// reach here (currentNodeTerminal===true → end_call succeeds), so autoAdvance
				// being set already means a forward exit exists.
				const nodeId = state.session?.currentAgent?.id ?? undefined;
				if (state.endCallRefusalNode === nodeId) {
					state.endCallRefusalCount += 1;
				} else {
					state.endCallRefusalNode = nodeId;
					state.endCallRefusalCount = 1;
				}
				if (state.endCallRefusalCount >= 2 && state.autoAdvance) {
					reportEvent(dispatch.callId, "flow.autoadvance_on_endcall", {
						node: nodeId ?? null,
						attempts: state.endCallRefusalCount,
					});
					// Fire the forward transition (async swap); return a steering string so
					// the model continues rather than hanging up. The counter is cleared when
					// the next node enters.
					void state.autoAdvance();
					return { message: "Moving on to the next part of the call now." };
				}
				return refuse(
					"not_terminal_stage",
					"There are more stages in this conversation — do not end the call. Take the appropriate exit to continue; only use end_call from the final stage, after you've said goodbye.",
				);
			}
			await runCtx.waitForPlayout().catch(() => {});
			await state.hangUp("agent_hangup");
			return "call ended";
		},
	});

	const buildLlm = (over?: {
		model?: string;
		temperature?: number;
		maxTokens?: number;
		/** Force strict JSON output (response_format json_object) — used by the
		 * objective judge so a truncation/format slip can't stall progression. */
		json?: boolean;
		/** Reasoning-model effort hint (gpt-5 family etc.). Off by default; the judge
		 * passes "minimal" on a reasoning model so reasoning tokens don't eat the
		 * completion budget. Ignored/omitted for non-reasoning models. */
		reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
	}) =>
		new inference.LLM({
			model: inferenceModel(over?.model ?? config.llm.model, "xai", "xai/grok-4-fast"),
			modelOptions: {
				temperature: over?.temperature ?? config.llm.temperature,
				max_completion_tokens: over?.maxTokens ?? config.llm.maxTokens,
				...(over?.json ? { response_format: { type: "json_object" } } : {}),
				...(over?.reasoningEffort ? { reasoning_effort: over.reasoningEffort } : {}),
			},
		});
	// The caller-facing respond LLM. On the TEXT channel with ANTHROPIC_API_KEY set
	// and no explicit config.models.respond override, run the reply on Claude via
	// the LiveKit Anthropic plugin (so widget/test text matches omnichannel Claude
	// quality); otherwise the current Inference path (grok / configured model).
	// VOICE never reaches this branch — the gate returns null off the text channel,
	// so buildVoiceChannel's flow is byte-for-byte unchanged. Temperature is NOT
	// passed (current Claude models reject non-default sampling), mirroring the
	// gateway's anthropicComplete. Judge/summary/router keep using buildLlm above.
	const claudeRespond = anthropicRespondModel(shared.dispatch.channel, config);
	// VOICE respond default (code-level, no config field): fall back to gpt-4o when
	// the agent sets no models.respond override. TEXT (non-Claude) keeps its legacy
	// default (config.llm.model via buildLlm) — passing undefined leaves it unchanged.
	const respondModelOverride =
		models.respond ?? (shared.dispatch.channel !== "text" ? VOICE_RESPOND_DEFAULT_MODEL : undefined);
	const defaultLlm: llm.LLM = claudeRespond
		? new AnthropicLLM({
				model: claudeRespond,
				apiKey: env.ANTHROPIC_API_KEY,
				...(config.llm.maxTokens ? { maxTokens: config.llm.maxTokens } : {}),
			})
		: buildLlm({ model: respondModelOverride });

	if (!config.flow) {
		// Single agent (no flow). On a handoff the carried chatCtx keeps the
		// conversation continuous (no re-greeting); the call's first agent gets none.
		const tools = buildTools(bundle.tools, dispatch);
		if (endCallEnabled) tools.end_call = endCallTool;
		// Agent.create (not the constructor) so a handed-off target can hook
		// onEnter — the nudge that makes it speak first (see AssembleParams).
		const agent = voice.Agent.create({
			instructions,
			llm: defaultLlm,
			tools,
			...(entryChatCtx ? { chatCtx: entryChatCtx } : {}),
			...(entryOnEnter ? { onEnter: () => entryOnEnter() } : {}),
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

	// Node-result variables (CloseBot "Nodes" Tier 1). Every node that becomes an
	// agent (kind "agent" — plain agent, objective, and conversation nodes) exposes
	// its outcome as {{node_<id>_result|attempts|succeeded}}. Pre-seed all of them to
	// "" so a FORWARD reference (a node reading a node that hasn't run yet)
	// interpolates to empty instead of leaving a raw {{token}} in the text — and so
	// they aren't flagged as MISSING CONTEXT. Values fill in as nodes complete.
	const nodeEntryTurns = new Map<string, number>();
	const userTurnCount = () => turns.filter((t) => t.role === "user").length;
	for (const n of flow.nodes) {
		if ((n.kind ?? "agent") !== "agent") continue;
		variables[nodeResultVarName(n.id, "result")] ??= "";
		variables[nodeResultVarName(n.id, "attempts")] ??= "";
		variables[nodeResultVarName(n.id, "succeeded")] ??= "";
	}
	const markNodeEntry = (nodeId: string) => {
		nodeEntryTurns.set(nodeId, userTurnCount());
	};
	const recordNodeResult = (nodeId: string, fields: { result?: string; succeeded?: boolean }) => {
		if (fields.result !== undefined) variables[nodeResultVarName(nodeId, "result")] = fields.result;
		if (fields.succeeded !== undefined) {
			variables[nodeResultVarName(nodeId, "succeeded")] = fields.succeeded ? "true" : "false";
		}
		const base = nodeEntryTurns.get(nodeId);
		const attempts = base === undefined ? userTurnCount() : Math.max(0, userTurnCount() - base);
		variables[nodeResultVarName(nodeId, "attempts")] = String(attempts);
	};

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
		markNodeEntry,
		recordNodeResult,
		buildLlm,
		defaultLlm,
		buildTts,
		recordUsage: (cls, inTok, outTok) => state.usage.record(cls, inTok, outTok),
		models,
		globalInstructions,
		pacingRules,
		conversationStyle,
		noEarlyWrapUp,
		languageRules,
		textRules,
		textStyle,
		responseStyle,
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
		buildParkedAgent: (chatCtx) => buildParkedAgent(chatCtx),
		startHandoff: handoff.startHandoff,
	});
	const { buildFlowAgent, buildParkedAgent } = createAgentBuilder(flowCtx, {
		resolveTarget,
		runTransfer,
		runHandoff: handoff.runHandoff,
		getObjectivesTracker: () => objectivesTracker,
		entryOnEnter,
		startTransfer,
		startHandoff: handoff.startHandoff,
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
		buildParkedAgent,
		startTransfer,
		startHandoff: handoff.startHandoff,
		hangUp: (reason: string) => state.hangUp(reason),
		isCompleted: () => state.completed,
		// Committed-transition flag: set the moment the judge decides to advance so
		// a same-turn (or idle-wait-window) end_call is refused; cleared on abort here
		// and by buildFlowAgent onEnter once the next node enters.
		setTransitionPending: (pending: boolean) => {
			state.transitionPending = pending;
		},
		judgeModel: models.judge,
		recordUsage: (inTok, outTok) => state.usage.record("judge", inTok, outTok),
		recordNodeResult,
		// No-progress backstop reset (installed by session-lifecycle) + terminal-for-
		// end_call flag once a node's objectives are satisfied.
		onProgress: () => state.onProgress?.(),
		setObjectivesComplete: (complete: boolean) => {
			state.currentNodeObjectivesComplete = complete;
		},
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
