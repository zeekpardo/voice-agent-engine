import { fileURLToPath } from "node:url";
import { ServerOptions, cli, defineAgent, inference, llm, voice } from "@livekit/agents";
import type { JSONSchema7 } from "json-schema";
import { env } from "./env.js";
import {
	type AgentConfig,
	type DispatchMetadata,
	type FlowObjective,
	fetchAgentBundle,
	reportCompletion,
	reportEvent,
	resolveInbound,
} from "./gateway.js";
import { buildTools, invokeTool } from "./tools.js";

/**
 * agent-worker — the media plane (spec §7).
 *
 * One deployed worker binary serves every project and every agent. Per job:
 * parse DispatchMetadata → fetch the pinned agent config from the gateway →
 * interpolate {{variables}} → assemble an AgentSession (LiveKit Inference,
 * all-xAI by default) → run the conversation with tools-as-webhooks → flush
 * transcript + usage to the gateway, which fans out call.completed.
 */

const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * {{variables}} → values. Unknown placeholders stay visible in MODEL-facing
 * text (instructions) — the model is told about them via the missing-context
 * block — but must never reach TTS verbatim: use interpolateSpoken for
 * anything spoken word-for-word.
 */
function interpolate(template: string, variables: Record<string, string>): string {
	return template.replace(VAR_RE, (whole, name: string) =>
		Object.hasOwn(variables, name) ? variables[name]! : whole,
	);
}

/**
 * For text spoken VERBATIM (greeting, statement lines): unresolved
 * placeholders are stripped and the sentence tidied, so the caller never
 * hears "curly brace seller underscore name".
 */
function interpolateSpoken(template: string, variables: Record<string, string>): string {
	return (
		template
			// Unknown placeholder swallows a directly preceding preposition too,
			// so "your property at {{address}}," reads "your property," instead
			// of "your property at,".
			.replace(
				/(\b(?:at|in|on|for|about|regarding|of|with)\s+)?\{\{\s*([\w.-]+)\s*\}\}/g,
				(_whole, prep: string | undefined, name: string) =>
					Object.hasOwn(variables, name) ? `${prep ?? ""}${variables[name]!}` : "",
			)
			.replace(/[ \t]+([,.!?;:])/g, "$1") // "Hi , this" → "Hi, this"
			.replace(/,\s*,/g, ",")
			.replace(/[ \t]{2,}/g, " ")
			.replace(/\(\s*\)/g, "")
			.trim()
	);
}

/** Variable names referenced by a template but absent from this call's variables. */
function collectMissingVars(template: string | undefined, variables: Record<string, string>, into: Set<string>): void {
	if (!template) return;
	for (const m of template.matchAll(VAR_RE)) {
		const name = m[1]!;
		if (!Object.hasOwn(variables, name)) into.add(name);
	}
}

/**
 * Agent configs use xAI's own model names (valid against the gateway's
 * /v1/chat proxy); LiveKit Inference uses its own catalog ids. Translate the
 * common ones; anything already namespaced ("vendor/model") passes through.
 */
const LLM_ALIASES: Record<string, string> = {
	"grok-4-fast": "xai/grok-4-1-fast-non-reasoning",
	"grok-4-1-fast": "xai/grok-4-1-fast-non-reasoning",
	"grok-4-1-fast-reasoning": "xai/grok-4-1-fast-reasoning",
};

function inferenceModel(model: string | undefined, provider: string, fallback: string): string {
	if (!model) return fallback;
	if (model.includes("/")) return model;
	return LLM_ALIASES[model] ?? `${provider}/${model}`;
}

const DEFAULT_DISCLOSURE = "Just so you know, you're speaking with an A.I. assistant.";

const TTS_PROVIDER_MODELS: Record<string, string> = {
	xai: "xai/tts-1",
	cartesia: "cartesia/sonic-3",
	elevenlabs: "elevenlabs/eleven_turbo_v2_5",
	deepgram: "deepgram/aura-2",
	rime: "rime/arcana",
	inworld: "inworld/inworld-tts-1",
};

/**
 * Build the TTS from config, forwarding speaking speed only to providers
 * whose inference API supports it — each with its own parameter semantics.
 * xAI/Deepgram have no speed parameter; the setting is ignored for them.
 */
function buildTts(tts: AgentConfig["tts"]) {
	const model = TTS_PROVIDER_MODELS[tts.provider] ?? "xai/tts-1";
	const speed = tts.speed ?? 1.0;
	let modelOptions: Record<string, unknown> | undefined;
	if (Math.abs(speed - 1) > 0.01) {
		if (tts.provider === "cartesia") {
			modelOptions = { speed: speed < 0.95 ? "slow" : speed > 1.05 ? "fast" : "normal" };
		} else if (tts.provider === "elevenlabs") {
			modelOptions = { speed };
		} else if (tts.provider === "rime") {
			// Rime's speed_alpha is inverted: <1 = faster, >1 = slower.
			modelOptions = { speed_alpha: Number((1 / speed).toFixed(2)) };
		} else if (tts.provider === "inworld") {
			modelOptions = { speaking_rate: speed };
		}
	}
	return new inference.TTS({
		model,
		voice: tts.voice,
		...(modelOptions ? { modelOptions } : {}),
	} as ConstructorParameters<typeof inference.TTS>[0]);
}

interface Turn {
	role: "agent" | "user" | "system";
	text: string;
	ts?: number;
}

interface RemoteLike {
	identity: string;
	attributes: Record<string, string>;
}

/**
 * Resolve true once the participant is live: web participants immediately
 * (no sip.callStatus attribute), SIP participants when the callee answers.
 * False on hangup-while-ringing or timeout.
 */
function waitForSipAnswer(
	ctx: { room: unknown },
	participant: RemoteLike,
	timeoutMs: number,
): Promise<boolean> {
	const status = () => participant.attributes["sip.callStatus"];
	if (!status()) return Promise.resolve(true); // not SIP (browser participant)
	if (status() === "active") return Promise.resolve(true);

	const room = ctx.room as {
		on(event: string, cb: (changed: unknown, p: RemoteLike) => void): void;
		off(event: string, cb: (changed: unknown, p: RemoteLike) => void): void;
	};
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve(false);
		}, timeoutMs);
		const onAttrs = (_changed: unknown, p: RemoteLike) => {
			if (p.identity !== participant.identity) return;
			const s = p.attributes["sip.callStatus"];
			if (s === "active") {
				cleanup();
				resolve(true);
			} else if (s === "hangup") {
				cleanup();
				resolve(false);
			}
		};
		const cleanup = () => {
			clearTimeout(timer);
			room.off("participantAttributesChanged", onAttrs);
		};
		room.on("participantAttributesChanged", onAttrs);
	});
}

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

		// Built-in hangup, shared by the end_call tool and the engine timers.
		// Reassigned once the session exists; tools/timers only fire after that.
		let hangUp: (reason: string) => Promise<void> = async () => {};
		const turns: Turn[] = [];

		// True while a simulated warm transfer (announcement + hold music) is
		// playing. Session-scoped (not flow-scoped) so the SpeechCreated guard
		// below can see it: while set, any LLM-generated speech is discarded.
		let transferInFlight = false;

		// Set by the flow branch when objective-driven nodes exist; invoked from
		// the session's ConversationItemAdded listener on every caller turn.
		let objectiveUserTurnHook: (() => void) | undefined;

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
				await hangUp("agent_hangup");
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
		const defaultLlm = buildLlm();

		// 3. Assemble the active agent. A flow config runs as a graph of small
		//    agents — one per node, each with its own instructions and gated
		//    tools — connected by exit tools that hand the session off to the
		//    next node (context carried over, previous node's prompt dropped).
		//    Without a flow, it's the classic single agent.
		let agent: voice.Agent;
		if (config.flow) {
			const flow = config.flow;
			const nodesById = new Map(flow.nodes.map((n) => [n.id, n]));
			const sanitize = (s: string) =>
				s
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "_")
					.replace(/^_+|_+$/g, "");

			// Simulated warm transfers ("transfer" nodes): the voice the caller
			// hears from the transfer onward. The sequence itself runs as a
			// detached chain (see followTarget) — announcement in the old voice,
			// hold music, then session.updateAgent() to the target. Returning an
			// llm.handoff from the exit tool does NOT work here: with a queued
			// say + parallel tool calls in the same turn the SDK drops the
			// handoff and keeps generating on the old agent.
			let ttsOverride: ReturnType<typeof buildTts> | undefined;
			let backgroundAudio: voice.BackgroundAudioPlayer | null = null;
			const ensureBackgroundAudio = async () => {
				if (!backgroundAudio) {
					backgroundAudio = new voice.BackgroundAudioPlayer();
					await backgroundAudio.start({ room: ctx.room, agentSession: session });
				}
				return backgroundAudio;
			};

			/**
			 * Where an exit lands after following routers/statements:
			 * - agent: hand the session off to this agent node
			 * - end: dead end (router chain ran out) — hang up now
			 * - end_after_speech: a terminal statement was queued; hangup is
			 *   already scheduled after its playout — do NOT hang up again.
			 */
			type ResolvedTarget =
				| { kind: "agent"; id: string }
				| { kind: "end" }
				| { kind: "end_after_speech" }
				| { kind: "transfer"; nodeId: string };

			/**
			 * Follow an exit's target through any router/statement nodes to the
			 * first AGENT node. Routers never speak: each one is a single
			 * standalone LLM evaluation over the transcript that picks an exit.
			 * Statements speak their fixed line (queued on the session) and
			 * immediately continue to their single exit — or, with no exit target,
			 * end the call once the line finishes playing.
			 */
			const resolveTarget = async (targetId: string | undefined): Promise<ResolvedTarget> => {
				let current = targetId;
				let hops = 0;
				while (current) {
					const node = nodesById.get(current);
					if (!node) throw new Error(`flow node "${current}" not found`);
					if (
						node.kind !== "router" &&
						node.kind !== "statement" &&
						node.kind !== "transfer" &&
						node.kind !== "set_field" &&
						node.kind !== "modify_tags"
					) {
						return { kind: "agent", id: current };
					}
					if (++hops > 5) {
						console.error(`flow: node chain exceeded 5 hops at node "${node.id}" — ending call`);
						return { kind: "end" };
					}

					if (node.kind === "transfer") {
						// Handled by followTarget as a detached timed sequence — never
						// inline: the announcement/music must play out AFTER the current
						// tool turn completes, and the agent switch must not ride a
						// tool-returned handoff (the SDK drops it in mixed-tool turns).
						return { kind: "transfer", nodeId: node.id };
					}

					// Deterministic CRM action nodes: fire the webhook(s) silently and
					// continue to the single exit — they never speak or wait.
					if (node.kind === "set_field") {
						reportEvent(dispatch.callId, "flow.node", {
							node: node.id,
							name: node.name ?? null,
							kind: "set_field",
						});
						const sf = node.setField;
						if (sf?.field && updateContactDef) {
							void invokeTool(updateContactDef, dispatch, {
								field_name: sf.field,
								value: interpolate(sf.value ?? "", variables),
							}).catch((err) => console.error(`flow: set_field "${sf.field}" failed`, err));
						}
						const exit = node.exits[0];
						reportEvent(dispatch.callId, "flow.exit", {
							node: node.id,
							exit: exit?.name ?? "end",
							target: exit?.target ?? null,
						});
						current = exit?.target;
						continue;
					}

					if (node.kind === "modify_tags") {
						reportEvent(dispatch.callId, "flow.node", {
							node: node.id,
							name: node.name ?? null,
							kind: "modify_tags",
						});
						const add = node.modifyTags?.add ?? [];
						if (add.length > 0 && addTagDef) {
							for (const tag of add) {
								void invokeTool(addTagDef, dispatch, { tag }).catch((err) =>
									console.error(`flow: modify_tags add "${tag}" failed`, err),
								);
							}
						}
						if ((node.modifyTags?.remove ?? []).length > 0) {
							console.warn(
								`flow: modify_tags node "${node.id}" requested tag removal, which is not wired yet`,
							);
						}
						const exit = node.exits[0];
						reportEvent(dispatch.callId, "flow.exit", {
							node: node.id,
							exit: exit?.name ?? "end",
							target: exit?.target ?? null,
						});
						current = exit?.target;
						continue;
					}

					if (node.kind === "statement") {
						reportEvent(dispatch.callId, "flow.node", {
							node: node.id,
							name: node.name ?? null,
							kind: "statement",
						});
						const handle = session.say(interpolateSpoken(node.statement?.say ?? "", variables));
						const exit = node.exits[0];
						reportEvent(dispatch.callId, "flow.exit", {
							node: node.id,
							exit: exit?.name ?? "end",
							target: exit?.target ?? null,
						});
						if (!exit?.target) {
							// Terminal statement: hang up once the line finishes playing.
							// NOT awaited — awaiting a queued speech's playout from inside
							// a tool execution risks the drain deadlock (see onEnter note).
							handle
								.waitForPlayout()
								.then(() => hangUp("flow_complete"))
								.catch((err) => console.error("flow: terminal statement playout failed", err));
							return { kind: "end_after_speech" };
						}
						current = exit.target;
						continue;
					}

					reportEvent(dispatch.callId, "flow.node", {
						node: node.id,
						name: node.name ?? null,
						kind: "router",
					});

					const fallbackExit =
						node.exits.find((e) => ["otherwise", "none", "default"].includes(e.name.toLowerCase())) ??
						node.exits[node.exits.length - 1]!;
					const transcript = turns
						.filter((t) => t.role !== "system")
						.slice(-40)
						.map((t) => `${t.role === "user" ? "caller" : "agent"}: ${t.text}`)
						.join("\n");

					const evalCtx = new llm.ChatContext();
					evalCtx.addMessage({
						role: "system",
						content:
							"You are routing a phone call. Given the conversation transcript, evaluate the statement/question and answer with EXACTLY one option name from the list — the option name only, nothing else.",
					});
					evalCtx.addMessage({
						role: "user",
						content: `Statement/question: ${node.router?.condition ?? ""}\n\nOptions:\n${node.exits
							.map((e) => `- ${e.name}: ${e.description}`)
							.join("\n")}\n\nConversation transcript:\n${transcript}`,
					});

					let chosen = fallbackExit;
					let decision = "";
					try {
						const evalLlm = node.llm ? buildLlm(node.llm) : defaultLlm;
						const res = await evalLlm.chat({ chatCtx: evalCtx }).collect();
						decision = res.text.trim();
						const lower = decision.toLowerCase();
						chosen =
							node.exits.find((e) => e.name.toLowerCase() === lower) ??
							node.exits.find((e) => lower.includes(e.name.toLowerCase())) ??
							fallbackExit;
					} catch (err) {
						console.error(`flow: router node "${node.id}" evaluation failed, using fallback exit`, err);
						decision = "evaluation_error";
					}
					reportEvent(dispatch.callId, "flow.exit", {
						node: node.id,
						exit: chosen.name,
						target: chosen.target ?? null,
						decision: decision.slice(0, 200),
					});
					current = chosen.target;
				}
				return { kind: "end" };
			};

			/**
			 * Shared tail of every exit tool (regular exits and scenario exits):
			 * resolve the target through routers/statements, then hand off, hang
			 * up, or let an already-scheduled post-speech hangup run its course.
			 */
			const followTarget = async (
				target: string | undefined,
				runCtx: voice.RunContext,
			): Promise<string | llm.AgentHandoff> => {
				// Routers/statements between here and the next agent node are
				// evaluated inline (routers: one LLM pass; statements: a queued say).
				const resolved = await resolveTarget(target);
				if (resolved.kind === "end") {
					// Abort-tolerant: caller may disconnect mid-playout (see end_call).
					await runCtx.waitForPlayout().catch(() => {});
					await hangUp("flow_complete");
					return "call ended";
				}
				if (resolved.kind === "end_after_speech") {
					// A terminal statement was queued and will hang up after playout —
					// do NOT hang up (or await playout) here: awaiting a queued
					// speech from inside a tool execution risks the drain deadlock.
					return "call ending";
				}
				if (resolved.kind === "transfer") {
					return runTransfer(resolved.nodeId);
				}
				const nextCtx = runCtx.session.currentAgent.chatCtx.copy({
					excludeInstructions: true,
				});
				return llm.handoff({
					agent: buildFlowAgent(resolved.id, nextCtx),
					returns: `Moved to stage "${nodesById.get(resolved.id)?.name ?? resolved.id}".`,
				});
			};

			/**
			 * Simulated warm transfer: the exit tool ends the LLM turn immediately
			 * (StopResponse — no tool reply, no further generation) while a
			 * detached chain speaks the announcement in the CURRENT voice, plays
			 * hold music, applies the new voice and switches agents via
			 * session.updateAgent — the one mechanism that survives mixed-tool
			 * turns. StopResponse only silences the turn when the exit was the
			 * sole tool call; with parallel tool calls (e.g. update_contact +
			 * exit) the SDK still generates a reply for the other tools' outputs
			 * — the SpeechCreated guard on the session discards those.
			 */
			const startTransfer = (nodeId: string): void => {
				const node = nodesById.get(nodeId);
				const t = node?.transfer;
				if (transferInFlight) return;
				transferInFlight = true;
				reportEvent(dispatch.callId, "flow.node", {
					node: nodeId,
					name: node?.name ?? null,
					kind: "transfer",
				});
				const exit = node?.exits[0];
				reportEvent(dispatch.callId, "flow.exit", {
					node: nodeId,
					exit: exit?.name ?? "end",
					target: exit?.target ?? null,
				});

				void (async () => {
					// Announcement in the pre-transfer voice; queued after any speech
					// already playing. Not interruptible — it's a system moment.
					if (t?.say) {
						const announce = session.say(interpolateSpoken(t.say, variables), {
							allowInterruptions: false,
						});
						await announce.waitForPlayout().catch(() => {});
					}
					const holdSeconds = Math.max(0, t?.holdSeconds ?? 4);
					if (holdSeconds > 0) {
						const player = await ensureBackgroundAudio();
						const music = player.play(
							{ source: voice.BuiltinAudioClip.HOLD_MUSIC, volume: 0.7 },
							true,
						);
						await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
						music.stop();
					}
					if (t?.voice) {
						ttsOverride = buildTts({
							provider: t.voice.provider,
							voice: t.voice.voice,
							speed: t.voice.speed ?? 1.0,
						});
					}
					// The transfer's onward wire may pass through routers/statements.
					const next = await resolveTarget(exit?.target);
					// Lift the speech guard BEFORE the switch: the next agent's
					// onEnter generateReply (and any statement say) is legitimate.
					transferInFlight = false;
					if (next.kind === "agent") {
						const nextCtx = session.currentAgent.chatCtx.copy({ excludeInstructions: true });
						session.updateAgent(buildFlowAgent(next.id, nextCtx));
					} else if (next.kind === "end") {
						await hangUp("flow_complete");
					}
					// end_after_speech: a terminal statement queued its own hangup.
					// A transfer chaining into another transfer is not supported.
				})()
					.catch((err) => console.error("flow: transfer sequence failed", err))
					.finally(() => {
						transferInFlight = false;
					});
			};

			/** Tool-call path into a transfer: start the sequence, then end the
			 * LLM turn with no tool reply — the model never gets a chance to keep
			 * talking over the transfer. Engine paths (objective transitions)
			 * call startTransfer directly; there is no LLM turn to stop. */
			const runTransfer = (nodeId: string): never => {
				startTransfer(nodeId);
				throw new voice.StopResponse();
			};

			// ------------------------------------------------------------ objectives
			// Objective-driven nodes (voiceagent-engine/objectives-and-conversation-spec.md).
			// The conversational LLM only talks; after every caller turn a cheap
			// judge pass rates each unmet objective ASYNC (never delaying speech),
			// auto-writes CRM fields via update_contact, and the ENGINE takes the
			// node's primary exit once every required objective is verified.
			interface ObjectiveProgress {
				met: boolean;
				rating?: number;
				answer?: string;
				/** Caller turns spent while this was the first unmet objective. */
				attempts: number;
				/** maxAttempts exhausted — stops gating the exit, stays unmet. */
				skipped: boolean;
			}
			interface ObjectiveRuntime {
				nodeId: string;
				exitName: string;
				target?: string;
				judge?: { model: string; temperature?: number };
				objectives: FlowObjective[];
				state: Map<string, ObjectiveProgress>;
				judging: boolean;
				rerun: boolean;
				transitioning: boolean;
			}
			let activeObjectives: ObjectiveRuntime | null = null;

			// Strict default: on a voice call a wrong "met" audibly advances (or
			// ends) the conversation. Per-objective `sensitivity` overrides it.
			const OBJECTIVE_RATING_THRESHOLD = 90;
			const objectiveThreshold = (o: FlowObjective): number =>
				Math.min(100, Math.max(10, o.sensitivity ?? OBJECTIVE_RATING_THRESHOLD));
			const OBJECTIVE_JUDGE_SYSTEM =
				'You evaluate whether data-collection objectives for a phone call have been satisfied by the conversation so far. Respond with ONLY a JSON object — no prose, no code fences — of the form {"checks":[{"key":"<objective key>","rating":<0-100>,"answer":"<extracted value or empty string>"}]}. Include one check per objective. rating is your confidence that the CALLER explicitly provided the information (100 = clearly provided, 0 = not provided at all). Extract answer from what the caller actually said. NEVER invent or assume a value the caller did not state; if the information was not provided, rating must be low and answer empty. When an objective lists allowed values, answer must be exactly one of them, chosen from what the caller said. Some objectives are CONDITIONAL ("if X, …"): when the conversation clearly shows the condition does NOT apply, the objective is satisfied — rate it 100 with answer "N/A".';
			const updateContactDef = bundle.tools.find((t) => t.name === "update_contact");
			const addTagDef = bundle.tools.find((t) => t.name === "add_tag");
			const defaultJudgeLlm = buildLlm({ model: "grok-4-fast", temperature: 0, maxTokens: 400 });

			const writeObjectiveField = (objective: FlowObjective, answer: string): void => {
				if (!objective.field || !answer) return;
				if (!updateContactDef) {
					console.warn(
						`flow: objective "${objective.key}" wants field "${objective.field}" but no update_contact tool is registered`,
					);
					return;
				}
				// Snap to the exact picklist option when one matches case-insensitively.
				const option = objective.options?.find((v) => v.toLowerCase() === answer.toLowerCase());
				void invokeTool(updateContactDef, dispatch, {
					field_name: objective.field,
					value: option ?? answer,
				}).catch((err) => console.error(`flow: objective field write failed (${objective.field})`, err));
			};

			const runObjectiveJudge = async (rt: ObjectiveRuntime): Promise<void> => {
				const unmet = rt.objectives.filter((o) => {
					const p = rt.state.get(o.key);
					return p && !p.met && !p.skipped;
				});
				if (unmet.length === 0) return;
				const transcript = turns
					.filter((t) => t.role !== "system")
					.slice(-40)
					.map((t) => `${t.role === "user" ? "caller" : "agent"}: ${t.text}`)
					.join("\n");

				const evalCtx = new llm.ChatContext();
				evalCtx.addMessage({ role: "system", content: OBJECTIVE_JUDGE_SYSTEM });
				evalCtx.addMessage({
					role: "user",
					content: `Objectives:\n${unmet
						.map(
							(o) =>
								`- key "${o.key}": ${o.description}${
									o.options ? ` — allowed values: ${o.options.map((v) => `"${v}"`).join(", ")}` : ""
								}`,
						)
						.join("\n")}\n\nConversation transcript:\n${transcript}`,
				});

				const judgeLlm = rt.judge
					? buildLlm({ temperature: 0, maxTokens: 400, ...rt.judge })
					: defaultJudgeLlm;
				const res = await judgeLlm.chat({ chatCtx: evalCtx }).collect();
				const text = res.text
					.trim()
					.replace(/^```(?:json)?\s*/i, "")
					.replace(/\s*```$/, "");
				let parsed: { checks?: { key?: string; rating?: number; answer?: string }[] };
				try {
					parsed = JSON.parse(text) as typeof parsed;
				} catch {
					console.error(`flow: objective judge returned unparseable output: ${text.slice(0, 200)}`);
					return;
				}

				for (const check of parsed.checks ?? []) {
					const objective = rt.objectives.find((o) => o.key === check.key);
					if (!objective) continue;
					const progress = rt.state.get(objective.key);
					if (!progress || progress.met) continue;
					const rating = Number(check.rating ?? 0);
					if (!(rating >= objectiveThreshold(objective))) continue;
					progress.met = true;
					progress.rating = rating;
					progress.answer = typeof check.answer === "string" ? check.answer.trim() : "";
					reportEvent(dispatch.callId, "flow.objective", {
						node: rt.nodeId,
						key: objective.key,
						rating,
						answer: progress.answer.slice(0, 200),
					});
					// "N/A" = a conditional objective whose condition didn't apply —
					// satisfied, but nothing to write to the CRM.
					if (progress.answer && progress.answer.toUpperCase() !== "N/A") {
						writeObjectiveField(objective, progress.answer);
					}
				}

				// Max attempts (CloseBot semantics): objectives are pursued roughly
				// in order, so each caller turn that leaves the FIRST live objective
				// unmet burns one attempt on it. Exhausted → it stops gating the
				// exit (skipped, stays unmet) so a dodging caller can't stall the
				// flow forever.
				const focus = rt.objectives.find((o) => {
					const p = rt.state.get(o.key);
					return p && !p.met && !p.skipped;
				});
				if (focus?.maxAttempts) {
					const progress = rt.state.get(focus.key)!;
					progress.attempts += 1;
					if (progress.attempts >= focus.maxAttempts) {
						progress.skipped = true;
						reportEvent(dispatch.callId, "flow.objective_skipped", {
							node: rt.nodeId,
							key: focus.key,
							attempts: progress.attempts,
						});
					}
				}
			};

			/** Idle = agent finished speaking its current reply. Bounded: a stuck
			 * state must not wedge the flow, so transition anyway after timeoutMs. */
			const waitForAgentIdle = (timeoutMs: number): Promise<void> => {
				const state = session.agentState;
				if (state === "listening" || state === "idle" || state === "initializing") {
					return Promise.resolve();
				}
				return new Promise((resolve) => {
					const finish = () => {
						clearTimeout(timer);
						session.off(voice.AgentSessionEventTypes.AgentStateChanged, onState);
						resolve();
					};
					const timer = setTimeout(finish, timeoutMs);
					const onState = (ev: voice.AgentStateChangedEvent) => {
						if (ev.newState === "listening" || ev.newState === "idle") finish();
					};
					session.on(voice.AgentSessionEventTypes.AgentStateChanged, onState);
				});
			};

			const maybeCompleteObjectives = (rt: ObjectiveRuntime): void => {
				if (rt.transitioning || activeObjectives !== rt) return;
				const pending = rt.objectives.filter((o) => {
					const p = rt.state.get(o.key);
					return (o.required ?? true) && p && !p.met && !p.skipped;
				});
				if (pending.length > 0) return;
				rt.transitioning = true;
				reportEvent(dispatch.callId, "flow.objectives_met", { node: rt.nodeId });
				void (async () => {
					// Never cut the agent off mid-sentence: transition at the next
					// turn boundary (agent back to listening).
					await waitForAgentIdle(15_000);
					// A scenario/secondary exit (or hangup) may have moved the call on.
					if (completed || activeObjectives !== rt) return;
					if (session.currentAgent.id !== `node:${rt.nodeId}`) return;
					reportEvent(dispatch.callId, "flow.exit", {
						node: rt.nodeId,
						exit: rt.exitName,
						target: rt.target ?? null,
						via: "objectives",
					});
					activeObjectives = null;
					const resolved = await resolveTarget(rt.target);
					if (resolved.kind === "agent") {
						const nextCtx = session.currentAgent.chatCtx.copy({ excludeInstructions: true });
						session.updateAgent(buildFlowAgent(resolved.id, nextCtx));
					} else if (resolved.kind === "end") {
						await hangUp("flow_complete");
					} else if (resolved.kind === "transfer") {
						startTransfer(resolved.nodeId);
					}
					// end_after_speech: the terminal statement queued its own hangup.
				})().catch((err) => console.error("flow: objective transition failed", err));
			};

			objectiveUserTurnHook = () => {
				const rt = activeObjectives;
				if (!rt || rt.transitioning) return;
				if (rt.judging) {
					// A newer caller turn arrived mid-judge — re-run once it finishes
					// so the verdict always covers the latest turn.
					rt.rerun = true;
					return;
				}
				void (async () => {
					do {
						rt.rerun = false;
						rt.judging = true;
						try {
							await runObjectiveJudge(rt);
						} catch (err) {
							console.error("flow: objective judge pass failed", err);
						} finally {
							rt.judging = false;
						}
					} while (rt.rerun && activeObjectives === rt && !rt.transitioning);
					maybeCompleteObjectives(rt);
				})();
			};

			const buildFlowAgent = (nodeId: string, chatCtx?: llm.ChatContext): voice.Agent => {
				const node = nodesById.get(nodeId);
				if (!node) throw new Error(`flow node "${nodeId}" not found`);
				if (node.kind === "router" || node.kind === "statement" || node.kind === "transfer") {
					throw new Error(
						`flow node "${nodeId}" is a ${node.kind} — routers, statements and transfers are evaluated inline via resolveTarget and never become agents`,
					);
				}

				const objectives = node.objectives ?? [];
				const hasObjectives = objectives.length > 0;

				const nodeTools = buildTools(
					bundle.tools.filter((t) => node.toolIds.includes(t.id as string)),
					dispatch,
				);
				// With objectives, the primary exit (exits[0]) belongs to the
				// ENGINE — the judge takes it once the data is verified; the model
				// gets no tool for it (this is what stops eager exits). Secondary
				// exits ("Wrong number") stay model-callable.
				const toolExits = hasObjectives ? node.exits.slice(1) : node.exits;
				// Guards against duplicate exit invocations from this node instance —
				// e.g. preemptiveGeneration drafting a reply (incl. tool calls) off an
				// interim transcript, then generating a second, final reply that calls
				// the same exit tool again once the caller's turn actually ends. Both
				// calls have real side effects (reportEvent + followTarget/handoff), so
				// the second one must be a no-op rather than replaying the transition.
				let exited = false;
				for (const exit of toolExits) {
					const target = exit.target;
					nodeTools[`exit_${sanitize(exit.name)}`] = llm.tool({
						description: `Take the "${exit.name}" exit: ${exit.description}${
							target ? "" : " This ends the call — say a brief goodbye first."
						}`,
						parameters: EMPTY_PARAMS,
						execute: async (_args, { ctx: runCtx }) => {
							if (exited) return "already handled";
							exited = true;
							reportEvent(dispatch.callId, "flow.exit", {
								node: node.id,
								exit: exit.name,
								target: target ?? null,
							});
							return followTarget(target, runCtx);
						},
					});
				}
				// Global scenarios (detect-and-jump): one extra exit per scenario on
				// every agent node, except a scenario already targeting this node.
				const scenarios = (flow.scenarios ?? []).filter((s) => s.target !== node.id);
				for (const scenario of scenarios) {
					nodeTools[`exit_scenario_${sanitize(scenario.name)}`] = llm.tool({
						description: `SCENARIO — take this exit IMMEDIATELY if at any point: ${scenario.description}`,
						parameters: EMPTY_PARAMS,
						execute: async (_args, { ctx: runCtx }) => {
							if (exited) return "already handled";
							exited = true;
							reportEvent(dispatch.callId, "flow.exit", {
								node: node.id,
								exit: scenario.name,
								target: scenario.target,
								scenario: true,
							});
							return followTarget(scenario.target, runCtx);
						},
					});
				}
				if (endCallEnabled) nodeTools.end_call = endCallTool;

				const exitNames = toolExits.map((e) => `exit_${sanitize(e.name)}`).join(", ");
				return voice.Agent.create({
					id: `node:${node.id}`,
					// Global job info is written ONCE on the agent and inherited by
					// every node; the node contributes only its stage instructions.
					// The transition rules below are what stop the two classic flow
					// failure modes: closing the conversation at every stage change,
					// and re-greeting/recapping after each handoff.
					instructions:
						globalInstructions +
						`\n\n## YOUR CURRENT STAGE\n${interpolate(node.instructions, variables)}` +
						(hasObjectives
							? `\n\n## OBJECTIVES\nIn this stage you must learn the following from the caller, naturally and ONE question at a time:\n${objectives
									.map(
										(o) =>
											`- ${o.description}${
												o.options ? ` (record as one of: ${o.options.join(", ")})` : ""
											}${(o.required ?? true) ? "" : " (optional — don't push if they decline)"}`,
									)
									.join(
										"\n",
									)}\nThe system verifies these automatically as the caller answers and advances the conversation to the next stage on its own — never announce a stage change or rush the caller, and do not save these specific values with tools; they are recorded automatically.`
							: "") +
						(toolExits.length > 0
							? `\n\n## MOVING BETWEEN STAGES\nThis call flows through several stages and you handle ONLY this one. The moment the conversation satisfies an exit condition, call that exit tool (${exitNames}) IMMEDIATELY and SILENTLY. Changing stages is invisible to the caller: do NOT wrap up, do NOT say goodbye or "thanks for your time", do NOT announce a transfer or say you're passing them along — the very same voice simply continues the conversation.`
							: "") +
						(scenarios.length > 0
							? `\n\n## SCENARIOS\nThese scenario exits override your stage goal — call one the moment its condition appears: ${scenarios
									.map((s) => `exit_scenario_${sanitize(s.name)}`)
									.join(", ")}.`
							: "") +
						"\n\n## CONTINUITY\nThis is ONE continuous conversation. Never greet the caller again or re-introduce yourself after the call has started. Never repeat a question that was already answered — check the conversation before asking. Don't recap earlier answers unless you're confirming a correction. Vary your acknowledgements instead of repeating the same phrase." +
						pacingRules +
						(endCallEnabled
							? "\n\nOnly the end_call tool ends the call — moving between stages never ends it. Use end_call solely when the conversation is truly over and you've said goodbye."
							: "") +
						missingNote +
						prohibited,
					chatCtx,
					llm: node.llm ? buildLlm(node.llm) : defaultLlm,
					// A transfer node upstream switched the "person": this and every
					// later agent speaks with the post-transfer voice.
					tts: ttsOverride,
					tools: nodeTools,
					onEnter: (agentCtx) => {
						reportEvent(dispatch.callId, "flow.node", { node: node.id, name: node.name ?? null });
						// Arm (or disarm) the objective judge for this node. Rebuilt
						// fresh on every entry — re-entering a node restarts its goals.
						activeObjectives = hasObjectives
							? {
									nodeId: node.id,
									exitName: node.exits[0]?.name ?? "end",
									target: node.exits[0]?.target,
									judge: node.judge,
									objectives,
									state: new Map(objectives.map((o) => [o.key, { met: false, attempts: 0, skipped: false }])),
									judging: false,
									rerun: false,
									transitioning: false,
								}
							: null;
						// Entry node speech is the greeting (step 8); later nodes open
						// themselves. Not awaited — awaiting playout inside a
						// tool-triggered onEnter deadlocks the tool call.
						if (node.id !== flow.entry) {
							// If the last thing spoken is an agent question the caller
							// hasn't answered (an exit fired early, or speech queued
							// ahead of the handoff), opening this stage would stack a
							// second question on top of it — stay silent and let the
							// caller answer; the LLM resumes on their next turn.
							const lastSpoken = turns.filter((t) => t.role !== "system").at(-1);
							if (lastSpoken?.role === "agent" && lastSpoken.text.trim().endsWith("?")) {
								reportEvent(dispatch.callId, "flow.entry_silent", {
									node: node.id,
									pending_question: lastSpoken.text.slice(0, 200),
								});
								return;
							}
							agentCtx.session.generateReply({
								instructions:
									"Continue this same conversation mid-stream — no greeting, no re-introduction, no recap of what was already covered. " +
									(node.entryInstructions
										? interpolate(node.entryInstructions, variables)
										: "Move naturally to this stage's first question."),
							});
						}
					},
				});
			};

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

		const sttModel = inferenceModel(config.stt.model, config.stt.provider, "xai/stt-1");
		const session = new voice.AgentSession({
			// xAI STT auto-detects (and code-switches) languages mid-call; pinning
			// it to the agent's language forces monolingual decoding — Spanish
			// callers got slow/empty finals. Only language-scoped providers
			// (Deepgram, AssemblyAI, …) receive the hint.
			stt: new inference.STT({
				model: sttModel,
				...(sttModel.startsWith("xai/") ? {} : { language: config.language }),
			}),
			tts: buildTts(config.tts),
			turnHandling: {
				// semantic → LiveKit's end-of-turn model; vad → VAD start/stop cues.
				turnDetection:
					config.turnDetection.mode === "semantic" ? new inference.TurnDetector() : "vad",
				endpointing: { minDelay: config.turnDetection.endpointingMs },
				// minWords: 0 (SDK default) lets any 500ms+ noise burst — line hiss,
				// SIP echo of the agent's own TTS — register as a barge-in with no
				// recognized speech, cutting the agent off mid-sentence. Requiring at
				// least one recognized word filters that out while still letting real
				// speech interrupt immediately.
				interruption: { enabled: config.turnDetection.allowInterruptions, minWords: 1 },
				// Draft the reply (LLM + first TTS chunk) while the caller is still
				// finishing their sentence; discard if the final transcript differs.
				preemptiveGeneration: { enabled: config.turnDetection.preemptiveGeneration !== false },
			},
		});

		// Backstop for the transfer StopResponse (see runTransfer): when the
		// exit rode a parallel-tool turn, the SDK still generates a reply for
		// the OTHER tools' outputs on the outgoing agent. Discard any
		// LLM-generated speech while the transfer sequence is playing; the
		// chain's own say() lines (announcement, statements) pass through.
		session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
			if (transferInFlight && ev.source !== "say") {
				try {
					ev.speechHandle.interrupt(true);
				} catch (err) {
					console.error("flow: failed to discard speech during transfer", err);
				}
			}
		});

		// 4. Collect transcript turns + usage meters as the session runs.
		session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
			if (!("role" in ev.item)) return; // agent-handoff items carry no speech
			const role = ev.item.role === "assistant" ? "agent" : ev.item.role === "user" ? "user" : "system";
			const text = ev.item.textContent;
			if (text) turns.push({ role, text, ts: Date.now() / 1000 });
			// Judge objectives off the hot path: fires AFTER the turn is recorded
			// so the judge always sees the caller's latest words. Async — never
			// delays the reply that's already generating.
			if (role === "user" && text) objectiveUserTurnHook?.();
		});

		const usage = { llmIn: 0, llmOut: 0, ttsChars: 0, sttMs: 0 };
		session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
			const m = ev.metrics;
			if (m.type === "llm_metrics") {
				usage.llmIn += m.promptTokens;
				usage.llmOut += m.completionTokens;
			} else if (m.type === "tts_metrics") {
				usage.ttsChars += m.charactersCount;
			} else if (m.type === "stt_metrics") {
				usage.sttMs += m.audioDurationMs;
			}
		});

		// 5. Completion is reported exactly once, whatever ends the call.
		let startedAt = Date.now();
		let endReason = "unknown";
		let completionStatus: "completed" | "no_answer" | "failed" = "completed";
		let completed = false;
		const complete = async () => {
			if (completed) return;
			completed = true;
			const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
			await reportCompletion(dispatch.callId, {
				status: completionStatus,
				end_reason: endReason,
				duration_seconds: durationSeconds,
				transcript: { turns },
				usage: [
					{ kind: "call_minutes", quantity: durationSeconds / 60 },
					{ kind: "llm_tokens_in", quantity: usage.llmIn },
					{ kind: "llm_tokens_out", quantity: usage.llmOut },
					{ kind: "tts_characters", quantity: usage.ttsChars },
					{ kind: "stt_seconds", quantity: usage.sttMs / 1000 },
				],
			});
		};

		// Agent-initiated hangup. Order matters:
		// 1. FLUSH FIRST — the job process dies within milliseconds of the room
		//    deletion, killing any in-flight request (transcripts were lost this
		//    way). The gateway's /complete responds fast (summarize runs async
		//    server-side), so this adds ~50ms before the line drops.
		// 2. Delete the room — disconnects the SIP leg; the SDK closes the
		//    session itself on the disconnect. Do NOT call session.close() here:
		//    racing the SDK's disconnect-close crashes closeImplInner
		//    ("reading 'currentSpeech'"). A delayed close is the safety net.
		hangUp = async (reason: string) => {
			if (endReason === "unknown") endReason = reason;
			await complete().catch((err) => console.error("pre-hangup flush failed", err));
			await ctx.deleteRoom().catch(() => {});
			setTimeout(() => {
				void session.close().catch(() => {});
			}, 5000);
		};

		session.on(voice.AgentSessionEventTypes.Close, (ev) => {
			if (endReason === "unknown") {
				endReason =
					ev.reason === voice.CloseReason.PARTICIPANT_DISCONNECTED
						? "caller_hangup"
						: ev.reason === voice.CloseReason.ERROR
							? "error"
							: String(ev.reason);
			}
			// Flush the moment the session closes — don't depend on a graceful
			// job shutdown (an SDK crash after close previously lost the whole
			// transcript). complete() is idempotent.
			void complete().catch((err) => console.error("completion flush failed", err));
		});
		ctx.addShutdownCallback(complete);

		// 6. Engine-enforced timeouts (spec §4).
		const maxCallTimer = setTimeout(() => {
			void hangUp("max_duration");
		}, config.timeouts.maxCallSeconds * 1000);

		let silenceTimer: NodeJS.Timeout | undefined;
		const resetSilence = () => {
			if (silenceTimer) clearTimeout(silenceTimer);
			silenceTimer = setTimeout(() => {
				void hangUp("silence_timeout");
			}, config.timeouts.silenceHangupSeconds * 1000);
		};
		session.on(voice.AgentSessionEventTypes.UserInputTranscribed, resetSilence);
		session.on(voice.AgentSessionEventTypes.ConversationItemAdded, resetSilence);
		session.on(voice.AgentSessionEventTypes.Close, () => {
			clearTimeout(maxCallTimer);
			if (silenceTimer) clearTimeout(silenceTimer);
		});

		// 7. Go live. Wait for the human before greeting: browsers join within
		// seconds; outbound SIP participants exist while ringing, so also wait
		// for the call to be answered (sip.callStatus → active).
		await session.start({ agent, room: ctx.room });

		const noAnswerMs = (config.timeouts.noAnswerSeconds ?? 25) * 1000;
		const remote = await Promise.race([
			ctx.waitForParticipant(),
			new Promise<null>((r) => setTimeout(() => r(null), noAnswerMs + 20_000)),
		]);
		const answered = remote ? await waitForSipAnswer(ctx, remote, noAnswerMs) : false;
		if (!answered) {
			completionStatus = "no_answer";
			endReason = "no_answer";
			await complete();
			await hangUp("no_answer");
			return;
		}

		startedAt = Date.now();
		resetSilence();
		if (!rawMetadata.inbound) {
			reportEvent(dispatch.callId, "call.started", { room: ctx.room.name ?? null });
		}

		// 8. Compliance disclosure is engine-enforced, then the configured greeting.
		const opening: string[] = [];
		if (config.compliance.aiDisclosure) {
			opening.push(config.compliance.disclosureText ?? DEFAULT_DISCLOSURE);
		}
		if (greeting) opening.push(greeting);
		if (opening.length > 0) session.say(opening.join(" "));
	},
});

cli.runApp(
	new ServerOptions({
		agent: fileURLToPath(import.meta.url),
		agentName: env.AGENT_NAME,
	}),
);
