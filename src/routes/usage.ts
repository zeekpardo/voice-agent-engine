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
