import { llm, voice, workflows } from "@livekit/agents";
import { SipClient } from "livekit-server-sdk";
import { env } from "../env.js";
import { reportEvent } from "../gateway.js";
import type { FlowRuntimeContext } from "./context.js";
import type { ResolvedTarget } from "./objectives.js";

/**
 * The "transfer" node hands the caller off to another party. ONE node kind,
 * THREE modes (config `transfer.mode`, default "simulated" so pre-existing
 * transfer nodes — which carry no mode — keep behaving exactly as before):
 *
 * - "simulated" (DEFAULT, unchanged): NO real phone dial. The exit tool ends the
 *   LLM turn immediately while a detached chain speaks the announcement in the
 *   CURRENT voice, plays hold music, applies the new voice, and switches agents
 *   via session.updateAgent — the one mechanism that survives mixed-tool turns.
 *   Returning an llm.handoff from the exit tool does NOT work here: with a queued
 *   say + parallel tool calls in the same turn the SDK drops the handoff and
 *   keeps generating on the old agent.
 *
 * - "warm" (REAL attended transfer): dial `target` over SIP, keep the caller on
 *   hold music while it rings, brief the human agent, then merge the two calls.
 *   Backed by LiveKit's `workflows.WarmTransferTask`, which MUST run inside a
 *   function-tool / onEnter context — so it is only driven from the exit-tool
 *   path (`runTransfer`). A warm node reached from a non-tool context (an
 *   objective-driven transition via `startTransfer`) cannot start the task and
 *   degrades to a cold SIP REFER to the same `target` (documented below).
 *
 * - "cold" (REAL blind transfer / call forwarding): SIP REFER via
 *   `SipClient.transferSipParticipant`. The inbound PSTN leg is forwarded to
 *   `target`, the agent drops, and the session ends. Works from either path.
 *
 * REAL modes need a SIP trunk (outbound for warm, REFER-capable for cold) and
 * cannot be exercised without one — see the deploy notes.
 */
export interface Transfer {
	/** Start the detached transfer sequence (engine paths + exit-tool path).
	 * Handles simulated + cold; a warm node here degrades to cold REFER. */
	startTransfer(nodeId: string): void;
	/** Exit-tool entry (a valid context for WarmTransferTask). For "warm" it runs
	 * the attended-transfer task inline and resolves once the parties are merged
	 * (the agent then steps out); for simulated/cold it starts the detached
	 * sequence and ends the LLM turn with no reply (throws StopResponse). */
	runTransfer(nodeId: string): Promise<string>;
}

export interface TransferDeps {
	resolveTarget(target: string | undefined): Promise<ResolvedTarget>;
	buildFlowAgent(nodeId: string, chatCtx?: llm.ChatContext): voice.Agent;
	/** Start an agent-handoff sequence when a transfer chains into a `handoff` node. */
	startHandoff(target: {
		agentId: string;
		fromNode: string;
		transition?: { say?: string; holdSeconds?: number };
	}): void;
}

/** Minimal shape of a room participant we read for SIP identity resolution. */
interface ParticipantLike {
	identity: string;
	attributes?: Record<string, string>;
}

export function createTransfer(ctx: FlowRuntimeContext, deps: TransferDeps): Transfer {
	const { nodesById, dispatch } = ctx;
	const { resolveTarget, buildFlowAgent, startHandoff } = deps;

	// Lazily-started hold-music player, shared across transfers on this call.
	let backgroundAudio: voice.BackgroundAudioPlayer | null = null;
	const ensureBackgroundAudio = async () => {
		if (!backgroundAudio) {
			backgroundAudio = new voice.BackgroundAudioPlayer();
			await backgroundAudio.start({ room: ctx.job.room, agentSession: ctx.session });
		}
		return backgroundAudio;
	};

	/**
	 * Resolve the inbound PSTN caller's participant identity for a cold (REFER)
	 * transfer: the remote participant carrying `sip.*` attributes (LiveKit stamps
	 * these on every SIP/telephony leg). Returns null on a browser/webRTC-only
	 * call (nothing to REFER) — the caller logs and ends.
	 */
	const resolveSipParticipantIdentity = (): string | null => {
		const room = ctx.job.room as {
			remoteParticipants?: Map<string, ParticipantLike>;
		};
		const rp = room.remoteParticipants;
		if (!rp) return null;
		for (const p of rp.values()) {
			if (Object.keys(p.attributes ?? {}).some((k) => k.startsWith("sip."))) {
				return p.identity;
			}
		}
		return null;
	};

	/** Announce the transfer in the pre-transfer voice (shared by every mode). */
	const announce = async (say: string | undefined): Promise<void> => {
		if (!say) return;
		// Queued after any speech already playing. Not interruptible — it's a
		// system moment.
		const handle = ctx.session.say(ctx.interpolateSpoken(say), {
			allowInterruptions: false,
		});
		await handle.waitForPlayout().catch(() => {});
	};

	/**
	 * Cold transfer (real blind transfer / call forwarding via SIP REFER). Runs
	 * fine from a detached context — it is a pure server-side API call. After the
	 * REFER the caller leg leaves for `target` and the agent's session ends.
	 */
	const coldTransfer = async (nodeId: string): Promise<void> => {
		const node = nodesById.get(nodeId);
		const t = node?.transfer;
		const target = t?.target;
		if (!target) {
			console.error(`flow: cold transfer node "${nodeId}" has no target — ending call`);
			await ctx.hangUp("transfer_no_target");
			return;
		}
		const identity = resolveSipParticipantIdentity();
		if (!identity) {
			console.error(
				`flow: cold transfer node "${nodeId}" found no SIP participant to REFER — ending call`,
			);
			await ctx.hangUp("transfer_no_sip_participant");
			return;
		}
		await announce(t?.say);
		const sip = new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
		await sip.transferSipParticipant(ctx.job.room.name ?? "", identity, target, {
			playDialtone: true,
			// Whole-second granularity; reuse waitSeconds as the REFER ring timeout.
			ringingTimeout: Math.round(t?.waitSeconds ?? 30),
		});
		// The caller has been forwarded; tear down this agent's session.
		await ctx.hangUp("transfer_cold");
	};

	/**
	 * Warm transfer (real attended transfer). MUST be awaited inside a
	 * function-tool / onEnter context (WarmTransferTask requirement), so it is
	 * only reachable via `runTransfer`. Dials `target`, holds the caller on music
	 * while it rings + while the human is briefed, then merges the calls. On
	 * success the agent steps out (session.close, NOT hangUp — deleting the room
	 * would drop the now-bridged caller+human).
	 */
	const warmTransfer = async (nodeId: string): Promise<string> => {
		const node = nodesById.get(nodeId);
		const t = node?.transfer;
		const target = t?.target;
		if (!target) {
			console.error(`flow: warm transfer node "${nodeId}" has no target — ending call`);
			await ctx.hangUp("transfer_no_target");
			throw new voice.StopResponse();
		}
		await announce(t?.say);
		const waitSeconds = Math.max(1, Math.min(120, t?.waitSeconds ?? 30));
		try {
			const task = new workflows.WarmTransferTask({
				sipCallTo: target,
				// Option is in milliseconds (rounded to whole seconds internally).
				ringingTimeout: waitSeconds * 1000,
				// Reuse the built-in hold music the simulated path already uses.
				holdAudio: { source: voice.BuiltinAudioClip.HOLD_MUSIC, volume: 0.7 },
			});
			const result = await task.run();
			reportEvent(dispatch.callId, "flow.transfer_warm", {
				node: nodeId,
				target,
				humanAgentIdentity: result.humanAgentIdentity,
			});
			// Parties merged — the AI leaves the conversation but the room lives on
			// so the caller and human keep talking. Close only the agent session.
			await ctx.session.close().catch((err) => console.error("flow: warm transfer close failed", err));
			ctx.state.completed = true;
			return "transfer complete";
		} catch (err) {
			// Dial failed / declined / voicemail / timeout — return the caller to the
			// flow (the exit target) rather than dropping them.
			console.error(`flow: warm transfer node "${nodeId}" failed`, err);
			reportEvent(dispatch.callId, "flow.transfer_warm_failed", { node: nodeId, target });
			throw new voice.StopResponse();
		}
	};

	const startTransfer = (nodeId: string): void => {
		const node = nodesById.get(nodeId);
		const t = node?.transfer;
		const mode = t?.mode ?? "simulated";
		if (ctx.state.transferInFlight) return;
		ctx.state.transferInFlight = true;
		reportEvent(dispatch.callId, "flow.node", {
			node: nodeId,
			name: node?.name ?? null,
			kind: "transfer",
			mode,
		});
		const exit = node?.exits[0];
		reportEvent(dispatch.callId, "flow.exit", {
			node: nodeId,
			exit: exit?.name ?? "end",
			target: exit?.target ?? null,
		});

		// Real cold transfer: REFER and end. A warm node reached HERE (an
		// objective-driven / engine transition, not the exit-tool path) cannot run
		// WarmTransferTask (which requires a tool context) — degrade to a cold REFER
		// to the same target so the caller still reaches `target`.
		if (mode === "cold" || mode === "warm") {
			if (mode === "warm") {
				console.warn(
					`flow: warm transfer node "${nodeId}" reached from a non-tool transition — ` +
						`WarmTransferTask needs a function-tool context; degrading to cold SIP REFER`,
				);
			}
			void coldTransfer(nodeId)
				.catch((err) => console.error("flow: cold transfer failed", err))
				.finally(() => {
					ctx.state.transferInFlight = false;
				});
			return;
		}

		// Simulated (default, unchanged): announcement → hold music → voice swap →
		// continue the flow at the exit target within the same session.
		void (async () => {
			await announce(t?.say);
			const holdSeconds = Math.max(0, t?.holdSeconds ?? 4);
			if (holdSeconds > 0) {
				const player = await ensureBackgroundAudio();
				const music = player.play(
					{ source: voice.BuiltinAudioClip.HOLD_MUSIC, volume: 0.7 },
					true,
				);
				await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
				music.stop();
			}
			if (t?.voice) {
				ctx.state.ttsOverride = ctx.buildTts({
					provider: t.voice.provider,
					voice: t.voice.voice,
					speed: t.voice.speed ?? 1.0,
				});
			}
			// The transfer's onward wire may pass through routers/statements.
			const next = await resolveTarget(exit?.target);
			// Lift the speech guard BEFORE the switch: the next agent's
			// onEnter generateReply (and any statement say) is legitimate.
			ctx.state.transferInFlight = false;
			if (next.kind === "agent") {
				const nextCtx = ctx.session.currentAgent.chatCtx.copy({ excludeInstructions: true });
				ctx.session.updateAgent(buildFlowAgent(next.id, nextCtx));
			} else if (next.kind === "end") {
				await ctx.hangUp("flow_complete");
			} else if (next.kind === "handoff") {
				startHandoff({
					agentId: next.agentId,
					fromNode: next.fromNode,
					transition: next.transition,
				});
			}
			// end_after_speech: a terminal statement queued its own hangup.
			// A transfer chaining into another transfer is not supported.
		})()
			.catch((err) => console.error("flow: transfer sequence failed", err))
			.finally(() => {
				ctx.state.transferInFlight = false;
			});
	};

	/** Tool-call path into a transfer. Warm runs the attended-transfer task inline
	 * (valid context) and resolves once merged; simulated/cold start the detached
	 * sequence and end the LLM turn with no tool reply — the model never gets a
	 * chance to keep talking over the transfer. Engine paths (objective
	 * transitions) call startTransfer directly; there is no LLM turn to stop. */
	const runTransfer = async (nodeId: string): Promise<string> => {
		const mode = nodesById.get(nodeId)?.transfer?.mode ?? "simulated";
		if (mode === "warm") {
			return warmTransfer(nodeId);
		}
		startTransfer(nodeId);
		throw new voice.StopResponse();
	};

	return { startTransfer, runTransfer };
}
