import { env } from "../env.js";

/**
 * Thin chat-completion client for the gateway-side turn-runner (Wave 1b).
 *
 * The worker reaches models through LiveKit Inference; the gateway has no such
 * media plane, so the turn-based conversation path talks to the configured
 * provider over the OpenAI-compatible HTTP API the gateway already uses for
 * post-call summarize/extract (see lib/postcall.ts — same XAI_BASE_URL +
 * XAI_API_KEY). Engine-neutral: this only speaks the chat-completions wire
 * protocol; model ids come from the AgentConfig (config.llm.model /
 * config.models.*), never hardcoded to a vertical.
 */

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatUsage {
	promptTokens: number;
	completionTokens: number;
}

export interface ChatResult {
	text: string;
	usage: ChatUsage;
}

export interface ChatOptions {
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	maxTokens?: number;
	/** Force a JSON object response (used by the objectives judge). */
	json?: boolean;
	/** Per-call timeout; defaults to 30s (spoken-length replies are short). */
	timeoutMs?: number;
}

/**
 * One chat completion against the configured provider. Returns the assistant
 * text plus token usage (for per-turn metering). Throws on transport / non-2xx
 * so callers can decide whether to degrade (the judge/router swallow and fall
 * back; the responder surfaces the error to the caller of runTurn).
 */
export async function chatComplete(opts: ChatOptions): Promise<ChatResult> {
	const res = await fetch(`${env.XAI_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.XAI_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: opts.model,
			temperature: opts.temperature ?? 0.4,
			max_tokens: opts.maxTokens ?? 400,
			...(opts.json ? { response_format: { type: "json_object" } } : {}),
			messages: opts.messages,
		}),
		signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
	});

	if (!res.ok) {
		throw new Error(`chat completion failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
	}

	const data = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	return {
		text: data.choices?.[0]?.message?.content ?? "",
		usage: {
			promptTokens: data.usage?.prompt_tokens ?? 0,
			completionTokens: data.usage?.completion_tokens ?? 0,
		},
	};
}
