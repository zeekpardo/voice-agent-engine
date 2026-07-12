import { type JobContext, asLanguageCode, inference, voice } from "@livekit/agents";
import {
	BackgroundVoiceCancellation,
	TelephonyBackgroundVoiceCancellation,
} from "@livekit/noise-cancellation-node";
import { reportAiTurn } from "./ai-log.js";
import { type FlowRuntimeState, type Turn, anthropicRespondModel, buildTts, inferenceModel } from "./flow/context.js";
import { type AgentConfig, type DispatchMetadata, reportCompletion, reportEvent } from "./gateway.js";
import { createLanguageAligner } from "./language.js";

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
 *
 * Channel abstraction (Phase 6): everything I/O-specific — how the AgentSession
 * is constructed (STT/TTS/VAD vs bare), how it goes live (SIP answer wait vs a
 * simple participant wait), how the caller's turns arrive (audio vs lk.chat text
 * streams) and how the agent's replies leave (TTS audio vs lk.chat text) — lives
 * behind the `ChannelRuntime` seam built by `buildChannel`. The `voice` channel
 * is today's behavior byte-for-byte; the `text` channel runs the SAME flow (same
 * `turns` buffer, objectives/memory hooks, transcript flush, completion report,
 * timers) over LiveKit text streams with no audio tracks. Everything below the
 * seam — the shared event wiring, the completion/hangup ordering, the engine
 * timers — is channel-agnostic.
 */

/** LiveKit text-stream topic for chat I/O (matches the SDK's RoomIO default and
 * the wire contract the SaaS/text portal is built against). Caller turns arrive
 * on this topic (native RoomIO handler → generateReply) and the agent's replies
 * are published back on it. Mirrors `@livekit/agents` constants TOPIC_CHAT. */
const TOPIC_CHAT = "lk.chat";

/** Text sessions have no dead-air cost, so the inactivity timeout is far longer
 * than a voice call's silence-hangup. Used unless the configured silence value
 * is even longer (an operator who set a long voice silence keeps it on text). */
const TEXT_INACTIVITY_SECONDS = 300;

interface RemoteLike {
	identity: string;
	attributes: Record<string, string>;
}

/** Outcome of waiting for a participant to go live. `endReason`/`status` are set
 * only when the leg never went live, so the completion report can distinguish a
 * busy signal from a plain no-answer (retry logic downstream depends on it). */
type LiveResult =
	| { live: true }
	| { live: false; endReason: string; status: "no_answer" | "failed" };

/**
 * Map a SIP leg that dropped before it was answered to a granular end reason.
 * LiveKit writes `sip.*` attributes onto the SIP participant; `sip.callStatusCode`
 * carries the SIP response code and some deployments also surface a textual
 * `sip.disconnectReason`. We collapse those into the reasons downstream retry
 * logic understands. `no_answer` stays the catch-all fallback.
 *
 * NOTE: this cannot be exercised without a real SIP failure leg (see verify
 * report); the table below is the code-inspection + logged mapping.
 *   486 Busy Here / 600 Busy Everywhere          → user_busy      (no_answer)
 *   403 Forbidden / 603 Decline                  → call_rejected  (no_answer)
 *   480 Temporarily Unavailable / 408 Timeout    → no_answer      (no_answer)
 *   404 Not Found / 484 / 485 / 604              → invalid_number (failed)
 *   5xx (500/502/503/504/…)                      → trunk_failure  (failed)
 *   anything else / no code                      → no_answer      (no_answer)
 */
function sipDisconnectReason(attrs: Record<string, string>): {
	endReason: string;
	status: "no_answer" | "failed";
} {
	const raw = (attrs["sip.disconnectReason"] ?? "").toLowerCase();
	if (raw) {
		if (raw.includes("busy")) return { endReason: "user_busy", status: "no_answer" };
		if (raw.includes("declin") || raw.includes("reject") || raw.includes("forbidden"))
			return { endReason: "call_rejected", status: "no_answer" };
		if (raw.includes("not found") || raw.includes("invalid") || raw.includes("no such"))
			return { endReason: "invalid_number", status: "failed" };
		if (raw.includes("unavailable") || raw.includes("no answer") || raw.includes("timeout"))
			return { endReason: "no_answer", status: "no_answer" };
	}
	const code = Number.parseInt(attrs["sip.callStatusCode"] ?? "", 10);
	if (Number.isFinite(code)) {
		if (code === 486 || code === 600) return { endReason: "user_busy", status: "no_answer" };
		if (code === 403 || code === 603) return { endReason: "call_rejected", status: "no_answer" };
		if (code === 404 || code === 484 || code === 485 || code === 604)
			return { endReason: "invalid_number", status: "failed" };
		if (code >= 500 && code < 600) return { endReason: "trunk_failure", status: "failed" };
		if (code === 480 || code === 408) return { endReason: "no_answer", status: "no_answer" };
	}
	return { endReason: "no_answer", status: "no_answer" };
}

/** True if any remote participant is a SIP/telephony leg (carries `sip.*`
 * attributes) — the ground-truth signal `waitForSipAnswer` keys off, read up
 * front so the right noise-cancellation model is chosen at session.start. */
function roomHasSipParticipant(room: unknown): boolean {
	const rp = (room as { remoteParticipants?: Map<string, RemoteLike> }).remoteParticipants;
	if (!rp) return false;
	for (const p of rp.values()) {
		if (Object.keys(p.attributes ?? {}).some((k) => k.startsWith("sip."))) return true;
	}
	return false;
}

/**
 * Resolve `{ live: true }` once the participant is live: web participants
 * immediately (no sip.callStatus attribute), SIP participants when the callee
 * answers. On hangup-while-ringing or timeout, resolve `{ live: false }` with a
 * granular end reason mapped from the SIP disconnect attributes.
 */
function waitForSipAnswer(
	ctx: { room: unknown },
	participant: RemoteLike,
	timeoutMs: number,
): Promise<LiveResult> {
	const status = () => participant.attributes["sip.callStatus"];
	if (!status()) return Promise.resolve({ live: true }); // not SIP (browser participant)
	if (status() === "active") return Promise.resolve({ live: true });

	const room = ctx.room as {
		on(event: string, cb: (changed: unknown, p: RemoteLike) => void): void;
		off(event: string, cb: (changed: unknown, p: RemoteLike) => void): void;
	};
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve({ live: false, endReason: "no_answer", status: "no_answer" });
		}, timeoutMs);
		const onAttrs = (_changed: unknown, p: RemoteLike) => {
			if (p.identity !== participant.identity) return;
			const s = p.attributes["sip.callStatus"];
			if (s === "active") {
				cleanup();
				resolve({ live: true });
			} else if (s === "hangup") {
				cleanup();
				resolve({ live: false, ...sipDisconnectReason(p.attributes) });
			}
		};
		const cleanup = () => {
			clearTimeout(timer);
			room.off("participantAttributesChanged", onAttrs);
		};
		room.on("participantAttributesChanged", onAttrs);
	});
}

/**
 * The channel-specific I/O surface (Phase 6). One is built per job by
 * `buildChannel`; the shared lifecycle in `startSession` drives it. Keeps the
 * voice path byte-for-byte identical while letting a text session reuse every
 * flow module, timer, and the completion pipeline unchanged.
 */
interface ChannelRuntime {
	/** The AgentSession — voice: STT/TTS/VAD + turn detection; text: bare (the
	 * agent carries the LLM, text I/O rides RoomIO's lk.chat streams). */
	session: voice.AgentSession;
	/** Inactivity-hangup budget in seconds: voice = silence-hangup; text = a far
	 * longer no-dead-air-cost inactivity window. */
	idleTimeoutSeconds: number;
	/** Start the AgentSession with channel-appropriate room I/O options. */
	start(agent: voice.Agent): Promise<void>;
	/** Wait until the human is live (voice: participant + SIP answer; text:
	 * participant joined). `{ live: false }` → no answer / abandoned before going
	 * live, carrying a granular end reason for the completion report. */
	waitUntilLive(): Promise<LiveResult>;
	/** Egress a committed agent turn. voice: no-op (TTS already spoke it); text:
	 * publish the full message on the lk.chat topic. Called from the shared
	 * ConversationItemAdded listener so the greeting and every reply flow out. */
	emitAgentTurn(text: string): void;
	/** Release channel-owned resources at session close (voice: the thinking-sound
	 * BackgroundAudioPlayer). Optional — text has none. */
	dispose?(): Promise<void>;
}

/**
 * Build the voice channel: today's AgentSession (STT/TTS/VAD + turn detection),
 * its go-live SIP-answer wait, and TTS-drives-egress (so emitAgentTurn is a
 * no-op). Preserved byte-for-byte from the pre-Phase-6 startSession.
 */
function buildVoiceChannel(
	ctx: JobContext,
	config: AgentConfig,
	isInbound: boolean,
	dispatch: DispatchMetadata,
): ChannelRuntime {
	const sttModel = inferenceModel(config.stt.model, config.stt.provider, "xai/stt-1");
	// xAI STT auto-detects (and code-switches) languages mid-call; pinning
	// it to the agent's language forces monolingual decoding — Spanish
	// callers got slow/empty finals. Only language-scoped providers
	// (Deepgram, AssemblyAI, …) receive the hint.
	const sttIsXai = sttModel.startsWith("xai/");
	const stt = new inference.STT({
		model: sttModel,
		...(sttIsXai ? {} : { language: config.language }),
	});
	// vad mode is a REAL mode in @livekit/agents ≥1.5.0: AgentSession auto-
	// provisions a bundled inference.VAD (Silero, via the Inference gateway). We
	// pass it explicitly so the wiring is self-documenting and not reliant on the
	// auto-provision behavior. semantic mode keeps the cloud end-of-turn model.
	const useVad = config.turnDetection.mode === "vad";
	const session = new voice.AgentSession({
		stt,
		tts: buildTts(config.tts),
		...(useVad ? { vad: new inference.VAD() } : {}),
		turnHandling: {
			// semantic → LiveKit's end-of-turn model; vad → Silero VAD start/stop cues.
			turnDetection: useVad ? "vad" : new inference.TurnDetector(),
			endpointing: { minDelay: config.turnDetection.endpointingMs },
			// minWords: 0 (SDK default) lets any 500ms+ noise burst — line hiss,
			// SIP echo of the agent's own TTS — register as a barge-in with no
			// recognized speech, cutting the agent off mid-sentence. Requiring at
			// least one recognized word filters that out while still letting real
			// speech interrupt immediately; configurable now that telephony noise
			// cancellation removes most of the root cause.
			interruption: {
				enabled: config.turnDetection.allowInterruptions,
				minWords: config.turnDetection.interruptionMinWords,
				// False-interruption recovery: if the barge-in yields no user
				// transcript within this window (a cough, background noise), resume
				// the agent's turn instead of leaving it permanently cut off. These
				// match the SDK defaults but are set explicitly so the behavior is
				// intentional and tunable.
				falseInterruptionTimeout: 2000,
				resumeFalseInterruption: true,
			},
			// Draft the reply (LLM + first TTS chunk) while the caller is still
			// finishing their sentence; discard if the final transcript differs.
			preemptiveGeneration: { enabled: config.turnDetection.preemptiveGeneration !== false },
		},
	});

	// Mid-call language alignment: follow the CALLER's language, debounced per
	// final transcript (two consecutive confident detections before switching).
	// Language-scoped STT providers get their hint updated in place —
	// stt.updateOptions propagates to the live stream, no session recreation.
	// xAI STT stays unhinted (auto-detects / code-switches; see above). The LLM
	// side is covered by the unconditional language rule assemble.ts injects
	// into every voice agent's instructions; our TTS options pin no language.
	const aligner = createLanguageAligner({
		callId: dispatch.callId,
		initialLanguage: config.language,
		apply: (hint) => {
			if (!sttIsXai) stt.updateOptions({ language: asLanguageCode(hint) });
		},
	});
	session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
		if (ev.isFinal) aligner.onFinalTranscript(ev.transcript, ev.language);
	});

	// Subtle thinking sound (SDK-native, driven by the agent-state machine) so a
	// slow LLM/tool turn isn't dead air. Voice channel only; created at start and
	// released in dispose(). Default ON, kill switch via config.audio.thinkingSound.
	const thinkingSoundEnabled = config.audio?.thinkingSound !== false;
	let bgAudio: voice.BackgroundAudioPlayer | null = null;

	const noAnswerMs = (config.timeouts.noAnswerSeconds ?? 25) * 1000;
	return {
		session,
		idleTimeoutSeconds: config.timeouts.silenceHangupSeconds,
		start: async (agent) => {
			// Noise cancellation on the caller's inbound audio. Telephony model for
			// SIP legs (inbound is always SIP; outbound detected via the SIP
			// participant), the general model for web legs. Kill switch: audio.noiseCancellation.
			const ncEnabled = config.audio?.noiseCancellation !== false;
			const telephony = isInbound || roomHasSipParticipant(ctx.room);
			const noiseCancellation = !ncEnabled
				? undefined
				: telephony
					? TelephonyBackgroundVoiceCancellation()
					: BackgroundVoiceCancellation();
			console.log(
				`[session] voice options: turnDetection=${config.turnDetection.mode} interruptionMinWords=${config.turnDetection.interruptionMinWords} falseInterruptionTimeout=2000ms noiseCancellation=${ncEnabled ? (telephony ? "telephony" : "background") : "off"} thinkingSound=${thinkingSoundEnabled ? "on" : "off"}`,
			);
			await session.start({
				agent,
				room: ctx.room,
				...(noiseCancellation ? { inputOptions: { noiseCancellation } } : {}),
			});
			if (thinkingSoundEnabled) {
				try {
					bgAudio = new voice.BackgroundAudioPlayer({
						thinkingSound: { source: voice.BuiltinAudioClip.KEYBOARD_TYPING2, volume: 0.4 },
					});
					await bgAudio.start({ room: ctx.room, agentSession: session });
				} catch (err) {
					// Non-fatal: a missing audio track must never fail the call.
					console.error("[session] thinking-sound start failed", err);
					bgAudio = null;
				}
			}
		},
		waitUntilLive: async () => {
			// Wait for the human before greeting: browsers join within seconds;
			// outbound SIP participants exist while ringing, so also wait for the
			// call to be answered (sip.callStatus → active).
			const remote = await Promise.race([
				ctx.waitForParticipant(),
				new Promise<null>((r) => setTimeout(() => r(null), noAnswerMs + 20_000)),
			]);
			if (!remote) return { live: false, endReason: "no_answer", status: "no_answer" };
			return await waitForSipAnswer(ctx, remote, noAnswerMs);
		},
		// Voice replies are spoken by TTS — nothing extra to emit.
		emitAgentTurn: () => {},
		dispose: async () => {
			await bgAudio?.close().catch((err) => console.error("[session] thinking-sound close failed", err));
			bgAudio = null;
		},
	};
}

/**
 * Build the text channel (Phase 6): a bare AgentSession with no STT/TTS/VAD,
 * driven entirely over LiveKit text streams on the lk.chat topic. Inbound caller
 * turns are handled natively by RoomIO's text-stream handler (which calls
 * generateReply on the agent's LLM); outbound agent turns are published back on
 * lk.chat by emitAgentTurn. No audio tracks are ever published or subscribed.
 */
function buildTextChannel(ctx: JobContext, config: AgentConfig): ChannelRuntime {
	// No stt/tts/vad: the agent carries the LLM, and turns are text — no
	// endpointing / VAD / barge-in machinery is involved.
	const session = new voice.AgentSession({});

	const publish = (text: string) => {
		const lp = ctx.room.localParticipant;
		if (!lp) return;
		// Full-message delivery (sendText, not streamText): a text/SMS channel
		// wants the whole reply as one message, not per-token deltas.
		void lp.sendText(text, { topic: TOPIC_CHAT }).catch((err) => {
			console.error("text channel: sendText failed", err);
		});
	};

	return {
		session,
		// Text has no dead-air cost — a much longer inactivity budget (unless the
		// operator configured an even longer voice silence-hangup).
		idleTimeoutSeconds: Math.max(config.timeouts.silenceHangupSeconds, TEXT_INACTIVITY_SECONDS),
		start: (agent) =>
			session
				.start({
					agent,
					room: ctx.room,
					// Text-only I/O: no audio in or out. Caller input arrives on the
					// lk.chat text-stream topic (RoomIO registers the handler and the
					// default callback feeds it to generateReply). We publish the
					// agent's replies ourselves (emitAgentTurn on lk.chat), so the
					// native transcription output is disabled to avoid a second stream
					// on lk.transcription.
					inputOptions: { audioEnabled: false, textEnabled: true },
					outputOptions: { audioEnabled: false, transcriptionEnabled: false },
				})
				.then(() => undefined),
		waitUntilLive: async () => {
			// A text participant (browser / bridge) joins immediately; no SIP answer
			// to wait on. Timeout → treated as abandoned (no_answer).
			const noAnswerMs = (config.timeouts.noAnswerSeconds ?? 25) * 1000;
			const remote = await Promise.race([
				ctx.waitForParticipant(),
				new Promise<null>((r) => setTimeout(() => r(null), noAnswerMs)),
			]);
			return remote ? { live: true } : { live: false, endReason: "no_answer", status: "no_answer" };
		},
		emitAgentTurn: publish,
	};
}

function buildChannel(
	channel: "voice" | "text",
	ctx: JobContext,
	config: AgentConfig,
	isInbound: boolean,
	dispatch: DispatchMetadata,
): ChannelRuntime {
	return channel === "text"
		? buildTextChannel(ctx, config)
		: buildVoiceChannel(ctx, config, isInbound, dispatch);
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
	/** When true, `greeting` is a DIRECTION the model generates the opener from
	 * (via generateReply) rather than a verbatim line spoken via say. */
	greetingGenerate?: boolean;
	/** Inbound SIP jobs skip the call.started event (already reported upstream). */
	isInbound: boolean;
	/** Session channel (Phase 6): selects the I/O adapter. Defaults to voice. */
	channel: "voice" | "text";
}

const DEFAULT_DISCLOSURE = "Just so you know, you're speaking with an A.I. assistant.";

/**
 * Build the AgentSession (per channel), wire every session event handler +
 * engine timer, go live (waiting for the human / SIP answer), then speak/send
 * the disclosure + greeting. Returns once the opening is queued.
 */
export async function startSession(deps: SessionLifecycleDeps): Promise<void> {
	const { job: ctx, config, dispatch, turns, state, agent, greeting } = deps;

	const channel = buildChannel(deps.channel, ctx, config, deps.isInbound, dispatch);
	const { session } = channel;
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

	// Responder ai.turn pairing state (AI-logs panel): llm_metrics for a reply
	// arrive before the reply commits as a ConversationItemAdded, so metrics are
	// queued here and consumed by the item handler.
	const respondMetricsQueue: { promptTokens: number; completionTokens: number }[] = [];
	// AI-logs badge for the respond role. When the TEXT channel runs the reply on
	// Claude (same gate as flow/assemble's defaultLlm), label the ai.turn with the
	// Claude model so providerFromModel maps it to Anthropic; otherwise the xAI /
	// configured Inference model. Voice is unaffected (gate returns null).
	const respondModel =
		anthropicRespondModel(dispatch.channel, config) ??
		inferenceModel(config.models?.respond ?? config.llm.model, "xai", "xai/grok-4-fast");

	// 4. Collect transcript turns + usage meters as the session runs. Channel-
	// agnostic: ConversationItemAdded fires whether the turn arrived by STT or a
	// text stream, and whether the reply left as TTS audio or a text stream.
	session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
		if (!("role" in ev.item)) return; // agent-handoff items carry no speech
		const role = ev.item.role === "assistant" ? "agent" : ev.item.role === "user" ? "user" : "system";
		const text = ev.item.textContent;
		if (text) turns.push({ role, text, ts: Date.now() / 1000 });
		// Text channel: publish the agent's committed reply back on lk.chat (no-op
		// on voice, where TTS already spoke it). The greeting/disclosure ride the
		// same path (session.say emits a ConversationItemAdded too).
		if (role === "agent" && text) channel.emitAgentTurn(text);
		// AI-logs panel: pair each committed LLM reply with its collected metrics
		// (queued below in MetricsCollected — the stream finishes before the item
		// commits). say()-driven items (greeting/statements) have no metrics queued
		// and are skipped. The session drives the responder internally, so the full
		// request isn't capturable here — the row carries model/tokens/response.
		if (role === "agent" && text) {
			const m = respondMetricsQueue.shift();
			if (m) {
				reportAiTurn(dispatch.callId, {
					class: "respond",
					title: "Agent response",
					model: respondModel,
					promptTokens: m.promptTokens,
					completionTokens: m.completionTokens,
					request: null,
					response: text,
					extra: { node: session.currentAgent?.id ?? null },
				});
			}
		}
		// Judge objectives off the hot path: fires AFTER the turn is recorded
		// so the judge always sees the caller's latest words. Async — never
		// delays the reply that's already generating. Read fresh off state.turnHooks
		// so an agent handoff (flow.handoff) swaps in the TARGET's trackers.
		if (role === "user" && text) {
			state.turnHooks.objective?.();
			state.turnHooks.memory?.();
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
			// Queue for the ConversationItemAdded pairing above (ai.turn logging).
			// Cap the queue so interrupted/discarded generations can't grow it.
			respondMetricsQueue.push({ promptTokens: m.promptTokens, completionTokens: m.completionTokens });
			if (respondMetricsQueue.length > 4) respondMetricsQueue.shift();
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
		// The room delete is what disconnects the SIP leg — a swallowed failure
		// here leaves the caller on a silent open line while the engine reports
		// the call completed. Log loudly and retry once before giving up.
		try {
			await ctx.deleteRoom();
		} catch (err) {
			console.error("room delete failed — SIP leg may linger; retrying once", err);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			await ctx
				.deleteRoom()
				.catch((err2) => console.error("room delete retry failed — caller line may stay open", err2));
		}
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
		// Release channel-owned resources (voice thinking-sound player).
		void channel.dispose?.().catch((err) => console.error("channel dispose failed", err));
	});
	ctx.addShutdownCallback(complete);

	// 6. Engine-enforced timeouts (spec §4). Max-duration applies to both
	// channels; the silence timer becomes a (longer) inactivity timeout on text.
	const maxCallTimer = setTimeout(() => {
		void state.hangUp("max_duration");
	}, config.timeouts.maxCallSeconds * 1000);

	let silenceTimer: NodeJS.Timeout | undefined;
	const idleMs = channel.idleTimeoutSeconds * 1000;
	const resetSilence = () => {
		if (silenceTimer) clearTimeout(silenceTimer);
		silenceTimer = setTimeout(() => {
			void state.hangUp(deps.channel === "text" ? "inactivity_timeout" : "silence_timeout");
		}, idleMs);
	};
	// UserInputTranscribed is STT-driven (voice only, dead on text); ConversationItemAdded
	// fires on every committed turn on both channels, so text inactivity resets too.
	session.on(voice.AgentSessionEventTypes.UserInputTranscribed, resetSilence);
	session.on(voice.AgentSessionEventTypes.ConversationItemAdded, resetSilence);
	session.on(voice.AgentSessionEventTypes.Close, () => {
		clearTimeout(maxCallTimer);
		if (silenceTimer) clearTimeout(silenceTimer);
		// A conversation node's soft wrap-up timer must not fire (generateReply)
		// after the session is torn down.
		if (state.conversationTimer) clearTimeout(state.conversationTimer);
	});

	// 7. Go live. The channel owns how (voice: start + SIP answer wait; text:
	// start with text-only I/O + participant wait).
	await channel.start(agent);

	const live = await channel.waitUntilLive();
	if (!live.live) {
		// Granular no-answer/failure reason (busy, rejected, invalid number, trunk
		// failure) mapped from the SIP disconnect attributes; plain "no_answer" for
		// web/abandoned. Threaded into the completion report + call.failed/completed.
		completionStatus = live.status;
		endReason = live.endReason;
		await complete();
		await state.hangUp(live.endReason);
		return;
	}

	startedAt = Date.now();
	resetSilence();
	if (!deps.isInbound) {
		reportEvent(dispatch.callId, "call.started", { room: ctx.room.name ?? null });
	}

	// 8. Compliance disclosure is engine-enforced, then the configured greeting.
	// session.say commits the message to chat context and emits a
	// ConversationItemAdded on both channels: voice speaks it via TTS; text has
	// no audio output, so the message rides the lk.chat egress (emitAgentTurn).
	const disclosure = config.compliance.aiDisclosure
		? (config.compliance.disclosureText ?? DEFAULT_DISCLOSURE)
		: undefined;
	if (greeting && deps.greetingGenerate) {
		// generate=true: the disclosure (a compliance string) stays VERBATIM, then
		// the model opens with a fresh greeting generated from the DIRECTION — the
		// same generateReply-from-direction path statements/handoffs use, so the
		// agent's persona/style + language rules apply.
		if (disclosure) session.say(disclosure);
		session.generateReply({
			instructions: `Open the call now: greet the caller warmly in ONE short, natural spoken sentence, varying the phrasing so it never sounds scripted. Base your greeting on this direction: ${greeting}`,
		});
	} else {
		// Verbatim (default): disclosure + greeting spoken exactly as authored.
		const opening: string[] = [];
		if (disclosure) opening.push(disclosure);
		if (greeting) opening.push(greeting);
		if (opening.length > 0) session.say(opening.join(" "));
	}
}
