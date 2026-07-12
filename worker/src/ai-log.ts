import type { llm } from "@livekit/agents";
import { reportEvent } from "./gateway.js";

/**
 * AI-decision logging (`ai.turn` call events): one structured event per LLM
 * call the worker makes, carrying the request messages + response text so the
 * SaaS "AI logs" panel can show exactly what the model saw and said. Rides the
 * existing call-events pipeline (reportEvent → gateway /internal/calls/:id/events
 * → call_events), no new storage.
 *
 * Payloads are hot-path adjacent (judge/summary/router run per caller turn), so
 * every text field is capped at AI_LOG_CAP chars; truncation is flagged in the
 * payload rather than silent.
 */

export const AI_LOG_CAP = 16_384;

/**
 * Derive the API provider label from a resolved model id. Roles now run on
 * different providers (OpenAI judge/summary/router, xAI/Anthropic respond, …),
 * so the `ai.turn` badge must reflect the model that actually ran rather than a
 * single hardcoded runtime. Namespaced ids (`openai/gpt-4o-mini`) and bare ids
 * (`gpt-4o-mini`, `grok-4-fast`, `claude-sonnet-5`) are both recognized.
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

export function capText(text: string): { text: string; truncated: boolean } {
	if (text.length <= AI_LOG_CAP) return { text, truncated: false };
	return { text: `${text.slice(0, AI_LOG_CAP)}… [truncated]`, truncated: true };
}

/**
 * Cap an arbitrary JSON value for event payloads: small values pass through
 * untouched (stay structured/pretty in the UI); oversized ones are replaced by
 * a truncated JSON string marker.
 */
export function capJson(value: unknown): unknown {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "null";
	} catch {
		return { truncated: true, note: "unserializable value" };
	}
	if (serialized.length <= AI_LOG_CAP) return value;
	return { truncated: true, cap_chars: AI_LOG_CAP, json: `${serialized.slice(0, AI_LOG_CAP)}…` };
}

export interface AiLogMessage {
	role: string;
	content: string;
	truncated?: boolean;
}

/** Flatten a ChatContext into loggable {role, content} messages (capped). */
export function chatCtxMessages(chatCtx: llm.ChatContext): AiLogMessage[] {
	const out: AiLogMessage[] = [];
	for (const item of chatCtx.items) {
		if (item.type !== "message") continue;
		const msg = item as llm.ChatMessage;
		const raw = msg.textContent ?? "";
		const { text, truncated } = capText(raw);
		out.push({ role: msg.role, content: text, ...(truncated ? { truncated: true } : {}) });
	}
	return out;
}

export interface AiTurnLog {
	/** Which engine subsystem made the call. */
	class: "respond" | "judge" | "summary" | "router";
	/** Human title for the log row ("Agent node — qualify", "Objective judge", …). */
	title: string;
	model: string | null;
	promptTokens: number;
	completionTokens: number;
	/** The request messages the model saw (already capped), or null when the
	 * request isn't capturable (session-driven responder turns). */
	request: AiLogMessage[] | null;
	/** The raw completion text (capped here), or null when unavailable. */
	response: string | null;
	/** Extra context (node id, attempt number, …). */
	extra?: Record<string, unknown>;
}

/** Fire-and-forget `ai.turn` call event. Never throws, never blocks speech. */
export function reportAiTurn(callId: string, log: AiTurnLog): void {
	const response = log.response != null ? capText(log.response) : null;
	reportEvent(callId, "ai.turn", {
		class: log.class,
		title: log.title,
		provider: providerFromModel(log.model),
		model: log.model,
		prompt_tokens: log.promptTokens,
		completion_tokens: log.completionTokens,
		request: log.request,
		response: response?.text ?? null,
		...(response?.truncated || log.request?.some((m) => m.truncated)
			? { truncated: true, cap_chars: AI_LOG_CAP }
			: {}),
		...(log.extra ?? {}),
	});
}
