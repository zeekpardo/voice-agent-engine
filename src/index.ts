import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { migrate } from "./db/index.js";
import { env } from "./env.js";
import { startCallQueueDrainer, startCallScheduler } from "./lib/outbound.js";
import { startWebhookDispatcher } from "./lib/webhooks.js";

await migrate();
startWebhookDispatcher();
startCallScheduler();
startCallQueueDrainer();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
	console.log(`🎙️  voice-agent-engine listening on http://localhost:${info.port}`);
	console.log(`    health:     GET  /health`);
	console.log(`    agents:     CRUD /v1/agents · /v1/tools · /v1/webhooks`);
	console.log(`    sessions:   POST /v1/sessions          (browser voice agent)`);
	console.log(`    telephony:  POST /v1/calls · /v1/numbers   (outbound + inbound)`);
});
