import type { ContactStateEntryT } from "@voice-engine/shared/agent-config";
import { jsonb, sql } from "../db/index.js";
import { env } from "../env.js";
import { agentRuntime } from "../providers/agent-runtime/index.js";
import type { DispatchMetadata } from "../providers/agent-runtime/types.js";
import type { AgentRow } from "../routes/agents.js";
import { logCallEvent } from "./call-events.js";
import { type CapacityCheck, checkCapacity } from "./concurrency.js";
import { resolveGroupRef } from "./group-ref.js";
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
	/** Opaque tenant tag for per-group usage attribution. Falls back to
	 * metadata.source_id when absent so existing callers stay attributed. */
	groupRef?: string;
}

export async function createOutboundCall(input: CreateOutboundInput) {
	const callId = newId("call");
	const roomName = `va_${callId}`;
	const scheduled = input.scheduledAt && input.scheduledAt.getTime() > Date.now();
	const groupRef = resolveGroupRef(input.groupRef, input.metadata);

	// Concurrency cap (multi-account plan §2): an immediate outbound at capacity is
	// parked as status='queued' + queued_reason='capacity' (the drainer dispatches
	// it once capacity frees, or expires it). Scheduled calls are checked at fire
	// time in the scheduler, not now.
	let capacity: CapacityCheck | undefined;
	if (!scheduled) {
		capacity = await checkCapacity({ project: input.project, agentId: input.agent.id, groupRef });
	}
	const parked = capacity ? !capacity.allowed : false;
	const status = scheduled ? "scheduled" : "queued";

	await sql`
		INSERT INTO calls (id, project, agent_id, agent_version, direction, status, queued_reason,
		                   to_number, from_number, room_name, scheduled_at, variables, metadata, contact_state, contact_tags, group_ref)
		VALUES (${callId}, ${input.project}, ${input.agent.id}, ${input.agent.version},
		        'outbound', ${status}, ${parked ? "capacity" : null},
		        ${input.to}, ${input.from ?? null}, ${roomName},
		        ${input.scheduledAt ?? null},
		        ${jsonb(input.variables ?? {})}, ${jsonb(input.metadata ?? {})},
		        ${input.contactState ? jsonb(input.contactState) : null},
		        ${input.contactTags ? jsonb(input.contactTags) : null},
		        ${groupRef ?? null})`;

	const eventType = scheduled
		? "call.scheduled"
		: parked
			? "call.queued_capacity"
			: "call.queued";
	await logCallEvent(
		sql,
		{
			callId,
			type: eventType,
			payload: parked
				? { to: input.to, blocked_by: capacity!.blockedBy, current: capacity!.current, limit: capacity!.limit }
				: { to: input.to },
		},
		{
			project: input.project,
			event: {
				type: eventType,
				call_id: callId,
				agent_id: input.agent.id,
				to: input.to,
				scheduled_at: input.scheduledAt?.toISOString() ?? null,
				metadata: input.metadata ?? {},
				...(parked
					? { blocked_by: capacity!.blockedBy, current: capacity!.current, limit: capacity!.limit }
					: {}),
			},
		},
	);

	if (!scheduled && !parked) {
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
				SELECT id, project, agent_id, group_ref, to_number FROM calls
				WHERE status = 'scheduled' AND scheduled_at <= now()
				ORDER BY scheduled_at LIMIT 10`;
			for (const row of due) {
				// Respect the concurrency cap at fire time: a due scheduled call at
				// capacity is re-parked as a capacity-queued call for the drainer.
				const capacity = await checkCapacity({
					project: row.project as string,
					agentId: row.agent_id as string,
					groupRef: (row.group_ref as string | null) ?? null,
				});
				if (capacity.allowed) {
					await dispatchOutbound(row.id as string);
				} else {
					await parkForCapacity(row, capacity);
				}
			}
		} catch (err) {
			console.error("call scheduler error", err);
		}
	}, 5_000).unref();
}

/** Move a call into the capacity queue + emit call.queued_capacity. */
async function parkForCapacity(
	row: Record<string, unknown>,
	capacity: CapacityCheck,
): Promise<void> {
	const callId = row.id as string;
	await sql`
		UPDATE calls SET status = 'queued', queued_reason = 'capacity', updated_at = now()
		WHERE id = ${callId}`;
	await logCallEvent(
		sql,
		{
			callId,
			type: "call.queued_capacity",
			payload: { blocked_by: capacity.blockedBy, current: capacity.current, limit: capacity.limit },
		},
		{
			project: row.project as string,
			event: {
				type: "call.queued_capacity",
				call_id: callId,
				agent_id: row.agent_id as string,
				to: (row.to_number as string | null) ?? null,
				blocked_by: capacity.blockedBy,
				current: capacity.current,
				limit: capacity.limit,
			},
		},
	);
}

/**
 * Capacity-queue drainer (multi-account plan §2). Every 10s: expire capacity-
 * parked calls older than QUEUE_EXPIRY_SECONDS (→ canceled, end_reason
 * 'queue_expired'), then dispatch the oldest parked calls whose scope now has
 * capacity. Crash-safe: any error is logged and swallowed so the interval keeps
 * running.
 */
export function startCallQueueDrainer(): void {
	setInterval(async () => {
		try {
			// 1. Expire stale parked calls.
			const expired = await sql`
				SELECT id, project, agent_id FROM calls
				WHERE status = 'queued' AND queued_reason = 'capacity'
				  AND created_at < now() - make_interval(secs => ${env.QUEUE_EXPIRY_SECONDS})
				ORDER BY created_at LIMIT 50`;
			for (const row of expired) {
				const callId = row.id as string;
				await sql`
					UPDATE calls SET status = 'canceled', queued_reason = NULL,
					                 end_reason = 'queue_expired', ended_at = now(), updated_at = now()
					WHERE id = ${callId}`;
				await logCallEvent(
					sql,
					{ callId, type: "call.queue_expired" },
					{
						project: row.project as string,
						event: {
							type: "call.queue_expired",
							call_id: callId,
							agent_id: row.agent_id as string,
							end_reason: "queue_expired",
						},
					},
				);
			}

			// 2. Dispatch parked calls that now have capacity, oldest first. Each
			//    dispatchOutbound flips the row to 'dialing' synchronously, so the next
			//    checkCapacity in this loop already counts it.
			const parked = await sql`
				SELECT id, project, agent_id, group_ref FROM calls
				WHERE status = 'queued' AND queued_reason = 'capacity'
				ORDER BY created_at LIMIT 20`;
			for (const row of parked) {
				const callId = row.id as string;
				const capacity = await checkCapacity({
					project: row.project as string,
					agentId: row.agent_id as string,
					groupRef: (row.group_ref as string | null) ?? null,
				});
				if (!capacity.allowed) continue;
				await sql`UPDATE calls SET queued_reason = NULL, updated_at = now() WHERE id = ${callId}`;
				await logCallEvent(
					sql,
					{ callId, type: "call.queue_dispatched" },
					{
						project: row.project as string,
						event: {
							type: "call.queue_dispatched",
							call_id: callId,
							agent_id: row.agent_id as string,
						},
					},
				);
				await dispatchOutbound(callId);
			}
		} catch (err) {
			console.error("call queue drainer error", err);
		}
	}, 10_000).unref();
}
