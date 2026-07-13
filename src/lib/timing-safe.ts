import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison for bearer secrets (ADMIN_TOKEN / INTERNAL_KEY).
 * Length is checked first (a length mismatch is not itself sensitive here), then
 * the equal-length buffers are compared without short-circuiting on content — so
 * an attacker can't recover the secret byte-by-byte via response timing.
 */
export function safeEqualStr(a: string | undefined | null, b: string | undefined | null): boolean {
	if (!a || !b) return false;
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}
