import { fileURLToPath } from "node:url";
import { ServerOptions, cli, defineAgent, inference, llm, voice } from "@livekit/agents";
import type { JSONSchema7 } from "json-schema";
import { env } from "./env.js";
import {
	type AgentConfig,
	type DispatchMetadata,
	fetchAgentBundle,
	resolveInbound,
} from "./gateway.js";
import {
	type FlowRuntimeContext,
	type FlowRuntimeState,
	type ResolvedModels,
	type Turn,
	buildTts,
	collectMissingVars,
	createUsageRecorder,
	findToolDef,
	inferenceModel,
	interpolate,
	interpolateSpoken,
} from "./flow/context.js";
import { createAgentBuilder } from "./flow/agent-builder.js";
import { createMemoryTracker } from "./flow/memory.js";
import { type ObjectivesTracker, createObjectivesTracker } from "./flow/objectives.js";
import { createRouter } from "./flow/router.js";
import { createTransfer } from "./flow/transfer.js";
import { startSession } from "./session-lifecycle.js";
import { buildTools } from "./tools.js";

/**
 * agent-worker — the media plane (spec §7).
 *
 * One deployed worker binary serves every project and every agent. Per job:
 * parse DispatchMetadata → fetch the pinned agent config from the gateway →
 * interpolate {{variables}} → assemble an AgentSession (LiveKit Inference,
 * all-xAI by default) → run the conversation with tools-as-webhooks → flush
 * transcript + usage to the gateway, which fans out call.completed.
 *
 * This file is the orchestrator: it parses the dispatch, fetches config,
 * assembles the shared prompt fragments, and wires the flow modules
 * (flow/router, flow/transfer, flow/agent-builder, flow/objectives) behind a
 * single FlowRuntimeContext, then hands off to session-lifecycle to run the
 * call. The pure helpers and the context type live in flow/context.ts.
 */

export default defineAgent({
	entry: async (ctx) => {
		await ctx.connect();

		// 1. Identify the call. Web/outbound jobs carry full DispatchMetadata;
		//    inbound SIP jobs carry {"inbound":true} from the dispatch rule and
		//    are resolved against the gateway's number registry.
		let dispatch: DispatchMetadata;
		let bundle: Awaited<ReturnType<typeof fetchAgentBundle>>;
		const rawMetadata = JSON.parse(ctx.job.metadata || "{}") as Partial<DispatchMetadata> & {
			inbound?: boolean;
		};

		if (rawMetadata.inbound || !rawMetadata.callId) {
			const caller = await ctx.waitForParticipant();
			const toNumber = caller.attributes["sip.trunkPhoneNumber"] ?? "";
			const fromNumber = caller.attributes["sip.phoneNumber"] ?? "unknown";
			if (!toNumber) {
				console.error("agent-worker: inbound job without SIP attributes, refusing");
				return;
			}
			const resolved = await resolveInbound({
				to_number: toNumber,
				from_number: fromNumber,
				room_name: ctx.room.name ?? "",
			});
			bundle = resolved;
			dispatch = {
				projectId: resolved.agent.project,
				agentId: resolved.agent.id,
				agentVersion: resolved.agent.version,
				callId: resolved.call_id,
				variables: { caller_number: fromNumber },
				metadata: { direction: "inbound", from_number: fromNumber },
			};
		} else {
			dispatch = rawMetadata as DispatchMetadata;
			// 2. Config fetch (cached ~60s; pinned to the version the call started with).
			bundle = await fetchAgentBundle(dispatch.agentId, dispatch.agentVersion);
		}
		const config: AgentConfig = bundle.agent.config;
		const variables = dispatch.variables ?? {};
		const endCallEnabled = config.endCall?.enabled !== false;
		// Per-call known-contact data (Phase 1). A mutable copy: successful field
		// writes (objectives / set_field) upsert into it so the next node's prompt
		// rebuild reflects the new value. Never re-fetched mid-call.
		const contactState = dispatch.contactState ? [...dispatch.contactState] : [];
		// Rolling in-call memory (Phase 3). Resolve config.memory with defaults —
		// ON unless explicitly disabled. `rollingSummary` is a stable-reference
		// mutable holder shared into agent-builder (renders it) and memory.ts (writes it).
		const memory = {
			enabled: config.memory?.enabled !== false,
			intervalTurns: config.memory?.intervalTurns ?? 10,
			windowTurns: config.memory?.windowTurns ?? 20,
			model: config.memory?.model,
		};
		const rollingSummary = { text: "" };

		// Per-class model tiers (Phase 4). Each defaults to today's behavior:
		// respond → config.llm.model (buildLlm's own default), judge → grok-4-fast,
		// summary → config.memory.model then grok-4-fast, router → config.llm.model.
		// A tier is only the DEFAULT for its class — per-node overrides still win.
		const models: ResolvedModels = config.models ?? {};

		// Global blocks shared by every node/agent (CloseBot "Job Information"
		// + "Prohibited Words"): the root instructions are written ONCE and
		// inherited everywhere, so node prompts stay lean stage instructions.
		const globalInstructions = interpolate(config.instructions, variables);
		const prohibited =
			(config.prohibitedWords ?? []).length > 0
				? `\n\n## PROHIBITED WORDS\nNever say any of these words or phrases, in any form: ${config.prohibitedWords!.join(", ")}.`
				: "";
		const endCallGuidance = endCallEnabled
			? "\n\nOnly the end_call tool actually ends the call — and only at the true end of the conversation: purpose complete (or the caller asked to stop), they need nothing else, and you've said a brief goodbye. Never call it early or after a single short reply."
			: "";

		// Anti-barreling rules, inherited by every agent (flow node or single):
		// without them, checklist-style stage instructions get executed as one
		// long turn — the model asks a question, invents the answer, and moves
		// on without the caller ever speaking.
		const pacingRules =
			"\n\n## PACING\nThis is a live phone call: ask at most ONE question per reply, then stop and wait for the caller to answer. Never ask a follow-up question in the same reply, never assume or invent an answer the caller has not actually said, and never save a value with a tool unless the caller explicitly provided it. After a tool returns, if you still need information from the caller, ask your single next question and wait.";

		// Graceful handling of unresolved {{variables}}: scan every template up
		// front; spoken text strips them (interpolateSpoken), model-facing text
		// keeps the tokens but gets this block explaining how to work around
		// the missing values.
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
		const greeting = config.greeting ? interpolateSpoken(config.greeting, variables) : undefined;

		// Shared, mutable runtime slots. session-lifecycle installs the real
		// session / hangUp and flips `completed`; the flow modules read these
		// lazily. transferInFlight / ttsOverride are written by flow/transfer.
		const turns: Turn[] = [];
		const state: FlowRuntimeState = {
			session: undefined,
			hangUp: async () => {},
			completed: false,
			transferInFlight: false,
			ttsOverride: undefined,
			conversationTimer: undefined,
			usage: createUsageRecorder(),
		};

		const EMPTY_PARAMS = {
			type: "object",
			properties: {},
			additionalProperties: false,
		} as JSONSchema7;

		const endCallTool = llm.tool({
			description:
				"Hang up the phone. Use ONLY when the conversation is fully over: you completed the purpose of the call, the caller confirmed they need nothing else, and you already said goodbye. Never use it early in the call or in reaction to a short, unclear, or ambiguous remark.",
			parameters: EMPTY_PARAMS,
			execute: async (_args, { ctx: runCtx }) => {
				// Code-level backstop against over-eager models: a real
				// conversation has at least a couple of caller turns.
				const userTurns = turns.filter((t) => t.role === "user").length;
				if (userTurns < 2) {
					return {
						error: "too_early",
						message:
							"The conversation just started — do not hang up. Continue helping the caller and only end the call once its purpose is complete and the caller confirms they need nothing else.",
					};
				}
				// Let the goodbye spoken before this tool call finish playing.
				// A caller hanging up mid-goodbye aborts the playout wait — that
				// must not fail the tool; proceed straight to the hangup flush.
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
		// Respond tier (Phase 4): the responder the caller hears. models.respond
		// overrides config.llm.model; unset → buildLlm's own config.llm.model default.
		// Per-node node.llm still wins (agent-builder builds those separately).
		const defaultLlm = buildLlm({ model: models.respond });

		// 3. Assemble the active agent. A flow config runs as a graph of small
		//    agents — one per node, each with its own instructions and gated
		//    tools — connected by exit tools that hand the session off to the
		//    next node (context carried over, previous node's prompt dropped).
		//    Without a flow, it's the classic single agent.
		let agent: voice.Agent;
		// Set by the flow branch when objective-driven nodes exist; invoked from
		// the session's ConversationItemAdded listener on every caller turn.
		let objectiveUserTurnHook: (() => void) | undefined;
		// Set by the flow branch when rolling memory is enabled; a second
		// per-caller-turn hook alongside objectiveUserTurnHook.
		let memoryUserTurnHook: (() => void) | undefined;

		if (config.flow) {
			const flow = config.flow;
			const nodesById = new Map(flow.nodes.map((n) => [n.id, n]));
			// Engine neutrality: the write tools are named by the config, not
			// hardcoded. Defaults preserve pre-existing configs (see agent-config.ts).
			const fieldWriteDef = findToolDef(bundle.tools, config.fieldWriteToolId ?? "update_contact");
			const tagWriteDef = findToolDef(bundle.tools, config.tagWriteToolId ?? "add_tag");
			const resolveToolDef = (toolId: string | undefined, fallback: typeof fieldWriteDef) =>
				findToolDef(bundle.tools, toolId) ?? fallback;

			// One shared context threaded into every flow module. Values built
			// after this point (session, hangUp, completion) are reached lazily
			// via the getters / the shared `state` holder.
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
				rollingSummary,
				memory,
				get session() {
					// Constructed by session-lifecycle (after the flow wiring);
					// only read at call time, never during wiring.
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
				resolveToolDef,
				endCallTool,
				EMPTY_PARAMS,
			};

			// Wire the flow modules. They reference each other through explicit
			// deps; the two forward references (transfer → buildFlowAgent,
			// agent-builder → objectivesTracker) are only invoked at call time,
			// by which point every binding is initialized.
			const { resolveTarget } = createRouter(flowCtx);
			let objectivesTracker: ObjectivesTracker;
			const { startTransfer, runTransfer } = createTransfer(flowCtx, {
				resolveTarget,
				buildFlowAgent: (id, chatCtx) => buildFlowAgent(id, chatCtx),
			});
			const { buildFlowAgent } = createAgentBuilder(flowCtx, {
				resolveTarget,
				runTransfer,
				getObjectivesTracker: () => objectivesTracker,
			});
			objectivesTracker = createObjectivesTracker({
				dispatch,
				turns,
				contactState,
				// Accessed lazily: the AgentSession isn't constructed until
				// session-lifecycle runs, after this wiring.
				get session() {
					return state.session!;
				},
				buildLlm,
				fieldWriteDef,
				resolveTarget,
				buildFlowAgent,
				startTransfer,
				hangUp: (reason: string) => state.hangUp(reason),
				isCompleted: () => state.completed,
				// Judge tier (Phase 4): default judge model; per-node node.judge still wins.
				judgeModel: models.judge,
				recordUsage: (inTok, outTok) => state.usage.record("judge", inTok, outTok),
			});
			objectiveUserTurnHook = () => objectivesTracker.onUserTurn();

			// Rolling memory (Phase 3): a second per-caller-turn hook alongside the
			// objective judge. Summary generation is fully async and never blocks
			// speech; its standalone summary-call usage folds into state.auxUsage,
			// which session-lifecycle adds to the completion meters.
			if (memory.enabled) {
				const memoryTracker = createMemoryTracker({
					dispatch,
					turns,
					rollingSummary,
					memory,
					buildLlm,
					getSession: () => state.session,
					// Summary tier (Phase 4): memory.model wins, then models.summary, then grok-4-fast.
					summaryModel: models.summary,
					recordUsage: (inTok, outTok) => state.usage.record("summary", inTok, outTok),
				});
				memoryUserTurnHook = () => memoryTracker.onUserTurn();
			}

			agent = buildFlowAgent(flow.entry);
		} else {
			const tools = buildTools(bundle.tools, dispatch);
			if (endCallEnabled) tools.end_call = endCallTool;
			agent = new voice.Agent({
				instructions,
				llm: defaultLlm,
				tools,
			});
		}

		// Hand off to session-lifecycle: build the AgentSession, wire the event
		// handlers + engine timers, go live, and speak the disclosure + greeting.
		await startSession({
			job: ctx,
			config,
			dispatch,
			turns,
			state,
			agent,
			greeting,
			isInbound: !!rawMetadata.inbound,
			objectiveUserTurnHook,
			memoryUserTurnHook,
		});
	},
});

cli.runApp(
	new ServerOptions({
		agent: fileURLToPath(import.meta.url),
		agentName: env.AGENT_NAME,
	}),
);
