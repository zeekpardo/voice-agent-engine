import { interpolate } from "@voice-engine/shared/agent-config";
import type { FlowNode } from "@voice-engine/shared/agent-config";
import type { ChatMessage } from "../llm.js";
import type { ConvTurn, TurnContext } from "./types.js";

/**
 * System-prompt composition for a turn — the gateway-side, text-channel port of
 * the worker's flow/agent-builder instruction assembly. Ported concepts:
 * global instructions + current-stage instructions + objectives block +
 * conversation-mode block + rolling summary (## CONVERSATION SO FAR) + known
 * contact info (## KNOWN CONTACT INFO, with the UNRESOLVED sentinel) +
 * continuity rules + prohibited words.
 *
 * Deliberately DROPPED vs voice (not applicable to async text): pacing/spoken
 * rules, "MOVING BETWEEN STAGES" exit-tool instructions (v1 has no
 * model-callable exits), scenario tools, transfer/handoff wording. The engine
 * stays neutral — no phone/SMS/channel vocabulary; the person is "the person
 * you're talking to".
 */

const CONTINUITY =
	"\n\n## CONTINUITY\nThis is ONE continuous conversation. Do not greet the person again or re-introduce yourself after it has started. Never repeat a question that was already answered — check the conversation before asking. Reply with a single, natural message; ask at most one question at a time.";

function contactInfoBlock(ctx: TurnContext): string {
	if (ctx.state.contactState.length === 0) return "";
	return `\n\n## KNOWN CONTACT INFO\nYou already know these details about the person. NEVER ask for a value shown here — if you need one, weave it in or confirm it naturally instead of asking. A field shown as UNRESOLVED is still unknown; those you MAY ask about. Never write the word "UNRESOLVED".\n${ctx.state.contactState
		.map((e) => `${e.label} -> ${e.value != null && e.value !== "" ? e.value : "UNRESOLVED"}`)
		.join("\n")}`;
}

function summaryBlock(ctx: TurnContext): string {
	const summary = ctx.state.rollingSummary.trim();
	if (!summary) return "";
	return `\n\n## CONVERSATION SO FAR\nEarlier parts of this conversation, condensed (the most recent messages are still verbatim below). Use this for continuity — never re-ask something already covered here:\n${summary}`;
}

function prohibitedBlock(ctx: TurnContext): string {
	const words = ctx.config.prohibitedWords ?? [];
	if (words.length === 0) return "";
	return `\n\n## PROHIBITED\nNever use the following words or phrases: ${words.map((w) => `"${w}"`).join(", ")}.`;
}

/**
 * Build the system prompt for the current turn. `node` is the active agent flow
 * node, or undefined for a single-agent (flow-less) config.
 */
export function buildSystemPrompt(ctx: TurnContext, node: FlowNode | undefined): string {
	const interp = (s: string) => interpolate(s, ctx.state.variables);
	const global = interp(ctx.config.instructions);

	if (!node) {
		return global + summaryBlock(ctx) + contactInfoBlock(ctx) + CONTINUITY + prohibitedBlock(ctx);
	}

	const conversation = node.conversation;
	const isConversation = !!conversation;
	const objectives = isConversation ? [] : (node.objectives ?? []);
	const hasObjectives = objectives.length > 0;

	const stageBlock = `\n\n## YOUR CURRENT STAGE\n${interp(node.instructions)}`;

	const conversationReasonBlock = isConversation
		? `\n\n## CONVERSATION REASON\n${interp(conversation!.reason)}${
				conversation!.hints?.length
					? `\n\nTalking points you can naturally explore (not a checklist — follow the person's lead, one question at a time):\n${conversation!.hints
							.map((h) => `- ${interp(h)}`)
							.join("\n")}`
					: ""
			}`
		: "";

	const objectivesBlock = hasObjectives
		? `\n\n## OBJECTIVES\nIn this stage you must learn the following from the person, naturally and ONE question at a time:\n${objectives
				.map(
					(o) =>
						`- ${o.description}${o.options ? ` (record as one of: ${o.options.join(", ")})` : ""}${
							(o.required ?? true) ? "" : " (optional — don't push if they decline)"
						}`,
				)
				.join(
					"\n",
				)}\nThe system verifies these automatically as the person answers and advances the conversation to the next stage on its own — never announce a stage change or rush the person, and do not try to save these specific values yourself; they are recorded automatically.`
		: "";

	return (
		global +
		stageBlock +
		conversationReasonBlock +
		objectivesBlock +
		summaryBlock(ctx) +
		contactInfoBlock(ctx) +
		CONTINUITY +
		prohibitedBlock(ctx)
	);
}

/**
 * Assemble the chat messages for a responder call: the system prompt plus the
 * recent conversation history mapped to user/assistant roles. `windowTurns`
 * bounds how many verbatim turns ride along (older context lives in the rolling
 * summary inside the system prompt).
 */
export function buildResponderMessages(system: string, turns: ConvTurn[], windowTurns: number): ChatMessage[] {
	const convo = turns.filter((t) => t.role !== "system");
	const window = convo.slice(-windowTurns);
	const messages: ChatMessage[] = [{ role: "system", content: system }];
	for (const t of window) {
		messages.push({ role: t.role === "user" ? "user" : "assistant", content: t.text });
	}
	return messages;
}
