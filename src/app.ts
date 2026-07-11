import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { logger } from "hono/logger";
import type { AppEnv } from "./app-types.js";
import { apiKeyAuth } from "./auth/middleware.js";
import { AppError } from "./lib/errors.js";
import { admin } from "./routes/admin.js";
import { agents } from "./routes/agents.js";
import { calls } from "./routes/calls.js";
import { conversations } from "./routes/conversations.js";
import { health } from "./routes/health.js";
import { internal } from "./routes/internal.js";
import { limits } from "./routes/limits.js";
import { numbers } from "./routes/numbers.js";
import { sessions } from "./routes/sessions.js";
import { tools } from "./routes/tools.js";
import { usage } from "./routes/usage.js";
import { webhooks } from "./routes/webhooks.js";

export const app = new Hono<AppEnv>();

// Request id (echoed back for correlation) + access logs.
app.use("*", async (c, next) => {
	const id = c.req.header("x-request-id") ?? randomUUID();
	c.set("requestId", id);
	c.header("x-request-id", id);
	await next();
});
app.use("*", logger());

// Public.
app.route("/", health);

// Admin (key issuance + usage) — gated by ADMIN_TOKEN inside the router.
app.route("/admin", admin);

// Internal surface for the agent-worker — gated by INTERNAL_KEY inside the router.
app.route("/internal", internal);

// Everything under /v1 requires an issued API key.
const v1 = new Hono<AppEnv>();
v1.use("*", apiKeyAuth);
v1.route("/", agents);
v1.route("/", tools);
v1.route("/", sessions);
v1.route("/", calls);
v1.route("/", conversations);
v1.route("/", webhooks);
v1.route("/", numbers);
v1.route("/", usage);
v1.route("/", limits);
app.route("/v1", v1);

// Consistent error envelope.
app.onError((err, c) => {
	if (err instanceof AppError) {
		if (err.internal !== undefined) {
			console.error(`[${c.get("requestId")}] ${err.code}:`, err.internal);
		}
		return c.json({ error: { code: err.code, message: err.message } }, err.status as never);
	}
	console.error(`[${c.get("requestId")}] unhandled:`, err);
	return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
