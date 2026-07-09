/**
 * Consistent error envelope for the whole API:
 *   { "error": { "code": "...", "message": "..." } }
 *
 * Throw AppError anywhere; the Hono onError handler renders it.
 */
export class AppError extends Error {
	readonly status: number;
	readonly code: string;
	/** Extra detail logged server-side but never returned to callers. */
	readonly internal?: unknown;

	constructor(status: number, code: string, message: string, internal?: unknown) {
		super(message);
		this.name = "AppError";
		this.status = status;
		this.code = code;
		this.internal = internal;
	}
}

export const badRequest = (message: string) => new AppError(400, "bad_request", message);
export const unauthorized = (message = "Invalid or missing API key") =>
	new AppError(401, "unauthorized", message);
export const payloadTooLarge = (message: string) =>
	new AppError(413, "payload_too_large", message);
export const tooManyRequests = (message = "Rate limited by upstream, try again shortly") =>
	new AppError(429, "rate_limited", message);
export const notImplemented = (message: string) =>
	new AppError(501, "not_implemented", message);
/** Upstream (xAI) failed in a way that is our problem, not the caller's. */
export const badGateway = (message: string, internal?: unknown) =>
	new AppError(502, "upstream_error", message, internal);
