import type { ChannelT, ContactStateEntryT } from "@voice-engine/shared/agent-config";
import { jsonb, sql } from "../db/index.js";
import { agentRuntime } from "../providers/agent-runtime/index.js";
import type { AgentRow } from "../routes/agents.js";
import { logCallEvent } from "./call-events.js";
import { resolveGroupRef } from "./group-ref.js";
import { newId } from "./id.js";

export interface CreateWebSessionInput {
	project: string;
	agent: AgentRow;
	variables?: Record<string, string>;
	metadata?: Record<string, unknown>;
	/** Per-call known-contact data (Phase 1); persisted + forwarded in dispatch. */
	contactState?: ContactStateEntryT[];
	/** Per-call CRM tag names (Phase 5b); persisted + forwarded in dispatch. */
	contactTags?: string[];
	/** Session channel (Phase 6): "voice" (default) or "text". Persisted on the
	 * calls row + forwarded in dispatch so the worker builds the right I/O adapter. */
	channel?: ChannelT;
	/** Opaque tenant tag for per-group usage attribution. Falls back to
	 * metadata.source_id when absent so existing callers stay attributed. */
	groupRef?: string;
}

export interface WebSessionResult {
	call_id: string;
	room_name: string;
	room_url: string;
	token: string;
	agent_id: string;
	agent_version: number;
}

/**
 * Create a browser voice session (spec §5 /v1/sessions): one calls row with
 * direction=web, a LiveKit room token with the agent dispatch embedded, and a
 * call.queued event. The worker takes over lifecycle reporting from here.
 */
export async function createWebSession(input: CreateWebSessionInput): Promise<WebSessionResult> {
	const callId = newId("call");
	const roomName = `va_${callId}`;
	const variables = input.variables ?? {};
	const metadata = input.metadata ?? {};
	const contactState = input.contactState;
	const contactTags = input.contactTags;
	const channel = input.channel ?? "voice";
	const groupRef = resolveGroupRef(input.groupRef, metadata);

	await sql`
		INSERT INTO calls (id, project, agent_id, agent_version, direction, status, room_name, variables, metadata, contact_state, contact_tags, channel, group_ref)
		VALUES (${callId}, ${input.project}, ${input.agent.id}, ${input.agent.version},
		        'web', 'queued', ${roomName}, ${jsonb(variables)}, ${jsonb(metadata)},
		        ${contactState ? jsonb(contactState) : null}, ${contactTags ? jsonb(contactTags) : null}, ${channel}, ${groupRef ?? null})`;

	// Recording is per-agent opt-in and voice-only — text sessions never record.
	const recording = input.agent.config.recording?.enabled === true && channel === "voice";

	const { roomUrl, token, recording: recordingRef } = await agentRuntime.createWebSession({
		roomName,
		participantIdentity: `user_${callId}`,
		recording,
		dispatch: {
			projectId: input.project,
			agentId: input.agent.id,
			agentVersion: input.agent.version,
			callId,
			variables,
			metadata,
			...(contactState ? { contactState } : {}),
			...(contactTags ? { contactTags } : {}),
			...(input.channel ? { channel: input.channel } : {}),
		},
	});

	// Persist the recording reference (deterministic S3 path known at start).
	// The egress id, when it later exists, would arrive via a LiveKit webhook.
	if (recordingRef) {
		await sql`
			UPDATE calls SET recording_url = ${recordingRef.recordingUrl},
			                 recording_egress_id = ${recordingRef.recordingEgressId ?? null},
			                 updated_at = now()
			WHERE id = ${callId}`;
	}

	await logCallEvent(
		sql,
		{ callId, type: "call.queued", payload: { direction: "web" } },
		{
			project: input.project,
			event: {
				type: "call.queued",
				call_id: callId,
				agent_id: input.agent.id,
				direction: "web",
				metadata,
			},
		},
	);

	return {
		call_id: callId,
		room_name: roomName,
		room_url: roomUrl,
		token,
		agent_id: input.agent.id,
		agent_version: input.agent.version,
	};
}
