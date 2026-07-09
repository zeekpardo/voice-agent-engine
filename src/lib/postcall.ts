import { env } from "../env.js";

/**
 * Post-call summarize + extract (spec §4 postCall). Runs gateway-side when the
 * worker flushes a transcript: one LLM pass produces a short summary and the
 * named fields the consuming app asked for (e.g. Diamond Realty's
 * { contact_made, appointment_scheduled, docs_submitted, approved }).
 *
 * Values the transcript does not explicitly support come back "unknown" —
 * the engine never assumes an outcome without confirmation.
 */

export interface PostCallConfig {
	summarize: boolean;
	extract?: Record<string, string>;
}

export interface Turn {
	role: string;
	text: string;
}

export interface PostCallResult {
	summary?: string;
	extracted?: Record<string, string>;
}

// Generous: 14-field extractions over long transcripts can exceed 20s on
// reasoning-capable models; a slow extraction beats a missing one.
const TIMEOUT_MS = 45_000;

export async function summarizeAndExtract(
	postCall: PostCallConfig,
	turns: Turn[],
): Promise<PostCallResult> {
	if (turns.length === 0) return {};
	if (!postCall.summarize && !postCall.extract) return {};

	const transcript = turns
		.map((t) => `${t.role === "agent" ? "Agent" : t.role === "user" ? "Caller" : "System"}: ${t.text}`)
		.join("\n");

	const wants: string[] = [];
	if (postCall.summarize) {
		wants.push(`"summary": a 1-3 sentence factual summary of the call`);
	}
	if (postCall.extract && Object.keys(postCall.extract).length > 0) {
		const fields = Object.entries(postCall.extract)
			.map(([name, hint]) => `    "${name}": ${hint}`)
			.join("\n");
		wants.push(`"extracted": an object with EXACTLY these keys:\n${fields}`);
	}

	const res = await fetch(`${env.XAI_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.XAI_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: env.CHAT_DEFAULT_MODEL,
			temperature: 0,
			response_format: { type: "json_object" },
			messages: [
				{
					role: "system",
					content:
						"You analyze call transcripts. Respond with a single JSON object. " +
						"Every extracted value must be a string. If the transcript does not " +
						'explicitly confirm a value, use "unknown" — never infer or assume outcomes.',
				},
				{
					role: "user",
					content: `Transcript:\n${transcript}\n\nReturn a JSON object with:\n${wants.join("\n")}`,
				},
			],
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});

	if (!res.ok) {
		throw new Error(`post-call LLM pass failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
	}

	const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	const content = data.choices?.[0]?.message?.content;
	if (!content) return {};

	const parsed = JSON.parse(content) as { summary?: unknown; extracted?: Record<string, unknown> };
	const result: PostCallResult = {};
	if (postCall.summarize && typeof parsed.summary === "string") result.summary = parsed.summary;
	if (postCall.extract && parsed.extracted && typeof parsed.extracted === "object") {
		result.extracted = {};
		// Only the requested keys survive; anything else the model added is dropped.
		for (const key of Object.keys(postCall.extract)) {
			const v = parsed.extracted[key];
			result.extracted[key] = typeof v === "string" ? v : v == null ? "unknown" : JSON.stringify(v);
		}
	}
	return result;
}
