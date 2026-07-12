import { type inference, llm, voice } from "@livekit/agents";
import { chatCtxMessages, reportAiTurn } from "../ai-log.js";
import { type DispatchMetadata, reportEvent } from "../gateway.js";
import { compactChatContext, type ResolvedMemory, type Turn } from "./context.js";

/**
 * Rolling in-call memory (voiceagent-engine/conversation-build-plan.md Phase 3 —
 * CloseBot's regenerated `<conversation summary>`).
 *
 * Every `intervalTurns` caller turns, a cheap async model call condenses the
 * turns OLDER than the live `windowTurns` window into a bullet summary. The
 * summary is stored on a shared mutable holder (`rollingSummary.text`) that
 * agent-builder renders into every node prompt as `## CONVERSATION SO FAR`, and
 * the responder's live chat history is compacted (here after a refresh, and in
 * agent-builder on every node handoff) to summary + last `windowTurns` verbatim
 * turns — so per-turn responder cost plateaus instead of growing.
 *
 * Two invariants:
 *  - NEVER blocks speech: generation is fully async off the ConversationItemAdded
 *    hook; a stale summary is always acceptable.
 *  - NEVER compacts the source of truth: the full `turns` buffer (transcript
 *    flush) and the objectives judge (which reads `turns`) stay COMPLETE.
 *    Compaction only ever trims a responder-facing ChatContext.
 *
 * Follows flow/objectives.ts's explicit-deps factory pattern (createX(deps),
 * lazy session getter).
 */

/** Minimal cheap-LLM shape the summary call needs (same as the judge uses). */
type SummaryLlm = inference.LLM;

export interface MemoryDeps {
	dispatch: DispatchMetadata;
	/** Live transcript buffer (main.ts's `turns`); read-only here, NEVER compacted. */
	turns: Turn[];
	/** Shared mutable holder written after each refresh (stable reference). */
	rollingSummary: { text: string };
	/** Resolved memory settings (config.memory + defaults). */
	memory: ResolvedMemory;
	/** Builds the cheap summary LLM (defaults to the judge-tier model). */
	buildLlm: (over?: { model?: string; temperature?: number; maxTokens?: number }) => SummaryLlm;
	/** AgentSession getter — lazy; only read at call time (post-refresh live
	 * compaction), never during wiring. */
	getSession: () => voice.AgentSession | undefined;
	/** Summary model tier (config.models.summary). memory.model wins over this;
	 * both unset → openai/gpt-4o-mini via Inference (cheap-tier default). */
	summaryModel?: string;
	/** Record one summary-call's token usage under the "summary" class (Phase 4). */
	recordUsage: (promptTokens: number, completionTokens: number) => void;
}

export interface MemoryTracker {
	/** Call after every recorded caller turn (role === "user" with text). */
	onUserTurn(): void;
}

/**
 * Resolve once the agent is between turns (listening/idle) so we can splice the
 * responder chatCtx without racing an in-flight generation. Bounded: a stuck
 * state must not wedge memory work, so resolve anyway after timeoutMs.
 */
function waitForAgentIdle(session: voice.AgentSession, timeoutMs: number): Promise<void> {
	const s = session.agentState;
	if (s === "listening" || s === "idle" || s === "initializing") return Promise.resolve();
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

const SUMMARY_SYSTEM =
	"You maintain a running summary of an ongoing phone call. Given the earlier portion of the conversation, produce a concise, factual bullet list (one short bullet per line, prefixed with '- ') capturing the durable facts, decisions, preferences, and context established so far — everything a colleague would need to continue seamlessly. Omit greetings, filler, and pleasantries. Do not invent anything. Output ONLY the bullet lines, no preamble or headings.";

export function createMemoryTracker(deps: MemoryDeps): MemoryTracker {
	const { dispatch, turns, rollingSummary, memory, buildLlm, getSession, summaryModel, recordUsage } = deps;

	// One reusable cheap LLM (temp 0). Summary tier (Phase 4, cheap-router update):
	// the per-config memory.model wins, then config.models.summary, then the
	// Inference cheap default openai/gpt-4o-mini (Inference brokers OpenAI, no
	// separate key needed on the worker; gpt-4.1-nano is not in the Inference
	// catalog so it can't be used here the way the gateway text path uses it).
	// This is a standalone call the session's MetricsCollected never sees — usage
	// is read straight off each collected response (see regenerate) into the
	// "summary" class.
	const summaryLlm = buildLlm({ model: memory.model ?? summaryModel ?? "openai/gpt-4o-mini", temperature: 0, maxTokens: 400 });

	let userTurns = 0;
	let generating = false;
	let pending = false;
	// Id of the summary message currently injected into the LIVE responder
	// chatCtx (within-node), so each refresh replaces the last one.
	let injectedSummaryId: string | undefined;

	const regenerate = async (): Promise<void> => {
		// Condense everything OLDER than the live verbatim window. If nothing is
		// older than the window yet, there is nothing to summarize.
		const convo = turns.filter((t) => t.role !== "system");
		const older = convo.slice(0, Math.max(0, convo.length - memory.windowTurns));
		if (older.length === 0) return;

		const transcript = older
			.map((t) => `${t.role === "user" ? "caller" : "agent"}: ${t.text}`)
			.join("\n");
		const evalCtx = new llm.ChatContext();
		evalCtx.addMessage({ role: "system", content: SUMMARY_SYSTEM });
		evalCtx.addMessage({ role: "user", content: `Conversation so far (earlier portion):\n${transcript}` });

		const res = await summaryLlm.chat({ chatCtx: evalCtx }).collect();
		// Per-class metering (Phase 4): record this standalone call under "summary".
		recordUsage(res.usage?.promptTokens ?? 0, res.usage?.completionTokens ?? 0);
		// AI-logs panel: full request/response for the summary refresh (capped).
		reportAiTurn(dispatch.callId, {
			class: "summary",
			title: "Summarizing conversation",
			model: summaryLlm.model,
			promptTokens: res.usage?.promptTokens ?? 0,
			completionTokens: res.usage?.completionTokens ?? 0,
			request: chatCtxMessages(evalCtx),
			response: res.text,
		});
		const summary = res.text.trim();
		if (!summary) return;
		rollingSummary.text = summary;
		reportEvent(dispatch.callId, "flow.memory_summary", {
			bullets: summary.split("\n").filter((l) => l.trim()).length,
			condensed_turns: older.length,
			window_turns: memory.windowTurns,
			chars: summary.length,
		});

		// Compact the LIVE responder history to summary + window, but only when the
		// agent is between turns (listening/idle) so we never splice mid-generation.
		// A node's instructions (with their `## CONVERSATION SO FAR` block) are built
		// ONCE at handoff, so within a long-running node the ONLY way the responder
		// sees a refreshed summary is via the chatCtx — we inject it as a managed
		// system message that replaces the previous one, alongside the truncation.
		const session = getSession();
		if (!session) return;
		// Wait for a turn boundary so we never splice a chatCtx mid-generation
		// (the summary call usually finishes while the agent is still replying).
		await waitForAgentIdle(session, 12_000);
		const agent = session.currentAgent;
		if (!agent) return;
		// The LIVE agent's chatCtx is read-only — mutate a copy and hand it back via
		// updateChatCtx (the SDK's supported path). `work` is a fresh, writable ctx.
		// excludeInstructions: the agent already carries its own instructions; copying
		// them into history too would duplicate the full prompt every turn (bloat that
		// defeats compaction). We keep ONLY conversational turns + our summary message.
		const work = agent.chatCtx.copy({ excludeInstructions: true });
		// Drop the summary message we injected last time so it neither lingers nor
		// counts toward the window; measure the real-turn size before/after.
		if (injectedSummaryId) {
			work.items = work.items.filter((i) => i.id !== injectedSummaryId);
			injectedSummaryId = undefined;
		}
		const before = work.items.length;
		compactChatContext(work, memory.windowTurns);
		const afterTurns = work.items.length;
		// Prepend the fresh summary as a system message so the responder always sees
		// summary + the last windowTurns verbatim turns, even within a long-running
		// node whose instructions (with their own summary block) were built once.
		const msg = new llm.ChatMessage({ role: "system", content: `## CONVERSATION SO FAR\n${summary}` });
		injectedSummaryId = msg.id;
		work.items = [msg, ...work.items];
		await agent.updateChatCtx(work);
		reportEvent(dispatch.callId, "flow.memory_compact", {
			before,
			after: afterTurns,
			site: "live",
			injected_summary: true,
		});
	};

	return {
		onUserTurn(): void {
			if (!memory.enabled) return;
			userTurns++;
			if (userTurns % memory.intervalTurns !== 0) return;
			if (generating) {
				// A refresh is already running — coalesce; run once more when it ends
				// so the summary always reflects the latest interval boundary.
				pending = true;
				return;
			}
			void (async () => {
				do {
					pending = false;
					generating = true;
					try {
						await regenerate();
					} catch (err) {
						console.error("flow: rolling-summary refresh failed", err);
					} finally {
						generating = false;
					}
				} while (pending);
			})();
		},
	};
}
