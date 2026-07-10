import { Hono } from "hono";
import type { AppEnv } from "../app-types.js";

export const health = new Hono<AppEnv>();

health.get("/health", (c) =>
	c.json({ ok: true, service: "voice-agent-engine", ts: new Date().toISOString() }),
);
