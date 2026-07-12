import type { ContactStateEntryT } from "@voice-engine/shared/agent-config";

/**
 * Small pure helpers ported verbatim (behavior-wise) from the worker's
 * flow/context.ts, so the turn-runner shapes contact state and gates exits
 * exactly as the voice runtime does.
 */

/** Upsert a field into the in-memory contact state (mirrors worker upsertContactState). */
export function upsertContactState(list: ContactStateEntryT[], key: string, value: string, label?: string): void {
	if (!key) return;
	const existing = list.find((e) => e.key === key);
	if (existing) {
		existing.value = value;
	} else {
		list.push({ key, label: label ?? key, value });
	}
}

export interface TagRules {
	mustHave?: string[];
	cantHave?: string[];
}

/** Is this exit allowed given the current tag set? (mirrors worker tagRulesSatisfied). */
export function tagRulesSatisfied(tagRules: TagRules | undefined, tagSet: Set<string>): boolean {
	if (!tagRules) return true;
	if (tagRules.mustHave?.some((t) => !tagSet.has(t))) return false;
	if (tagRules.cantHave?.some((t) => tagSet.has(t))) return false;
	return true;
}

/** Opt-out / clear "we're done" phrases that end an SMS continuation gracefully. */
const DISENGAGE_RE =
	/\b(stop|unsubscribe|cancel|no thanks|no thank you|not interested|leave me alone|we'?re good|i'?m good|im good|all set|nothing else|that'?s all|thats all|no more|goodbye|good ?bye|talk later)\b/i;
/** Very short bare negatives/acks ("no", "nope", "nah", "k", "ok", "done"). */
const SHORT_NEGATIVE_RE = /^(no|nope|nah|na|k|ok|okay|done|bye|stop)[.!\s]*$/i;

/**
 * Heuristic: does this inbound text signal the contact wants to disengage? Used
 * ONLY by the SMS "keep the conversation going" continuation (config
 * .continueConversation) to decide when to wrap up gracefully — it never affects
 * the flow itself. Empty/whitespace also counts as disengagement. Intentionally
 * conservative so continuation errs toward stopping rather than pestering; hard
 * SMS STOP-keyword compliance still lives in the telephony/SaaS layer.
 */
export function isDisengageSignal(text: string): boolean {
	const t = text.trim();
	if (!t) return true;
	if (SHORT_NEGATIVE_RE.test(t)) return true;
	return DISENGAGE_RE.test(t);
}
