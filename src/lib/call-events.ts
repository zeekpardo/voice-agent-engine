import type postgres from "postgres";
import { jsonb } from "../db/index.js";
import { newId } from "./id.js";
import { emitEvent, type EngineEvent } from "./webhooks.js";

/**
 * Append a row to call_events and, if `emit` is given, fan the same moment
 * out over webhooks. `db` accepts either the top-level `sql` or a `tx` from
 * `sql.begin(...)` — both satisfy the tagged-template query interface.
 */
export async function logCallEvent(
	db: postgres.ISql,
	event: { callId: string; type: string; payload?: unknown },
	emit?: { project: string; event: EngineEvent },
): Promise<void> {
	await db`
		INSERT INTO call_events (id, call_id, type, payload)
		VALUES (${newId("cev")}, ${event.callId}, ${event.type}, ${jsonb(event.payload ?? {})})`;
	if (emit) void emitEvent(emit.project, emit.event);
}
