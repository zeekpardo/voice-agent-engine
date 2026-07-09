import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app-types.js";
import { unauthorized } from "../lib/errors.js";
import { findLiveKey, touchKey } from "./keys.js";

/**
 * Bearer API-key auth for YOUR projects.
 * Expects: `Authorization: Bearer vk_live_...`
 */
export const apiKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
	const header = c.req.header("Authorization") ?? "";
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) throw unauthorized("Missing Authorization: Bearer <key> header");

	const token = match[1]!.trim();
	const key = await findLiveKey(token);
	if (!key) throw unauthorized();

	c.set("apiKey", key);
	void touchKey(key.id); // best-effort last-seen stamp
	await next();
});
