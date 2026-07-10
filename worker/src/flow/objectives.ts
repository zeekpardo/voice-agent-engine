import { llm, voice } from "@livekit/agents";
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
	| { kind: "transfer"; nodeId: string };

interface ObjectiveProgress {
	met: boolean;
	rating?: number;
	answer?: string;
	/** Caller turns spent while this was the first unmet objective. */
	attempts: number;
	/** maxAttempts exhausted — stops gating the exit, stays unmet. */
	skipped: boolean;
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
	session: voice.AgentSession;
	buildLlm: (over?: {
		model?: string;
		temperature?: number;
		maxTokens?: number;
	}) => {
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
	/** Starts a simulated warm-transfer sequence for a transfer node. */
	startTransfer: (nodeId: string) => void;
	/** Agent-initiated hangup (flushes + tears down the room). */
	hangUp: (reason: string) => Promise<void>;
	/** True once call completion has already been reported. */
	isCompleted: () => boolean;
	/** Judge model tier (config.models.judge). Sets the DEFAULT judge model; a
	 * per-node node.judge override still wins. Unset → grok-4-fast (unchanged). */
	judgeModel?: string;
	/** Record one judge LLM call's usage (Phase 4 per-class metering). */
	recordUsage: (tokensIn: number, tokensOut: number) => void;
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
const OBJECTIVE_JUDGE_SYSTEM =
	'You evaluate whether data-collection objectives for a phone call have been satisfied by the conversation so far. Respond with ONLY a JSON object — no prose, no code fences — of the form {"checks":[{"key":"<objective key>","rating":<0-100>,"answer":"<extracted value or empty string>"}]}. Objectives come in two groups. For each objective under "To collect" include exactly one check. For each objective under "Already answered" include a check ONLY if the caller has since stated a DIFFERENT value than its recorded answer — return the new value with your confidence; do not re-report an unchanged answer. rating is your confidence that the CALLER explicitly provided the information (100 = clearly provided, 0 = not provided at all). Extract answer from what the caller actually said. NEVER invent or assume a value the caller did not state; if the information was not provided, rating must be low and answer empty. When an objective lists allowed values, answer must be exactly one of them, chosen from what the caller said. Some objectives are CONDITIONAL ("if X, …"): when the conversation clearly shows the condition does NOT apply, the objective is satisfied — rate it 100 with answer "N/A".';

/** Case- and whitespace-insensitive key for comparing a caller's corrected
 * answer against the recorded one (the material-change / duplicate-write guard). */
const answerKey = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

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
	const { dispatch, turns, contactState, buildLlm, fieldWriteDef, resolveTarget, buildFlowAgent, startTransfer, hangUp, isCompleted, judgeModel, recordUsage } =
		deps;
	// `session` is a LAZY getter on deps (the AgentSession is built after this
	// factory wires up) — it MUST be read fresh via deps.session at call time.
	// Destructuring it here would capture `undefined` (the value during wiring)
	// and every transition would crash on `session.agentState`.
	const getSession = () => deps.session;
	const defaultJudgeLlm = buildLlm({ model: judgeModel ?? "grok-4-fast", temperature: 0, maxTokens: 400 });

	let activeObjectives: ObjectiveRuntime | null = null;

	const writeObjectiveField = (objective: FlowObjective, answer: string): void => {
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
		console.log(
			`flow: contactState updated ${objective.field} -> "${written}" | now: ${JSON.stringify(contactState)}`,
		);
		void invokeTool(fieldWriteDef, dispatch, {
			field_name: objective.field,
			value: written,
		}).catch((err) => console.error(`flow: objective field write failed (${objective.field})`, err));
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
				writeObjectiveField(agg, answer);
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
			if (answer && answer.toUpperCase() !== "N/A") writeObjectiveField(agg, answer);
			console.log(`flow: aggregate objective "${agg.key}" recomposed after correction -> "${answer}"`);
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

		const judgeLlm = rt.judge ? buildLlm({ temperature: 0, maxTokens: 400, ...rt.judge }) : defaultJudgeLlm;
		const res = await judgeLlm.chat({ chatCtx: evalCtx }).collect();
		// Per-class metering (Phase 4): the judge is a standalone call the session's
		// MetricsCollected never sees — read usage straight off the collected response.
		recordUsage(res.usage?.promptTokens ?? 0, res.usage?.completionTokens ?? 0);
		const text = res.text
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "");
		let parsed: { checks?: { key?: string; rating?: number; answer?: string }[] };
		try {
			parsed = JSON.parse(text) as typeof parsed;
		} catch {
			console.error(`flow: objective judge returned unparseable output: ${text.slice(0, 200)}`);
			return;
		}

		for (const check of parsed.checks ?? []) {
			const objective = rt.objectives.find((o) => o.key === check.key);
			if (!objective) continue;
			const progress = rt.state.get(objective.key);
			if (!progress) continue;
			const rating = Number(check.rating ?? 0);
			const answer = typeof check.answer === "string" ? check.answer.trim() : "";

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
				if (corrected.toUpperCase() !== "N/A") writeObjectiveField(objective, corrected);
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
				writeObjectiveField(objective, progress.answer);
			}
		}

		// Max attempts (CloseBot semantics): objectives are pursued roughly in
		// order, so each caller turn that leaves the FIRST live objective unmet
		// burns one attempt on it. Exhausted → it stops gating the exit
		// (skipped, stays unmet) so a dodging caller can't stall the flow
		// forever.
		const focus = rt.objectives.find((o) => {
			if (o.aggregateOf?.length) return false;
			const p = rt.state.get(o.key);
			return p && !p.met && !p.skipped;
		});
		if (focus?.maxAttempts) {
			const progress = rt.state.get(focus.key)!;
			progress.attempts += 1;
			if (progress.attempts >= focus.maxAttempts) {
				progress.skipped = true;
				reportEvent(dispatch.callId, "flow.objective_skipped", {
					node: rt.nodeId,
					key: focus.key,
					attempts: progress.attempts,
				});
			}
		}

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
		rt.transitioning = true;
		reportEvent(dispatch.callId, "flow.objectives_met", { node: rt.nodeId });
		void (async () => {
			// Never cut the agent off mid-sentence: transition at the next turn
			// boundary (agent back to listening).
			const session = getSession();
			await waitForAgentIdle(session, 15_000);
			// A scenario/secondary exit (or hangup) may have moved the call on.
			if (isCompleted() || activeObjectives !== rt) return;
			if (session.currentAgent.id !== `node:${rt.nodeId}`) return;
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
			} else if (resolved.kind === "end") {
				await hangUp("flow_complete");
			} else if (resolved.kind === "transfer") {
				startTransfer(resolved.nodeId);
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
