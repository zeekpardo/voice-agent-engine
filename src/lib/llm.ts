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
	/** Reasoning-model effort hint (gpt-5 family / o-series). Only honored by
	 * openaiComplete. "minimal" keeps a reasoning model from spending its whole
	 * completion budget on hidden reasoning tokens and truncating the JSON — the
	 * objective-judge wedge. Omitted → provider default. */
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
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

/**
 * One chat completion against OpenAI's real chat-completions API (Wave: text
 * judge on gpt-5-mini). Only used by the gateway-side TEXT judge — the
 * worker's VOICE judge already reaches OpenAI via LiveKit Inference.
 *
 * Same OpenAI-compatible request/response shape as chatComplete, so this
 * reuses ChatOptions/ChatResult, but hits api.openai.com with OPENAI_API_KEY
 * instead of xAI. gpt-5 family models reject non-default sampling params
 * (like current Claude rejects them on anthropicComplete), so temperature is
 * NOT sent — the config's temperature is intentionally ignored on this path.
 */
export async function openaiComplete(opts: ChatOptions): Promise<ChatResult> {
	const res = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.OPENAI_API_KEY ?? ""}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: opts.model,
			max_completion_tokens: opts.maxTokens ?? 400,
			...(opts.json ? { response_format: { type: "json_object" } } : {}),
			...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
			messages: opts.messages,
		}),
		signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
	});

	if (!res.ok) {
		throw new Error(`openai completion failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
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

/**
 * One completion against Anthropic's Messages API (Wave: premium text models).
 *
 * The TEXT `respond` role can read warmer/more naturally on Claude than on the
 * default xAI grok. The worker's VOICE path can't reach Anthropic (LiveKit
 * Inference has no Anthropic provider), but this gateway-side turn-runner speaks
 * plain HTTP, so it can call Anthropic directly. Same ChatOptions shape as
 * chatComplete so the responder can swap providers with identical args; the
 * OpenAI-style `system` message (role "system") is lifted out to Anthropic's
 * top-level `system` param, and the remaining user/assistant turns are
 * normalized (leading assistant turns dropped, consecutive same-role turns
 * merged) so the request satisfies Anthropic's alternation rules.
 *
 * Thinking is disabled to keep replies fast and cheap (a text turn wants a
 * direct conversational reply, not a reasoning pass). Sampling params are NOT
 * sent — current Claude models reject non-default temperature — so the config's
 * temperature is intentionally ignored on this path.
 */
export async function anthropicComplete(opts: ChatOptions): Promise<ChatResult> {
	const system = opts.messages
		.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n\n");

	// Map to Anthropic turns, drop leading assistant turns (the first must be a
	// user turn), and merge any consecutive same-role turns.
	const turns: { role: "user" | "assistant"; content: string }[] = [];
	for (const m of opts.messages) {
		if (m.role === "system") continue;
		const role = m.role === "assistant" ? "assistant" : "user";
		if (turns.length === 0 && role === "assistant") continue;
		const last = turns[turns.length - 1];
		if (last && last.role === role) last.content += `\n\n${m.content}`;
		else turns.push({ role, content: m.content });
	}
	// A turn is required; if somehow empty, seed a minimal user turn.
	if (turns.length === 0) turns.push({ role: "user", content: "(no message)" });

	const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
		method: "POST",
		headers: {
			"x-api-key": env.ANTHROPIC_API_KEY ?? "",
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: opts.model,
			max_tokens: opts.maxTokens ?? 400,
			thinking: { type: "disabled" },
			...(system ? { system } : {}),
			messages: turns,
		}),
		signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
	});

	if (!res.ok) {
		throw new Error(`anthropic completion failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
	}

	const data = (await res.json()) as {
		content?: { type?: string; text?: string }[];
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	const text = (data.content ?? [])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("");
	return {
		text,
		usage: {
			promptTokens: data.usage?.input_tokens ?? 0,
			completionTokens: data.usage?.output_tokens ?? 0,
		},
	};
}
