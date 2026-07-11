import type { JobContext, inference, voice } from "@livekit/agents";
import { inference as inferenceNs, llm } from "@livekit/agents";
import type { JSONSchema7 } from "json-schema";
import type {
	AgentBundle,
	AgentConfig,
	ContactStateEntryT,
	DispatchMetadata,
	FlowNode,
	ToolDef,
} from "../gateway.js";

/**
 * Shared runtime context for the flow subsystem (spec §7). main.ts's entry
 * closure used to capture all of this state directly; the flow modules
 * (router, transfer, agent-builder) and session-lifecycle now take this
 * explicit context instead — the same pattern flow/objectives.ts established
 * with ObjectivesDeps.
 *
 * Values constructed later than the flow wiring (the AgentSession, the real
 * hangUp, the completion flag) are reached through the shared FlowRuntimeState
 * holder / lazy getters, never captured by value.
 */

const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * {{variables}} → values. Unknown placeholders stay visible in MODEL-facing
 * text (instructions) — the model is told about them via the missing-context
 * block — but must never reach TTS verbatim: use interpolateSpoken for
 * anything spoken word-for-word.
 */
export function interpolate(template: string, variables: Record<string, string>): string {
	return template.replace(VAR_RE, (whole, name: string) =>
		Object.hasOwn(variables, name) ? variables[name]! : whole,
	);
}

/**
 * For text spoken VERBATIM (greeting, statement lines): unresolved
 * placeholders are stripped and the sentence tidied, so the caller never
 * hears "curly brace seller underscore name".
 */
export function interpolateSpoken(template: string, variables: Record<string, string>): string {
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
export function collectMissingVars(
	template: string | undefined,
	variables: Record<string, string>,
	into: Set<string>,
): void {
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

export function inferenceModel(model: string | undefined, provider: string, fallback: string): string {
	if (!model) return fallback;
	if (model.includes("/")) return model;
	return LLM_ALIASES[model] ?? `${provider}/${model}`;
}

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
export function buildTts(tts: AgentConfig["tts"]) {
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
	return new inferenceNs.TTS({
		model,
		voice: tts.voice,
		...(modelOptions ? { modelOptions } : {}),
	} as ConstructorParameters<typeof inference.TTS>[0]);
}

export type TtsInstance = ReturnType<typeof buildTts>;

/** A single transcript turn as recorded off the session's ConversationItemAdded. */
export interface Turn {
	role: "agent" | "user" | "system";
	text: string;
	ts?: number;
}

/**
 * Per-call-class LLM usage (Phase 4). The engine makes four distinct kinds of
 * model call and they used to be metered together (or not at all): `respond`
 * (the responder the caller hears — session MetricsCollected), `judge` (the
 * async objective judge), `summary` (the rolling-memory refresh), and `router`
 * (a router node's one-shot evaluation). The recorder accumulates tokens+calls
 * per class so the completion report can carry a per-class breakdown alongside
 * the legacy total meters.
 */
export type UsageClass = "respond" | "judge" | "summary" | "router";
export interface ClassUsage {
	tokensIn: number;
	tokensOut: number;
	calls: number;
}
export const USAGE_CLASSES: readonly UsageClass[] = ["respond", "judge", "summary", "router"];
export interface UsageRecorder {
	/** Add one LLM call's usage to its class. Missing token counts default to 0. */
	record(cls: UsageClass, tokensIn: number, tokensOut: number): void;
	/** Per-class accumulated usage (live view of the internal map). */
	byClass(): Record<UsageClass, ClassUsage>;
	/** Summed tokens across every class (the legacy llm_tokens_in/out meters). */
	totals(): { tokensIn: number; tokensOut: number };
}

export function createUsageRecorder(): UsageRecorder {
	const map: Record<UsageClass, ClassUsage> = {
		respond: { tokensIn: 0, tokensOut: 0, calls: 0 },
		judge: { tokensIn: 0, tokensOut: 0, calls: 0 },
		summary: { tokensIn: 0, tokensOut: 0, calls: 0 },
		router: { tokensIn: 0, tokensOut: 0, calls: 0 },
	};
	return {
		record(cls, tokensIn, tokensOut) {
			const c = map[cls];
			c.tokensIn += tokensIn || 0;
			c.tokensOut += tokensOut || 0;
			c.calls += 1;
		},
		byClass: () => map,
		totals: () => ({
			tokensIn: USAGE_CLASSES.reduce((s, k) => s + map[k].tokensIn, 0),
			tokensOut: USAGE_CLASSES.reduce((s, k) => s + map[k].tokensOut, 0),
		}),
	};
}

/** Resolved per-class model tiers (config.models). A tier is the DEFAULT model
 * for that call class; per-node overrides (node.llm / node.judge.model) win. */
export interface ResolvedModels {
	respond?: string;
	judge?: string;
	summary?: string;
	router?: string;
}

/**
 * Mutable runtime slots that flow modules read lazily but session-lifecycle
 * owns and writes. Threaded so the flow wiring can reference the session /
 * hangUp / completion state that only exists after the session is built.
 */
export interface FlowRuntimeState {
	/** The AgentSession, assigned by session-lifecycle once constructed. */
	session?: voice.AgentSession;
	/** Agent-initiated hangup — the real implementation is installed by
	 * session-lifecycle; a no-op until then (nothing fires before go-live). */
	hangUp: (reason: string) => Promise<void>;
	/** True once call completion has been reported (idempotency guard). */
	completed: boolean;
	/** True while a simulated warm transfer (announcement + hold music) plays;
	 * the SpeechCreated guard discards any LLM speech while set. */
	transferInFlight: boolean;
	/** Stamped by buildFlowAgent on every node→node swap (and by the transfer /
	 * handoff sequences). The end_call tool refuses to fire within a short window
	 * of this — a model that emits end_call IN THE SAME TURN as an exit tool
	 * (parallel tool calls) would otherwise kill the call mid-transition. */
	lastTransitionAt?: number;
	/** True from the moment an exit to a REAL next node is COMMITTED (model exit
	 * tool executing, or the objectives judge deciding to advance) until that next
	 * node actually enters. The lastTransitionAt 5s window only covers the tail
	 * AFTER a swap; it does NOT cover the objectives path, where seconds can pass
	 * between "objectives met" and the new node entering (waitForAgentIdle). end_call
	 * also refuses while this is set, so a model that emits end_call in the same turn
	 * as an exit — or during the judge's idle-wait — can't kill the call mid-transition.
	 * Cleared once the next node enters (buildFlowAgent onEnter) or the transition aborts. */
	transitionPending: boolean;
	/** Whether the CURRENT flow node is terminal (no regular exit routes onward to a
	 * next node). Published by buildFlowAgent onEnter; read by the shared end_call
	 * tool, which refuses to hang up on a NON-terminal node so the model can't close
	 * the call while stages remain — it must take the forward exit instead. Defaults
	 * true (a single-agent, no-flow config is inherently terminal). */
	currentNodeTerminal: boolean;
	/** Post-transfer voice: applied to every agent built after the switch. */
	ttsOverride?: TtsInstance;
	/** Soft per-node wrap-up timer for a conversation node's maxDurationSeconds
	 * (Phase 2). Re-armed on every node entry (cleared first) and on teardown, so
	 * at most one is ever live. */
	conversationTimer?: ReturnType<typeof setTimeout>;
	/** Per-class LLM usage recorder (Phase 4). Every model call — the responder
	 * (via session MetricsCollected), the objective judge, the rolling-summary
	 * refresh, and router evaluations — tags its tokens here so the completion
	 * report carries a per-class breakdown plus the summed legacy total meters. */
	usage: UsageRecorder;
	/**
	 * Active per-caller-turn hooks (objective judge + rolling-memory refresh),
	 * read fresh by session-lifecycle's ConversationItemAdded listener on every
	 * caller turn. A MUTABLE holder so an agent-handoff (flow `handoff` node) can
	 * swap in the NEW agent's trackers when it calls session.updateAgent — the old
	 * agent's trackers stop firing, the target's take over. Populated once by
	 * main.ts for the call's own agent; re-pointed by flow/handoff on each handoff.
	 */
	turnHooks: { objective?: () => void; memory?: () => void };
}

/** Resolved rolling-memory settings (config.memory with defaults applied). */
export interface ResolvedMemory {
	enabled: boolean;
	intervalTurns: number;
	windowTurns: number;
	model?: string;
}

/**
 * Everything the flow subsystem needs from the surrounding call. Constructed
 * once per job in main.ts and threaded into the flow module factories.
 */
export interface FlowRuntimeContext {
	// identity + pinned config
	job: JobContext;
	dispatch: DispatchMetadata;
	config: AgentConfig;
	bundle: AgentBundle;
	variables: Record<string, string>;
	endCallEnabled: boolean;
	flow: NonNullable<AgentConfig["flow"]>;
	nodesById: Map<string, FlowNode>;

	// live transcript (shared with session-lifecycle + objectives)
	turns: Turn[];

	/**
	 * Per-call known-contact data (Phase 1). A MUTABLE holder (stable array
	 * reference, mutated in place via upsertContactState) so a field write in one
	 * node is reflected in the next node's prompt rebuild. Opaque to the engine —
	 * generic key/label/value, no CRM meaning. Empty array when the dispatch
	 * carried none.
	 */
	contactState: ContactStateEntryT[];

	/**
	 * Per-call in-memory tag set (Phase 5b — tag-driven exit routing). Seeded
	 * from dispatch `contactTags`; every tag added via a modify_tags node / the
	 * config tag-write tool is inserted and every removed tag is deleted, so exit
	 * `tagRules` gate against the live set. A stable Set reference threaded into
	 * router (writes on modify_tags) + agent-builder (reads to gate exits).
	 * Mid-node tag changes take effect at the next node handoff (per-node build).
	 */
	contactTags: Set<string>;

	/**
	 * Rolling in-call summary holder (Phase 3). A stable-reference mutable object
	 * (like contactState): flow/memory.ts writes `.text` after each async refresh,
	 * agent-builder reads it into every node's `## CONVERSATION SO FAR` block.
	 * Empty string until the first interval fires; a stale value is always fine.
	 */
	rollingSummary: { text: string };
	/** Resolved rolling-memory settings (config.memory + defaults). */
	memory: ResolvedMemory;

	// lazy runtime, owned by session-lifecycle
	readonly session: voice.AgentSession;
	hangUp(reason: string): Promise<void>;
	isCompleted(): boolean;
	/** Shared mutable holder (transferInFlight / ttsOverride live here). */
	state: FlowRuntimeState;

	// interpolation helpers, pre-bound to this call's variables
	interpolate(template: string): string;
	interpolateSpoken(template: string): string;

	// model/voice builders
	buildLlm(over?: { model?: string; temperature?: number; maxTokens?: number }): inference.LLM;
	defaultLlm: inference.LLM;
	buildTts: typeof buildTts;
	/** Per-class usage recorder (Phase 4) — bound to state.usage.record. Router
	 * evaluations (owned by flow/router.ts, which reads ctx) tag "router" here. */
	recordUsage(cls: UsageClass, tokensIn: number, tokensOut: number): void;
	/** Resolved per-class model tiers (config.models + defaults). */
	models: ResolvedModels;

	// prompt fragments assembled once, inherited by every node
	globalInstructions: string;
	pacingRules: string;
	/** Voice-only "reply in the caller's current language" rule (empty on text). */
	languageRules: string;
	/** Text-only "don't read back typed values character by character" rule (empty
	 * on voice, where read-back confirmation of critical fields is correct). */
	textRules: string;
	/** Per-agent phrasing/tone directive (`## RESPONSE STYLE` block), empty when
	 * the agent sets no responseStyle. Inherited by every node so all generation
	 * follows it. */
	responseStyle: string;
	missingNote: string;
	prohibited: string;

	// Config-designated write tools, resolved once from config.fieldWriteToolId /
	// config.tagWriteToolId (engine neutrality — no hardcoded CRM tool names).
	// Undefined when the project registers no such tool. A set_field / modify_tags
	// node may override per-node via resolveToolDef(node.…​.toolId).
	fieldWriteDef?: ToolDef;
	tagWriteDef?: ToolDef;
	/** Config-designated tag-REMOVAL tool (config.tagRemoveToolId — Phase 5b).
	 * modify_tags removals invoke this. Undefined when the project registers no
	 * such tool (removal is then a logged no-op, but the tag set still updates). */
	tagRemoveDef?: ToolDef;
	/** Resolve a config tool id (ToolDef.name, then ToolDef.id) to its def, or
	 * fall back to the given default when the id is unset/unknown. */
	resolveToolDef(toolId: string | undefined, fallback: ToolDef | undefined): ToolDef | undefined;
	endCallTool: ReturnType<typeof llm.tool>;
	EMPTY_PARAMS: JSONSchema7;
}

/** Look up a config tool by its designated id (ToolDef.name first — that's how
 * the historical update_contact/add_tag defaults resolve — then ToolDef.id). */
export function findToolDef(tools: ToolDef[], toolId: string | undefined): ToolDef | undefined {
	if (!toolId) return undefined;
	return tools.find((t) => t.name === toolId) ?? tools.find((t) => t.id === toolId);
}

/**
 * Reflect a successful field write into the in-memory contactState (Phase 1
 * live updates): match an existing entry by `key` and overwrite its value, or
 * append a best-effort entry when the written field isn't in the list yet. The
 * next node's prompt rebuild then shows the value instead of UNRESOLVED. Mutates
 * the array in place so the shared reference stays live. `key` is the opaque
 * field identifier (objective.field / setField.field) — matched against the
 * entry key with no CRM interpretation.
 */
export function upsertContactState(
	list: ContactStateEntryT[],
	key: string,
	value: string,
	label?: string,
): void {
	if (!key) return;
	const existing = list.find((e) => e.key === key);
	if (existing) {
		existing.value = value;
	} else {
		// Best-effort label when the write targets a field not in the injected
		// list: fall back to the raw key so the prompt still reads sensibly.
		list.push({ key, label: label ?? key, value });
	}
}

/** An exit's optional tag-gating rules (Phase 5b). */
export interface TagRules {
	mustHave?: string[];
	cantHave?: string[];
}

/**
 * Tag-driven exit gating (Phase 5b): is this exit allowed given the call's
 * current tag set? An exit with no tagRules is always allowed. `mustHave`: every
 * listed tag must be present. `cantHave`: none of the listed tags may be present.
 * Deterministic, zero LLM cost. `tagSet` is the worker's live in-memory set,
 * seeded from dispatch `contactTags` and grown as tags are written mid-call.
 */
export function tagRulesSatisfied(tagRules: TagRules | undefined, tagSet: Set<string>): boolean {
	if (!tagRules) return true;
	if (tagRules.mustHave?.some((t) => !tagSet.has(t))) return false;
	if (tagRules.cantHave?.some((t) => tagSet.has(t))) return false;
	return true;
}

/**
 * Rolling-memory compaction (Phase 3): cap what the RESPONDER model sees to the
 * last `windowTurns` verbatim conversational turns. The condensed older context
 * rides in the prompt's `## CONVERSATION SO FAR` block instead. Mutates the
 * ChatContext in place (LiveKit's `truncate` splices `_items`).
 *
 * CRITICAL: this touches ONLY a responder-facing ChatContext. The full `turns`
 * buffer (transcript flush) and the objectives judge window (which read from
 * `turns`, never from this ChatContext) stay COMPLETE. `truncate` keeps the last
 * N items, drops any leading orphaned tool call/output, and preserves a system
 * message — so the current node's most recent, unanswered turns are never
 * dropped. No-op when history already fits (or windowTurns ≤ 0).
 *
 * `windowTurns` counts conversational MESSAGES (user/assistant); we translate it
 * to the item count that spans the last `windowTurns` messages (tool call/output
 * items in that span are kept with their message).
 */
export function compactChatContext(chatCtx: llm.ChatContext, windowTurns: number): void {
	if (windowTurns <= 0) return;
	const items = chatCtx.items;
	let messages = 0;
	let keepFrom = 0;
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i]!.type === "message" && (items[i] as llm.ChatMessage).role !== "system") {
			messages++;
			if (messages >= windowTurns) {
				keepFrom = i;
				break;
			}
		}
	}
	const keepCount = items.length - keepFrom;
	if (keepCount >= items.length) return; // nothing older than the window
	chatCtx.truncate(keepCount);
}
