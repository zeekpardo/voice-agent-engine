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
