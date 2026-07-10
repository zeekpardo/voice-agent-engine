import { llm, voice } from "@livekit/agents";
import { reportEvent } from "../gateway.js";
import type { FlowRuntimeContext } from "./context.js";
import type { ResolvedTarget } from "./objectives.js";

/**
 * Simulated warm transfers ("transfer" nodes): the exit tool ends the LLM turn
 * immediately while a detached chain speaks the announcement in the CURRENT
 * voice, plays hold music, applies the new voice, and switches agents via
 * session.updateAgent — the one mechanism that survives mixed-tool turns.
 *
 * Returning an llm.handoff from the exit tool does NOT work here: with a queued
 * say + parallel tool calls in the same turn the SDK drops the handoff and
 * keeps generating on the old agent.
 */
export interface Transfer {
	/** Start the detached transfer sequence (engine paths + exit-tool path). */
	startTransfer(nodeId: string): void;
	/** Exit-tool entry: start the sequence, then end the LLM turn with no reply. */
	runTransfer(nodeId: string): never;
}

export interface TransferDeps {
	resolveTarget(target: string | undefined): Promise<ResolvedTarget>;
	buildFlowAgent(nodeId: string, chatCtx?: llm.ChatContext): voice.Agent;
}

export function createTransfer(ctx: FlowRuntimeContext, deps: TransferDeps): Transfer {
	const { nodesById, dispatch } = ctx;
	const { resolveTarget, buildFlowAgent } = deps;

	// Lazily-started hold-music player, shared across transfers on this call.
	let backgroundAudio: voice.BackgroundAudioPlayer | null = null;
	const ensureBackgroundAudio = async () => {
		if (!backgroundAudio) {
			backgroundAudio = new voice.BackgroundAudioPlayer();
			await backgroundAudio.start({ room: ctx.job.room, agentSession: ctx.session });
		}
		return backgroundAudio;
	};

	const startTransfer = (nodeId: string): void => {
		const node = nodesById.get(nodeId);
		const t = node?.transfer;
		if (ctx.state.transferInFlight) return;
		ctx.state.transferInFlight = true;
		reportEvent(dispatch.callId, "flow.node", {
			node: nodeId,
			name: node?.name ?? null,
			kind: "transfer",
		});
		const exit = node?.exits[0];
		reportEvent(dispatch.callId, "flow.exit", {
			node: nodeId,
			exit: exit?.name ?? "end",
			target: exit?.target ?? null,
		});

		void (async () => {
			// Announcement in the pre-transfer voice; queued after any speech
			// already playing. Not interruptible — it's a system moment.
			if (t?.say) {
				const announce = ctx.session.say(ctx.interpolateSpoken(t.say), {
					allowInterruptions: false,
				});
				await announce.waitForPlayout().catch(() => {});
			}
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
			}
			// end_after_speech: a terminal statement queued its own hangup.
			// A transfer chaining into another transfer is not supported.
		})()
			.catch((err) => console.error("flow: transfer sequence failed", err))
			.finally(() => {
				ctx.state.transferInFlight = false;
			});
	};

	/** Tool-call path into a transfer: start the sequence, then end the
	 * LLM turn with no tool reply — the model never gets a chance to keep
	 * talking over the transfer. Engine paths (objective transitions) call
	 * startTransfer directly; there is no LLM turn to stop. */
	const runTransfer = (nodeId: string): never => {
		startTransfer(nodeId);
		throw new voice.StopResponse();
	};

	return { startTransfer, runTransfer };
}
