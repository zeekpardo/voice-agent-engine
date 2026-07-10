import { signPayload } from "@voice-engine/shared/hmac";
import { sql } from "../db/index.js";
import { newId } from "./id.js";

/**
 * Events out (spec §8.1): HMAC-signed webhooks, at-least-once with exponential
 * retry, `event_id` for consumer-side idempotency.
 *
 * emitEvent() writes one pending delivery per matching endpoint; a small
 * in-process dispatcher drains them. Deliveries survive restarts because the
 * queue is the webhook_deliveries table, not memory.
 */

const MAX_ATTEMPTS = 8;
const DELIVERY_TIMEOUT_MS = 10_000;

export { signPayload };

export interface EngineEvent {
	type: string; // call.queued | call.started | call.completed | tool.invoked | …
	call_id?: string;
	agent_id?: string;
	[key: string]: unknown;
}

/** Fan an event out to every enabled endpoint whose filter matches. */
export async function emitEvent(project: string, event: EngineEvent): Promise<string> {
	const eventId = newId("evt");
	const payload = { event_id: eventId, ...event };

	const endpoints = await sql`
		SELECT id FROM webhook_endpoints
		WHERE project = ${project} AND enabled
		  AND (event_filter = '{}' OR ${event.type} = ANY(event_filter))`;

	for (const ep of endpoints) {
		await sql`
			INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, next_attempt_at)
			VALUES (${newId("whd")}, ${ep.id as string}, ${eventId}, ${event.type}, ${sql.json(payload)}, now())`;
	}
	if (endpoints.length > 0) setImmediate(() => void processPendingDeliveries());
	return eventId;
}

let draining = false;

/** Attempt every due pending delivery once; reschedule failures with backoff. */
export async function processPendingDeliveries(): Promise<void> {
	if (draining) return; // one drain loop at a time per process
	draining = true;
	try {
		const due = await sql`
			SELECT d.id, d.attempts, d.payload, d.event_type, d.event_id, w.url, w.secret
			FROM webhook_deliveries d
			JOIN webhook_endpoints w ON w.id = d.webhook_id
			WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND w.enabled
			ORDER BY d.next_attempt_at
			LIMIT 25`;

		for (const d of due) {
			const body = JSON.stringify(d.payload);
			const ts = Math.floor(Date.now() / 1000).toString();
			let status = 0;
			try {
				const res = await fetch(d.url as string, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Voice-Event": d.event_type as string,
						"X-Voice-Event-Id": d.event_id as string,
						"X-Voice-Timestamp": ts,
						"X-Voice-Signature": `hmac-sha256=${signPayload(d.secret as string, ts, body)}`,
					},
					body,
					signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
				});
				status = res.status;
			} catch {
				status = 0; // network error / timeout
			}

			const attempts = Number(d.attempts) + 1;
			if (status >= 200 && status < 300) {
				await sql`
					UPDATE webhook_deliveries
					SET status = 'delivered', attempts = ${attempts}, last_status = ${status}, updated_at = now()
					WHERE id = ${d.id as string}`;
			} else if (attempts >= MAX_ATTEMPTS) {
				await sql`
					UPDATE webhook_deliveries
					SET status = 'failed', attempts = ${attempts}, last_status = ${status}, updated_at = now()
					WHERE id = ${d.id as string}`;
			} else {
				// 5s, 10s, 20s … capped at 1h.
				const delaySeconds = Math.min(5 * 2 ** (attempts - 1), 3600);
				await sql`
					UPDATE webhook_deliveries
					SET attempts = ${attempts}, last_status = ${status}, updated_at = now(),
					    next_attempt_at = now() + make_interval(secs => ${delaySeconds})
					WHERE id = ${d.id as string}`;
			}
		}
	} catch (err) {
		console.error("webhook dispatcher error", err);
	} finally {
		draining = false;
	}
}

/** Poll for due retries — emitEvent() already fast-paths fresh deliveries. */
export function startWebhookDispatcher(): void {
	setInterval(() => void processPendingDeliveries(), 5_000).unref();
}
