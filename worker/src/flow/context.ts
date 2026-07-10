import type { JobContext, inference, llm, voice } from "@livekit/agents";
import { inference as inferenceNs } from "@livekit/agents";
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
	/** Post-transfer voice: applied to every agent built after the switch. */
	ttsOverride?: TtsInstance;
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

	// prompt fragments assembled once, inherited by every node
	globalInstructions: string;
	pacingRules: string;
	missingNote: string;
	prohibited: string;

	// Config-designated write tools, resolved once from config.fieldWriteToolId /
	// config.tagWriteToolId (engine neutrality — no hardcoded CRM tool names).
	// Undefined when the project registers no such tool. A set_field / modify_tags
	// node may override per-node via resolveToolDef(node.…​.toolId).
	fieldWriteDef?: ToolDef;
	tagWriteDef?: ToolDef;
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
