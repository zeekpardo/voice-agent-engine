import type { ContactStateEntryT } from "@voice-engine/shared/agent-config";
import { jsonb, sql } from "../db/index.js";
import { agentRuntime } from "../providers/agent-runtime/index.js";
import type { DispatchMetadata } from "../providers/agent-runtime/types.js";
import type { AgentRow } from "../routes/agents.js";
import { logCallEvent } from "./call-events.js";
import { newId } from "./id.js";

/**
 * Outbound call dispatch (spec §5 POST /v1/calls). A call row is created
 * queued (or scheduled); dispatch attaches the agent to a room and dials the
 * number through the SIP trunk. From there the worker owns lifecycle
 * reporting, exactly like web sessions.
 */

export interface CreateOutboundInput {
	project: string;
	agent: AgentRow;
	to: string;
	from?: string;
	scheduledAt?: Date;
	variables?: Record<string, string>;
	metadata?: Record<string, unknown>;
	contactState?: ContactStateEntryT[];
	contactTags?: string[];
}

export async function createOutboundCall(input: CreateOutboundInput) {
	const callId = newId("call");
	const roomName = `va_${callId}`;
	const scheduled = input.scheduledAt && input.scheduledAt.getTime() > Date.now();

	await sql`
		INSERT INTO calls (id, project, agent_id, agent_version, direction, status,
		                   to_number, from_number, room_name, scheduled_at, variables, metadata, contact_state, contact_tags)
		VALUES (${callId}, ${input.project}, ${input.agent.id}, ${input.agent.version},
		        'outbound', ${scheduled ? "scheduled" : "queued"},
		        ${input.to}, ${input.from ?? null}, ${roomName},
		        ${input.scheduledAt ?? null},
		        ${jsonb(input.variables ?? {})}, ${jsonb(input.metadata ?? {})},
		        ${input.contactState ? jsonb(input.contactState) : null},
		        ${input.contactTags ? jsonb(input.contactTags) : null})`;

	const eventType = scheduled ? "call.scheduled" : "call.queued";
	await logCallEvent(
		sql,
		{ callId, type: eventType, payload: { to: input.to } },
		{
			project: input.project,
			event: {
				type: eventType,
				call_id: callId,
				agent_id: input.agent.id,
				to: input.to,
				scheduled_at: input.scheduledAt?.toISOString() ?? null,
				metadata: input.metadata ?? {},
			},
		},
	);

	if (!scheduled) {
		await dispatchOutbound(callId);
	}

	const rows = await sql`SELECT * FROM calls WHERE id = ${callId}`;
	return rows[0];
}

/** Attach the agent + dial. Failures mark the call failed and fan out. */
export async function dispatchOutbound(callId: string): Promise<void> {
	const rows = await sql`SELECT * FROM calls WHERE id = ${callId}`;
	const call = rows[0];
	if (!call || !["queued", "scheduled"].includes(call.status as string)) return;

	await sql`UPDATE calls SET status = 'dialing', updated_at = now() WHERE id = ${callId}`;

	// Recording is per-agent opt-in, read from the config version pinned to this
	// call. Outbound is always a voice channel, so no channel check is needed.
	const versions = await sql`
		SELECT config FROM agent_versions
		WHERE agent_id = ${call.agent_id as string} AND version = ${call.agent_version as number}`;
	const recording =
		(versions[0]?.config as { recording?: { enabled?: boolean } } | undefined)?.recording
			?.enabled === true;

	try {
		const result = await agentRuntime.dispatchCall({
			roomName: call.room_name as string,
			to: call.to_number as string,
			from: (call.from_number as string | null) ?? undefined,
			recording,
			dispatch: {
				projectId: call.project as string,
				agentId: call.agent_id as string,
				agentVersion: call.agent_version as number,
				callId,
				variables: (call.variables ?? {}) as Record<string, string>,
				metadata: (call.metadata ?? {}) as Record<string, unknown>,
				...(call.contact_state
					? { contactState: call.contact_state as DispatchMetadata["contactState"] }
					: {}),
				...(call.contact_tags
					? { contactTags: call.contact_tags as DispatchMetadata["contactTags"] }
					: {}),
			},
		});
		if (result.recording) {
			await sql`
				UPDATE calls SET recording_url = ${result.recording.recordingUrl},
				                 recording_egress_id = ${result.recording.recordingEgressId ?? null},
				                 updated_at = now()
				WHERE id = ${callId}`;
		}
		await logCallEvent(sql, { callId, type: "call.dialing", payload: { to: call.to_number } });
	} catch (err) {
		console.error(`outbound dispatch failed for ${callId}:`, err);
		await sql`
			UPDATE calls SET status = 'failed', end_reason = 'dispatch_failed', ended_at = now(), updated_at = now()
			WHERE id = ${callId}`;
		await logCallEvent(
			sql,
			{
				callId,
				type: "call.failed",
				payload: { error: err instanceof Error ? err.message : String(err) },
			},
			{
				project: call.project as string,
				event: {
					type: "call.failed",
					call_id: callId,
					agent_id: call.agent_id as string,
					end_reason: "dispatch_failed",
					metadata: call.metadata,
				},
			},
		);
	}
}

/** Fire due scheduled calls. Poll-based, like the webhook dispatcher. */
export function startCallScheduler(): void {
	setInterval(async () => {
		try {
			const due = await sql`
				SELECT id FROM calls
				WHERE status = 'scheduled' AND scheduled_at <= now()
				ORDER BY scheduled_at LIMIT 10`;
			for (const row of due) {
				await dispatchOutbound(row.id as string);
			}
		} catch (err) {
			console.error("call scheduler error", err);
		}
	}, 5_000).unref();
}
