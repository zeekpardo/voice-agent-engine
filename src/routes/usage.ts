import { Hono } from "hono";
import type { AppEnv } from "../app-types.js";
import { sql } from "../db/index.js";
import { badRequest } from "../lib/errors.js";

/**
 * GET /v1/usage?from&to&group_by=agent|day|kind — per-project rollups so
 * consuming apps can bill THEIR customers with margin (spec §12).
 */
export const usage = new Hono<AppEnv>();

usage.get("/usage", async (c) => {
	const key = c.get("apiKey");
	const from = c.req.query("from") ?? null;
	const to = c.req.query("to") ?? null;
	const groupBy = c.req.query("group_by") ?? "kind";
	if (!["agent", "day", "kind"].includes(groupBy)) {
		throw badRequest('group_by must be one of "agent", "day", "kind"');
	}

	const groupCol =
		groupBy === "agent"
			? sql`COALESCE(c.agent_id, 'none')`
			: groupBy === "day"
				? sql`to_char(u.created_at, 'YYYY-MM-DD')`
				: sql`COALESCE(u.kind, 'http')`;

	const rows = await sql`
		SELECT ${groupCol} AS bucket,
		       COALESCE(u.kind, 'http')   AS kind,
		       COUNT(*)::int              AS events,
		       COALESCE(SUM(u.quantity), 0)::float AS quantity
		FROM usage_events u
		LEFT JOIN calls c ON c.id = u.call_id
		WHERE u.project = ${key.project}
		  ${from ? sql`AND u.created_at >= ${from}` : sql``}
		  ${to ? sql`AND u.created_at < ${to}` : sql``}
		GROUP BY bucket, kind
		ORDER BY bucket, kind`;

	return c.json({ group_by: groupBy, from, to, usage: rows });
});

/**
 * GET /v1/usage/by-group?from&to&group_ref — per-group call attribution
 * (client-1 gate). Aggregates the calls table (not usage_events) by the opaque
 * `group_ref` tenant tag so the consuming SaaS can attribute calls + minutes per
 * subaccount. Project-scoped like every /v1 route; only attributed calls
 * (group_ref NOT NULL) are counted.
 *
 * Duration semantics (from the schema): completed calls carry an integer
 * `duration_seconds` set by /complete. Still-active calls have no final duration
 * yet, so elapsed seconds are computed from `started_at` (the active-transition
 * timestamp) when present; an active call with no started_at contributes to the
 * counts but 0 seconds. Both branches are covered by idx_calls_group
 * (project, group_ref, created_at) — no full scan.
 */
usage.get("/usage/by-group", async (c) => {
	const key = c.get("apiKey");
	const from = c.req.query("from") ?? null;
	const to = c.req.query("to") ?? null;
	const groupRef = c.req.query("group_ref") ?? null;

	const seconds = sql`
		CASE
			WHEN status = 'active' AND started_at IS NOT NULL
				THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)))
			ELSE COALESCE(duration_seconds, 0)
		END`;

	const rows = await sql`
		SELECT group_ref,
		       COUNT(*)::int                                   AS calls,
		       COUNT(*) FILTER (WHERE status = 'active')::int  AS active_calls,
		       COALESCE(SUM(${seconds}), 0)::float             AS total_seconds
		FROM calls
		WHERE project = ${key.project}
		  AND group_ref IS NOT NULL
		  ${groupRef ? sql`AND group_ref = ${groupRef}` : sql``}
		  ${from ? sql`AND created_at >= ${from}` : sql``}
		  ${to ? sql`AND created_at < ${to}` : sql``}
		GROUP BY group_ref
		ORDER BY group_ref`;

	const totals = rows.reduce(
		(acc, r) => ({
			calls: acc.calls + Number(r.calls),
			active_calls: acc.active_calls + Number(r.active_calls),
			total_seconds: acc.total_seconds + Number(r.total_seconds),
		}),
		{ calls: 0, active_calls: 0, total_seconds: 0 },
	);

	return c.json({ from, to, group_ref: groupRef, groups: rows, totals });
});
