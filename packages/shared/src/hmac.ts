import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Canonical HMAC webhook signing scheme shared by the gateway (root) and kit
 * (consuming apps' webhook/tool handlers): HMAC-SHA256 over `${timestamp}.${body}`,
 * hex-encoded, carried as `X-Voice-Signature: hmac-sha256=<hex>` alongside an
 * `X-Voice-Timestamp` header.
 *
 * worker/src/tools.ts and worker/src/main.ts intentionally keep their own copies
 * of this scheme (see comments there): `lk agent deploy` builds the worker's
 * Docker image from the worker/ directory alone, so this workspace package isn't
 * available in that build context. Keep those copies in sync with this file by
 * hand if the scheme ever changes.
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
