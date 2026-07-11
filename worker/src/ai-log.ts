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
		provider: "livekit-inference",
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
