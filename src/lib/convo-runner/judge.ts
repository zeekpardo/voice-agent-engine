import type { FlowNode, FlowObjective } from "@voice-engine/shared/agent-config";
import { z } from "zod";
import { env } from "../../env.js";
import { chatComplete, openaiComplete } from "../llm.js";
import { resolveToolDef } from "./tools.js";
import { invokeWriteTool } from "./tools.js";
import { type ObjectiveProgress, recordUsage, type TurnContext } from "./types.js";
import { upsertContactState } from "./util.js";

/**
 * Objective judging for the turn-runner — the gateway-side port of the worker's
 * flow/objectives.ts judge pass. After each inbound message a cheap judge model
 * rates each unmet objective; a confident answer marks it met, auto-writes the
 * value through config.fieldWriteToolId, and the orchestrator takes the node's
 * primary exit once every required objective is verified.
 *
 * Ported: first-time completion, per-objective sensitivity threshold,
 * skipIfKnown (start met from known contact data), maxAttempts (stop gating
 * after N turns), required-gating, field auto-write with picklist snapping.
 * DEFERRED for v1 (documented): corrections of already-met objectives and
 * aggregate objectives — an aggregate is marked non-gating so it can't wedge a
 * required exit; its parts still record normally.
 */

const OBJECTIVE_JUDGE_SYSTEM =
	'You evaluate whether data-collection objectives for a conversation have been satisfied so far. Respond with ONLY a JSON object — no prose, no code fences — of the form {"checks":[{"key":"<objective key>","rating":<0-100>,"answer":"<extracted value or empty string>"}]}. For each objective under "To collect" include exactly one check. rating is your confidence that the PERSON explicitly provided the information (100 = clearly provided, 0 = not provided at all). Extract answer from what the person actually said. NEVER invent or assume a value the person did not state; if the information was not provided, rating must be low and answer empty. When an objective lists allowed values, answer must be exactly one of them, chosen from what the person said. Some objectives are CONDITIONAL ("if X, …"): when the conversation clearly shows the condition does NOT apply, the objective is satisfied — rate it 100 with answer "N/A".';

const judgeOutputSchema = z.object({
	checks: z.array(
		z.object({
			key: z.string(),
			rating: z.coerce.number().catch(0),
			answer: z.string().catch(""),
		}),
	),
});

const DEFAULT_THRESHOLD = 90;
const objectiveThreshold = (o: FlowObjective): number => Math.min(100, Math.max(10, o.sensitivity ?? DEFAULT_THRESHOLD));

/**
 * (Re)arm the objective progress map for a node, applying skipIfKnown from the
 * current contactState. Rebuilt fresh whenever the conversation enters a node
 * (state.objectivesNode mismatch). Aggregate objectives are marked skipped
 * (deferred in v1) so they never gate the exit.
 */
export function armObjectives(ctx: TurnContext, node: FlowNode): void {
	const objectives = node.objectives ?? [];
	const map: Record<string, ObjectiveProgress> = {};
	for (const o of objectives) {
		const progress: ObjectiveProgress = { met: false, attempts: 0, skipped: false };
		if (o.aggregateOf?.length) {
			// Aggregates are deferred in v1 — mark non-gating so a config that uses
			// them isn't wedged waiting on an objective the judge never completes.
			progress.skipped = true;
		} else if (o.skipIfKnown !== false && o.field) {
			const known = ctx.state.contactState.find((e) => e.key === o.field);
			if (known && known.value != null && known.value !== "") {
				progress.met = true;
				progress.rating = 100;
				progress.answer = known.value;
				ctx.events.push({
					type: "conversation.objective",
					payload: { node: node.id, key: o.key, rating: 100, answer: known.value.slice(0, 200), source: "known" },
				});
			}
		}
		map[o.key] = progress;
	}
	ctx.state.objectives = map;
	ctx.state.objectivesNode = node.id;
}

/** Every required, non-skipped objective is met (or skipped) → exit may be taken. */
export function allRequiredMet(node: FlowNode, ctx: TurnContext): boolean {
	for (const o of node.objectives ?? []) {
		if (!(o.required ?? true)) continue;
		const p = ctx.state.objectives[o.key];
		if (!p) return false;
		if (!p.met && !p.skipped) return false;
	}
	return true;
}

async function writeObjectiveField(ctx: TurnContext, objective: FlowObjective, answer: string): Promise<void> {
	if (!objective.field || !answer || answer.toUpperCase() === "N/A") return;
	// Snap to the exact picklist option when one matches case-insensitively.
	const option = objective.options?.find((v) => v.toLowerCase() === answer.toLowerCase());
	const written = option ?? answer;
	// Reflect into contactState so a later node's prompt shows it instead of UNRESOLVED.
	upsertContactState(ctx.state.contactState, objective.field, written);
	const tool = resolveToolDef(ctx.tools, ctx.config.fieldWriteToolId);
	if (!tool) {
		ctx.events.push({
			type: "conversation.objective_write_skipped",
			payload: { key: objective.key, field: objective.field, reason: "no field-write tool registered" },
		});
		return;
	}
	await invokeWriteTool(tool, ctx, { field_name: objective.field, value: written }).catch((err) => {
		ctx.events.push({
			type: "conversation.objective_write_failed",
			payload: { key: objective.key, field: objective.field, error: err instanceof Error ? err.message : String(err) },
		});
	});
}

/**
 * Run one judge pass over the current transcript for the node's unmet
 * objectives, recording completions + field writes. Mutates ctx.state.objectives
 * in place. Swallows judge/transport errors (objective progression degrades
 * gracefully rather than failing the turn).
 */
export async function judgeObjectives(ctx: TurnContext, node: FlowNode): Promise<void> {
	const objectives = node.objectives ?? [];
	const unmet = objectives.filter((o) => {
		if (o.aggregateOf?.length) return false;
		const p = ctx.state.objectives[o.key];
		return p && !p.met && !p.skipped;
	});
	if (unmet.length === 0) return;

	const transcript = ctx.turns
		.filter((t) => t.role !== "system")
		.slice(-40)
		.map((t) => `${t.role === "user" ? "person" : "agent"}: ${t.text}`)
		.join("\n");

	const objLine = (o: FlowObjective): string =>
		`- key "${o.key}": ${o.description}${o.options ? ` — allowed values: ${o.options.map((v) => `"${v}"`).join(", ")}` : ""}`;

	// Judge model selection, mirroring the responder's provider precedence
	// (index.ts): an explicit per-node/per-agent override always wins; otherwise
	// prefer OpenAI (gpt-5-mini, warmer objective judging) when OPENAI_API_KEY is
	// set; otherwise fall back to the pre-existing xAI default.
	const judgeOverride = node.judge?.model ?? ctx.config.models?.judge;
	const useOpenAI = !judgeOverride && !!env.OPENAI_API_KEY;
	const judgeModel = judgeOverride ?? (useOpenAI ? env.OPENAI_JUDGE_MODEL : "grok-4-fast");
	let parsed: z.infer<typeof judgeOutputSchema> | null = null;
	try {
		const complete = useOpenAI ? openaiComplete : chatComplete;
		const res = await complete({
			model: judgeModel,
			temperature: node.judge?.temperature ?? 0,
			maxTokens: 400,
			json: true,
			messages: [
				{ role: "system", content: OBJECTIVE_JUDGE_SYSTEM },
				{ role: "user", content: `To collect:\n${unmet.map(objLine).join("\n")}\n\nConversation transcript:\n${transcript}` },
			],
		});
		recordUsage(ctx.state, "judge", res.usage.promptTokens, res.usage.completionTokens);
		const clean = res.text
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "");
		const validated = judgeOutputSchema.safeParse(JSON.parse(clean));
		if (validated.success) parsed = validated.data;
	} catch (err) {
		ctx.events.push({ type: "conversation.judge_error", payload: { node: node.id, error: err instanceof Error ? err.message : String(err) } });
	}

	if (parsed) {
		for (const check of parsed.checks) {
			const objective = objectives.find((o) => o.key === check.key);
			if (!objective || objective.aggregateOf?.length) continue;
			const progress = ctx.state.objectives[objective.key];
			if (!progress || progress.met || progress.skipped) continue;
			const answer = typeof check.answer === "string" ? check.answer.trim() : "";
			if (check.rating < objectiveThreshold(objective)) continue;
			// Picklist objectives must resolve to an exact option.
			if (objective.options && !objective.options.some((v) => v.toLowerCase() === answer.toLowerCase())) continue;
			progress.met = true;
			progress.rating = check.rating;
			progress.answer = answer;
			ctx.events.push({
				type: "conversation.objective",
				payload: { node: node.id, key: objective.key, rating: check.rating, answer: answer.slice(0, 200), source: "judge" },
			});
			await writeObjectiveField(ctx, objective, answer);
		}
	}

	// maxAttempts (CloseBot semantics): each turn that leaves the FIRST live
	// objective unmet burns one attempt on it; exhausted → it stops gating.
	const focus = objectives.find((o) => {
		if (o.aggregateOf?.length) return false;
		const p = ctx.state.objectives[o.key];
		return p && !p.met && !p.skipped;
	});
	if (focus?.maxAttempts) {
		const progress = ctx.state.objectives[focus.key]!;
		progress.attempts += 1;
		if (progress.attempts >= focus.maxAttempts) {
			progress.skipped = true;
			ctx.events.push({
				type: "conversation.objective_skipped",
				payload: { node: node.id, key: focus.key, attempts: progress.attempts },
			});
		}
	}
}
