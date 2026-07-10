/**
 * AgentRuntime — the swap point for the realtime voice-agent runtime, sibling
 * to VoiceProvider (spec §6). Gateway routes call this interface; today's
 * implementation is LiveKit Cloud. A future vapi.ts / elevenagents.ts could
 * implement the same interface and consuming apps would never know.
 */

import type { ChannelT, ContactStateEntryT } from "@voice-engine/shared/agent-config";

export interface DispatchMetadata {
	projectId: string;
	agentId: string;
	agentVersion: number;
	callId: string;
	variables: Record<string, string>;
	metadata: Record<string, unknown>;
	/** Per-call known-contact data (Phase 1). Optional: old dispatches omit it. */
	contactState?: ContactStateEntryT[];
	/** Per-call CRM tag names (Phase 5b — seeds the worker's tag set). Optional. */
	contactTags?: string[];
	/** Session channel (Phase 6). Optional: old dispatches omit it → the worker
	 * defaults to voice. `text` runs the flow over lk.chat text streams, no audio. */
	channel?: ChannelT;
}

export interface WebSessionInput {
	roomName: string;
	participantIdentity: string;
	dispatch: DispatchMetadata;
	/** Start audio-only call recording (egress) for this session. Voice only —
	 * callers must not set this for text sessions. Silently skipped if the
	 * gateway has no storage (S3_*) configured. */
	recording?: boolean;
}

export interface DispatchCallInput {
	roomName: string;
	to: string;
	from?: string;
	dispatch: DispatchMetadata;
	/** Start audio-only call recording (egress) right after dispatch. Skipped if
	 * the gateway has no storage (S3_*) configured — never fails the call. */
	recording?: boolean;
}

/** Recording reference captured when egress starts; persisted on the calls row. */
export interface RecordingRef {
	/** Deterministic S3 object reference (s3://bucket/{room}.ogg). */
	recordingUrl: string;
	/** LiveKit egress id, when known at start (explicit egress path). */
	recordingEgressId?: string;
}

export interface ProvisionNumberInput {
	project: string;
	areaCode?: string;
	e164?: string;
}

export interface AgentRuntime {
	readonly name: string; // "livekit"

	/** Browser session: room + participant token; agent dispatched on join. */
	createWebSession(
		input: WebSessionInput,
	): Promise<{ roomUrl: string; token: string; recording?: RecordingRef }>;

	/** Outbound: place a call and attach the agent. (Phase 3) */
	dispatchCall(
		input: DispatchCallInput,
	): Promise<{ providerCallRef: string; roomName: string; recording?: RecordingRef }>;

	/** Inbound numbers. (Phase 3) */
	provisionNumber(input: ProvisionNumberInput): Promise<{ e164: string; providerRef: string }>;
	routeNumber(providerRef: string, dispatch: DispatchMetadata): Promise<void>;

	/** Tear-down / cancel — ends the room, which ends the session. */
	cancelCall(roomName: string): Promise<void>;
}
