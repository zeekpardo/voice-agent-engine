// ============================================================================
// DO NOT EDIT — GENERATED FILE.
//
// Vendored verbatim from packages/shared/src/safe-url.ts by `pnpm sync:worker`.
// The worker builds standalone (`lk agent deploy` uses worker/ as the entire
// Docker build context), so it can't import @voice-engine/shared. Edit the
// canonical file in packages/shared/src/ and re-run `pnpm sync:worker`.
// CI runs `pnpm sync:worker --check` to fail on drift.
// ============================================================================

import { isIP } from "node:net";
import { z } from "zod";

/**
 * SSRF guard for user-supplied outbound URLs (tool endpoint_url, webhook url).
 *
 * These URLs are fetched by the engine (webhook delivery in lib/webhooks.ts,
 * gateway-side tool writes in lib/convo-runner/tools.ts) and by the worker.
 * Without validation a tenant could point them at cloud metadata
 * (169.254.169.254), localhost, or RFC1918 hosts to pivot inside our network.
 *
 * SCHEME POLICY: https-only. Nothing in the codebase legitimately fetches a
 * tool/webhook over plain http to a non-local host (all first-party fetches use
 * env-configured https bases), so we require `https:` and reject `http:`.
 *
 * NOTE ON DNS REBINDING: this validates the URL's *literal* host. A hostname
 * that resolves to a blocked IP only at fetch time (DNS rebinding) is NOT caught
 * here — full protection needs a pinned-lookup fetch agent that re-checks the
 * resolved socket address. Callers re-run assertSafeUrl right before fetch as a
 * cheap defence (host re-check + guards URLs stored before this guard existed);
 * see the follow-up note at each fetch site.
 */

export class UnsafeUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafeUrlError";
	}
}

/** Parse a single inet_aton-style token: decimal, 0x-hex, or 0-octal. */
function parseIpv4Token(tok: string): number | null {
	if (/^0x[0-9a-f]+$/i.test(tok)) return Number.parseInt(tok, 16);
	if (/^0[0-7]+$/.test(tok)) return Number.parseInt(tok, 8);
	if (/^0$/.test(tok)) return 0;
	if (/^[1-9][0-9]*$/.test(tok)) return Number.parseInt(tok, 10);
	return null;
}

/**
 * Parse a host as an IPv4 address in any inet_aton form (dotted quad, but also
 * `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`) → 32-bit int, or null if it
 * is not a numeric IPv4 at all (i.e. a real hostname). This closes the classic
 * "decimal/hex/octal IP bypasses a dotted-quad blocklist" hole.
 */
function ipv4ToInt(host: string): number | null {
	const parts = host.split(".");
	if (parts.length > 4) return null;
	const nums: number[] = [];
	for (const p of parts) {
		const n = parseIpv4Token(p);
		if (n === null || n < 0) return null;
		nums.push(n);
	}
	// inet_aton: the final part absorbs all remaining low bytes. `>>> 0` coerces
	// the shift result to an unsigned 32-bit int (a<<24 is otherwise negative for
	// a >= 128, which would wrongly reject 172./192./169. addresses).
	const [n0 = 0, n1 = 0, n2 = 0, n3 = 0] = nums;
	let value: number;
	switch (nums.length) {
		case 1:
			value = n0;
			break;
		case 2:
			if (n0 > 0xff || n1 > 0xff_ffff) return null;
			value = ((n0 << 24) | n1) >>> 0;
			break;
		case 3:
			if (n0 > 0xff || n1 > 0xff || n2 > 0xffff) return null;
			value = ((n0 << 24) | (n1 << 16) | n2) >>> 0;
			break;
		case 4:
			if (nums.some((n) => n > 0xff)) return null;
			value = ((n0 << 24) | (n1 << 16) | (n2 << 8) | n3) >>> 0;
			break;
		default:
			return null;
	}
	if (value < 0 || value > 0xffff_ffff) return null;
	return value >>> 0;
}

/** True if a 32-bit IPv4 int falls in a loopback / private / link-local range. */
function isBlockedIpv4(ip: number): boolean {
	const a = (ip >>> 24) & 0xff;
	const b = (ip >>> 16) & 0xff;
	return (
		a === 0 || // 0.0.0.0/8 "this host"
		a === 127 || // 127.0.0.0/8 loopback
		a === 10 || // 10.0.0.0/8 private
		(a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
		(a === 192 && b === 168) || // 192.168.0.0/16 private
		(a === 169 && b === 254) || // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
		a === 255 // 255.0.0.0/8 broadcast/reserved
	);
}

/** Expand an IPv6 literal (net.isIP-validated) into 8 hextets, or null. */
function expandIpv6(hostRaw: string): number[] | null {
	let work = hostRaw.split("%")[0] ?? ""; // drop zone id
	// Fold an embedded IPv4 tail (e.g. ::ffff:1.2.3.4) into two hextets.
	const v4 = work.match(/^(.*:)((?:\d+\.){3}\d+)$/);
	if (v4?.[1] && v4[2]) {
		const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = v4[2].split(".").map((o) => Number.parseInt(o, 10));
		if ([o0, o1, o2, o3].some((o) => o > 255)) return null;
		const h1 = ((o0 << 8) | o1).toString(16);
		const h2 = ((o2 << 8) | o3).toString(16);
		work = `${v4[1]}${h1}:${h2}`;
	}
	const halves = work.split("::");
	if (halves.length > 2) return null;
	if (halves.length === 1) {
		const groups = work.split(":");
		if (groups.length !== 8) return null;
		return groups.map((g) => Number.parseInt(g || "0", 16));
	}
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (missing < 0) return null;
	const full = [...head, ...Array(missing).fill("0"), ...tail];
	if (full.length !== 8) return null;
	return full.map((g) => Number.parseInt(g || "0", 16));
}

/** True if an IPv6 literal is loopback / unspecified / ULA / link-local / maps to a blocked v4. */
function isBlockedIpv6(host: string): boolean {
	const hextets = expandIpv6(host);
	if (!hextets) return true; // unparseable literal → fail closed
	let value = 0n;
	for (const h of hextets) value = (value << 16n) | BigInt(h & 0xffff);

	if (value === 0n) return true; // :: unspecified
	if (value === 1n) return true; // ::1 loopback
	if (value >> 121n === 0x7en) return true; // fc00::/7 unique-local
	if (value >> 118n === 0x3fan) return true; // fe80::/10 link-local

	const high96 = value >> 32n;
	const low32 = Number(value & 0xffff_ffffn) >>> 0;
	// ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (deprecated IPv4-compatible):
	// re-check the embedded IPv4 against the v4 blocklist.
	if (high96 === 0xffffn) return isBlockedIpv4(low32);
	if (high96 === 0n && low32 !== 0 && low32 !== 1) return isBlockedIpv4(low32);
	return false;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal"];

/**
 * Validate a user-supplied URL for outbound fetch safety. Returns the parsed URL
 * on success; throws {@link UnsafeUrlError} with a caller-safe message otherwise.
 */
export function assertSafeUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new UnsafeUrlError("must be a valid absolute URL");
	}

	if (url.protocol !== "https:") {
		throw new UnsafeUrlError("must use https");
	}

	// url.hostname strips the [] around an IPv6 literal already.
	const host = url.hostname.toLowerCase().replace(/\.$/, ""); // trailing-dot FQDN
	if (!host) throw new UnsafeUrlError("missing host");

	if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
		throw new UnsafeUrlError("host is not publicly routable");
	}

	const ipKind = isIP(host);
	if (ipKind === 6 || host.includes(":")) {
		if (isBlockedIpv6(host)) {
			throw new UnsafeUrlError("host resolves to a private or reserved address");
		}
		return url;
	}

	// IPv4 in any notation (dotted quad, decimal, hex, octal, short forms).
	const v4 = ipv4ToInt(host);
	if (v4 !== null && isBlockedIpv4(v4)) {
		throw new UnsafeUrlError("host resolves to a private or reserved address");
	}

	return url;
}

/**
 * Zod string schema that enforces {@link assertSafeUrl}. Use in request bodies so
 * a bad URL is rejected at create-time with a clear 400 (the route's parseBody
 * formatter surfaces the message).
 */
export function safeHttpUrl(): z.ZodType<string, z.ZodTypeDef, string> {
	return z.string().superRefine((val, ctx) => {
		try {
			assertSafeUrl(val);
		} catch (err) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: err instanceof UnsafeUrlError ? err.message : "invalid or unsafe URL",
			});
		}
	});
}
