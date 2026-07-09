import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "../db/index.js";

/**
 * API keys the gateway issues to YOUR projects (not the xAI key).
 * We store only a SHA-256 hash of the key plus a short prefix for display.
 * The plaintext is shown exactly once, at mint time.
 */

const KEY_PREFIX = "vk_live_";

export interface ApiKeyRecord {
	id: string;
	project: string;
	prefix: string;
	internal: boolean;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
}

export function hashKey(plaintext: string): string {
	return createHash("sha256").update(plaintext).digest("hex");
}

/** Create a new key, persist its hash, and return the one-time plaintext. */
export async function mintKey(
	project: string,
	opts: { internal?: boolean } = {},
): Promise<{ plaintext: string; record: ApiKeyRecord }> {
	const plaintext = KEY_PREFIX + randomBytes(24).toString("base64url");
	const prefix = plaintext.slice(0, 12); // e.g. "vk_live_ab12"
	const record: ApiKeyRecord = {
		id: randomUUID(),
		project,
		prefix,
		internal: opts.internal ?? false,
		created_at: new Date().toISOString(),
		last_used_at: null,
		revoked_at: null,
	};

	await sql`
		INSERT INTO api_keys (id, project, prefix, key_hash, internal, created_at)
		VALUES (${record.id}, ${project}, ${prefix}, ${hashKey(plaintext)}, ${record.internal}, ${record.created_at})`;

	return { plaintext, record };
}

/** Look up a live (non-revoked) key by its plaintext. Returns null if absent/revoked. */
export async function findLiveKey(plaintext: string): Promise<ApiKeyRecord | null> {
	const rows = await sql`
		SELECT id, project, prefix, internal, created_at, last_used_at, revoked_at
		FROM api_keys
		WHERE key_hash = ${hashKey(plaintext)} AND revoked_at IS NULL`;
	return (rows[0] as unknown as ApiKeyRecord) ?? null;
}

export async function touchKey(id: string): Promise<void> {
	try {
		await sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${id}`;
	} catch {
		/* best-effort last-seen stamp */
	}
}

export async function listKeys(): Promise<ApiKeyRecord[]> {
	const rows = await sql`
		SELECT id, project, prefix, internal, created_at, last_used_at, revoked_at
		FROM api_keys ORDER BY created_at DESC`;
	return rows as unknown as ApiKeyRecord[];
}
