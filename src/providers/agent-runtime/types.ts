/**
 * AgentRuntime — the swap point for the realtime voice-agent runtime, sibling
 * to VoiceProvider (spec §6). Gateway routes call this interface; today's
 * implementation is LiveKit Cloud. A future vapi.ts / elevenagents.ts could
 * implement the same interface and consuming apps would never know.
 */

export interface DispatchMetadata {
	projectId: string;
	agentId: string;
	agentVersion: number;
	callId: string;
	variables: Record<string, string>;
	metadata: Record<string, unknown>;
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
