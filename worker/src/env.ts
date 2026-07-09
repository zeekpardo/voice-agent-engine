import "dotenv/config";
import { z } from "zod";

const schema = z.object({
	// LiveKit worker registration (provided automatically on LiveKit Cloud deploys).
	LIVEKIT_URL: z.string().min(1),
	LIVEKIT_API_KEY: z.string().min(1),
	LIVEKIT_API_SECRET: z.string().min(1),
	// The agent name this worker registers under — must match the gateway's
	// LIVEKIT_AGENT_NAME (dispatch targets it by name).
	AGENT_NAME: z.string().default("voice-agent"),
	// Control plane.
	GATEWAY_URL: z.string().url(),
	GATEWAY_INTERNAL_KEY: z.string().min(1),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
	console.error("❌ agent-worker: invalid environment:");
	for (const issue of parsed.error.issues) {
		console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
	}
	process.exit(1);
}

export const env = parsed.data;
