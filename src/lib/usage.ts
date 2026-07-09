import { randomUUID } from "node:crypto";
import { sql } from "../db/index.js";

/**
 * Metered usage kinds. `http` covers plain request metering (legacy shape);
 * the model/call kinds carry a `quantity` in their natural unit and are the
 * basis for per-project billing (spec §12).
 */
export type UsageKind =
	| "http"
	| "stt_seconds"
	| "tts_characters"
	| "llm_tokens_in"
	| "llm_tokens_out"
	| "call_minutes";

export interface UsageEvent {
	apiKeyId: string | null;
	project: string | null;
	endpoint: string;
	provider: string | null;
	bytes: number | null;
	status: number;
	latencyMs: number;
	kind?: UsageKind;
	quantity?: number | null;
	callId?: string | null;
}

export interface UsageSummaryRow {
	project: string | null;
	endpoint: string;
	requests: number;
	ok: number;
	bytes: number;
	total_latency_ms: number;
}

/** Aggregate usage per project + endpoint — the basis for reporting / billing. */
export async function usageSummary(): Promise<UsageSummaryRow[]> {
	const rows = await sql`
		SELECT project, endpoint,
		       COUNT(*)::int                                                        AS requests,
		       SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END)::int AS ok,
		       COALESCE(SUM(bytes), 0)::bigint                                      AS bytes,
		       COALESCE(SUM(latency_ms), 0)::bigint                                 AS total_latency_ms
		FROM usage_events
		GROUP BY project, endpoint
		ORDER BY project, endpoint`;
	return rows as unknown as UsageSummaryRow[];
}

/** Best-effort usage record — never let metering failures break a request. */
export async function recordUsage(event: UsageEvent): Promise<void> {
	try {
		await sql`
			INSERT INTO usage_events
				(id, api_key_id, project, endpoint, provider, kind, quantity, call_id, bytes, status, latency_ms)
			VALUES
				(${randomUUID()}, ${event.apiKeyId}, ${event.project}, ${event.endpoint},
				 ${event.provider}, ${event.kind ?? "http"}, ${event.quantity ?? null},
				 ${event.callId ?? null}, ${event.bytes}, ${event.status}, ${event.latencyMs})`;
	} catch (err) {
		console.error("usage record failed", err);
	}
}
