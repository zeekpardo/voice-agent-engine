import { voice } from "@livekit/agents";
import { type AgentBundle, type DispatchMetadata, fetchAgentBundleLatest, reportEvent } from "../gateway.js";
import { type AssembleShared, assembleAgent } from "./assemble.js";
import { buildTts, interpolate } from "./context.js";

/**
 * Agent-handoff (flow `handoff` node): hand the LIVE call off to a DIFFERENT
 * published agent, one-way, carrying the conversation context. Mirrors
 * flow/transfer's detached-swap pattern — the agent switch (session.updateAgent)
 * must NOT ride a tool-returned handoff in a mixed-tool turn (the SDK drops it),
 * so the exit tool ends its turn (runHandoff → StopResponse) and the swap runs
 * detached here.
 *
 * The sequence: fetch the target's CURRENT config from the gateway → build its
 * entry agent (its flow.entry, or a single-agent build with no flow) carrying the
 * copied chatCtx → re-point the session's per-caller-turn hooks to the target's
 * trackers → session.updateAgent → nudge the target to pick the call up in its own
 * persona (no greeting/recap). One-way: there is no automatic return.
 *
 * Guards: a max handoff count (loop protection) and a missing/inaccessible or
 * cross-project target both log a flow event and end the call gracefully.
 */

const MAX_HANDOFFS = 3;

export interface HandoffTarget {
	/** Target published-agent id (flow node's handoffAgentId). */
	agentId: string;
	/** The source flow's handoff node id (for the flow.handoff event). */
	fromNode: string;
	/** The node's optional transition moment: announcement (spoken in the
	 * SOURCE agent's voice) + hold music before the swap. `mode` selects how the
	 * swap presents — "announced" (default): say + music + the target's entry
	 * greeting; "seamless": none of the three, the target just continues the same
	 * conversation. */
	transition?: {
		mode?: "seamless" | "announced";
		say?: string;
		generate?: boolean;
		holdSeconds?: number;
	};
}

/** Hold music to play when the node doesn't set holdSeconds — a short beat so
 * the handoff feels deliberate. 0 in the node config disables it entirely. */
const DEFAULT_HOLD_SECONDS = 3;

/** Cap on waiting for in-flight speech to finish before the hold music — a
 * stuck playout must not wedge the handoff. */
const SPEECH_WAIT_CAP_MS = 15_000;

/**
 * Wait for the speech currently playing on the session (if any) to finish.
 * Used before starting hold music: the source agent's own transition words —
 * the reply the model spoke alongside the exit tool call — may still be
 * playing, and BackgroundAudioPlayer rides a SEPARATE room track that bypasses
 * the speech queue, so starting music immediately puts it UNDER/BEFORE the
 * announcement. NOTE: `waitForPlayout()` is not usable here — this detached
 * chain inherits the exit tool's async context, and awaiting the handle that
 * owns the still-running tool throws SpeechHandleCircularWaitError — so wait
 * on done via addDoneCallback (fires immediately for already-done handles).
 */
async function waitForCurrentSpeech(session: voice.AgentSession): Promise<void> {
	const current = session._activity?.currentSpeech;
	if (!current || current.done()) return;
	await new Promise<void>((resolve) => {
		const onDone = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			current.removeDoneCallback(onDone);
			resolve();
		}, SPEECH_WAIT_CAP_MS);
		current.addDoneCallback(onDone);
	});
}

export interface Handoff {
	/** Start the detached handoff sequence (engine paths: objectives / transfer chain). */
	startHandoff(target: HandoffTarget): void;
	/** Exit-tool entry: start the sequence, then end the LLM turn with no reply. */
	runHandoff(target: HandoffTarget): never;
}

export function createHandoff(shared: AssembleShared): Handoff {
	const callId = shared.dispatch.callId;
	let handoffs = 0;
	let inFlight = false;

	const doHandoff = async (target: HandoffTarget): Promise<void> => {
		// One handoff at a time; a duplicated exit invocation is a no-op.
		if (inFlight) return;
		inFlight = true;
		// Covers the single-agent target path too (flow targets re-stamp via
		// buildFlowAgent) — see FlowRuntimeState.lastTransitionAt.
		shared.state.lastTransitionAt = Date.now();

		// Loop protection: a graph that keeps handing off (A→B→A→…) can't wedge a
		// call. On the cap we end gracefully rather than continue under a runaway.
		if (++handoffs > MAX_HANDOFFS) {
			console.error(`flow: handoff limit (${MAX_HANDOFFS}) exceeded at node "${target.fromNode}" — ending call`);
			reportEvent(callId, "flow.handoff_aborted", {
				from: target.fromNode,
				toAgentId: target.agentId,
				reason: "max_handoffs",
				max: MAX_HANDOFFS,
			});
			await shared.state.hangUp("handoff_limit");
			return; // leave inFlight set — the call is ending
		}

		let bundle: AgentBundle;
		try {
			// The target's CURRENT live config (version omitted → gateway resolves
			// the published version). The handed-off call runs the latest config.
			bundle = await fetchAgentBundleLatest(target.agentId);
		} catch (err) {
			console.error(`flow: handoff target fetch failed (${target.agentId})`, err);
			reportEvent(callId, "flow.handoff_failed", {
				from: target.fromNode,
				toAgentId: target.agentId,
				reason: "fetch_failed",
			});
			await shared.state.hangUp("handoff_failed");
			return;
		}

		// Never cross the project boundary — a handoff stays within this call's org.
		if (bundle.agent.project !== shared.dispatch.projectId) {
			console.error(
				`flow: handoff target "${target.agentId}" is in project "${bundle.agent.project}", not "${shared.dispatch.projectId}" — refusing`,
			);
			reportEvent(callId, "flow.handoff_failed", {
				from: target.fromNode,
				toAgentId: target.agentId,
				reason: "cross_project",
			});
			await shared.state.hangUp("handoff_failed");
			return;
		}

		const session = shared.state.session;
		if (!session) {
			inFlight = false;
			return;
		}

		// Expose the TARGET agent's display name as {{agent_name}} so the bridge
		// announcement ("passing you to {{agent_name}}") and the target's entry
		// greeting ("Hi, this is {{agent_name}}") can name it. Set before any
		// interpolation below; persists in the shared variable map thereafter.
		shared.variables.agent_name = bundle.agent.name;

		// Handoff mode (default "announced" — preserves the pre-mode behavior:
		// say + music + the target's entry greeting). "seamless" suppresses all
		// three so the target just continues the same conversation.
		const mode = target.transition?.mode ?? "announced";

		// Transition moment (Announced mode, voice channel only): optional
		// announcement in the SOURCE agent's voice, then hold music — the same
		// CloseBot-style beat the simulated transfer plays, so a handoff sounds like
		// being connected to a colleague rather than an instant personality swap.
		// Seamless skips it entirely (no bridge, no music). Runs AFTER the fetch
		// guards (never play music into a call that's about to end) and BEFORE the
		// ttsOverride below (the announcement belongs to the outgoing agent).
		if (mode === "announced" && shared.dispatch.channel !== "text") {
			const t = target.transition;
			if (t?.say) {
				// generate=true: the SOURCE agent's model speaks a fresh announcement
				// from `say`-as-direction (caller-language + persona/style already in the
				// current session) — the same generateReply-from-direction path
				// statements/greetings use. Absent/false (default): spoken VERBATIM.
				const handle =
					t.generate === true
						? session.generateReply({
								instructions: `Tell the caller now, in ONE short natural sentence and in the language they are currently using, that you're connecting/transferring them — vary the phrasing so it never sounds scripted. Do this based on: ${interpolate(t.say, shared.variables)}`,
								allowInterruptions: false,
							})
						: session.say(
								t.say.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => shared.variables[key] ?? ""),
								{ allowInterruptions: false },
							);
				await handle.waitForPlayout().catch(() => {});
			}
			// Announcement (the configured say above AND/OR the model's own spoken
			// transition line) fully out BEFORE any music starts.
			await waitForCurrentSpeech(session);
			const holdSeconds = Math.max(0, Math.min(30, t?.holdSeconds ?? DEFAULT_HOLD_SECONDS));
			if (holdSeconds > 0) {
				try {
					const player = new voice.BackgroundAudioPlayer();
					await player.start({ room: shared.job.room, agentSession: session });
					const music = player.play(
						{ source: voice.BuiltinAudioClip.HOLD_MUSIC, volume: 0.7 },
						true,
					);
					await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
					music.stop();
					await player.close?.();
				} catch (err) {
					console.error("flow: handoff hold music failed (continuing)", err);
				}
			}
		}

		reportEvent(callId, "flow.handoff", {
			from: target.fromNode,
			toAgentId: bundle.agent.id,
			toVersion: bundle.agent.version,
			count: handoffs,
		});

		// Carry the conversation context so the caller isn't re-greeted (the same
		// excludeInstructions copy node-to-node handoffs use). buildFlowAgent /
		// the single-agent build attach it to the target's entry agent.
		const nextCtx = session.currentAgent.chatCtx.copy({ excludeInstructions: true });
		const targetDispatch: DispatchMetadata = {
			...shared.dispatch,
			agentId: bundle.agent.id,
			agentVersion: bundle.agent.version,
		};
		// Speak in the TARGET's voice from its first word: the session TTS was
		// built from the ORIGINAL agent's config and updateAgent alone never
		// re-applies it. Same override slot the simulated transfer's voice swap
		// uses — agent-builder passes state.ttsOverride into every agent it
		// constructs, so this must be set BEFORE assembleAgent builds the target.
		shared.state.ttsOverride = buildTts(bundle.agent.config.tts);

		// Nudge the target to continue the call in its OWN persona. A flow entry
		// node's onEnter stays silent (it relies on the call's greeting, which never
		// re-fires mid-call), so without this the target waits mutely for the caller.
		// TIMING: this MUST run from the TARGET's onEnter (via entryOnEnter below),
		// NOT right after session.updateAgent — updateAgent only SCHEDULES the
		// activity swap, so a generateReply issued immediately after it lands on the
		// OLD (draining) activity's queue and is dropped (observed live: the
		// handed-off agent stayed silent until the caller spoke). onEnter runs
		// inside the NEW activity's startup — the same mechanism non-entry flow
		// nodes use to open their stage.
		// The target's entry-node "entry message" (a spoken DIRECTION, e.g.
		// "Introduce yourself as the selling specialist…"), if it set one, is the
		// target's opening line on this fresh entry. On a normal (non-handoff) call
		// the engine ignores the entry node's entryInstructions (the greeting opens),
		// so it only ever surfaces here. Interpolated for {{variables}}; the LANGUAGE
		// rule in the assembled agent makes the model translate it into the caller's
		// current language rather than TTS'ing a verbatim string.
		// Seamless suppresses the target's self-intro entry greeting: the target
		// still initiates the conversation content (the generic continue nudge
		// below), just without a "Hi, this is …" opening. Announced (default) uses
		// the target entry node's entryInstructions as its opening line.
		const targetFlow = bundle.agent.config.flow;
		const openingDirection =
			mode === "seamless"
				? undefined
				: targetFlow
					? targetFlow.nodes.find((n) => n.id === targetFlow.entry)?.entryInstructions?.trim()
					: undefined;

		// Skip when the last thing said is an unanswered agent question — opening
		// would stack a second question; let the caller answer first.
		let nudged = false;
		const entryOnEnter = (): void => {
			// One-shot: a flow that later loops back into its entry node re-enters
			// it, and that re-entry must stay silent (pre-handoff semantics).
			if (nudged) return;
			nudged = true;
			const sess = shared.state.session;
			if (!sess || shared.state.completed) return;
			const lastSpoken = shared.turns.filter((t) => t.role !== "system").at(-1);
			if (lastSpoken?.role === "agent" && lastSpoken.text.trim().endsWith("?")) {
				reportEvent(callId, "flow.handoff_silent", {
					toAgentId: bundle.agent.id,
					pending_question: lastSpoken.text.slice(0, 200),
				});
				return;
			}
			// Warm hand-off opening: the target inherits the full conversation context
			// (the copied chatCtx) AND the target agent's own KNOWN CONTACT INFO block,
			// so it can open PERSONALLY — greet the caller by name if that name is
			// known, briefly acknowledge their stated intent (e.g. selling their home),
			// then move to its first needed question. It must NOT recap or re-ask what
			// the previous agent already collected in this same call. Name is used ONLY
			// when actually known — no placeholder when it isn't. The LANGUAGE rule in
			// the assembled agent still makes the model open in the caller's language.
			const warmOpen =
				"You have just taken over this same ongoing call from a colleague — it is the SAME caller, already mid-conversation. Open warmly and personally in ONE short, natural turn: if you know the caller's name (from the conversation so far or the known contact info), greet them BY NAME; if you do not know it, greet them naturally WITHOUT a name and never use a placeholder. In that same opening, briefly acknowledge what they are already here for based on what they told your colleague (for example, that they're looking to sell their home). Do NOT re-introduce the call, do NOT recap details already covered, and do NOT re-ask anything the caller has already answered — weave in or confirm what you already know instead of asking for it.";
			sess.generateReply({
				instructions: openingDirection
					? `${warmOpen} Then: ${interpolate(openingDirection, shared.variables)} Speak in the language the caller is currently using.`
					: `${warmOpen} Then lead naturally into your first needed question. Speak in the language the caller is currently using.`,
			});
		};

		const assembled = assembleAgent(shared, {
			bundle,
			dispatch: targetDispatch,
			handoff: controller,
			entryChatCtx: nextCtx,
			entryOnEnter,
		});

		// Swap the per-caller-turn hooks to the TARGET's trackers BEFORE the agent,
		// so the outgoing agent's objective judge / memory refresh stop firing and
		// the target's take over on the next caller turn.
		shared.state.turnHooks.objective = assembled.objectiveUserTurnHook;
		shared.state.turnHooks.memory = assembled.memoryUserTurnHook;
		session.updateAgent(assembled.agent);
		inFlight = false;
	};

	const controller: Handoff = {
		startHandoff(target) {
			void doHandoff(target).catch((err) => {
				console.error("flow: handoff sequence failed", err);
				inFlight = false;
			});
		},
		runHandoff(target) {
			controller.startHandoff(target);
			throw new voice.StopResponse();
		},
	};
	return controller;
}
