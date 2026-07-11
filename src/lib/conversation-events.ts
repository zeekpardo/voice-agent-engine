import type postgres from "postgres";
import { jsonb } from "../db/index.js";
import { newId } from "./id.js";

/**
 * Append a row to conversation_events — the turn-based analogue of
 * lib/call-events.ts's logCallEvent. A parallel table (not call_events) because
 * call_events.call_id carries a FK to calls(id); a sibling table is the smaller
 * change than dropping that FK. `db` accepts either the top-level `sql` or a
 * `tx` from `sql.begin(...)`.
 *
 * v1 does NOT fan these out over webhooks (call events do): conversation
 * webhook delivery is deferred — the events are queryable via GET
 * /v1/conversations/:id for now.
 */
export async function logConversationEvent(
	db: postgres.ISql,
	event: { conversationId: string; type: string; payload?: unknown },
): Promise<void> {
	await db`
		INSERT INTO conversation_events (id, conversation_id, type, payload)
		VALUES (${newId("cev")}, ${event.conversationId}, ${event.type}, ${jsonb(event.payload ?? {})})`;
}
