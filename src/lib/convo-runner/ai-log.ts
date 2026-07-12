import type { ConvEvent } from "./types.js";

/**
 * `ai.turn` events for the TEXT (turn-runner) path — the gateway-side analogue of
 * the worker's worker/src/ai-log.ts. One structured event per LLM call the runner
 * makes (respond / judge / summary / router), carrying the request messages + the
 * response text so the SaaS "AI logs" drawer can render the exact same provider /
 * model / prompt-token / completion-token badges it shows for voice calls.
 *
 * The payload shape mirrors the worker's `ai.turn` EXACTLY so a single SaaS
 * renderer works across voice and text. Events ride the existing conversation-
 * event buffer (ctx.events → logConversationEvent), so they persist atomically
 * with the turn and can never throw on the conversation turn.
 *
 * Text fields are capped at AI_LOG_CAP chars (mirroring the worker) so per-turn
 * events don't bloat; truncation is flagged rather than silent.
 */

export const AI_LOG_CAP = 16_384;

function capText(text: string): { text: string; truncated: boolean } {
	if (text.length <= AI_LOG_CAP) return { text, truncated: false };
	return { text: `${text.slice(0, AI_LOG_CAP)}… [truncated]`, truncated: true };
}

/**
 * Derive the API provider label from a resolved model id — mirrors the worker's
 * providerFromModel so the two paths label identical models identically. Handles
 * namespaced (`openai/gpt-4o-mini`) and bare (`gpt-4o-mini`, `grok-4-fast`,
 * `claude-sonnet-5`) ids.
 */
export function providerFromModel(model: string | null): string {
	if (!model) return "Unknown";
	const m = model.toLowerCase();
	if (m.startsWith("openai/") || /^(gpt-|o1|o3)/.test(m)) return "OpenAI";
	if (m.startsWith("xai/") || m.startsWith("grok")) return "xAI";
	if (m.startsWith("claude") || m.startsWith("anthropic")) return "Anthropic";
	if (m.startsWith("google/") || m.startsWith("gemini")) return "Google";
	if (m.startsWith("deepseek")) return "DeepSeek";
	if (m.startsWith("moonshot") || m.startsWith("kimi")) return "Moonshot";
	if (m.startsWith("zai") || m.startsWith("glm")) return "Z.ai";
	const slash = model.indexOf("/");
	if (slash > 0) return model.charAt(0).toUpperCase() + model.slice(1, slash);
	return "Unknown";
}

export interface AiTurnInput {
	cls: "respond" | "judge" | "summary" | "router";
	/** Human label for the log row (e.g. "Agent Node", "Evaluating Objectives"). */
	title: string;
	/** Resolved model id (exact). */
	model: string;
	/** Explicit provider label; when omitted it is derived from `model`. */
	provider?: string;
	promptTokens: number;
	completionTokens: number;
	/** The messages sent to the model, or null when unavailable. */
	request: { role: string; content: string }[] | null;
	/** The completion text, or null when unavailable. */
	response: string | null;
	/** Optional flow node id this call ran under. */
	node?: string;
}

/**
 * Build an `ai.turn` ConvEvent to push into `ctx.events`. Request messages and
 * the response are capped per-field (mirrors the worker's AI_LOG_CAP behavior).
 */
export function aiTurnEvent(input: AiTurnInput): ConvEvent {
	const request =
		input.request?.map((msg) => {
			const { text, truncated } = capText(msg.content);
			return { role: msg.role, content: text, ...(truncated ? { truncated: true } : {}) };
		}) ?? null;
	const response = input.response != null ? capText(input.response) : null;
	const anyTruncated = (response?.truncated ?? false) || (request?.some((m) => m.truncated) ?? false);
	return {
		type: "ai.turn",
		payload: {
			class: input.cls,
			title: input.title,
			provider: input.provider ?? providerFromModel(input.model),
			model: input.model,
			prompt_tokens: input.promptTokens,
			completion_tokens: input.completionTokens,
			request,
			response: response?.text ?? null,
			...(anyTruncated ? { truncated: true, cap_chars: AI_LOG_CAP } : {}),
			...(input.node ? { node: input.node } : {}),
		},
	};
}
