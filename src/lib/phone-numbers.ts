import { AccessToken } from "livekit-server-sdk";
import { env } from "../env.js";
import { AppError, badGateway, tooManyRequests } from "./errors.js";

/**
 * LiveKit Phone Numbers — a thin Twirp REST client (spec #3).
 *
 * LiveKit Cloud exposes number provisioning through the `PhoneNumberService`
 * Twirp API, which the Node `livekit-server-sdk` does not wrap. We call it
 * directly:
 *
 *   POST https://{PROJECT_DOMAIN}/twirp/livekit.PhoneNumberService/{Method}
 *   Authorization: Bearer <access token w/ SIP admin grant>
 *   Content-Type: application/json
 *   body: JSON, snake_case fields
 *
 * This module is CRM-neutral: it knows only phone numbers and dispatch rules.
 * Any source/subaccount ↔ number mapping is the SaaS's concern.
 *
 * NOTE: this cannot be live-tested here (no funded telephony project), so the
 * request/response field names below are best-effort against LiveKit's Twirp
 * schema. Every DTO is permissive (extra keys pass through) and the spots we
 * could not confirm are marked `// verify against live API`.
 */

/** Thrown when LiveKit creds / URL are missing — never crashes the gateway. */
export class PhoneNumbersNotConfiguredError extends AppError {
	constructor() {
		super(
			503,
			"livekit_not_configured",
			"Phone number provisioning requires LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET",
		);
	}
}

/** Resolved LiveKit config for the Twirp client. */
interface LiveKitConfig {
	apiKey: string;
	apiSecret: string;
	/** https origin derived from LIVEKIT_URL host, e.g. https://my-proj.livekit.cloud */
	domain: string;
}

/**
 * Derive the project's HTTPS domain from LIVEKIT_URL. The env holds the realtime
 * URL (wss://<project>.livekit.cloud); the Twirp control-plane lives at the same
 * host over https. We only swap the scheme + keep the host so this works for
 * both `*.livekit.cloud` and self-hosted hosts.
 */
function projectDomain(livekitUrl: string): string {
	const host = new URL(livekitUrl).host;
	return `https://${host}`;
}

function requireConfig(): LiveKitConfig {
	if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
		throw new PhoneNumbersNotConfiguredError();
	}
	return {
		apiKey: env.LIVEKIT_API_KEY,
		apiSecret: env.LIVEKIT_API_SECRET,
		domain: projectDomain(env.LIVEKIT_URL),
	};
}

/**
 * Mint a short-lived LiveKit access token carrying the SIP admin grant — the
 * authorization the PhoneNumberService requires. Same signing primitive
 * (`AccessToken` from livekit-server-sdk) the dispatch/SIP paths already use.
 */
async function sipAdminToken(cfg: LiveKitConfig): Promise<string> {
	const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { ttl: "10m" });
	at.addSIPGrant({ admin: true });
	return at.toJwt();
}

/** Shape of a Twirp error body: { code, msg, meta? }. */
interface TwirpError {
	code?: string;
	msg?: string;
	meta?: Record<string, string>;
}

/**
 * POST one Twirp method and return the parsed JSON body. Maps upstream failures
 * onto the gateway's error envelope so a route never leaks a raw fetch error.
 */
async function twirp<T>(method: string, body: Record<string, unknown>): Promise<T> {
	const cfg = requireConfig();
	const token = await sipAdminToken(cfg);
	const url = `${cfg.domain}/twirp/livekit.PhoneNumberService/${method}`;

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
	} catch (cause) {
		throw badGateway(`LiveKit PhoneNumberService unreachable (${method})`, cause);
	}

	const text = await res.text();
	if (!res.ok) {
		let err: TwirpError = {};
		try {
			err = JSON.parse(text) as TwirpError;
		} catch {
			// non-JSON error body — keep the raw text as internal detail
		}
		const detail = err.msg ?? text ?? `HTTP ${res.status}`;
		if (res.status === 429) throw tooManyRequests(`LiveKit: ${detail}`);
		if (res.status === 400 || res.status === 404) {
			throw new AppError(res.status, err.code ?? "bad_request", `LiveKit: ${detail}`);
		}
		throw badGateway(`LiveKit PhoneNumberService ${method} failed: ${detail}`, {
			status: res.status,
			body: err,
		});
	}

	return (text ? JSON.parse(text) : {}) as T;
}

/*
 * ─── DTOs ────────────────────────────────────────────────────────────────
 * Permissive: known fields are typed, `[key: string]: unknown` lets any extra
 * fields LiveKit returns pass straight through to the caller.
 */

/** An in-inventory number returned by SearchPhoneNumbers. */
export interface AvailablePhoneNumber {
	/** E.164 number, e.g. +16615550142. // verify field name against live API */
	phone_number?: string;
	country?: string;
	region?: string;
	locality?: string;
	/** Monthly cost, provider-defined units. // verify against live API */
	monthly_cost?: string | number;
	capabilities?: Record<string, unknown>;
	[key: string]: unknown;
}

/** An owned/active number (Purchase/List/Get/Update responses). */
export interface PhoneNumber {
	/** LiveKit's internal id for the number. // verify field name against live API */
	id?: string;
	phone_number?: string;
	country?: string;
	/** Dispatch rule routing inbound calls on this number, if any. */
	sip_dispatch_rule_id?: string;
	[key: string]: unknown;
}

export interface SearchParams {
	country?: string;
	area_code?: string;
	/** Optional digit/substring filter, if the API supports it. // verify */
	contains?: string;
	limit?: number;
}

/** SearchPhoneNumbers → available inventory for country / area code. */
export async function searchPhoneNumbers(
	params: SearchParams,
): Promise<{ available_numbers: AvailablePhoneNumber[] }> {
	// Drop undefined so we only send what the caller asked for.
	const body: Record<string, unknown> = {};
	if (params.country) body.country = params.country;
	if (params.area_code) body.area_code = params.area_code;
	if (params.contains) body.contains = params.contains;
	if (params.limit) body.limit = params.limit;
	return twirp<{ available_numbers: AvailablePhoneNumber[] }>("SearchPhoneNumbers", body);
}

/** PurchasePhoneNumber → buy a number from inventory, optionally routing inbound. */
export async function purchasePhoneNumber(input: {
	phone_number: string;
	sip_dispatch_rule_id?: string;
}): Promise<{ phone_number: PhoneNumber }> {
	const body: Record<string, unknown> = { phone_number: input.phone_number };
	if (input.sip_dispatch_rule_id) body.sip_dispatch_rule_id = input.sip_dispatch_rule_id;
	return twirp<{ phone_number: PhoneNumber }>("PurchasePhoneNumber", body);
}

/** ListPhoneNumbers → all numbers owned by this project. */
export async function listPhoneNumbers(): Promise<{ phone_numbers: PhoneNumber[] }> {
	return twirp<{ phone_numbers: PhoneNumber[] }>("ListPhoneNumbers", {});
}

/** GetPhoneNumber → one number by its LiveKit id. */
export async function getPhoneNumber(
	phoneNumberId: string,
): Promise<{ phone_number: PhoneNumber }> {
	// verify request field name (phone_number_id) against live API
	return twirp<{ phone_number: PhoneNumber }>("GetPhoneNumber", {
		phone_number_id: phoneNumberId,
	});
}

/** UpdatePhoneNumber → set/change the inbound SIP dispatch rule for a number. */
export async function updatePhoneNumber(input: {
	phone_number_id: string;
	sip_dispatch_rule_id: string;
}): Promise<{ phone_number: PhoneNumber }> {
	return twirp<{ phone_number: PhoneNumber }>("UpdatePhoneNumber", {
		phone_number_id: input.phone_number_id,
		sip_dispatch_rule_id: input.sip_dispatch_rule_id,
	});
}

/** ReleasePhoneNumbers → deactivate (release) one or more numbers. */
export async function releasePhoneNumbers(
	phoneNumberIds: string[],
): Promise<Record<string, unknown>> {
	// verify request field name (phone_number_ids) against live API
	return twirp<Record<string, unknown>>("ReleasePhoneNumbers", {
		phone_number_ids: phoneNumberIds,
	});
}
