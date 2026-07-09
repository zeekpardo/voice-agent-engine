import { randomBytes } from "node:crypto";

/**
 * Prefixed, URL-safe ids for API resources: agt_…, tool_…, call_…, wh_…, evt_…
 * 18 random bytes → 24 base64url chars; prefix makes ids self-describing in
 * logs and webhook payloads.
 */
export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(18).toString("base64url")}`;
}
