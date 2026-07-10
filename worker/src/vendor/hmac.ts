// ============================================================================
// DO NOT EDIT — GENERATED FILE.
//
// Vendored verbatim from packages/shared/src/hmac.ts by `pnpm sync:worker`.
// The worker builds standalone (`lk agent deploy` uses worker/ as the entire
// Docker build context), so it can't import @voice-engine/shared. Edit the
// canonical file in packages/shared/src/ and re-run `pnpm sync:worker`.
// CI runs `pnpm sync:worker --check` to fail on drift.
// ============================================================================

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Canonical HMAC webhook signing scheme shared by the gateway (root) and kit
 * (consuming apps' webhook/tool handlers): HMAC-SHA256 over `${timestamp}.${body}`,
 * hex-encoded, carried as `X-Voice-Signature: hmac-sha256=<hex>` alongside an
 * `X-Voice-Timestamp` header.
 *
 * The worker cannot import this workspace package (`lk agent deploy` builds the
 * worker's Docker image from the worker/ directory alone). Instead this file is
 * VENDORED into worker/src/vendor/hmac.ts by `pnpm sync:worker`; the worker
 * imports the vendored copy. This file stays canonical — edit here, then run
 * `pnpm sync:worker` (CI runs `pnpm sync:worker --check` to catch drift).
 */

const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Sign a webhook/tool-invocation body for the given timestamp. */
export function signPayload(secret: string, timestamp: string, body: string): string {
	return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Verify an engine signature (webhooks and tool invocations share the scheme). */
export function verifySignature(
	secret: string,
	timestamp: string | null,
	signatureHeader: string | null,
	rawBody: string,
): boolean {
	if (!timestamp || !signatureHeader) return false;
	const age = Math.abs(Date.now() / 1000 - Number(timestamp));
	if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;
	const expected = signPayload(secret, timestamp, rawBody);
	const received = signatureHeader.replace(/^hmac-sha256=/, "");
	if (expected.length !== received.length) return false;
	return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}
