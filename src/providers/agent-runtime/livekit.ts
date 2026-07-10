import {
	AccessToken,
	AgentDispatchClient,
	EgressClient,
	EncodedFileOutput,
	EncodedFileType,
	RoomAgentDispatch,
	RoomCompositeEgressRequest,
	RoomConfiguration,
	RoomEgress,
	RoomServiceClient,
	S3Upload,
	SipClient,
} from "livekit-server-sdk";
import { env } from "../../env.js";
import { AppError, notImplemented } from "../../lib/errors.js";
import type {
	AgentRuntime,
	DispatchCallInput,
	ProvisionNumberInput,
	RecordingRef,
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

/**
 * Recording (LiveKit Egress) — a GATEWAY concern (spec: the engine is neutral;
 * WHERE audio lands is deployment config). We record audio-only RoomComposite
 * egress to S3-compatible storage from the gateway env (S3_*). The filepath is
 * deterministic — `{room}.ogg` — so the S3 reference is known at start time even
 * on the auto-egress (web) path where LiveKit hasn't returned an egress id yet.
 */

/** True only when enough S3 config exists to actually write a recording. */
function recordingStorageConfigured(): boolean {
	return Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY);
}

/**
 * Build the audio-only egress file output + its deterministic S3 reference for a
 * room, or null (with a clear warning) when storage is unconfigured. Never
 * throws — a missing destination must skip recording, not fail the call.
 */
function buildRecordingOutput(
	roomName: string,
): { output: EncodedFileOutput; url: string } | null {
	if (!recordingStorageConfigured()) {
		console.warn(
			`recording: agent opted in but no S3 storage configured (set S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY) — skipping egress for room ${roomName}`,
		);
		return null;
	}
	const filepath = `${roomName}.ogg`;
	const output = new EncodedFileOutput({
		fileType: EncodedFileType.OGG,
		filepath,
		output: {
			case: "s3",
			value: new S3Upload({
				accessKey: env.S3_ACCESS_KEY,
				secret: env.S3_SECRET_KEY,
				bucket: env.S3_BUCKET,
				...(env.S3_REGION ? { region: env.S3_REGION } : {}),
				// A custom endpoint means an S3-compatible store (R2/MinIO/…), which
				// generally needs path-style addressing.
				...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
			}),
		},
	});
	return { output, url: `s3://${env.S3_BUCKET}/${filepath}` };
}

export const livekitRuntime: AgentRuntime = {
	name: "livekit",

	async createWebSession({ roomName, participantIdentity, dispatch, recording }: WebSessionInput) {
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

		// AUTO-EGRESS: the web room is created when the browser joins with this
		// token, so there is no room to start an explicit egress against yet.
		// RoomConfiguration.egress binds recording to that room-creation moment —
		// the correct lifecycle hook. We know the filepath deterministically, so
		// we return the S3 reference now; the egress id is learned later (webhook).
		let rec: RecordingRef | undefined;
		let egress: RoomEgress | undefined;
		if (recording) {
			const built = buildRecordingOutput(roomName);
			if (built) {
				egress = new RoomEgress({
					room: new RoomCompositeEgressRequest({
						roomName,
						audioOnly: true,
						fileOutputs: [built.output],
					}),
				});
				rec = { recordingUrl: built.url };
			}
		}

		token.roomConfig = new RoomConfiguration({
			agents: [
				new RoomAgentDispatch({
					agentName: AGENT_NAME,
					metadata: JSON.stringify(dispatch),
				}),
			],
			...(egress ? { egress } : {}),
		});

		return { roomUrl: lk.url, token: await token.toJwt(), recording: rec };
	},

	async dispatchCall({ roomName, to, from, dispatch, recording }: DispatchCallInput) {
		const lk = requireLiveKit();
		if (!env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID) {
			throw new AppError(
				503,
				"sip_not_configured",
				"Outbound calls require LIVEKIT_SIP_OUTBOUND_TRUNK_ID (run scripts/setup-sip.ts)",
			);
		}

		// Agent first, so it's already listening in the room when the callee answers.
		// createDispatch creates the room synchronously, so an explicit egress can
		// be started against it below.
		const agents = new AgentDispatchClient(lk.url, lk.apiKey, lk.apiSecret);
		await agents.createDispatch(roomName, AGENT_NAME, {
			metadata: JSON.stringify(dispatch),
		});

		// EXPLICIT EGRESS: unlike the web token path, outbound has no
		// RoomConfiguration surface (the room is created by createDispatch), so we
		// start an audio-only RoomComposite egress directly. The room exists by now.
		// Failure is caught and logged — a recording problem must NEVER drop a call.
		let rec: RecordingRef | undefined;
		if (recording) {
			const built = buildRecordingOutput(roomName);
			if (built) {
				try {
					const egressClient = new EgressClient(lk.url, lk.apiKey, lk.apiSecret);
					const info = await egressClient.startRoomCompositeEgress(
						roomName,
						{ file: built.output },
						{ audioOnly: true },
					);
					rec = { recordingUrl: built.url, recordingEgressId: info.egressId || undefined };
				} catch (err) {
					console.error(`recording: failed to start egress for room ${roomName}:`, err);
				}
			}
		}

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

		return { providerCallRef: participant.participantId ?? roomName, roomName, recording: rec };
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
