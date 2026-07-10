// ============================================================================
// DO NOT EDIT — GENERATED FILE.
//
// Vendored verbatim from packages/shared/src/agent-config.ts by `pnpm sync:worker`.
// The worker builds standalone (`lk agent deploy` uses worker/ as the entire
// Docker build context), so it can't import @voice-engine/shared. Edit the
// canonical file in packages/shared/src/ and re-run `pnpm sync:worker`.
// CI runs `pnpm sync:worker --check` to fail on drift.
// ============================================================================

import { z } from "zod";
import { slugify } from "./slugify.js";

/**
 * AgentConfig — the heart of engine neutrality (spec §4).
 *
 * An agent is a JSONB document; nothing vertical-specific is a first-class
 * field. Vertical behavior enters only through `instructions` (language),
 * `toolIds` (webhooks the consuming app implements), and `postCall.extract`
 * (named outcome fields the consuming app asks for).
 *
 * ── SINGLE SOURCE OF TRUTH ──────────────────────────────────────────────
 * This schema is canonical for BOTH the gateway and the worker. The gateway
 * (`src/lib/agent-config.ts`) re-exports it. The worker cannot import this
 * workspace package (`lk agent deploy` builds worker/ standalone), so this
 * file is VENDORED into worker/src/vendor/agent-config.ts by `pnpm sync:worker`,
 * and worker/src/gateway.ts derives its `AgentConfig`/`FlowNode`/… types from
 * the vendored copy via `z.infer`. Edit the schema HERE, then run
 * `pnpm sync:worker`. There is no longer a hand-mirrored TS interface to keep
 * in step — a schema change is a one-place edit plus the sync copy.
 */
export const AgentConfig = z.object({
	// Identity
	name: z.string().min(1),
	description: z.string().optional(),

	// Persona — the ONLY place vertical behavior lives as language
	instructions: z.string().min(1),
	greeting: z.string().optional(), // spoken first on inbound; omit → agent waits
	language: z.string().default("en"), // BCP-47
	fallbackLanguage: z.string().optional(),

	// Models (resolved by the worker via LiveKit Inference / gateway proxies)
	llm: z
		.object({
			model: z.string().default("grok-4-fast"),
			temperature: z.number().min(0).max(2).default(0.4),
			maxTokens: z.number().int().positive().default(400), // keep spoken turns short
		})
		.default({}),
	/**
	 * Per-class model tiers (Phase 4 — cost instrumentation & judge starvation).
	 * Optional; each defaults to today's behavior so old configs are unaffected:
	 *   respond  → config.llm.model (the responder the caller hears);
	 *   judge    → the cheap grok-4-fast objective judge;
	 *   summary  → config.memory.model, then grok-4-fast;
	 *   router   → config.llm.model (today's router evaluation model).
	 * A tier only sets the DEFAULT model for that call class — per-node overrides
	 * (node.llm, node.judge.model) always take precedence over the tier.
	 */
	models: z
		.object({
			respond: z.string().min(1).optional(),
			judge: z.string().min(1).optional(),
			summary: z.string().min(1).optional(),
			router: z.string().min(1).optional(),
		})
		.optional(),
	stt: z
		.object({
			provider: z.string().default("xai"),
			model: z.string().optional(),
			diarize: z.boolean().default(false),
		})
		.default({}),
	tts: z
		.object({
			provider: z.string().default("xai"),
			voice: z.string().default("ara"),
			speed: z.number().min(0.7).max(1.5).default(1.0),
		})
		.default({}),

	/**
	 * Audio experience (VOICE channel only — text sessions ignore this block).
	 * Both toggles default ON: they are kill switches, not opt-ins, so existing
	 * configs get the improved behavior automatically.
	 */
	audio: z
		.object({
			/**
			 * Inbound noise cancellation on the caller's audio (LiveKit Krisp models
			 * via @livekit/noise-cancellation-node). SIP/telephony legs get
			 * `TelephonyBackgroundVoiceCancellation`; web legs get
			 * `BackgroundVoiceCancellation`. Root-cause fix for the line-hiss/echo the
			 * `interruptionMinWords` hack compensated for. Set false to disable. */
			noiseCancellation: z.boolean().default(true),
			/**
			 * Subtle "thinking" sound played while the agent is generating a reply
			 * (SDK BackgroundAudioPlayer.thinkingSound, driven by the agent-state
			 * machine), so slow LLM/tool turns aren't dead air. Set false to disable. */
			thinkingSound: z.boolean().default(true),
		})
		.default({}),

	// Conversation dynamics
	turnDetection: z
		.object({
			/**
			 * How end-of-turn is decided. `semantic` → LiveKit's cloud end-of-turn
			 * model (`inference.TurnDetector`, the default). `vad` → voice-activity
			 * start/stop cues; this is a REAL, working mode in @livekit/agents ≥1.5.0
			 * because `AgentSession` auto-provisions a bundled `inference.VAD` (Silero,
			 * served through the same Inference gateway as STT/TTS/LLM) — the worker
			 * also passes it explicitly. Legacy `mode:"vad"` configs keep parsing and
			 * now actually function. */
			mode: z.enum(["vad", "semantic"]).default("semantic"),
			endpointingMs: z.number().int().positive().default(500),
			allowInterruptions: z.boolean().default(true),
			/**
			 * Minimum recognized words for a barge-in to count as an interruption
			 * (SDK `turnHandling.interruption.minWords`). 1 filters line-hiss / TTS
			 * echo false barge-ins while letting real speech interrupt. With telephony
			 * noise cancellation now on, 2 is a reasonable stricter value; default
			 * stays 1 to preserve prior behavior. */
			interruptionMinWords: z.number().int().min(0).max(10).default(1),
			/** Start LLM+TTS on interim transcript before end-of-turn; draft is
			 * discarded if the final transcript differs. Cuts response latency. */
			preemptiveGeneration: z.boolean().default(true),
		})
		.default({}),
	timeouts: z
		.object({
			maxCallSeconds: z.number().int().positive().default(900),
			silenceHangupSeconds: z.number().int().positive().default(30),
			noAnswerSeconds: z.number().int().positive().default(25),
		})
		.default({}),

	/**
	 * Opaque builder document (canvas positions, rich-text sections, mention
	 * chips). The engine never reads it — it rides along in the config so the
	 * builder UI round-trips through versioning for free.
	 */
	canvas: z.any().optional(),

	/**
	 * Opaque builder reference to the persona attached in the SaaS (identity/
	 * tone layer compiled into `instructions`). The engine never reads it —
	 * like `canvas`, it rides along so the builder round-trips the selection.
	 */
	personaId: z.string().nullish(),

	// Multi-node flow (canvas-built agents). When present, the call runs as a
	// graph of small agents: each node has its own instructions and gated
	// tools, and moves to another node (or ends the call) through its exits.
	// Single-agent configs simply omit this.
	flow: z
		.object({
			entry: z.string().min(1), // node id the call starts on
			nodes: z
				.array(
					z.object({
						id: z.string().min(1),
						name: z.string().optional(),
						/** "agent" nodes converse; "router" nodes never speak: one LLM
						 * evaluation over the conversation so far picks an exit and the
						 * flow immediately continues to that exit's target (or ends the call).
						 * "statement" nodes speak a fixed line and immediately move on —
						 * deterministic, never waiting for the user. "transfer" nodes
						 * simulate a warm transfer: optional announcement (in the current
						 * voice), hold music for a few seconds, then the flow continues at
						 * the target with a new voice that persists for the rest of the call. */
						kind: z
							.enum(["agent", "router", "statement", "transfer", "set_field", "modify_tags"])
							.default("agent"),
						/** Router-only: the statement/question evaluated against the
						 * conversation (e.g. "The caller has confirmed they speak English"). */
						router: z.object({ condition: z.string().min(1) }).optional(),
						/** Statement-only: the exact line spoken ({{variables}} interpolated). */
						statement: z.object({ say: z.string().min(1) }).optional(),
						/**
						 * set_field-only: deterministically write one data field.
						 *
						 * ENGINE NEUTRALITY: the engine no longer assumes a tool named
						 * "update_contact" exists. `toolId` names the config tool that performs
						 * the write (matched against ToolDef.name, falling back to ToolDef.id).
						 * Omitted -> the call falls back to config.fieldWriteToolId (which itself
						 * defaults to "update_contact"), preserving the behavior of every config
						 * authored before this field existed.
						 *
						 * DEPRECATION PATH: the "update_contact" default is a back-compat shim for
						 * pre-existing pinned configs. New configs emitted by the SaaS compiler
						 * always set `toolId` explicitly, so the default can be dropped once no
						 * live/pinned config relies on it (a data audit, NOT a code change alone).
						 */
						setField: z
							.object({
								field: z.string().min(1),
								value: z.string(),
								/** Config tool id/name that writes the field. Omit -> config.fieldWriteToolId. */
								toolId: z.string().min(1).optional(),
							})
							.optional(),
						/**
						 * modify_tags-only: deterministically add/remove tags. `toolId` names the
						 * config tool that mutates tags (see setField.toolId for the
						 * neutrality/deprecation story). Omitted -> config.tagWriteToolId.
						 */
						modifyTags: z
							.object({
								add: z.array(z.string().min(1)).default([]),
								remove: z.array(z.string().min(1)).default([]),
								/** Config tool id/name that adds tags. Omit -> config.tagWriteToolId. */
								toolId: z.string().min(1).optional(),
							})
							.optional(),
						/** Transfer-only: the simulated hand-off. */
						transfer: z
							.object({
								/** Announcement spoken before the music, in the pre-transfer voice. */
								say: z.string().optional(),
								/** Hold-music duration between the two "people". */
								holdSeconds: z.number().min(0).max(30).default(4),
								/** Voice from here on; omit to keep the current voice. */
								voice: z
									.object({
										provider: z.string(),
										voice: z.string(),
										speed: z.number().min(0.7).max(1.5).optional(),
									})
									.optional(),
							})
							.optional(),
						instructions: z.string().min(1),
						/**
						 * Conversation mode (Phase 2 — CloseBot's objective-less "keep the
						 * conversation going" node). When present, the node runs as an agent
						 * that self-drives open-ended discovery from `reason` (+ optional
						 * `hints` as talking points) with NO objectives block and NO
						 * objective judge; it wraps up warmly and closes when the caller
						 * disengages. `wrapUp` fixes how it closes: `end_call` hangs up via
						 * the end_call tool; `exit` takes the named node exit (matched to an
						 * `exits[].name`). `maxDurationSeconds` arms a soft per-node timer
						 * that nudges a wrap-up on expiry. Mutually exclusive with
						 * `objectives`. */
						conversation: z
							.object({
								/** Why this open-ended conversation exists — the discovery seed. */
								reason: z.string().min(1),
								/** Optional talking points the agent may explore (not a checklist). */
								hints: z.array(z.string().min(1)).optional(),
								/** How the node closes when the caller disengages. */
								wrapUp: z.discriminatedUnion("mode", [
									z.object({ mode: z.literal("end_call") }),
									z.object({ mode: z.literal("exit"), exit: z.string().min(1) }),
								]),
								/** Soft cap: on expiry the agent is nudged to wrap up (never a hard cut). */
								maxDurationSeconds: z.number().int().positive().optional(),
							})
							.optional(),
						/** Agent-only: engine-verified data goals. When present, the
						 * node's primary exit (exits[0]) is taken by the ENGINE once a
						 * judge pass confirms every required objective — the
						 * conversational LLM gets no exit tool for it. */
						objectives: z
							.array(
								z.object({
									/** Slug, unique within the node. */
									key: z.string().min(1),
									/** What must be learned from the caller — judged against this. */
									description: z.string().min(1),
									/** Field name auto-written (via config.fieldWriteToolId) when met. */
									field: z.string().optional(),
									/** Allowed values (picklist) — the judge coerces the answer to one of these. */
									options: z.array(z.string().min(1)).min(2).optional(),
									/** Required objectives gate the primary exit. */
									required: z.boolean().default(true),
									/** Give up after this many caller turns spent on the objective —
									 * it stops gating the exit (CloseBot "Max Attempts"). */
									maxAttempts: z.number().int().min(1).max(10).optional(),
									/** Judge strictness 0-100: rating required to mark the objective
									 * met (CloseBot "Sensitivity"). Default 90. */
									sensitivity: z.number().min(0).max(100).optional(),
									/** When this objective's `field` already has a value in the
									 * per-call contactState, start it MET with that value (no judge,
									 * no re-asking — CloseBot's "don't ask what you already know").
									 * Set false to force asking even when the value is known.
									 * Default true. */
									skipIfKnown: z.boolean().default(true),
									/**
									 * Aggregate objective (CloseBot's `get_full_address`). When set,
									 * this objective has NO own judge question: it lists the keys of
									 * OTHER objectives in the SAME node whose answers it composes. It
									 * completes automatically the moment every part is met; its answer
									 * is the parts' answers joined (in aggregateOf order, space-separated),
									 * and then its own `field` write fires as usual. Parts may have their
									 * own `field` or not. Excluded from the judge's unmet list.
									 * Constraints (validated): keys must reference other objectives in
									 * this node; no self-reference; no aggregate-of-aggregate.
									 */
									aggregateOf: z.array(z.string().min(1)).min(1).optional(),
								}),
							)
							.optional(),
						/** Model override for the objective judge (default: cheap fast model). */
						judge: z
							.object({
								model: z.string().min(1),
								temperature: z.number().min(0).max(2).optional(),
							})
							.optional(),
						/** Spoken direction generated when the node becomes active (skipped on the entry node — the greeting covers it). */
						entryInstructions: z.string().optional(),
						/** Tools available ONLY while this node is active (subset of the agent's toolIds). */
						toolIds: z.array(z.string()).default([]),
						/** Per-node LLM override, e.g. a cheap model for a yes/no filter node. */
						llm: z
							.object({
								model: z.string(),
								temperature: z.number().min(0).max(2).optional(),
								maxTokens: z.number().int().positive().optional(),
							})
							.optional(),
						exits: z
							.array(
								z.object({
									name: z.string().min(1),
									/** When to take this exit — becomes the exit tool's description. */
									description: z.string().min(1),
									/** Node id to move to; omit to end the call after this exit. */
									target: z.string().optional(),
									/**
									 * Tag-driven exit gating (Phase 5b — deterministic, zero LLM cost).
									 * An exit whose tagRules are NOT satisfied by the call's current
									 * in-memory tag set is not exposed as an exit tool when the node's
									 * agent is built, and is skipped as a router/objectives target
									 * candidate. `mustHave`: every listed tag must be present.
									 * `cantHave`: none of the listed tags may be present. The tag set
									 * seeds from dispatch `contactTags` and grows as modify_tags /
									 * tag-write tools run; mid-node tag changes take effect at the next
									 * handoff (per-node build granularity). */
									tagRules: z
										.object({
											mustHave: z.array(z.string().min(1)).optional(),
											cantHave: z.array(z.string().min(1)).optional(),
										})
										.optional(),
								}),
							)
							.default([]),
					}),
				)
				.min(1),
			/**
			 * Global detect-and-jump rules (CloseBot "Custom Scenario"): every agent
			 * node gets one extra exit tool per scenario; the moment the described
			 * situation appears, the flow jumps to the scenario's target node.
			 */
			scenarios: z
				.array(
					z.object({
						name: z.string().min(1),
						/** When to jump — becomes the scenario exit tool's description. */
						description: z.string().min(1),
						/** Node id the flow jumps to (any kind; routers/statements resolve inline). */
						target: z.string().min(1),
					}),
				)
				.default([]),
		})
		.optional()
		.superRefine((flow, ctx) => {
			if (!flow) return;
			const sanitize = slugify;
			const ids = new Set(flow.nodes.map((n) => n.id));
			if (ids.size !== flow.nodes.length) {
				ctx.addIssue({ code: "custom", message: "flow.nodes ids must be unique" });
			}
			if (!ids.has(flow.entry)) {
				ctx.addIssue({ code: "custom", message: `flow.entry "${flow.entry}" is not a node id` });
			}
			const entryNode = flow.nodes.find((n) => n.id === flow.entry);
			if (entryNode && entryNode.kind !== "agent") {
				ctx.addIssue({
					code: "custom",
					message: `flow.entry "${flow.entry}" must be an agent node — a ${entryNode.kind} cannot run before any conversation exists`,
				});
			}
			const scenarioNames = new Set<string>();
			for (const scenario of flow.scenarios) {
				if (!ids.has(scenario.target)) {
					ctx.addIssue({
						code: "custom",
						message: `flow.scenarios "${scenario.name}" targets unknown node "${scenario.target}"`,
					});
				}
				const key = sanitize(scenario.name);
				if (scenarioNames.has(key)) {
					ctx.addIssue({
						code: "custom",
						message: `flow.scenarios names must be unique — "${scenario.name}" collides after sanitization`,
					});
				}
				scenarioNames.add(key);
			}
			for (const node of flow.nodes) {
				if (node.objectives?.length) {
					if (node.kind !== "agent") {
						ctx.addIssue({
							code: "custom",
							message: `node "${node.id}" has objectives but is a ${node.kind} — only agent nodes converse and can gather objectives`,
						});
					}
					const keys = new Set(node.objectives.map((o) => o.key));
					if (keys.size !== node.objectives.length) {
						ctx.addIssue({
							code: "custom",
							message: `node "${node.id}" objective keys must be unique`,
						});
					}
					// Aggregate objectives (Phase 5b): parts must reference other
					// objectives in this node; no self-reference; no aggregate-of-aggregate.
					const aggregateKeys = new Set(
						node.objectives.filter((o) => o.aggregateOf?.length).map((o) => o.key),
					);
					for (const o of node.objectives) {
						if (!o.aggregateOf?.length) continue;
						for (const part of o.aggregateOf) {
							if (part === o.key) {
								ctx.addIssue({
									code: "custom",
									message: `node "${node.id}" aggregate objective "${o.key}" cannot reference itself`,
								});
							} else if (!keys.has(part)) {
								ctx.addIssue({
									code: "custom",
									message: `node "${node.id}" aggregate objective "${o.key}" references unknown objective "${part}"`,
								});
							} else if (aggregateKeys.has(part)) {
								ctx.addIssue({
									code: "custom",
									message: `node "${node.id}" aggregate objective "${o.key}" references another aggregate "${part}" — aggregate-of-aggregate is not allowed`,
								});
							}
						}
					}
				}
				if (node.conversation) {
					if (node.kind !== "agent") {
						ctx.addIssue({
							code: "custom",
							message: `node "${node.id}" has a conversation block but is a ${node.kind} — only agent nodes converse`,
						});
					}
					if (node.objectives?.length) {
						ctx.addIssue({
							code: "custom",
							message: `node "${node.id}" cannot have both conversation and objectives — a conversation node is objective-less by design`,
						});
					}
					if (node.conversation.wrapUp.mode === "exit") {
						const exitName = node.conversation.wrapUp.exit;
						if (!node.exits.some((e) => e.name === exitName)) {
							ctx.addIssue({
								code: "custom",
								message: `node "${node.id}" conversation wrapUp exit "${exitName}" does not match any of the node's exits`,
							});
						}
					}
				}
				if (node.kind === "set_field") {
					if (!node.setField?.field) {
						ctx.addIssue({
							code: "custom",
							message: `set_field node "${node.id}" must define setField.field`,
						});
					}
					if (node.exits.length > 1) {
						ctx.addIssue({
							code: "custom",
							message: `set_field node "${node.id}" must have at most 1 exit — it writes a field and moves on`,
						});
					}
				}
				if (node.kind === "modify_tags") {
					const add = node.modifyTags?.add ?? [];
					const remove = node.modifyTags?.remove ?? [];
					if (add.length === 0 && remove.length === 0) {
						ctx.addIssue({
							code: "custom",
							message: `modify_tags node "${node.id}" must add or remove at least one tag`,
						});
					}
					if (node.exits.length > 1) {
						ctx.addIssue({
							code: "custom",
							message: `modify_tags node "${node.id}" must have at most 1 exit — it changes tags and moves on`,
						});
					}
				}
				if (node.kind === "router") {
					if (!node.router?.condition) {
						ctx.addIssue({
							code: "custom",
							message: `router node "${node.id}" must define router.condition`,
						});
					}
					if (node.exits.length < 2) {
						ctx.addIssue({
							code: "custom",
							message: `router node "${node.id}" must have at least 2 exits`,
						});
					}
				}
				if (node.kind === "statement") {
					if (!node.statement?.say) {
						ctx.addIssue({
							code: "custom",
							message: `statement node "${node.id}" must define statement.say`,
						});
					}
					if (node.exits.length > 1) {
						ctx.addIssue({
							code: "custom",
							message: `statement node "${node.id}" must have at most 1 exit — it speaks its line and moves on (or ends the call)`,
						});
					}
				}
				for (const exit of node.exits) {
					if (exit.target && !ids.has(exit.target)) {
						ctx.addIssue({
							code: "custom",
							message: `node "${node.id}" exit "${exit.name}" targets unknown node "${exit.target}"`,
						});
					}
				}
			}
		}),

	/**
	 * Words/phrases the agent must never say (global, CloseBot "Prohibited
	 * Words"). Enforced via prompt on every node/agent.
	 */
	prohibitedWords: z.array(z.string().min(1)).default([]),

	// Capabilities
	toolIds: z.array(z.string()).default([]), // must belong to the same project

	/**
	 * Designated write tools (spec §4 — engine neutrality). The engine performs
	 * two kinds of automatic writes: set_field nodes + verified objectives write
	 * a data field; modify_tags nodes add tags. Rather than hardcoding the
	 * business tool names, the engine resolves the tool to invoke from these
	 * config ids (matched against ToolDef.name, then ToolDef.id). A set_field /
	 * modify_tags node may override per-node via node.setField.toolId /
	 * node.modifyTags.toolId; when it doesn't, these config-level ids are used.
	 *
	 * BACK-COMPAT: they default to the historical CRM tool names
	 * ("update_contact" / "add_tag"), so every config authored before these
	 * fields existed — including versions pinned to in-flight calls — keeps its
	 * exact prior behavior with no migration. The SaaS compiler now emits tool
	 * ids explicitly (self-describing configs); the defaults are a deprecation
	 * shim to be removed only after a data audit confirms nothing relies on them.
	 */
	fieldWriteToolId: z.string().min(1).default("update_contact"),
	tagWriteToolId: z.string().min(1).default("add_tag"),
	/**
	 * Tag-REMOVAL tool (Phase 5b — modify_tags removal support). modify_tags
	 * removals invoke this config-named tool (matched against ToolDef.name, then
	 * ToolDef.id). BACK-COMPAT: defaults to "remove_tag" (the CRM removal tool the
	 * SaaS now registers alongside add_tag). Same neutrality/deprecation story as
	 * tagWriteToolId — the engine hardcodes no CRM tool name. */
	tagRemoveToolId: z.string().min(1).default("remove_tag"),

	/** Built-in end_call tool: the LLM hangs up after wrapping the conversation. */
	endCall: z
		.object({
			enabled: z.boolean().default(true),
		})
		.default({}),
	transfer: z
		.object({
			enabled: z.boolean().default(false),
			numbers: z.array(z.object({ label: z.string(), e164: z.string() })).default([]),
		})
		.optional(),
	voicemail: z
		.object({
			detect: z.boolean().default(true),
			onVoicemail: z.enum(["hangup", "leave_message"]).default("hangup"),
			message: z.string().optional(),
		})
		.optional(),

	/**
	 * Call recording (LiveKit Egress). Per-agent opt-in; default disabled.
	 *
	 * ENGINE NEUTRALITY: this is a bare on/off switch — NO storage vocabulary
	 * (bucket, provider, path) lives in the agent document. WHERE a recording
	 * lands is a gateway deployment concern (S3_* env on the gateway), not
	 * per-agent config. When enabled, the gateway starts an audio-only
	 * RoomComposite egress as the session/call starts; when the gateway has no
	 * storage configured it logs a warning and skips (the call still proceeds).
	 * Only voice sessions are recorded — text sessions never start egress.
	 */
	recording: z
		.object({
			enabled: z.boolean().default(false),
		})
		.optional(),

	// Compliance (engine-enforced, not prompt-enforced)
	compliance: z
		.object({
			aiDisclosure: z.boolean().default(true),
			disclosureText: z.string().optional(),
			record: z.boolean().default(false),
			recordingConsentPrompt: z.string().optional(),
		})
		.default({}),

	// Post-call
	postCall: z
		.object({
			summarize: z.boolean().default(true),
			/** Named fields + extraction instructions, e.g. { appointment_scheduled: "true/false…" } */
			extract: z.record(z.string()).optional(),
		})
		.default({}),

	/**
	 * Rolling in-call memory (Phase 3 — CloseBot's regenerated `<conversation
	 * summary>`). Every `intervalTurns` caller turns a cheap async model call
	 * condenses the turns OLDER than the live `windowTurns` window into a bullet
	 * summary, injected into every node prompt as `## CONVERSATION SO FAR`; the
	 * responder's chat history is compacted to that summary + the last
	 * `windowTurns` verbatim turns so per-turn cost plateaus instead of growing.
	 * The full transcript buffer (for flush) and the objectives judge window are
	 * NEVER compacted — only what the responder model sees. Omitted → defaults
	 * (memory ON); set `enabled:false` to disable entirely.
	 */
	memory: z
		.object({
			enabled: z.boolean().default(true),
			/** Caller turns between summary refreshes. */
			intervalTurns: z.number().int().positive().default(10),
			/** Verbatim turns kept alongside the summary (the responder's live window). */
			windowTurns: z.number().int().positive().default(20),
			/** Summary model; defaults to the cheap judge-tier model. */
			model: z.string().min(1).optional(),
		})
		.optional(),
});

export type AgentConfigT = z.infer<typeof AgentConfig>;

/** Partial version for PATCH — validated after merging over the stored config. */
export const AgentConfigPatch = AgentConfig.partial();

/**
 * Contact state (Phase 1 — the UNRESOLVED block). PER-CALL data, deliberately
 * NOT part of AgentConfig: the SaaS builds it fresh per dispatch from the
 * caller's CRM record and sends it as a sibling of `variables`/`metadata` in the
 * session-create payload; it rides in the dispatch metadata to the worker.
 *
 * ENGINE NEUTRALITY: opaque generic key/label/value triples — no CRM-specific
 * naming. `key` is the field identifier the engine matches objective/set_field
 * writes against; `label` is the human phrasing the prompt shows; `value` is the
 * known value, or null when unknown (rendered as UNRESOLVED in the instruction
 * block only — never spoken).
 */
export const ContactStateEntry = z.object({
	key: z.string().min(1),
	label: z.string().min(1),
	value: z.string().nullable(),
});
export const ContactState = z.array(ContactStateEntry);
export type ContactStateEntryT = z.infer<typeof ContactStateEntry>;

/**
 * Contact tags (Phase 5b — tag-driven exit routing seed). PER-CALL data, a
 * sibling of `contactState` in the dispatch payload: the caller's CRM tag names
 * at dispatch. The worker seeds its in-memory tag set from these and adds every
 * tag written via modify_tags / tag-write tools during the call; exits with
 * `tagRules` are gated against that set. Opaque generic strings — the engine
 * reads no CRM meaning into them. Failure-isolated like contactState.
 */
export const ContactTags = z.array(z.string().min(1));
export type ContactTagsT = z.infer<typeof ContactTags>;

/**
 * Session channel (Phase 6 — channel abstraction). PER-CALL data, a sibling of
 * contactState/contactTags in the session-create body + dispatch payload. Which
 * I/O modality the session runs on: `voice` = STT/TTS/VAD over audio tracks
 * (today's behavior, the default); `text` = LiveKit text streams on the `lk.chat`
 * topic, no audio. The flow runtime (objectives, judge, memory, routers, exits,
 * contact state, transcript flush, usage metering) is identical across channels —
 * only the worker's I/O adapter differs. Omitted → voice.
 */
export const Channel = z.enum(["voice", "text"]);
export type ChannelT = z.infer<typeof Channel>;

/**
 * Structural sub-types derived from the ONE schema above (never hand-written).
 * The worker consumes these shapes; deriving them here keeps the worker's types
 * (via z.infer of the vendored copy) locked to the schema with zero drift.
 */
export type Flow = NonNullable<AgentConfigT["flow"]>;
export type FlowNode = Flow["nodes"][number];
export type FlowScenario = Flow["scenarios"][number];
export type FlowObjective = NonNullable<FlowNode["objectives"]>[number];

/**
 * Interpolate {{variables}} into instructions/greeting — how per-call context
 * enters without per-call configs (spec §5). Unknown placeholders are left
 * intact so a missing variable is visible in transcripts rather than silent.
 */
export function interpolate(template: string, variables: Record<string, string>): string {
	return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name: string) =>
		Object.hasOwn(variables, name) ? variables[name]! : whole,
	);
}
