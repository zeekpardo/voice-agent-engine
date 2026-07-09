import { jsonb, sql } from "../db/index.js";
import { agentRuntime } from "../providers/agent-runtime/index.js";
import type { AgentRow } from "../routes/agents.js";
import { newId } from "./id.js";
import { emitEvent } from "./webhooks.js";

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
}

export async function createOutboundCall(input: CreateOutboundInput) {
	const callId = newId("call");
	const roomName = `va_${callId}`;
	const scheduled = input.scheduledAt && input.scheduledAt.getTime() > Date.now();

	await sql`
		INSERT INTO calls (id, project, agent_id, agent_version, direction, status,
		                   to_number, from_number, room_name, scheduled_at, variables, metadata)
		VALUES (${callId}, ${input.project}, ${input.agent.id}, ${input.agent.version},
		        'outbound', ${scheduled ? "scheduled" : "queued"},
		        ${input.to}, ${input.from ?? null}, ${roomName},
		        ${input.scheduledAt ?? null},
		        ${jsonb(input.variables ?? {})}, ${jsonb(input.metadata ?? {})})`;

	await sql`
		INSERT INTO call_events (id, call_id, type, payload)
		VALUES (${newId("cev")}, ${callId}, ${scheduled ? "call.scheduled" : "call.queued"},
		        ${jsonb({ to: input.to })})`;
	void emitEvent(input.project, {
		type: scheduled ? "call.scheduled" : "call.queued",
		call_id: callId,
		agent_id: input.agent.id,
		to: input.to,
		scheduled_at: input.scheduledAt?.toISOString() ?? null,
		metadata: input.metadata ?? {},
	});

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

	try {
		await agentRuntime.dispatchCall({
			roomName: call.room_name as string,
			to: call.to_number as string,
			from: (call.from_number as string | null) ?? undefined,
			dispatch: {
				projectId: call.project as string,
				agentId: call.agent_id as string,
				agentVersion: call.agent_version as number,
				callId,
				variables: (call.variables ?? {}) as Record<string, string>,
				metadata: (call.metadata ?? {}) as Record<string, unknown>,
			},
		});
		await sql`
			INSERT INTO call_events (id, call_id, type, payload)
			VALUES (${newId("cev")}, ${callId}, 'call.dialing', ${jsonb({ to: call.to_number })})`;
	} catch (err) {
		console.error(`outbound dispatch failed for ${callId}:`, err);
		await sql`
			UPDATE calls SET status = 'failed', end_reason = 'dispatch_failed', ended_at = now(), updated_at = now()
			WHERE id = ${callId}`;
		await sql`
			INSERT INTO call_events (id, call_id, type, payload)
			VALUES (${newId("cev")}, ${callId}, 'call.failed',
			        ${jsonb({ error: err instanceof Error ? err.message : String(err) })})`;
		void emitEvent(call.project as string, {
			type: "call.failed",
			call_id: callId,
			agent_id: call.agent_id as string,
			end_reason: "dispatch_failed",
			metadata: call.metadata,
		});
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
