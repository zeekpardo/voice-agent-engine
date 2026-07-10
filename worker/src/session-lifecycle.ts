import { type JobContext, inference, voice } from "@livekit/agents";
import { type FlowRuntimeState, type Turn, buildTts, inferenceModel } from "./flow/context.js";
import { type AgentConfig, type DispatchMetadata, reportCompletion, reportEvent } from "./gateway.js";

/**
 * Session setup + teardown, shared by the flow and single-agent paths. Owns
 * the reliability-critical ordering that earlier bugs came from:
 *
 *  - agent-initiated hangups FLUSH the transcript BEFORE room teardown (the
 *    job process dies within ms of room deletion — transcripts were lost this
 *    way);
 *  - never double-close (concurrent closes race inside closeImplInner) — we
 *    close the session ourselves, awaited and exactly once, BEFORE deleting
 *    the room so the SDK's own closes early-return;
 *  - silence / max-duration hangups disconnect the phone leg via deleteRoom;
 *  - completion is reported exactly once, whatever ends the call.
 */

interface RemoteLike {
	identity: string;
	attributes: Record<string, string>;
}

/**
 * Resolve true once the participant is live: web participants immediately
 * (no sip.callStatus attribute), SIP participants when the callee answers.
 * False on hangup-while-ringing or timeout.
 */
function waitForSipAnswer(
	ctx: { room: unknown },
	participant: RemoteLike,
	timeoutMs: number,
): Promise<boolean> {
	const status = () => participant.attributes["sip.callStatus"];
	if (!status()) return Promise.resolve(true); // not SIP (browser participant)
	if (status() === "active") return Promise.resolve(true);

	const room = ctx.room as {
		on(event: string, cb: (changed: unknown, p: RemoteLike) => void): void;
		off(event: string, cb: (changed: unknown, p: RemoteLike) => void): void;
	};
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve(false);
		}, timeoutMs);
		const onAttrs = (_changed: unknown, p: RemoteLike) => {
			if (p.identity !== participant.identity) return;
			const s = p.attributes["sip.callStatus"];
			if (s === "active") {
				cleanup();
				resolve(true);
			} else if (s === "hangup") {
				cleanup();
				resolve(false);
			}
		};
		const cleanup = () => {
			clearTimeout(timer);
			room.off("participantAttributesChanged", onAttrs);
		};
		room.on("participantAttributesChanged", onAttrs);
	});
}

export interface SessionLifecycleDeps {
	job: JobContext;
	config: AgentConfig;
	dispatch: DispatchMetadata;
	/** Live transcript buffer (shared with the flow modules + objectives). */
	turns: Turn[];
	/** Shared mutable holder: this fills in `session`, `hangUp`, `completed`. */
	state: FlowRuntimeState;
	agent: voice.Agent;
	greeting?: string;
	/** Inbound SIP jobs skip the call.started event (already reported upstream). */
	isInbound: boolean;
	/** Fired after each recorded caller turn (flow objective judging); absent
	 * on the single-agent path. */
	objectiveUserTurnHook?: () => void;
	/** Fired after each recorded caller turn (rolling-summary refresh); absent
	 * on the single-agent path or when memory is disabled. */
	memoryUserTurnHook?: () => void;
}

const DEFAULT_DISCLOSURE = "Just so you know, you're speaking with an A.I. assistant.";

/**
 * Build the AgentSession, wire every session event handler + engine timer, go
 * live (waiting for the human / SIP answer), then speak the disclosure +
 * greeting. Returns once the opening speech is queued.
 */
export async function startSession(deps: SessionLifecycleDeps): Promise<void> {
	const { job: ctx, config, dispatch, turns, state, agent, greeting } = deps;

	const sttModel = inferenceModel(config.stt.model, config.stt.provider, "xai/stt-1");
	const session = new voice.AgentSession({
		// xAI STT auto-detects (and code-switches) languages mid-call; pinning
		// it to the agent's language forces monolingual decoding — Spanish
		// callers got slow/empty finals. Only language-scoped providers
		// (Deepgram, AssemblyAI, …) receive the hint.
		stt: new inference.STT({
			model: sttModel,
			...(sttModel.startsWith("xai/") ? {} : { language: config.language }),
		}),
		tts: buildTts(config.tts),
		turnHandling: {
			// semantic → LiveKit's end-of-turn model; vad → VAD start/stop cues.
			turnDetection:
				config.turnDetection.mode === "semantic" ? new inference.TurnDetector() : "vad",
			endpointing: { minDelay: config.turnDetection.endpointingMs },
			// minWords: 0 (SDK default) lets any 500ms+ noise burst — line hiss,
			// SIP echo of the agent's own TTS — register as a barge-in with no
			// recognized speech, cutting the agent off mid-sentence. Requiring at
			// least one recognized word filters that out while still letting real
			// speech interrupt immediately.
			interruption: { enabled: config.turnDetection.allowInterruptions, minWords: 1 },
			// Draft the reply (LLM + first TTS chunk) while the caller is still
			// finishing their sentence; discard if the final transcript differs.
			preemptiveGeneration: { enabled: config.turnDetection.preemptiveGeneration !== false },
		},
	});
	// Publish the session so the flow modules' lazy ctx.session getter resolves.
	state.session = session;

	// Backstop for the transfer StopResponse (see runTransfer): when the
	// exit rode a parallel-tool turn, the SDK still generates a reply for
	// the OTHER tools' outputs on the outgoing agent. Discard any
	// LLM-generated speech while the transfer sequence is playing; the
	// chain's own say() lines (announcement, statements) pass through.
	session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
		if (state.transferInFlight && ev.source !== "say") {
			try {
				ev.speechHandle.interrupt(true);
			} catch (err) {
				console.error("flow: failed to discard speech during transfer", err);
			}
		}
	});

	// 4. Collect transcript turns + usage meters as the session runs.
	session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
		if (!("role" in ev.item)) return; // agent-handoff items carry no speech
		const role = ev.item.role === "assistant" ? "agent" : ev.item.role === "user" ? "user" : "system";
		const text = ev.item.textContent;
		if (text) turns.push({ role, text, ts: Date.now() / 1000 });
		// Judge objectives off the hot path: fires AFTER the turn is recorded
		// so the judge always sees the caller's latest words. Async — never
		// delays the reply that's already generating.
		if (role === "user" && text) {
			deps.objectiveUserTurnHook?.();
			deps.memoryUserTurnHook?.();
		}
	});

	const usage = { ttsChars: 0, sttMs: 0 };
	session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
		const m = ev.metrics;
		if (m.type === "llm_metrics") {
			// The session drives ONLY the responder the caller hears; the judge,
			// summary and router calls are standalone and meter themselves off their
			// collected responses (Phase 4). So every session llm_metrics is "respond".
			state.usage.record("respond", m.promptTokens, m.completionTokens);
		} else if (m.type === "tts_metrics") {
			usage.ttsChars += m.charactersCount;
		} else if (m.type === "stt_metrics") {
			usage.sttMs += m.audioDurationMs;
		}
	});

	// 5. Completion is reported exactly once, whatever ends the call.
	let startedAt = Date.now();
	let endReason = "unknown";
	let completionStatus: "completed" | "no_answer" | "failed" = "completed";
	const complete = async () => {
		if (state.completed) return;
		state.completed = true;
		const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
		// Per-class breakdown (Phase 4): respond (session) + judge + summary + router.
		// The legacy llm_tokens_in/out meters stay intact as the SUM across every
		// class — previously the judge/router were unmetered, so the total now also
		// captures them (summary was already folded in via the old auxUsage sink).
		const byClass = state.usage.byClass();
		const totals = state.usage.totals();
		await reportCompletion(dispatch.callId, {
			status: completionStatus,
			end_reason: endReason,
			duration_seconds: durationSeconds,
			transcript: { turns },
			usage: [
				{ kind: "call_minutes", quantity: durationSeconds / 60 },
				{ kind: "llm_tokens_in", quantity: totals.tokensIn },
				{ kind: "llm_tokens_out", quantity: totals.tokensOut },
				{ kind: "tts_characters", quantity: usage.ttsChars },
				{ kind: "stt_seconds", quantity: usage.sttMs / 1000 },
			],
			usage_by_class: {
				respond: { tokens_in: byClass.respond.tokensIn, tokens_out: byClass.respond.tokensOut, calls: byClass.respond.calls },
				judge: { tokens_in: byClass.judge.tokensIn, tokens_out: byClass.judge.tokensOut, calls: byClass.judge.calls },
				summary: { tokens_in: byClass.summary.tokensIn, tokens_out: byClass.summary.tokensOut, calls: byClass.summary.calls },
				router: { tokens_in: byClass.router.tokensIn, tokens_out: byClass.router.tokensOut, calls: byClass.router.calls },
			},
		});
	};

	// Agent-initiated hangup. Order matters:
	// 1. FLUSH FIRST — the job process dies within milliseconds of the room
	//    deletion, killing any in-flight request (transcripts were lost this
	//    way). The gateway's /complete responds fast (summarize runs async
	//    server-side), so this adds ~50ms before the line drops.
	// 2. Close the session OURSELVES — awaited, exactly once — BEFORE deleting
	//    the room. deleteRoom() otherwise triggers two SDK closes at once (the
	//    ROOM_DELETED disconnect-close and job_proc_lazy_main's shutdown close);
	//    both pass closeImplInner's `if (!started) return` guard (started only
	//    flips false at the very end) and race — one sets activity=undefined
	//    mid-drain, the other then reads activity.currentSpeech → TypeError →
	//    unhandled rejection → the job wedges 60s until SIGTERM. Closing first
	//    (awaited) drives started→false, so both SDK closes early-return.
	// 3. Delete the room — disconnects the SIP leg; the session is already down.
	state.hangUp = async (reason: string) => {
		if (endReason === "unknown") endReason = reason;
		await complete().catch((err) => console.error("pre-hangup flush failed", err));
		await session.close().catch((err) => console.error("session close failed", err));
		await ctx.deleteRoom().catch(() => {});
	};

	session.on(voice.AgentSessionEventTypes.Close, (ev) => {
		if (endReason === "unknown") {
			endReason =
				ev.reason === voice.CloseReason.PARTICIPANT_DISCONNECTED
					? "caller_hangup"
					: ev.reason === voice.CloseReason.ERROR
						? "error"
						: String(ev.reason);
		}
		// Flush the moment the session closes — don't depend on a graceful
		// job shutdown (an SDK crash after close previously lost the whole
		// transcript). complete() is idempotent.
		void complete().catch((err) => console.error("completion flush failed", err));
	});
	ctx.addShutdownCallback(complete);

	// 6. Engine-enforced timeouts (spec §4).
	const maxCallTimer = setTimeout(() => {
		void state.hangUp("max_duration");
	}, config.timeouts.maxCallSeconds * 1000);

	let silenceTimer: NodeJS.Timeout | undefined;
	const resetSilence = () => {
		if (silenceTimer) clearTimeout(silenceTimer);
		silenceTimer = setTimeout(() => {
			void state.hangUp("silence_timeout");
		}, config.timeouts.silenceHangupSeconds * 1000);
	};
	session.on(voice.AgentSessionEventTypes.UserInputTranscribed, resetSilence);
	session.on(voice.AgentSessionEventTypes.ConversationItemAdded, resetSilence);
	session.on(voice.AgentSessionEventTypes.Close, () => {
		clearTimeout(maxCallTimer);
		if (silenceTimer) clearTimeout(silenceTimer);
		// A conversation node's soft wrap-up timer must not fire (generateReply)
		// after the session is torn down.
		if (state.conversationTimer) clearTimeout(state.conversationTimer);
	});

	// 7. Go live. Wait for the human before greeting: browsers join within
	// seconds; outbound SIP participants exist while ringing, so also wait
	// for the call to be answered (sip.callStatus → active).
	await session.start({ agent, room: ctx.room });

	const noAnswerMs = (config.timeouts.noAnswerSeconds ?? 25) * 1000;
	const remote = await Promise.race([
		ctx.waitForParticipant(),
		new Promise<null>((r) => setTimeout(() => r(null), noAnswerMs + 20_000)),
	]);
	const answered = remote ? await waitForSipAnswer(ctx, remote, noAnswerMs) : false;
	if (!answered) {
		completionStatus = "no_answer";
		endReason = "no_answer";
		await complete();
		await state.hangUp("no_answer");
		return;
	}

	startedAt = Date.now();
	resetSilence();
	if (!deps.isInbound) {
		reportEvent(dispatch.callId, "call.started", { room: ctx.room.name ?? null });
	}

	// 8. Compliance disclosure is engine-enforced, then the configured greeting.
	const opening: string[] = [];
	if (config.compliance.aiDisclosure) {
		opening.push(config.compliance.disclosureText ?? DEFAULT_DISCLOSURE);
	}
	if (greeting) opening.push(greeting);
	if (opening.length > 0) session.say(opening.join(" "));
}
