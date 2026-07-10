import { jsonb, sql } from "../db/index.js";
import { agentRuntime } from "../providers/agent-runtime/index.js";
import type { AgentRow } from "../routes/agents.js";
import { logCallEvent } from "./call-events.js";
import { newId } from "./id.js";

export interface CreateWebSessionInput {
	project: string;
	agent: AgentRow;
	variables?: Record<string, string>;
	metadata?: Record<string, unknown>;
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

	await sql`
		INSERT INTO calls (id, project, agent_id, agent_version, direction, status, room_name, variables, metadata)
		VALUES (${callId}, ${input.project}, ${input.agent.id}, ${input.agent.version},
		        'web', 'queued', ${roomName}, ${jsonb(variables)}, ${jsonb(metadata)})`;

	const { roomUrl, token } = await agentRuntime.createWebSession({
		roomName,
		participantIdentity: `user_${callId}`,
		dispatch: {
			projectId: input.project,
			agentId: input.agent.id,
			agentVersion: input.agent.version,
			callId,
			variables,
			metadata,
		},
	});

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
