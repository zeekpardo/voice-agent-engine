import { z } from "zod";
import { slugify } from "./slugify.js";

/**
 * Reserved exit name for a transfer node's FAILURE path (cross-repo join key).
 *
 * A "warm" transfer resolves ONLY on a successful human connect and rejects on
 * EVERY failure mode (dial failed / declined / voicemail / no-answer / timeout)
 * — one failure path, so one exit. The SaaS compiler emits the transfer node's
 * failure handle as an exit whose `name` is exactly this string; the engine's
 * warm-transfer catch matches on it to route the caller to a "Not Connected"
 * node instead of dropping them mid-flow. Kept here (the single source of truth,
 * vendored into the worker) so both sides agree on the literal.
 */
export const TRANSFER_FAILED_EXIT_NAME = "Not Connected";

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
	/**
	 * Free-text phrasing/tone directive injected into EVERY generated message
	 * (voice + text, every node, statements/handoff/greeter/entry generation) as
	 * a labeled `## RESPONSE STYLE` block, alongside persona/guardrails. Distinct
	 * from persona (identity/character): this governs HOW replies are phrased —
	 * varied, natural, non-repetitive. When empty/unset the engine injects
	 * nothing (behavior unchanged). Read LIVE by the worker at assembly time
	 * (unlike guardrails/goal, which the SaaS compiles into `instructions`).
	 */
	responseStyle: z.string().optional(),
	greeting: z.string().optional(), // spoken first on inbound; omit → agent waits
	/** When absent/false (default): the greeting is spoken VERBATIM (with
	 * {{variable}} substitution) exactly as authored. When true: the greeting
	 * text is a DIRECTION the model generates a fresh opener from each call —
	 * adapted to the caller's language + the agent's persona/style — via the same
	 * generateReply-from-direction path statements/handoffs use. */
	greetingGenerate: z.boolean().optional(),
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
	 * The two toggles default ON (kill switches, not opt-ins) so existing configs
	 * get the improved behavior automatically; the thinking-sound clip/volume and
	 * the optional continuous ambient bed are additive extensions whose defaults
	 * reproduce the prior hard-coded behavior byte-for-byte.
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
			/** Which built-in clip the thinking sound uses. Defaults to keyboard_typing2
			 * — byte-for-byte the previous hard-coded behavior. */
			thinkingSoundClip: z
				.enum(["keyboard_typing", "keyboard_typing2", "office_ambience", "hold_music"])
				.default("keyboard_typing2"),
			/** Thinking-sound loudness (0–1). Default 0.4 preserves prior behavior. */
			thinkingSoundVolume: z.number().min(0).max(1).default(0.4),
			/** Continuous ambient bed played for the whole call (SDK
			 * BackgroundAudioPlayer.ambientSound). OFF by default — opt-in, so existing
			 * configs are unchanged. */
			ambientSound: z
				.object({
					enabled: z.boolean().default(false),
					clip: z
						.enum(["office_ambience", "keyboard_typing", "keyboard_typing2", "hold_music"])
						.default("office_ambience"),
					volume: z.number().min(0).max(1).default(0.3),
				})
				.default({}),
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
			/**
			 * No-progress / stuck-node backstop (engine-enforced). If a flow stays on a
			 * single OBJECTIVE node with no objective progress (no objective met/skipped,
			 * no node change) for this many seconds, the engine force-ends the call. This
			 * catches a wedged objective judge that never advances the node while the
			 * model loops the same line — the ordinary silence timeout can't, because it
			 * resets on every agent turn (a looping agent keeps it alive forever). Only
			 * armed on objective nodes; conversation / single-agent turns reset it (they
			 * are governed by silenceHangupSeconds + maxCallSeconds instead). */
			noProgressSeconds: z.number().int().positive().default(180),
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

	/**
	 * Raw guardrails text authored in the SaaS builder. Compiled into
	 * `instructions` (## GUARDRAILS) at save time; the engine never reads the
	 * raw field — it rides along so the builder can re-edit it.
	 */
	guardrails: z.string().nullish(),

	/**
	 * Custom variable DEFINITIONS authored in the SaaS builder ("job flow
	 * variables"): reusable {{name}} placeholders with an optional default. The
	 * ENGINE never reads these — at dispatch time the consuming SaaS merges
	 * defaults + its own per-tenant overrides into the runtime `variables` map
	 * (which the worker already interpolates). Rides on the config so the
	 * builder round-trips definitions through save/publish/versioning.
	 */
	customVariables: z
		.array(
			z.object({
				name: z.string().min(1),
				description: z.string().optional(),
				default: z.string().optional(),
			}),
		)
		.optional(),

	/**
	 * Channel preferences authored in the SaaS builder. The ENGINE never reads
	 * these — enforcement happens SaaS-side at every dispatch entry point
	 * (trigger route, inbound-message routing, widget, test portal) and in the
	 * post-call webhook consumer (voice-fail → text fallback). Rides on the
	 * config for round-trip/versioning.
	 * - mode: which channels this agent operates on at all ("both" default).
	 * - textFallback: when an outbound voice call fails to connect
	 *   (no_answer / failed / voicemail), the SaaS starts a text conversation
	 *   with the same workflow instead.
	 */
	channels: z
		.object({
			mode: z.enum(["voice", "text", "both"]).default("both"),
			textFallback: z.boolean().default(false),
		})
		.optional(),

	/**
	 * Raw goal text authored in the SaaS builder (the job's overarching
	 * objective). Compiled into `instructions` (## GOAL) at save time; kept
	 * separately so re-editing never round-trips the composed prompt.
	 */
	goal: z.string().nullish(),

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
						 * the target with a new voice that persists for the rest of the call.
						 * "handoff" nodes hand the LIVE call off to a DIFFERENT published
						 * agent (its own persona/flow/tools, fetched from the gateway),
						 * carrying the conversation context — one-way, no automatic return.
						 * Terminal for this agent's flow (no normal exits).
						 * "stop_responding" nodes PARK the contact: the agent stops
						 * responding but the session stays alive and listening. It never
						 * hangs up on its own (voice calls still end via the existing
						 * silence-hangup timeout; text sessions park indefinitely) and never
						 * returns to the main flow. Global scenarios keep being evaluated
						 * while parked, so an inbound message can still trigger a scenario
						 * and route the contact onward. A leaf/terminal node (no exits) that
						 * is NOT an end-of-call — it must never fire end_call. */
						kind: z
							.enum([
								"agent",
								"router",
								"statement",
								"transfer",
								"set_field",
								"modify_tags",
								"handoff",
								"stop_responding",
							])
							.default("agent"),
						/** Router-only: the statement/question evaluated against the
						 * conversation (e.g. "The caller has confirmed they speak English"). */
						router: z.object({ condition: z.string().min(1) }).optional(),
						/** Statement-only: the line to deliver ({{variables}} interpolated).
						 * When `generate` is absent/false (the default) `say` is spoken/sent
						 * VERBATIM — exactly as written. When `generate` is true, `say` is
						 * treated as a DIRECTION/seed: the model generates a fresh, natural
						 * message from it each time (adapted to the caller's current language +
						 * the agent's persona/style) via the same generateReply-from-direction
						 * path that entry/handoff messages use, instead of reciting the literal
						 * string. */
						statement: z.object({ say: z.string().min(1), generate: z.boolean().optional() }).optional(),
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
						/**
						 * Transfer-only: hand the caller off to another party. One node,
						 * three modes:
						 *
						 * - "simulated" (DEFAULT — legacy behavior): NO real phone dial. The
						 *   agent speaks an optional announcement in the current voice, plays
						 *   hold music for `holdSeconds`, applies `voice`, then continues the
						 *   flow at the exit target — all within the same call/session. Works
						 *   with no SIP trunk. Existing transfer nodes (which carry no `mode`)
						 *   default here and keep behaving exactly as before.
						 * - "warm": REAL attended transfer. The agent dials `target` over SIP,
						 *   the caller hears hold music while it rings, then the two calls are
						 *   merged. Backed by LiveKit's WarmTransferTask. Requires a SIP
						 *   outbound trunk (LIVEKIT_SIP_OUTBOUND_TRUNK on the worker).
						 * - "cold": REAL blind transfer / call forwarding via SIP REFER. The
						 *   caller's SIP leg is transferred to `target` and the agent drops;
						 *   the LiveKit session ends. Requires a SIP trunk that permits REFER.
						 */
						transfer: z
							.object({
								/** Which transfer behavior to run. Default keeps old configs unchanged. */
								mode: z.enum(["simulated", "warm", "cold"]).default("simulated"),
								/**
								 * warm/cold destination: a dialable phone (`tel:+15551234567`) or
								 * SIP URI (`sip:agent@host`). Generic URI — the engine assigns it
								 * no business meaning. Required for warm/cold; ignored by simulated.
								 */
								target: z.string().min(1).optional(),
								/**
								 * warm-only ring/hold timeout in seconds: how long to wait for
								 * `target` to answer before giving up. Sensible default + cap.
								 */
								waitSeconds: z.number().min(1).max(120).default(30),
								/** Announcement spoken before the music, in the pre-transfer voice. */
								say: z.string().optional(),
								/** simulated-only: hold-music duration between the two "people". */
								holdSeconds: z.number().min(0).max(30).default(4),
								/** simulated-only: voice from here on; omit to keep the current voice. */
								voice: z
									.object({
										provider: z.string(),
										voice: z.string(),
										speed: z.number().min(0.7).max(1.5).optional(),
									})
									.optional(),
							})
							.optional(),
						/**
						 * Channels this node applies to. Omitted = every channel. The SaaS
						 * compiler marks voice-only/text-only nodes; the voice worker and the
						 * turn-based conversation runner MAY skip nodes excluded from their
						 * channel (runtime skipping is a follow-up — today the mark simply
						 * round-trips instead of being stripped).
						 */
						channels: z.array(z.enum(["voice", "text"])).optional(),
						/**
						 * handoff-only: the id of the DIFFERENT published agent this node
						 * hands the live call off to. The worker fetches that agent's current
						 * config from the gateway, builds its entry agent (its flow.entry, or a
						 * single-agent build when it has no flow), carries the conversation
						 * context across, and swaps the session's agent — one-way, no automatic
						 * return. Opaque to the engine's neutrality rule: just an agent id the
						 * gateway resolves.
						 */
						handoffAgentId: z.string().min(1).optional(),
						/**
						 * handoff-only: the transition moment before the swap — an optional
						 * announcement spoken in the SOURCE agent's voice, then hold music
						 * while the target takes over. `holdSeconds` 0 disables the music;
						 * omitted → a short runtime default so handoffs feel deliberate
						 * rather than abrupt. Voice-channel only (text sessions skip both).
						 */
						handoff: z
							.object({
								/**
								 * How the swap presents to the contact:
								 *   "announced" (default) — two beats: the SOURCE agent sends the
								 *     `say` bridge ("hold tight, passing you to {{agent_name}}"),
								 *     then the TARGET agent opens with its own entry greeting.
								 *     On voice the hold music may still cover the swap.
								 *   "seamless" — the target just continues the SAME conversation:
								 *     NO source bridge, NO target self-intro, NO hold music. To the
								 *     contact it feels like one continuous conversation.
								 * Default "announced" preserves the pre-mode behavior (a handoff
								 * that set a `say` + music still says + plays + the target greets).
								 */
								mode: z.enum(["seamless", "announced"]).optional(),
								say: z.string().optional(),
								/** When absent/false (default): `say` is the announcement spoken
								 * VERBATIM in the SOURCE agent's voice. When true: `say` is a
								 * DIRECTION the SOURCE agent's model speaks a fresh, natural
								 * announcement from — in the caller's current language +
								 * persona/style — via the same generateReply-from-direction path
								 * statements/greetings use. */
								generate: z.boolean().optional(),
								holdSeconds: z.number().min(0).max(30).optional(),
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
				if (node.kind === "handoff") {
					if (!node.handoffAgentId) {
						ctx.addIssue({
							code: "custom",
							message: `handoff node "${node.id}" must define handoffAgentId (the target agent)`,
						});
					}
					if (node.exits.length > 0) {
						ctx.addIssue({
							code: "custom",
							message: `handoff node "${node.id}" must have no exits — it hands the call off to another agent one-way and is terminal for this flow`,
						});
					}
				}
				if (node.kind === "stop_responding" && node.exits.length > 0) {
					ctx.addIssue({
						code: "custom",
						message: `stop_responding node "${node.id}" must have no exits — it parks the contact (agent stops responding, session keeps listening) and only a global scenario can move them onward`,
					});
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
			/**
			 * Optional CRM contact-field target the consuming SaaS writes the call
			 * summary to after the call. The ENGINE never reads this — it's a
			 * SaaS-side sync target that simply rides on the config so it
			 * round-trips through save/publish without being stripped.
			 */
			summaryField: z.string().nullish(),
			/**
			 * Whether the consuming SaaS posts a timeline note (summary + captured
			 * values) to the CRM contact after the call. Like `summaryField`, the
			 * ENGINE never reads this — it's a SaaS-side sync flag that rides on the
			 * config so it round-trips through save/publish. Optional: when absent the
			 * SaaS falls back to its own per-source default.
			 */
			writeNote: z.boolean().optional(),
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

	/**
	 * "Keep the conversation going" — CloseBot-style rapport/upsell continuation,
	 * TEXT/SMS only. Default OFF, so existing agents are unchanged. When enabled,
	 * once the flow reaches its natural terminal (all required objectives gathered,
	 * no forward node) the room-less text convo-runner does NOT end the
	 * conversation; instead it keeps a light, natural rapport/upsell conversation
	 * going — driven by the agent's goal/persona + the rolling summary — until the
	 * contact clearly disengages (a short/negative reply, "no thanks", "stop", …),
	 * then wraps up gracefully with a brief goodbye.
	 *
	 * Scope: the TEXT path (convo-runner). VOICE is unaffected — the terminal
	 * end_call gating still ends calls exactly as before; this never makes a voice
	 * call refuse to end. SaaS builder UI wiring is a follow-up; the engine honors
	 * the flag now so it can be turned on via config.
	 */
	continueConversation: z.boolean().default(false),
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
 * True when a node marked `channels` runs on `channel`. A node with no
 * `channels` mark (the default) runs on BOTH channels. An empty or
 * both-channels mark is treated as "no restriction".
 */
export function channelAllows(channels: ChannelT[] | undefined, channel: ChannelT): boolean {
	if (!channels || channels.length === 0) return true;
	const hasVoice = channels.includes("voice");
	const hasText = channels.includes("text");
	if (hasVoice && hasText) return true;
	return channels.includes(channel);
}

/** First exit target of a node (the "Next"-style primary edge), or undefined. */
function primaryExitTargetOf(node: FlowNode | undefined): string | undefined {
	if (!node || node.exits.length === 0) return undefined;
	const withTarget = node.exits.find((exit) => exit.target);
	return (withTarget ?? node.exits[0])?.target;
}

/**
 * Prune every node that does not run on `channel` and splice the graph back
 * together so it stays connected — the runtime counterpart of the SaaS
 * compiler's `pruneFlowForChannel`. The gateway serves BOTH channels from the
 * same published `config.flow`; the turn-based conversation runner (text/SMS)
 * runs the text-pruned spec so voice-only nodes (e.g. `transfer` — announcement
 * + hold music + voice swap / SIP forward, which the SaaS compiler always marks
 * voice-only) are skipped automatically, with edges re-pointed PAST them rather
 * than dead-ending the conversation.
 *
 *  - A node whose `channels` excludes `channel` is removed.
 *  - Any edge (exit target, entry, scenario target) that pointed at a pruned
 *    node is re-pointed to that node's primary exit target — transitively, so a
 *    chain of pruned nodes collapses to the first surviving node past it.
 *  - A pruned chain that dead-ends (or cycles among pruned nodes) resolves to
 *    undefined — the edge simply ends there (the conversation ends / leaf exit).
 *
 * Nodes marked for BOTH channels (the default — no mark) always survive, so a
 * flow with no channel marks is returned UNCHANGED (same reference — zero cost).
 */
export function pruneFlowForChannel(flow: Flow, channel: ChannelT): Flow {
	const prunedIds = new Set(
		flow.nodes.filter((node) => !channelAllows(node.channels, channel)).map((node) => node.id),
	);
	if (prunedIds.size === 0) return flow;

	const byId = new Map(flow.nodes.map((node) => [node.id, node]));

	const resolve = (id: string | undefined, seen: Set<string> = new Set()): string | undefined => {
		if (!id || !prunedIds.has(id)) return id;
		if (seen.has(id)) return undefined; // cycle among pruned nodes
		seen.add(id);
		return resolve(primaryExitTargetOf(byId.get(id)), seen);
	};

	const nodes = flow.nodes
		.filter((node) => !prunedIds.has(node.id))
		.map((node) => ({
			...node,
			exits: node.exits.map((exit) => ({ ...exit, target: resolve(exit.target) })),
		}));

	const scenarios = flow.scenarios
		.map((scenario) => ({ ...scenario, target: resolve(scenario.target) }))
		.filter((scenario): scenario is FlowScenario => scenario.target !== undefined);

	return { ...flow, entry: resolve(flow.entry) ?? "", nodes, scenarios };
}

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
