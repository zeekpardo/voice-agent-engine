import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";

/**
 * useVoiceAgent — in-app voice session against the agent engine.
 *
 * The app backend exposes a route that calls the gateway's POST /v1/sessions
 * (see @noba/voice-kit/agent/server createWebSession) and returns its JSON.
 * This hook fetches that route, joins the LiveKit room, publishes the mic,
 * and surfaces live transcript + agent state. The gateway key never reaches
 * the browser.
 *
 *   const a = useVoiceAgent({ sessionUrl: "/api/voice/session" });
 *   a.start(); a.stop(); a.status; a.transcript; a.sendText("…");
 */

export type VoiceAgentStatus =
	| "idle"
	| "connecting"
	| "listening"
	| "thinking"
	| "speaking"
	| "ended"
	| "error";

export interface VoiceAgentTurn {
	id: string;
	role: "agent" | "user";
	text: string;
	final: boolean;
}

export interface UseVoiceAgentOptions {
	/** App backend route that proxies POST /v1/sessions. */
	sessionUrl: string;
	/** Extra JSON merged into the session request (e.g. { variables }). */
	sessionBody?: Record<string, unknown>;
}

export interface UseVoiceAgentResult {
	status: VoiceAgentStatus;
	transcript: VoiceAgentTurn[];
	callId: string | null;
	error: string | null;
	start: () => Promise<void>;
	stop: () => Promise<void>;
	/** Send a text message into the conversation (agent replies with voice). */
	sendText: (text: string) => Promise<void>;
}

const AGENT_STATE_ATTRIBUTE = "lk.agent.state";
const TRANSCRIPTION_TOPIC = "lk.transcription";
const CHAT_TOPIC = "lk.chat";

export function useVoiceAgent(options: UseVoiceAgentOptions): UseVoiceAgentResult {
	const [status, setStatus] = useState<VoiceAgentStatus>("idle");
	const [transcript, setTranscript] = useState<VoiceAgentTurn[]>([]);
	const [callId, setCallId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const roomRef = useRef<Room | null>(null);

	const stop = useCallback(async () => {
		const room = roomRef.current;
		roomRef.current = null;
		if (room) await room.disconnect();
		setStatus("ended");
	}, []);

	useEffect(() => () => void roomRef.current?.disconnect(), []);

	const start = useCallback(async () => {
		if (roomRef.current) return;
		setStatus("connecting");
		setError(null);
		setTranscript([]);

		try {
			const res = await fetch(options.sessionUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(options.sessionBody ?? {}),
			});
			const session = (await res.json()) as {
				room_url?: string;
				token?: string;
				call_id?: string;
				error?: { message?: string };
			};
			if (!res.ok || !session.room_url || !session.token) {
				throw new Error(session.error?.message ?? `Session request failed (${res.status})`);
			}
			setCallId(session.call_id ?? null);

			const room = new Room();
			roomRef.current = room;

			// Live transcript: agents publish transcription text streams; the
			// attributed participant tells us whose speech each segment is.
			// Segments update incrementally (same id) until marked final.
			room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader, participantInfo) => {
				const id =
					(reader.info.attributes?.["lk.segment_id"] as string | undefined) ?? reader.info.id;
				const role: "agent" | "user" =
					participantInfo.identity === room.localParticipant.identity ? "user" : "agent";
				let text = "";
				for await (const chunk of reader) {
					text += chunk;
					const final = reader.info.attributes?.["lk.transcription_final"] === "true";
					setTranscript((prev) => {
						const next = prev.filter((t) => t.id !== id);
						return [...next, { id, role, text, final }];
					});
				}
			});

			room.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
				const state = participant.attributes[AGENT_STATE_ATTRIBUTE];
				if (!state) return;
				if (state === "listening" || state === "thinking" || state === "speaking") {
					setStatus(state);
				}
			});
			room.on(RoomEvent.Disconnected, () => {
				roomRef.current = null;
				setStatus("ended");
			});

			await room.connect(session.room_url, session.token);
			await room.localParticipant.setMicrophoneEnabled(true);
			setStatus("listening");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
			roomRef.current = null;
		}
	}, [options.sessionUrl, options.sessionBody]);

	const sendText = useCallback(async (text: string) => {
		await roomRef.current?.localParticipant.sendText(text, { topic: CHAT_TOPIC });
	}, []);

	return { status, transcript, callId, error, start, stop, sendText };
}
