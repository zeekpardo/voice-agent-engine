import { fileURLToPath } from "node:url";
import { ServerOptions, cli, defineAgent } from "@livekit/agents";
import type { JSONSchema7 } from "json-schema";
import { env } from "./env.js";
import {
	type AgentConfig,
	type DispatchMetadata,
	fetchAgentBundle,
	resolveInbound,
} from "./gateway.js";
import {
	type FlowRuntimeState,
	type Turn,
	createUsageRecorder,
	interpolate,
	interpolateSpoken,
} from "./flow/context.js";
import { type AssembleShared, assembleAgent } from "./flow/assemble.js";
import { createHandoff } from "./flow/handoff.js";
import { startSession } from "./session-lifecycle.js";

/**
 * agent-worker — the media plane (spec §7).
 *
 * One deployed worker binary serves every project and every agent. Per job:
 * parse DispatchMetadata → fetch the pinned agent config from the gateway →
 * interpolate {{variables}} → assemble an AgentSession (LiveKit Inference,
 * all-xAI by default) → run the conversation with tools-as-webhooks → flush
 * transcript + usage to the gateway, which fans out call.completed.
 *
 * This file is the orchestrator: it parses the dispatch, fetches config, holds
 * the call-wide shared state, and delegates the (per-config) agent assembly to
 * flow/assemble — reused verbatim when a `handoff` node continues the same call
 * under a DIFFERENT published agent (flow/handoff). session-lifecycle then runs
 * the call.
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
			// Concurrency cap reached (multi-account plan §2): the gateway created no
			// call and no bundle. End the call gracefully — leaving the room lets
			// LiveKit tear it down (the SaaS reacts to the call.rejected_capacity event).
			if ("rejected" in resolved) {
				console.warn(
					`agent-worker: inbound rejected (${resolved.rejected}, blockedBy=${resolved.blockedBy}); ending call`,
				);
				return;
			}
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
		// Session channel (Phase 6): voice (default) or text. Selects the worker's
		// I/O adapter in session-lifecycle; the assembled flow runtime is identical.
		const channel = dispatch.channel ?? "voice";
		// Per-call known-contact data (Phase 1). A mutable copy carried across any
		// agent handoff so a field written under one agent shows in the next.
		const contactState = dispatch.contactState ? [...dispatch.contactState] : [];
		// Per-call tag set (Phase 5b). Seeded from dispatch contactTags; carried
		// across handoffs and grown/pruned as modify_tags nodes run.
		const contactTags = new Set<string>(dispatch.contactTags ?? []);
		// Rolling in-call memory (Phase 3) holder — shared across handoffs so the
		// condensed record of the call stays continuous when agents swap.
		const rollingSummary = { text: "" };

		// The spoken greeting (call start only — a handoff never re-greets). All
		// other model/prompt assembly lives in flow/assemble (built per config, so
		// a handed-off target rebuilds its own prompt).
		// generate=true: keep {{placeholders}} visible (interpolate) so the model,
		// which generates the opener from this DIRECTION, sees them like any other
		// direction. Verbatim (default): interpolateSpoken strips unknowns for TTS.
		const greetingGenerate = config.greetingGenerate === true;
		const greeting = config.greeting
			? greetingGenerate
				? interpolate(config.greeting, variables)
				: interpolateSpoken(config.greeting, variables)
			: undefined;

		// Shared, mutable runtime slots. session-lifecycle installs the real
		// session / hangUp and flips `completed`; the flow modules read these lazily.
		const turns: Turn[] = [];
		const state: FlowRuntimeState = {
			session: undefined,
			hangUp: async () => {},
			completed: false,
			transferInFlight: false,
			transitionPending: false,
			currentNodeTerminal: true,
			endCallRefusalCount: 0,
			ttsOverride: undefined,
			conversationTimer: undefined,
			usage: createUsageRecorder(),
			// Populated below for the call's own agent; re-pointed by flow/handoff
			// to the target's trackers on each agent handoff.
			turnHooks: {},
			// Grows as objective/set_field writes capture values this call (in-call
			// carryover memory); shared across handoffs so the target doesn't re-ask.
			capturedFields: new Set<string>(),
		};

		const EMPTY_PARAMS = {
			type: "object",
			properties: {},
			additionalProperties: false,
		} as JSONSchema7;

		// 3. Call-wide state shared by EVERY assembled agent on this call — the
		//    call's own agent plus any agent it hands off to. The same references
		//    thread through handoffs so the transcript, contact data, tags, rolling
		//    summary and usage all stay continuous across the agent swap.
		const shared: AssembleShared = {
			job: ctx,
			dispatch,
			variables,
			turns,
			contactState,
			contactTags,
			rollingSummary,
			state,
			EMPTY_PARAMS,
		};

		// Agent-handoff controller (flow `handoff` node) — created once, shared
		// across the whole call (it holds the loop guard). Assembled agents call it
		// when a handoff node is reached; it fetches the target config, builds+swaps
		// its entry agent, and re-points state.turnHooks.
		const handoff = createHandoff(shared);

		// 4. Assemble the call's own agent: a flow config runs as a graph of small
		//    agents (one per node, gated tools, connected by exit tools); without a
		//    flow it's the classic single agent. flow/assemble also wires the
		//    per-caller-turn hooks (objective judge + rolling memory).
		const assembled = assembleAgent(shared, { bundle, dispatch, handoff });
		state.turnHooks.objective = assembled.objectiveUserTurnHook;
		state.turnHooks.memory = assembled.memoryUserTurnHook;

		// Hand off to session-lifecycle: build the AgentSession, wire the event
		// handlers + engine timers, go live, and speak the disclosure + greeting.
		await startSession({
			job: ctx,
			config,
			dispatch,
			turns,
			state,
			agent: assembled.agent,
			greeting,
			greetingGenerate,
			isInbound: !!rawMetadata.inbound,
			channel,
		});
	},
});

cli.runApp(
	new ServerOptions({
		agent: fileURLToPath(import.meta.url),
		agentName: env.AGENT_NAME,
	}),
);
