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
}

export interface DispatchCallInput {
	roomName: string;
	to: string;
	from?: string;
	dispatch: DispatchMetadata;
}

export interface ProvisionNumberInput {
	project: string;
	areaCode?: string;
	e164?: string;
}

export interface AgentRuntime {
	readonly name: string; // "livekit"

	/** Browser session: room + participant token; agent dispatched on join. */
	createWebSession(input: WebSessionInput): Promise<{ roomUrl: string; token: string }>;

	/** Outbound: place a call and attach the agent. (Phase 3) */
	dispatchCall(input: DispatchCallInput): Promise<{ providerCallRef: string; roomName: string }>;

	/** Inbound numbers. (Phase 3) */
	provisionNumber(input: ProvisionNumberInput): Promise<{ e164: string; providerRef: string }>;
	routeNumber(providerRef: string, dispatch: DispatchMetadata): Promise<void>;

	/** Tear-down / cancel — ends the room, which ends the session. */
	cancelCall(roomName: string): Promise<void>;
}
