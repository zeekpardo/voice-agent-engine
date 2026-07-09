import { Hono } from "hono";
import type { AppEnv } from "../app-types.js";
import { listKeys, mintKey } from "../auth/keys.js";
import { env } from "../env.js";
import { badRequest, unauthorized } from "../lib/errors.js";
import { usageSummary } from "../lib/usage.js";

/**
 * Admin API — issue keys and read usage remotely, so new projects can be
 * onboarded without SSH-ing into the box. Gated by ADMIN_TOKEN (Bearer or
 * x-admin-token). If ADMIN_TOKEN is unset, the whole surface is disabled.
 */
export const admin = new Hono<AppEnv>();

admin.use("*", async (c, next) => {
	if (!env.ADMIN_TOKEN) throw unauthorized("Admin API disabled (set ADMIN_TOKEN)");
	const header = c.req.header("Authorization") ?? "";
	const m = header.match(/^Bearer\s+(.+)$/i);
	const token = m ? m[1]!.trim() : c.req.header("x-admin-token");
	if (!token || token !== env.ADMIN_TOKEN) throw unauthorized("Invalid admin token");
	await next();
});

// Issue a new project key. The plaintext is returned ONCE.
admin.post("/keys", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { project?: unknown };
	const project = typeof body.project === "string" ? body.project.trim() : "";
	if (!project) throw badRequest('Missing "project" in JSON body');
	const { plaintext, record } = await mintKey(project);
	return c.json({
		key: plaintext,
		project: record.project,
		prefix: record.prefix,
		created_at: record.created_at,
	});
});

// List issued keys (prefix + metadata only; never the plaintext).
admin.get("/keys", async (c) => c.json({ keys: await listKeys() }));

// Usage aggregated per project + endpoint — reporting / billing basis.
admin.get("/usage", async (c) => c.json({ usage: await usageSummary() }));
