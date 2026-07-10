import "dotenv/config";
import { z } from "zod";

const schema = z.object({
	XAI_API_KEY: z.string().min(1, "XAI_API_KEY is required"),
	XAI_BASE_URL: z.string().url().default("https://api.x.ai/v1"),
	PORT: z.coerce.number().int().positive().default(8787),
	DATABASE_URL: z.string().min(1).default("postgres://localhost:5432/voice_gateway"),
	// Legacy SQLite file — only read by scripts/migrate-sqlite-to-pg.ts.
	DB_PATH: z.string().default("./data/gateway.db"),
	DEFAULT_LANGUAGE: z.string().default("en"),
	STT_FORMAT: z.string().default("true"),
	MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(157_286_400), // 150 MB (fits ~90 min audio)
	// Media (video files + URLs): larger uploads and a duration cap for extraction.
	MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1_073_741_824), // 1 GB (video files)
	MEDIA_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(5400), // 1 h 30 min
	// Translation (Anthropic). Optional — /v1/translate errors clearly if the key is unset.
	ANTHROPIC_API_KEY: z.string().optional(),
	ANTHROPIC_BASE_URL: z.string().url().default("https://api.anthropic.com"),
	TRANSLATE_MODEL: z.string().default("claude-opus-4-8"),
	TRANSLATE_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
	// Admin API (key issuance + usage). If unset, /admin routes are disabled.
	ADMIN_TOKEN: z.string().optional(),
	// Signing secret for short-lived stream tokens. Falls back to ADMIN_TOKEN.
	STREAM_TOKEN_SECRET: z.string().optional(),
	// LiveKit Cloud — required for agent sessions (/v1/sessions). Routes error
	// clearly if unset; transcription-only deployments can omit these.
	LIVEKIT_URL: z.string().url().optional(),
	LIVEKIT_API_KEY: z.string().optional(),
	LIVEKIT_API_SECRET: z.string().optional(),
	// Shared secret for agent-worker → gateway /internal routes. If unset, the
	// internal surface is disabled.
	INTERNAL_KEY: z.string().optional(),
	// LiveKit SIP outbound trunk (created by scripts/setup-sip.ts). Outbound
	// calls error clearly until set.
	LIVEKIT_SIP_OUTBOUND_TRUNK_ID: z.string().optional(),
	// Defaults for the LLM (/v1/chat) and TTS (/v1/speak) proxies.
	CHAT_DEFAULT_MODEL: z.string().default("grok-4-fast"),
	TTS_DEFAULT_VOICE: z.string().default("ara"),
	// Call recording destination (LiveKit Egress → S3-compatible storage). All
	// optional: when an agent enables recording but these are unset, the gateway
	// logs a warning and skips egress — it NEVER fails the call. S3_ENDPOINT is
	// only needed for non-AWS S3-compatible stores (R2, MinIO, GCS-S3); leaving it
	// unset targets AWS S3 in S3_REGION. Bucket + key + secret are the minimum for
	// recording to actually start.
	S3_ENDPOINT: z.string().optional(),
	S3_BUCKET: z.string().optional(),
	S3_ACCESS_KEY: z.string().optional(),
	S3_SECRET_KEY: z.string().optional(),
	S3_REGION: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
	console.error("❌ Invalid environment configuration:");
	for (const issue of parsed.error.issues) {
		console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
	}
	console.error("\nCopy .env.example to .env and fill in the values.");
	process.exit(1);
}

export const env = parsed.data;
