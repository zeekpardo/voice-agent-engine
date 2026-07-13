import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-types.js";
import { sql } from "../db/index.js";
import { env } from "../env.js";
import { invalidateLimitsCache } from "../lib/concurrency.js";
import { badRequest } from "../lib/errors.js";
import { parseBody } from "../lib/http.js";

/**
 * /v1/limits — per-tenant concurrent-call caps + per-org daily-volume caps
 * (multi-account plan §2). Project-scoped like every other /v1 route (the API
 * key's project owns its limits).
 *
 *   GET  /v1/limits            list this project's concurrency + daily limit rows and defaults
 *   PUT  /v1/limits            set/clear one concurrency limit: { scope, ref?, maxConcurrent|null }
 *   PUT  /v1/limits/daily      set/clear one daily cap:        { scope, ref?, maxPerDay|null }
 *
 * Concurrency scope is 'project' | 'agent' | 'group'; daily scope is 'project' |
 * 'group'. `ref` is the agent id / opaque group_ref for agent/group scope,
 * ignored for project scope. A null value clears the row (reverting that scope to
 * unlimited / the env default for project).
 */
export const limits = new Hono<AppEnv>();

limits.get("/limits", async (c) => {
	const key = c.get("apiKey");
	const rows = await sql`
		SELECT scope, ref, max_concurrent, updated_at
		FROM concurrency_limits WHERE project = ${key.project}
		ORDER BY scope, ref`;
	const dailyRows = await sql`
		SELECT scope, ref, max_per_day, updated_at
		FROM daily_call_limits WHERE project = ${key.project}
		ORDER BY scope, ref`;
	return c.json({
		limits: rows,
		project_default: env.DEFAULT_MAX_CONCURRENT_CALLS ?? null,
		daily_limits: dailyRows,
		daily_project_default: env.DEFAULT_MAX_CALLS_PER_DAY ?? null,
	});
});

const PutBody = z.object({
	scope: z.enum(["project", "agent", "group"]),
	ref: z.string().max(256).optional(),
	maxConcurrent: z.number().int().positive().nullable(),
});

limits.put("/limits", async (c) => {
	const key = c.get("apiKey");
	const body = await parseBody(
		c,
		PutBody,
		(issue) => `Invalid limit: ${issue?.path.join(".")} — ${issue?.message}`,
	);

	// project scope keys on the empty ref; agent/group require an explicit ref.
	const ref = body.scope === "project" ? "" : (body.ref ?? "").trim();
	if (body.scope !== "project" && !ref) {
		throw badRequest(`ref is required for ${body.scope} scope`);
	}

	if (body.maxConcurrent == null) {
		await sql`
			DELETE FROM concurrency_limits
			WHERE project = ${key.project} AND scope = ${body.scope} AND ref = ${ref}`;
	} else {
		await sql`
			INSERT INTO concurrency_limits (project, scope, ref, max_concurrent, updated_at)
			VALUES (${key.project}, ${body.scope}, ${ref}, ${body.maxConcurrent}, now())
			ON CONFLICT (project, scope, ref)
			DO UPDATE SET max_concurrent = EXCLUDED.max_concurrent, updated_at = now()`;
	}

	invalidateLimitsCache(key.project);
	return c.json({ ok: true, scope: body.scope, ref, maxConcurrent: body.maxConcurrent });
});

const DailyPutBody = z.object({
	scope: z.enum(["project", "group"]),
	ref: z.string().max(256).optional(),
	maxPerDay: z.number().int().positive().nullable(),
});

limits.put("/limits/daily", async (c) => {
	const key = c.get("apiKey");
	const body = await parseBody(
		c,
		DailyPutBody,
		(issue) => `Invalid daily limit: ${issue?.path.join(".")} — ${issue?.message}`,
	);

	// project scope keys on the empty ref; group requires an explicit ref.
	const ref = body.scope === "project" ? "" : (body.ref ?? "").trim();
	if (body.scope !== "project" && !ref) {
		throw badRequest(`ref is required for ${body.scope} scope`);
	}

	if (body.maxPerDay == null) {
		await sql`
			DELETE FROM daily_call_limits
			WHERE project = ${key.project} AND scope = ${body.scope} AND ref = ${ref}`;
	} else {
		await sql`
			INSERT INTO daily_call_limits (project, scope, ref, max_per_day, updated_at)
			VALUES (${key.project}, ${body.scope}, ${ref}, ${body.maxPerDay}, now())
			ON CONFLICT (project, scope, ref)
			DO UPDATE SET max_per_day = EXCLUDED.max_per_day, updated_at = now()`;
	}

	invalidateLimitsCache(key.project);
	return c.json({ ok: true, scope: body.scope, ref, maxPerDay: body.maxPerDay });
});
