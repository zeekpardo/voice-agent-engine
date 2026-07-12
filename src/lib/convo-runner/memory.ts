import { env } from "../../env.js";
import { chatComplete, openaiComplete } from "../llm.js";
import { recordUsage, type TurnContext } from "./types.js";

/**
 * Rolling conversation memory for the turn-runner — the gateway-side port of
 * the worker's flow/memory.ts. Every `intervalTurns` inbound messages, a cheap
 * model condenses the turns OLDER than the live `windowTurns` window into a
 * bullet summary stored on conversation.state.rollingSummary, which the prompt
 * builder renders as `## CONVERSATION SO FAR`. The responder message window
 * (buildResponderMessages) keeps only the last `windowTurns` verbatim turns, so
 * per-turn cost plateaus instead of growing.
 *
 * Unlike voice this runs SYNCHRONOUSLY within the turn (there is no live
 * ChatContext to splice and no speech to avoid blocking); a failed refresh is
 * swallowed and the stale summary is kept.
 */

const SUMMARY_SYSTEM =
	"You maintain a running summary of an ongoing conversation. Given the earlier portion, produce a concise, factual bullet list (one short bullet per line, prefixed with '- ') capturing the durable facts, decisions, preferences, and context established so far — everything a colleague would need to continue seamlessly. Omit greetings, filler, and pleasantries. Do not invent anything. Output ONLY the bullet lines, no preamble or headings.";

/** Resolve memory settings with the schema defaults (config.memory may be absent). */
export function memorySettings(ctx: TurnContext): { enabled: boolean; intervalTurns: number; windowTurns: number; model?: string } {
	const m = ctx.config.memory;
	return {
		enabled: m?.enabled ?? true,
		intervalTurns: m?.intervalTurns ?? 10,
		windowTurns: m?.windowTurns ?? 20,
		model: m?.model,
	};
}

/**
 * Refresh the rolling summary when this inbound turn hits an interval boundary.
 * `turnCount` is the number of inbound (user) messages seen so far.
 */
export async function maybeRefreshSummary(ctx: TurnContext): Promise<void> {
	const settings = memorySettings(ctx);
	if (!settings.enabled) return;
	if (ctx.state.turnCount === 0 || ctx.state.turnCount % settings.intervalTurns !== 0) return;

	const convo = ctx.turns.filter((t) => t.role !== "system");
	const older = convo.slice(0, Math.max(0, convo.length - settings.windowTurns));
	if (older.length === 0) return;

	const transcript = older.map((t) => `${t.role === "user" ? "person" : "agent"}: ${t.text}`).join("\n");
	// Summary model selection, mirroring the judge/responder precedence (judge.ts,
	// index.ts): an explicit override (config.memory.model, then config.models.summary)
	// always wins; otherwise prefer OpenAI's cheap nano tier (OPENAI_SUMMARY_MODEL) when
	// OPENAI_API_KEY is set; otherwise fall back to the pre-existing xAI default.
	const override = settings.model ?? ctx.config.models?.summary;
	const useOpenAI = !override && !!env.OPENAI_API_KEY;
	const model = override ?? (useOpenAI ? env.OPENAI_SUMMARY_MODEL : "grok-4-fast");
	try {
		const complete = useOpenAI ? openaiComplete : chatComplete;
		const res = await complete({
			model,
			temperature: 0,
			maxTokens: 400,
			messages: [
				{ role: "system", content: SUMMARY_SYSTEM },
				{ role: "user", content: `Conversation so far (earlier portion):\n${transcript}` },
			],
		});
		recordUsage(ctx.state, "summary", res.usage.promptTokens, res.usage.completionTokens);
		const summary = res.text.trim();
		if (!summary) return;
		ctx.state.rollingSummary = summary;
		ctx.events.push({
			type: "conversation.memory_summary",
			payload: { bullets: summary.split("\n").filter((l) => l.trim()).length, condensed_turns: older.length },
		});
	} catch (err) {
		ctx.events.push({ type: "conversation.memory_error", payload: { error: err instanceof Error ? err.message : String(err) } });
	}
}
