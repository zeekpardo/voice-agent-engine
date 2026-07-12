import { llm, voice } from "@livekit/agents";
import { z } from "zod";
import { chatCtxMessages, reportAiTurn } from "../ai-log.js";
import {
	type ContactStateEntryT,
	type DispatchMetadata,
	type FlowObjective,
	type ToolDef,
	reportEvent,
} from "../gateway.js";
import { invokeTool } from "../tools.js";
import { upsertContactState } from "./context.js";

/**
 * Objective-driven nodes (voiceagent-engine/objectives-and-conversation-spec.md).
 * The conversational LLM only talks; after every caller turn a cheap judge
 * pass rates each unmet objective ASYNC (never delaying speech), auto-writes
 * the verified value through the config's designated field-write tool
 * (config.fieldWriteToolId), and the ENGINE takes the node's primary exit
 * once every required objective is verified.
 *
 * Extracted from main.ts's flow branch: functions here take an explicit
 * ObjectivesDeps context instead of capturing session state via closure —
 * the pattern the upcoming full main.ts split (T3b) will follow.
 */

/** Minimal transcript turn shape the judge reads from. */
export interface ObjectiveTurn {
	role: "agent" | "user" | "system";
	text: string;
}

/** Where an exit lands after following routers/statements — owned by the
 * flow's target resolution in main.ts, re-exported here since the objectives
 * transition consumes it. */
export type ResolvedTarget =
	| { kind: "agent"; id: string }
	| { kind: "end" }
	| { kind: "end_after_speech" }
	/** A `stop_responding` node: PARK the contact. The current agent is swapped
	 * for a parked agent that stays silent (never speaks/hangs up) but keeps
	 * evaluating global scenarios each inbound turn, so a scenario can still move
	 * the contact onward. Voice calls still end via the existing silence timeout;
	 * text sessions park indefinitely. Handled by flow/agent-builder's parked agent. */
	| { kind: "park"; nodeId: string }
	| { kind: "transfer"; nodeId: string }
	/** A `handoff` node: hand the live call to a DIFFERENT published agent
	 * (target agent id resolved to `agentId`, from the source flow `fromNode`).
	 * Handled by flow/handoff — fetch the target config, build+swap its entry
	 * agent, carry context, one-way. `transition` carries the node's optional
	 * announcement + hold-music settings. */
	| {
			kind: "handoff";
			agentId: string;
			fromNode: string;
			transition?: { say?: string; generate?: boolean; holdSeconds?: number };
	  };

interface ObjectiveProgress {
	met: boolean;
	rating?: number;
	answer?: string;
	/** Caller turns spent while this was the first unmet objective. */
	attempts: number;
	/** maxAttempts exhausted — stops gating the exit, stays unmet. */
	skipped: boolean;
	/** Fire-and-forget field write failed (audit Tier 1 #7). The objective still
	 * counts as met — the model is never told the save failed — but the write is
	 * retried once at node transition so a transient CRM blip doesn't silently
	 * drop the captured value. */
	writeFailed?: boolean;
	/** The transition-time retry has already fired — guards a single retry. */
	writeRetried?: boolean;
}

interface ObjectiveRuntime {
	nodeId: string;
	exitName: string;
	target?: string;
	judge?: { model: string; temperature?: number };
	objectives: FlowObjective[];
	state: Map<string, ObjectiveProgress>;
	judging: boolean;
	rerun: boolean;
	transitioning: boolean;
}

/**
 * Everything the objectives subsystem needs from the surrounding session —
 * threaded explicitly rather than captured via closure. Deliberately narrow:
 * only what judging/writing/transitioning actually touch.
 */
export interface ObjectivesDeps {
	dispatch: DispatchMetadata;
	/** Live transcript buffer (main.ts's `turns`); read-only here. */
	turns: ObjectiveTurn[];
	/** Shared mutable per-call contact state (Phase 1). Read at arm() for
	 * skipIfKnown; written (upsert) when a verified objective field is saved so
	 * the next node's prompt reflects it. Same array reference threaded from main.ts. */
	contactState: ContactStateEntryT[];
	/** Field keys captured IN THIS CALL (state.capturedFields). Used at arm() to
	 * pre-satisfy an objective from an in-call answer — including a name key that
	 * differs from the source's (first_name vs full_name) — WITHOUT trusting stale
	 * CRM values (that stays governed by skipIfKnown). A value is recorded here
	 * whenever this tracker writes a verified objective field. */
	capturedFields: Set<string>;
	session: voice.AgentSession;
	buildLlm: (over?: {
		model?: string;
		temperature?: number;
		maxTokens?: number;
		json?: boolean;
		reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
	}) => {
		/** Resolved inference model id (for ai.turn logging). */
		model: string;
		chat(opts: { chatCtx: llm.ChatContext }): {
			collect(): Promise<{ text: string; usage?: { promptTokens?: number; completionTokens?: number } }>;
		};
	};
	/** Config-designated field-write tool (config.fieldWriteToolId), or undefined
	 * when the project registers no such tool. Engine neutrality — no hardcoded
	 * CRM tool name; a verified objective's value is written through this. */
	fieldWriteDef: ToolDef | undefined;
	/** Follows an exit target through routers/statements/set_field/modify_tags
	 * nodes to the next agent (or end). Owned by main.ts's flow branch. */
	resolveTarget: (target: string | undefined) => Promise<ResolvedTarget>;
	/** Builds (or rebuilds) the voice.Agent for a flow node, carrying over
	 * chat context. Owned by main.ts's flow branch. */
	buildFlowAgent: (nodeId: string, chatCtx?: llm.ChatContext) => voice.Agent;
	/** Builds the silent parked agent for a `stop_responding` (park) node — used
	 * when an objective node's primary exit routes onto a stop_responding node. */
	buildParkedAgent: (chatCtx?: llm.ChatContext) => voice.Agent;
	/** Starts a simulated warm-transfer sequence for a transfer node. */
	startTransfer: (nodeId: string) => void;
	/** Starts an agent-handoff sequence (flow `handoff` node): fetch the target
	 * agent's config, build+swap its entry agent carrying context. One-way. */
	startHandoff: (target: {
		agentId: string;
		fromNode: string;
		transition?: { say?: string; holdSeconds?: number };
	}) => void;
	/** Agent-initiated hangup (flushes + tears down the room). */
	hangUp: (reason: string) => Promise<void>;
	/** True once call completion has already been reported. */
	isCompleted: () => boolean;
	/** Flip the shared `transitionPending` flag. Set true the moment the judge
	 * commits to advancing (before the idle-wait), so a model-emitted end_call in
	 * that window is refused; cleared on abort here, and by buildFlowAgent onEnter
	 * once the next node actually enters. Mirrors the transferInFlight pattern. */
	setTransitionPending: (pending: boolean) => void;
	/** Judge model tier (config.models.judge). Sets the DEFAULT judge model; a
	 * per-node node.judge override still wins. Unset → openai/gpt-5-mini (a
	 * stronger structured-output model — the judge runs off the voice critical
	 * path, and OpenAI is reachable via LiveKit Inference). */
	judgeModel?: string;
	/** Record one judge LLM call's usage (Phase 4 per-class metering). */
	recordUsage: (tokensIn: number, tokensOut: number) => void;
	/** Publish this node's outcome as {{node_<id>_result|attempts|succeeded}}
	 * interpolation variables (CloseBot "Nodes" Tier 1) once its objectives complete.
	 * result = captured answer(s); succeeded = every required objective met (no skip). */
	recordNodeResult: (nodeId: string, fields: { result?: string; succeeded?: boolean }) => void;
	/** Signal genuine flow progress (an objective was met or skipped) so the engine's
	 * no-progress backstop resets. A wedged judge that never scores makes NO progress,
	 * so the backstop eventually force-ends the call — this keeps it from firing while
	 * objectives are actually advancing. */
	onProgress?: () => void;
	/** Publish that the current node's required objectives are all met/skipped, so the
	 * shared end_call tool treats the node as terminal-for-end_call (a model-driven
	 * hangup is legitimate once the data is captured, even mid-flow). Reset to false on
	 * every node entry (buildFlowAgent onEnter). */
	setObjectivesComplete?: (complete: boolean) => void;
}

/** Node-shaped input to `arm` — only the fields the tracker needs. */
export interface ObjectiveNodeInfo {
	id: string;
	objectives: FlowObjective[];
	judge?: { model: string; temperature?: number };
	/** The node's primary exit (exits[0]) — the one the engine takes once
	 * every required objective is verified. */
	primaryExit: { name: string; target?: string };
}

export interface ObjectivesTracker {
	/** Call from a flow node's onEnter to (re)arm the judge for that node, or
	 * disarm it (pass objectives: []) for nodes with no objectives. Rebuilt
	 * fresh on every entry — re-entering a node restarts its goals. */
	arm(node: ObjectiveNodeInfo): void;
	/** Call after every recorded caller turn (role === "user" with text). */
	onUserTurn(): void;
}

// Strict default: on a voice call a wrong "met" audibly advances (or ends)
// the conversation. Per-objective `sensitivity` overrides it.
const OBJECTIVE_RATING_THRESHOLD = 90;
const objectiveThreshold = (o: FlowObjective): number =>
	Math.min(100, Math.max(10, o.sensitivity ?? OBJECTIVE_RATING_THRESHOLD));

/** Default judge model. A NON-reasoning, cheap, strict-JSON model (CloseBot-style):
 * it returns a compact `{"checks":[…]}` object reliably and, unlike a reasoning
 * model (gpt-5-mini), spends none of its completion budget on hidden reasoning
 * tokens — the root cause of the live `unparseable_or_schema_invalid_json` wedge
 * (the 400-token cap was consumed by reasoning before any JSON was emitted). Already
 * the proven cheap model on this Inference path (router + parked-scenario passes). */
const DEFAULT_JUDGE_MODEL = "openai/gpt-4o-mini";

/** Judge completion-token budget, scaled to the number of objectives scored in one
 * batch so a many-objective node (the live wedge had 7) always gets a COMPLETE JSON
 * object back. The judge runs off the speech critical path, so a generous cap costs
 * no latency. Retries bump it further (see runObjectiveJudge). */
const judgeMaxTokens = (objectiveCount: number): number => Math.max(800, objectiveCount * 150 + 300);

/** Give up on an objective after this many caller turns / consecutive judge failures
 * when the objective sets no explicit maxAttempts. Prevents an infinite loop when the
 * judge can't score (every failure now counts) or a caller keeps dodging — the
 * objective is marked skipped so the node can still advance. */
const DEFAULT_MAX_ATTEMPTS = 3;
const OBJECTIVE_JUDGE_SYSTEM =
	'You evaluate whether data-collection objectives for a phone call have been satisfied by the conversation so far. Respond with ONLY a JSON object — no prose, no code fences — of the form {"checks":[{"key":"<objective key>","rating":<0-100>,"answer":"<extracted value or empty string>"}]}. Objectives come in two groups. For each objective under "To collect" include exactly one check. For each objective under "Already answered" include a check ONLY if the caller has since stated a DIFFERENT value than its recorded answer — return the new value with your confidence; do not re-report an unchanged answer. rating is your confidence that the CALLER explicitly provided the information (100 = clearly provided, 0 = not provided at all). Extract answer from what the caller actually said. NEVER invent or assume a value the caller did not state; if the information was not provided, rating must be low and answer empty. When an objective lists allowed values, answer must be exactly one of them, chosen from what the caller said — and the agent will usually LIST those options in its own question, which is NOT an answer: only count a listed-value objective as provided when the CALLER picks one, never extract it from the agent\'s own wording. Callers often speak emails and phone numbers phonetically — e.g. "count at gmail dot com" for count@gmail.com, or a number read out digit by digit — treat these as clearly provided (rate them high) and extract the value in normal written form (name@domain.com, a plain digit string). Some objectives are CONDITIONAL ("if X, …"): when the conversation clearly shows the condition does NOT apply, the objective is satisfied — rate it 100 with answer "N/A".';

/**
 * Structured-output contract for the judge (audit Tier 1 #6). The judge must
 * return {"checks":[{"key,rating,answer"}]}; a hand-rolled JSON.parse used to
 * swallow malformed replies (console.error + silent early return), stalling
 * objective progression. Validated here so a bad reply is retried once and, on a
 * second failure, surfaced as a `flow.judge_error` event instead of vanishing.
 * Lenient on the leaf fields to preserve prior behavior: rating coerces to a
 * number (was `Number(check.rating ?? 0)`), answer defaults to "" (was the
 * `typeof === "string"` guard). Only the {checks:[{key}]} SHAPE is enforced. */
const judgeCheckSchema = z.object({
	key: z.string(),
	rating: z.coerce.number().catch(0),
	answer: z.string().catch(""),
});
const judgeOutputSchema = z.object({
	checks: z.array(judgeCheckSchema),
});
type JudgeOutput = z.infer<typeof judgeOutputSchema>;
const JUDGE_CORRECTIVE = "Your last reply was not valid JSON matching the schema; respond with ONLY the JSON.";

/** Case- and whitespace-insensitive key for comparing a caller's corrected
 * answer against the recorded one (the material-change / duplicate-write guard). */
const answerKey = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Spoken-form normalization for captured objective answers. Voice STT renders
 * emails and phone numbers phonetically ("count at gmail dot com", "1 5 6. 3 2 1"),
 * which is never a storable value and (for email) blocks the judge from validating
 * it. Detected by the objective's target field key (or its own key). This is GENERIC
 * transcription cleanup — NO CRM/business field mapping (that lives in the SaaS
 * layer); it only tidies the shape of what the caller literally said.
 */
const isEmailObjective = (o: FlowObjective): boolean => /email/i.test(o.field ?? o.key ?? "");
const isPhoneObjective = (o: FlowObjective): boolean => /phone|mobile/i.test(o.field ?? o.key ?? "");

/** "count at gmail dot com" → "count@gmail.com". Lowercase, spoken separators to
 * symbols, common domain read-outs joined, spaces stripped. */
const normalizeSpokenEmail = (raw: string): string => {
	let s = raw.trim().toLowerCase();
	// Spoken separators → symbols (handle " at "/" dot " before stripping spaces).
	s = s.replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".");
	// Common provider read-outs said with a gap.
	s = s.replace(/\bg\s*mail\b/g, "gmail").replace(/\bhot\s*mail\b/g, "hotmail").replace(/\by\s*ahoo\b/g, "yahoo");
	// Drop punctuation the model may echo and collapse all remaining whitespace.
	s = s.replace(/[()<>,;]/g, "").replace(/\s+/g, "");
	// A trailing sentence period ("…dot com.") is not part of the address.
	s = s.replace(/\.+$/, "");
	return s;
};

/** Strip spaces and dial punctuation to a clean digit string; preserve a leading +. */
const normalizePhone = (raw: string): string => {
	const trimmed = raw.trim();
	const plus = trimmed.startsWith("+") ? "+" : "";
	return plus + trimmed.replace(/\D/g, "");
};

/** Normalize a judge-extracted answer by the objective's field kind. Email is
 * validated to look like an address (falls back to the raw trimmed value if the
 * normalized form doesn't); everything non-email/phone passes through unchanged. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeObjectiveAnswer = (o: FlowObjective, answer: string): string => {
	if (!answer) return answer;
	if (isEmailObjective(o)) {
		const email = normalizeSpokenEmail(answer);
		return EMAIL_SHAPE.test(email) ? email : answer.trim();
	}
	if (isPhoneObjective(o)) return normalizePhone(answer);
	return answer;
};

/** A name-shaped field key (first_name, last_name, full_name, contact_name, …).
 * Consistent with the existing generic email/phone field heuristics above — no
 * CRM/business mapping, just the shape of the key. Used ONLY to reconcile a
 * name value captured under one key with a target objective asking under another. */
const isNameField = (field: string): boolean => /name/i.test(field);

/**
 * In-call carryover resolution: has this objective's value ALREADY been captured
 * earlier in THIS call? Returns that value (so the objective can start met without
 * re-asking), or undefined to fall through to normal judging. Only reads keys in
 * `captured` (values written THIS call — never stale CRM), so a false positive can
 * at worst reuse a value the caller just gave; a miss simply re-asks as today.
 *
 * Handles the common key mismatch across a handoff (intake captured `first_name`,
 * the target asks `full_name`): captured name parts are bucketed and recomposed to
 * fit the target's name key. Non-name fields require an exact key match.
 */
const resolveCarriedAnswer = (
	objective: FlowObjective,
	contactState: ContactStateEntryT[],
	captured: Set<string>,
): string | undefined => {
	const field = objective.field;
	if (!field) return undefined;
	const valueOf = (key: string): string | undefined => {
		if (!captured.has(key)) return undefined;
		const v = contactState.find((e) => e.key === key)?.value;
		return v != null && v !== "" ? v : undefined;
	};
	// Exact key captured in-call — the clean common case.
	const direct = valueOf(field);
	if (direct) return direct;
	// Name key mismatch: recompose from whatever name parts were captured this call.
	if (!isNameField(field)) return undefined;
	let first: string | undefined;
	let last: string | undefined;
	let full: string | undefined;
	for (const e of contactState) {
		if (!captured.has(e.key) || !isNameField(e.key) || e.value == null || e.value === "") continue;
		const k = e.key.toLowerCase();
		if (k.includes("first") || k.includes("given")) first ??= e.value;
		else if (k.includes("last") || k.includes("surname") || k.includes("family")) last ??= e.value;
		else full ??= e.value;
	}
	const firstTok = (s: string | undefined) => s?.trim().split(/\s+/)[0];
	const lastTok = (s: string | undefined) => s?.trim().split(/\s+/).at(-1);
	const target = field.toLowerCase();
	if (target.includes("first") || target.includes("given")) return first ?? firstTok(full);
	if (target.includes("last") || target.includes("surname") || target.includes("family")) return last ?? lastTok(full);
	// full_name / name / generic: prefer a captured full value, else compose the parts.
	if (full) return full;
	const composed = [first, last].filter(Boolean).join(" ").trim();
	return composed || undefined;
};

/**
 * Idle = agent finished speaking its current reply. Bounded: a stuck state
 * must not wedge the flow, so transition anyway after timeoutMs.
 */
function waitForAgentIdle(session: voice.AgentSession, timeoutMs: number): Promise<void> {
	const state = session.agentState;
	if (state === "listening" || state === "idle" || state === "initializing") {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			session.off(voice.AgentSessionEventTypes.AgentStateChanged, onState);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		const onState = (ev: voice.AgentStateChangedEvent) => {
			if (ev.newState === "listening" || ev.newState === "idle") finish();
		};
		session.on(voice.AgentSessionEventTypes.AgentStateChanged, onState);
	});
}

export function createObjectivesTracker(deps: ObjectivesDeps): ObjectivesTracker {
	const { dispatch, turns, contactState, capturedFields, buildLlm, fieldWriteDef, resolveTarget, buildFlowAgent, buildParkedAgent, startTransfer, startHandoff, hangUp, isCompleted, setTransitionPending, judgeModel, recordUsage, recordNodeResult, onProgress, setObjectivesComplete } =
		deps;
	// `session` is a LAZY getter on deps (the AgentSession is built after this
	// factory wires up) — it MUST be read fresh via deps.session at call time.
	// Destructuring it here would capture `undefined` (the value during wiring)
	// and every transition would crash on `session.agentState`.
	const getSession = () => deps.session;
	// Resolved judge model: a per-node `node.judge.model` override still wins (applied
	// in runObjectiveJudge); this is the DEFAULT for nodes without one. Non-reasoning +
	// strict JSON (see DEFAULT_JUDGE_MODEL) so batched scoring returns complete JSON.
	const resolvedJudgeModel = judgeModel ?? DEFAULT_JUDGE_MODEL;
	// A reasoning model (gpt-5 family) still gets a "minimal" effort hint so reasoning
	// tokens don't eat the completion budget; the non-reasoning default ignores it.
	const isReasoningJudge = /gpt-5|o1|o3|o4|reasoning/i.test(resolvedJudgeModel);
	const buildJudgeLlm = (model: string, maxTokens: number, reasoning: boolean, temperature: number) =>
		buildLlm({
			model,
			temperature,
			maxTokens,
			json: true,
			...(reasoning ? { reasoningEffort: "minimal" as const } : {}),
		});

	let activeObjectives: ObjectiveRuntime | null = null;

	const writeObjectiveField = (objective: FlowObjective, answer: string, progress?: ObjectiveProgress): void => {
		if (!objective.field || !answer) return;
		if (!fieldWriteDef) {
			console.warn(
				`flow: objective "${objective.key}" wants field "${objective.field}" but no field-write tool (config.fieldWriteToolId) is registered`,
			);
			return;
		}
		// Snap to the exact picklist option when one matches case-insensitively.
		const option = objective.options?.find((v) => v.toLowerCase() === answer.toLowerCase());
		const written = option ?? answer;
		// Reflect the write into the in-memory contactState so the next node's
		// prompt shows the value instead of UNRESOLVED (Phase 1 live updates).
		upsertContactState(contactState, objective.field, written);
		// In-call carryover: this value was verified & captured THIS call, so a later
		// node / handoff target can treat it as answered instead of re-asking — even if
		// its objective uses a different name key (first_name vs full_name).
		capturedFields.add(objective.field);
		console.log(
			`flow: contactState updated ${objective.field} -> "${written}" | now: ${JSON.stringify(contactState)}`,
		);
		void invokeTool(fieldWriteDef, dispatch, {
			field_name: objective.field,
			value: written,
		}).catch((err) => {
			console.error(`flow: objective field write failed (${objective.field})`, err);
			// Failure honesty (audit Tier 1 #7): surface the dropped write and mark the
			// objective so maybeCompleteObjectives retries it once before transitioning.
			// The model is NOT interrupted and is never told the save succeeded.
			if (progress) progress.writeFailed = true;
			reportEvent(dispatch.callId, "flow.objective_write_failed", {
				node: activeObjectives?.nodeId ?? null,
				key: objective.key,
				field: objective.field,
				retry: progress?.writeRetried === true,
			});
		});
	};

	/**
	 * Aggregate objectives (Phase 5b — CloseBot's get_full_address). An aggregate
	 * has no own judge question: it completes automatically once every one of its
	 * parts is met. Its answer is the parts' answers joined in aggregateOf order
	 * (space-separated), then its `field` write fires as usual. Called after every
	 * judge pass and after arm()'s skipIfKnown pass.
	 */
	const completeAggregates = (rt: ObjectiveRuntime): void => {
		for (const agg of rt.objectives) {
			if (!agg.aggregateOf?.length) continue;
			const progress = rt.state.get(agg.key);
			if (!progress || progress.met || progress.skipped) continue;
			// Every part must exist (schema-guarded) and be met.
			const partStates = agg.aggregateOf.map((k) => rt.state.get(k));
			if (partStates.some((p) => !p || !p.met)) continue;
			const answer = agg.aggregateOf
				.map((k) => (rt.state.get(k)?.answer ?? "").trim())
				.filter((a) => a && a.toUpperCase() !== "N/A")
				.join(" ");
			progress.met = true;
			progress.rating = 100;
			progress.answer = answer;
			reportEvent(dispatch.callId, "flow.objective", {
				node: rt.nodeId,
				key: agg.key,
				rating: 100,
				answer: answer.slice(0, 200),
				source: "aggregate",
			});
			if (answer && answer.toUpperCase() !== "N/A") {
				writeObjectiveField(agg, answer, progress);
			}
			console.log(`flow: aggregate objective "${agg.key}" completed -> "${answer}"`);
		}
	};

	/**
	 * Correction ripple (LiveKit workflow alignment #1): when a corrected part
	 * belongs to an ALREADY-COMPLETED aggregate, recompose the aggregate's answer
	 * from its parts (aggregateOf order, space-joined) and re-fire its field write
	 * with source "correction". An unmet aggregate is left alone — completeAggregates
	 * finishes it normally once every part is met. The aggregate STAYS met; this
	 * never un-completes it or re-arms a transition.
	 */
	const recomposeAggregates = (rt: ObjectiveRuntime, changedKey: string): void => {
		for (const agg of rt.objectives) {
			if (!agg.aggregateOf?.length || !agg.aggregateOf.includes(changedKey)) continue;
			const progress = rt.state.get(agg.key);
			if (!progress || !progress.met) continue;
			const answer = agg.aggregateOf
				.map((k) => (rt.state.get(k)?.answer ?? "").trim())
				.filter((a) => a && a.toUpperCase() !== "N/A")
				.join(" ");
			// No material change → never re-fire the aggregate write.
			if (answerKey(answer) === answerKey(progress.answer ?? "")) continue;
			progress.answer = answer;
			progress.rating = 100;
			reportEvent(dispatch.callId, "flow.objective", {
				node: rt.nodeId,
				key: agg.key,
				rating: 100,
				answer: answer.slice(0, 200),
				source: "correction",
			});
			if (answer && answer.toUpperCase() !== "N/A") writeObjectiveField(agg, answer, progress);
			console.log(`flow: aggregate objective "${agg.key}" recomposed after correction -> "${answer}"`);
		}
	};

	/**
	 * Burn one attempt on the FIRST live (unmet, non-skipped, non-aggregate)
	 * objective and skip it once its limit is reached. Called on BOTH a scored pass
	 * that left the focus unmet AND a judge FAILURE (unparseable/schema-invalid) —
	 * the live wedge looped forever because failures never counted, so the node never
	 * advanced. The limit is the objective's own maxAttempts or DEFAULT_MAX_ATTEMPTS
	 * when unset (previously an objective with no maxAttempts could loop forever).
	 * Skipping stops the objective gating the exit, so the node can advance.
	 */
	const burnAttempt = (rt: ObjectiveRuntime, reason: "unmet" | "judge_failure"): void => {
		const focus = rt.objectives.find((o) => {
			if (o.aggregateOf?.length) return false;
			const p = rt.state.get(o.key);
			return p && !p.met && !p.skipped;
		});
		if (!focus) return;
		const progress = rt.state.get(focus.key)!;
		progress.attempts += 1;
		const limit = focus.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		if (progress.attempts >= limit) {
			progress.skipped = true;
			reportEvent(dispatch.callId, "flow.objective_skipped", {
				node: rt.nodeId,
				key: focus.key,
				attempts: progress.attempts,
				reason,
			});
			// A repeatedly-failing judge that forces a skip is a distinct, louder signal
			// than a caller simply not answering — surface it so the wedge is diagnosable.
			if (reason === "judge_failure") {
				reportEvent(dispatch.callId, "flow.judge_giveup", {
					node: rt.nodeId,
					key: focus.key,
					attempts: progress.attempts,
				});
			}
			// Skipping is real flow progress (the node can now advance) — reset the
			// no-progress backstop so it doesn't also fire.
			onProgress?.();
		}
	};

	const runObjectiveJudge = async (rt: ObjectiveRuntime): Promise<void> => {
		// Aggregate objectives have no own judge question — they complete from their
		// parts (completeAggregates), so they are excluded from both lists.
		const unmet = rt.objectives.filter((o) => {
			if (o.aggregateOf?.length) return false;
			const p = rt.state.get(o.key);
			return p && !p.met && !p.skipped;
		});
		// Corrections (LiveKit workflow alignment #1): already-MET objectives are
		// shown to the judge too — with their recorded answer — so a caller who
		// changes an answer later in the SAME node ("actually my zip is 93308") is
		// not ignored. maxAttempts-skipped objectives are NOT correctable (they were
		// never answered — skipped stays unmet); a met objective completed by the
		// judge, by skipIfKnown ("known"), or as an aggregate part all correct here.
		const correctable = rt.objectives.filter((o) => {
			if (o.aggregateOf?.length) return false; // aggregates recompose from their parts
			const p = rt.state.get(o.key);
			return p?.met === true;
		});
		if (unmet.length === 0 && correctable.length === 0) return;
		const transcript = turns
			.filter((t) => t.role !== "system")
			.slice(-40)
			.map((t) => `${t.role === "user" ? "caller" : "agent"}: ${t.text}`)
			.join("\n");

		const objLine = (o: FlowObjective): string =>
			`- key "${o.key}": ${o.description}${
				o.options ? ` — allowed values: ${o.options.map((v) => `"${v}"`).join(", ")}` : ""
			}`;
		// Two clearly-labeled sections; the "Already answered" block is only present
		// when there are met objectives to correct, so the starved judge context
		// pays nothing extra on a node with no captured answers yet.
		const sections: string[] = [];
		if (unmet.length > 0) sections.push(`To collect:\n${unmet.map(objLine).join("\n")}`);
		if (correctable.length > 0) {
			sections.push(
				`Already answered:\n${correctable
					.map((o) => `${objLine(o)} — recorded answer: "${rt.state.get(o.key)?.answer ?? ""}"`)
					.join("\n")}`,
			);
		}

		const evalCtx = new llm.ChatContext();
		evalCtx.addMessage({ role: "system", content: OBJECTIVE_JUDGE_SYSTEM });
		evalCtx.addMessage({
			role: "user",
			content: `${sections.join("\n\n")}\n\nConversation transcript:\n${transcript}`,
		});

		// Per-node judge override wins; else the resolved default. A reasoning override
		// (gpt-5/o-series) gets the "minimal" effort hint too.
		const model = rt.judge?.model ?? resolvedJudgeModel;
		const reasoning = rt.judge?.model ? /gpt-5|o1|o3|o4|reasoning/i.test(rt.judge.model) : isReasoningJudge;
		const temperature = rt.judge?.temperature ?? 0;
		// Count-scaled completion budget so a many-objective batch always returns a
		// COMPLETE JSON object (the live wedge truncated at a flat 400 cap).
		const baseTokens = judgeMaxTokens(unmet.length + correctable.length);
		// Parse + schema-validate with one corrective retry (audit Tier 1 #6). Both
		// attempts stay OFF the speech path (this whole pass is async/background). The
		// retry appends a corrective nudge to the SAME context AND doubles the token
		// budget (a truncated first attempt is the common failure), so the retry isn't
		// just re-running the same starved request.
		let parsed: JudgeOutput | null = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0) evalCtx.addMessage({ role: "user", content: JUDGE_CORRECTIVE });
			const maxTokens = baseTokens * (attempt + 1);
			const judgeLlm = buildJudgeLlm(model, maxTokens, reasoning, temperature);
			const res = await judgeLlm.chat({ chatCtx: evalCtx }).collect();
			// Per-class metering (Phase 4): the judge is a standalone call the session's
			// MetricsCollected never sees — read usage straight off the collected response.
			recordUsage(res.usage?.promptTokens ?? 0, res.usage?.completionTokens ?? 0);
			// AI-logs panel: full request/response for each judge pass (capped).
			reportAiTurn(dispatch.callId, {
				class: "judge",
				title: "Evaluating objectives",
				model: judgeLlm.model,
				promptTokens: res.usage?.promptTokens ?? 0,
				completionTokens: res.usage?.completionTokens ?? 0,
				request: chatCtxMessages(evalCtx),
				response: res.text,
				extra: { node: rt.nodeId, attempt: attempt + 1 },
			});
			const text = res.text
				.trim()
				.replace(/^```(?:json)?\s*/i, "")
				.replace(/\s*```$/, "");
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				console.error(`flow: objective judge returned unparseable output (attempt ${attempt + 1}): ${text.slice(0, 200)}`);
				continue;
			}
			const validated = judgeOutputSchema.safeParse(json);
			if (validated.success) {
				parsed = validated.data;
				break;
			}
			console.error(
				`flow: objective judge returned schema-invalid output (attempt ${attempt + 1}): ${text.slice(0, 200)}`,
			);
		}
		if (!parsed) {
			// Never silent: surface the stall so objective progression failures are visible.
			reportEvent(dispatch.callId, "flow.judge_error", {
				node: rt.nodeId,
				reason: "unparseable_or_schema_invalid_json",
			});
			// Circuit breaker: a judge failure now COUNTS toward the focus objective's
			// attempts, so a persistently-broken judge can't wedge the node forever —
			// after the limit the objective is skipped and the node advances.
			burnAttempt(rt, "judge_failure");
			return;
		}

		for (const check of parsed.checks) {
			const objective = rt.objectives.find((o) => o.key === check.key);
			if (!objective) continue;
			const progress = rt.state.get(objective.key);
			if (!progress) continue;
			const rating = Number(check.rating ?? 0);
			// Normalize spoken email/phone forms BEFORE storing or writing, so both the
			// recorded answer and the field write are clean ("count at gmail dot com" →
			// count@gmail.com, "1 5 6. 3 2 1" → 156321). Covers first-time capture AND
			// corrections below (both read `answer`); picklist option matching is
			// unaffected (email/phone objectives carry no options).
			const answer = normalizeObjectiveAnswer(
				objective,
				typeof check.answer === "string" ? check.answer.trim() : "",
			);

			if (progress.met) {
				// --- Correction of an already-met objective ---
				// Aggregates never correct here (no judge question; they recompose
				// from parts) — skip defensively even if the judge echoes one back.
				if (objective.aggregateOf?.length) continue;
				// A confident, non-empty extraction is required to overwrite a
				// captured answer.
				if (!(rating >= objectiveThreshold(objective)) || !answer) continue;
				// Picklist objectives must still resolve to an exact option; an answer
				// matching none is not a valid correction.
				if (objective.options && !objective.options.some((v) => v.toLowerCase() === answer.toLowerCase())) {
					continue;
				}
				const option = objective.options?.find((v) => v.toLowerCase() === answer.toLowerCase());
				const corrected = option ?? answer;
				// No material change (case/whitespace-insensitive) → never re-fire the
				// write (duplicate-write guard).
				if (answerKey(corrected) === answerKey(progress.answer ?? "")) continue;
				progress.answer = corrected;
				progress.rating = rating;
				// The objective STAYS met: a correction never un-completes the node or
				// re-arms its transition — node progression / exit gating is unaffected.
				reportEvent(dispatch.callId, "flow.objective", {
					node: rt.nodeId,
					key: objective.key,
					rating,
					answer: corrected.slice(0, 200),
					source: "correction",
				});
				if (corrected.toUpperCase() !== "N/A") writeObjectiveField(objective, corrected, progress);
				// Ripple the correction into any already-completed aggregate.
				recomposeAggregates(rt, objective.key);
				continue;
			}

			// --- First-time completion ---
			if (!(rating >= objectiveThreshold(objective))) continue;
			progress.met = true;
			progress.rating = rating;
			progress.answer = answer;
			reportEvent(dispatch.callId, "flow.objective", {
				node: rt.nodeId,
				key: objective.key,
				rating,
				answer: progress.answer.slice(0, 200),
				source: "judge",
			});
			// "N/A" = a conditional objective whose condition didn't apply —
			// satisfied, but nothing to write to the CRM.
			if (progress.answer && progress.answer.toUpperCase() !== "N/A") {
				writeObjectiveField(objective, progress.answer, progress);
			}
			// A newly-met objective is genuine flow progress — reset the no-progress backstop.
			onProgress?.();
		}

		// Max attempts (CloseBot semantics): objectives are pursued roughly in
		// order, so each caller turn that leaves the FIRST live objective unmet
		// burns one attempt on it. Exhausted → it stops gating the exit (skipped,
		// stays unmet) so a dodging caller — or a repeatedly-failing judge — can't
		// stall the flow forever. Now applied with a DEFAULT limit when the objective
		// sets none (previously such objectives looped unbounded).
		burnAttempt(rt, "unmet");

		// Roll any now-satisfiable aggregates up from their parts.
		completeAggregates(rt);
	};

	const maybeCompleteObjectives = (rt: ObjectiveRuntime): void => {
		if (rt.transitioning || activeObjectives !== rt) return;
		const pending = rt.objectives.filter((o) => {
			const p = rt.state.get(o.key);
			return (o.required ?? true) && p && !p.met && !p.skipped;
		});
		if (pending.length > 0) return;
		// Retry once any field write that failed while this node was active (audit
		// Tier 1 #7). Fire-and-forget like the original write — the transition never
		// blocks on the CRM — but a transient blip no longer silently drops a
		// captured value. writeRetried guards against a second retry.
		for (const o of rt.objectives) {
			const p = rt.state.get(o.key);
			if (!p || !p.writeFailed || p.writeRetried || !p.answer) continue;
			p.writeRetried = true;
			reportEvent(dispatch.callId, "flow.objective_write_retry", { node: rt.nodeId, key: o.key, field: o.field ?? null });
			writeObjectiveField(o, p.answer, p);
		}
		rt.transitioning = true;
		// The node's data goals are satisfied: publish it as terminal-for-end_call so a
		// model-driven hangup is legitimate from here (a safety net if the async
		// transition below ever stalls). Reset on the next node's entry.
		setObjectivesComplete?.(true);
		onProgress?.();
		// Publish this node's outcome as {{node_<id>_result|attempts|succeeded}}
		// (CloseBot "Nodes" Tier 1) BEFORE the async transition below, so the next
		// node's prompt build (which happens after the idle-wait) already resolves it.
		// result = every captured, non-"N/A" objective answer joined; succeeded =
		// no required objective was skipped (maxAttempts-exhausted); attempts =
		// caller-turn delta since node entry (computed inside recordNodeResult).
		const answers = rt.objectives
			.map((o) => (rt.state.get(o.key)?.answer ?? "").trim())
			.filter((a) => a && a.toUpperCase() !== "N/A");
		const anySkipped = rt.objectives.some((o) => (o.required ?? true) && rt.state.get(o.key)?.skipped);
		recordNodeResult(rt.nodeId, { result: answers.join(", "), succeeded: !anySkipped });
		// Commit the transition NOW (before the idle-wait below, which can take
		// seconds): a model that emits end_call in this window would otherwise pass
		// the lastTransitionAt guard (the current node was entered long ago) and kill
		// the call mid-advance — the exact live bug. Cleared on abort here, and by
		// buildFlowAgent onEnter once the next node enters.
		setTransitionPending(true);
		reportEvent(dispatch.callId, "flow.objectives_met", { node: rt.nodeId });
		void (async () => {
			// Never cut the agent off mid-sentence: transition at the next turn
			// boundary (agent back to listening).
			const session = getSession();
			await waitForAgentIdle(session, 15_000);
			// A scenario/secondary exit (or hangup) may have moved the call on.
			if (isCompleted() || activeObjectives !== rt) {
				setTransitionPending(false);
				return;
			}
			if (session.currentAgent.id !== `node:${rt.nodeId}`) {
				setTransitionPending(false);
				return;
			}
			reportEvent(dispatch.callId, "flow.exit", {
				node: rt.nodeId,
				exit: rt.exitName,
				target: rt.target ?? null,
				via: "objectives",
			});
			activeObjectives = null;
			const resolved = await resolveTarget(rt.target);
			if (resolved.kind === "agent") {
				const nextCtx = session.currentAgent.chatCtx.copy({ excludeInstructions: true });
				session.updateAgent(buildFlowAgent(resolved.id, nextCtx));
			} else if (resolved.kind === "park") {
				// Objective node's exit lands on a stop_responding node: park the
				// contact. The parked agent stays silent but keeps evaluating
				// scenarios; it never hangs up (voice ends via the silence timeout).
				const nextCtx = session.currentAgent.chatCtx.copy({ excludeInstructions: true });
				session.updateAgent(buildParkedAgent(nextCtx));
			} else if (resolved.kind === "end") {
				await hangUp("flow_complete");
			} else if (resolved.kind === "transfer") {
				startTransfer(resolved.nodeId);
			} else if (resolved.kind === "handoff") {
				startHandoff({
					agentId: resolved.agentId,
					fromNode: resolved.fromNode,
					transition: resolved.transition,
				});
			}
			// end_after_speech: the terminal statement queued its own hangup.
		})().catch((err) => console.error("flow: objective transition failed", err));
	};

	return {
		arm(node: ObjectiveNodeInfo): void {
			// Rebuilt fresh on every entry — re-entering a node restarts its
			// goals.
			if (node.objectives.length === 0) {
				activeObjectives = null;
				return;
			}
			const rt: ObjectiveRuntime = {
				nodeId: node.id,
				exitName: node.primaryExit.name,
				target: node.primaryExit.target,
				judge: node.judge,
				objectives: node.objectives,
				state: new Map(node.objectives.map((o) => [o.key, { met: false, attempts: 0, skipped: false }])),
				judging: false,
				rerun: false,
				transitioning: false,
			};
			// skipIfKnown (Phase 1): an objective whose `field` already has a
			// non-null value in the per-call contactState starts MET with that
			// value — no judge, no re-asking. skipIfKnown:false forces asking.
			for (const o of node.objectives) {
				if (o.skipIfKnown === false || !o.field) continue;
				const known = contactState.find((e) => e.key === o.field);
				if (!known || known.value == null || known.value === "") continue;
				const progress = rt.state.get(o.key)!;
				progress.met = true;
				progress.rating = 100;
				progress.answer = known.value;
				// Same event as a judge completion, marked source "known" — no field
				// write (the value already lives in the CRM / contactState).
				reportEvent(dispatch.callId, "flow.objective", {
					node: rt.nodeId,
					key: o.key,
					rating: 100,
					answer: known.value.slice(0, 200),
					source: "known",
				});
				console.log(`flow: objective "${o.key}" met from known contact field "${o.field}" (skipIfKnown)`);
			}
			// In-call carryover (warm hand-off / cross-node memory): an objective whose
			// value was ALREADY captured earlier in THIS call starts MET — no judge, no
			// re-asking. Distinct from skipIfKnown above: this reuses ONLY values written
			// this call (state.capturedFields), never stale CRM, so it fires even when the
			// objective sets skipIfKnown:false — and it reconciles a differing name key
			// (source captured first_name, target asks full_name). No field write: the
			// value is already in the CRM (exact match) or is a SaaS mapping concern
			// (recomposed name). Aggregates complete from their parts, so skip them here.
			for (const o of node.objectives) {
				if (o.aggregateOf?.length) continue;
				const progress = rt.state.get(o.key)!;
				if (progress.met) continue;
				const carried = resolveCarriedAnswer(o, contactState, capturedFields);
				if (!carried) continue;
				progress.met = true;
				progress.rating = 100;
				progress.answer = carried;
				reportEvent(dispatch.callId, "flow.objective", {
					node: rt.nodeId,
					key: o.key,
					rating: 100,
					answer: carried.slice(0, 200),
					source: "carryover",
				});
				console.log(`flow: objective "${o.key}" met from in-call captured data (carryover) -> "${carried}"`);
			}
			activeObjectives = rt;
			// An aggregate whose parts were all satisfied by skipIfKnown completes now.
			completeAggregates(rt);
			// If every required objective was already known, advance immediately
			// (guards + idle-wait live in maybeCompleteObjectives).
			maybeCompleteObjectives(rt);
		},
		onUserTurn(): void {
			// Corrections are only possible while this node is still the ACTIVE
			// objectives node. Once maybeCompleteObjectives transitions (or a
			// scenario/secondary exit fires), `activeObjectives` is cleared and the
			// tracker disarms — a caller who corrects an answer AFTER the node has
			// handed off is no longer tracked here (documented limitation; matches
			// the pre-existing re-entry-restarts-goals behavior).
			const rt = activeObjectives;
			if (!rt || rt.transitioning) return;
			if (rt.judging) {
				// A newer caller turn arrived mid-judge — re-run once it finishes so
				// the verdict always covers the latest turn.
				rt.rerun = true;
				return;
			}
			void (async () => {
				do {
					rt.rerun = false;
					rt.judging = true;
					try {
						await runObjectiveJudge(rt);
					} catch (err) {
						console.error("flow: objective judge pass failed", err);
					} finally {
						rt.judging = false;
					}
				} while (rt.rerun && activeObjectives === rt && !rt.transitioning);
				maybeCompleteObjectives(rt);
			})();
		},
	};
}
