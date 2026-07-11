import { voice } from "@livekit/agents";
import { type AgentBundle, type DispatchMetadata, fetchAgentBundleLatest, reportEvent } from "../gateway.js";
import { type AssembleShared, assembleAgent } from "./assemble.js";
import { buildTts } from "./context.js";

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
	 * SOURCE agent's voice) + hold music before the swap. */
	transition?: { say?: string; holdSeconds?: number };
}

/** Hold music to play when the node doesn't set holdSeconds — a short beat so
 * the handoff feels deliberate. 0 in the node config disables it entirely. */
const DEFAULT_HOLD_SECONDS = 3;

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

		// Transition moment (voice channel only): optional announcement in the
		// SOURCE agent's voice, then hold music — the same CloseBot-style beat the
		// simulated transfer plays, so a handoff sounds like being connected to a
		// colleague rather than an instant personality swap. Runs AFTER the fetch
		// guards (never play music into a call that's about to end) and BEFORE the
		// ttsOverride below (the announcement belongs to the outgoing agent).
		if (shared.dispatch.channel !== "text") {
			const t = target.transition;
			if (t?.say) {
				const spoken = t.say.replace(
					/\{\{\s*([\w.]+)\s*\}\}/g,
					(_, key: string) => shared.variables[key] ?? "",
				);
				const handle = session.say(spoken, { allowInterruptions: false });
				await handle.waitForPlayout().catch(() => {});
			}
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
		const assembled = assembleAgent(shared, {
			bundle,
			dispatch: targetDispatch,
			handoff: controller,
			entryChatCtx: nextCtx,
		});

		// Swap the per-caller-turn hooks to the TARGET's trackers BEFORE the agent,
		// so the outgoing agent's objective judge / memory refresh stop firing and
		// the target's take over on the next caller turn.
		shared.state.turnHooks.objective = assembled.objectiveUserTurnHook;
		shared.state.turnHooks.memory = assembled.memoryUserTurnHook;
		session.updateAgent(assembled.agent);
		inFlight = false;

		// Nudge the target to continue the call in its OWN persona. A flow entry
		// node's onEnter stays silent (it relies on the call's greeting, which never
		// re-fires mid-call), so without this the target waits mutely for the caller.
		// Skip when the last thing said is an unanswered agent question — opening
		// would stack a second question; let the caller answer first.
		const lastSpoken = shared.turns.filter((t) => t.role !== "system").at(-1);
		if (lastSpoken?.role === "agent" && lastSpoken.text.trim().endsWith("?")) {
			reportEvent(callId, "flow.handoff_silent", {
				toAgentId: bundle.agent.id,
				pending_question: lastSpoken.text.slice(0, 200),
			});
			return;
		}
		session.generateReply({
			instructions:
				"You have just taken over this same ongoing call. Continue it in your own role — no greeting, no re-introduction, no recap of what was already covered. Move naturally to your first point or question.",
		});
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
