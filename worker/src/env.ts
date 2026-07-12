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
	// TEXT `respond` path (Claude). When ANTHROPIC_API_KEY is set on the WORKER
	// env, the TEXT channel's caller-facing reply runs on Claude (via the LiveKit
	// Anthropic LLM plugin) so widget-chat / test-portal text matches omnichannel
	// quality; when unset, text stays on the xAI/Inference default (no breakage).
	// VOICE is never affected — this gate is text-only. An explicit
	// config.models.respond override always wins (stays on Inference).
	ANTHROPIC_API_KEY: z.string().optional(),
	// Claude model for the TEXT respond path (used only when ANTHROPIC_API_KEY is
	// set and no config.models.respond override). Mirrors the gateway default.
	ANTHROPIC_TEXT_MODEL: z.string().default("claude-sonnet-5"),
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
