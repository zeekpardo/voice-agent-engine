import {
	AccessToken,
	AgentDispatchClient,
	RoomAgentDispatch,
	RoomConfiguration,
	RoomServiceClient,
	SipClient,
} from "livekit-server-sdk";
import { env } from "../../env.js";
import { AppError, notImplemented } from "../../lib/errors.js";
import type {
	AgentRuntime,
	DispatchCallInput,
	ProvisionNumberInput,
	WebSessionInput,
} from "./types.js";

/**
 * LiveKit Cloud implementation of AgentRuntime.
 *
 * Web sessions use per-participant tokens with an embedded agent dispatch
 * (RoomConfiguration.agents): the room is created when the browser joins and
 * LiveKit dispatches the named agent-worker to it with our DispatchMetadata
 * as job metadata. The worker deploys separately via `lk agent deploy`.
 */

/** The agent name the deployed worker registers under (worker/livekit.toml). */
export const AGENT_NAME = process.env.LIVEKIT_AGENT_NAME ?? "voice-agent";

function requireLiveKit(): { url: string; apiKey: string; apiSecret: string } {
	if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
		throw new AppError(
			503,
			"livekit_not_configured",
			"Agent sessions require LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET",
		);
	}
	return { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET };
}

export const livekitRuntime: AgentRuntime = {
	name: "livekit",

	async createWebSession({ roomName, participantIdentity, dispatch }: WebSessionInput) {
		const lk = requireLiveKit();

		const token = new AccessToken(lk.apiKey, lk.apiSecret, {
			identity: participantIdentity,
			// Session tokens are short-lived; the room lives as long as participants do.
			ttl: "15m",
		});
		token.addGrant({
			room: roomName,
			roomJoin: true,
			canPublish: true,
			canSubscribe: true,
			canPublishData: true,
		});
		token.roomConfig = new RoomConfiguration({
			agents: [
				new RoomAgentDispatch({
					agentName: AGENT_NAME,
					metadata: JSON.stringify(dispatch),
				}),
			],
		});

		return { roomUrl: lk.url, token: await token.toJwt() };
	},

	async dispatchCall({ roomName, to, from, dispatch }: DispatchCallInput) {
		const lk = requireLiveKit();
		if (!env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID) {
			throw new AppError(
				503,
				"sip_not_configured",
				"Outbound calls require LIVEKIT_SIP_OUTBOUND_TRUNK_ID (run scripts/setup-sip.ts)",
			);
		}

		// Agent first, so it's already listening in the room when the callee answers.
		const agents = new AgentDispatchClient(lk.url, lk.apiKey, lk.apiSecret);
		await agents.createDispatch(roomName, AGENT_NAME, {
			metadata: JSON.stringify(dispatch),
		});

		// Dial. Non-blocking: the worker observes answer/no-answer via participant
		// join and reports call state through the internal API.
		const sip = new SipClient(lk.url, lk.apiKey, lk.apiSecret);
		const participant = await sip.createSipParticipant(
			env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID,
			to,
			roomName,
			{
				...(from ? { fromNumber: from } : {}),
				participantIdentity: `phone_${dispatch.callId}`,
				participantName: to,
				waitUntilAnswered: false,
			},
		);

		return { providerCallRef: participant.participantId ?? roomName, roomName };
	},

	async provisionNumber(_input: ProvisionNumberInput): Promise<never> {
		throw notImplemented("Number provisioning ships in Phase 3 (LiveKit SIP)");
	},

	async routeNumber(): Promise<never> {
		throw notImplemented("Number routing ships in Phase 3 (LiveKit SIP)");
	},

	async cancelCall(roomName: string): Promise<void> {
		const lk = requireLiveKit();
		const rooms = new RoomServiceClient(lk.url, lk.apiKey, lk.apiSecret);
		await rooms.deleteRoom(roomName).catch(() => {
			/* room may already be gone — cancel is idempotent */
		});
	},
};
