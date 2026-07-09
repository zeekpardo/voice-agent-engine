import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { env } from "../src/env.js";

/**
 * Zero-click Telnyx provisioning for the voice engine: outbound voice
 * profile, FQDN SIP connection pointed at LiveKit (TCP) with credential
 * outbound auth, number purchase + assignment. Idempotent — safe to re-run.
 *
 * Usage: pnpm tsx scripts/setup-telnyx.ts   (TELNYX_API_KEY from .env)
 * Then:  scripts/setup-sip.ts with the printed SIP_* values
 *        (also written to ./.telnyx-sip.json, gitignored).
 */

const API_KEY = process.env.TELNYX_API_KEY;
const AREA_CODE = process.env.AREA_CODE ?? "661";
const NAME = "voice-engine";

if (!API_KEY) {
	console.error("TELNYX_API_KEY missing");
	process.exit(1);
}
if (!env.LIVEKIT_URL) {
	console.error("LIVEKIT_URL missing from .env");
	process.exit(1);
}

const sipHost = new URL(env.LIVEKIT_URL.replace(/^wss:/, "https:")).host.replace(
	/\.livekit\.cloud$/,
	".sip.livekit.cloud",
);

async function telnyx<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`https://api.telnyx.com/v2${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const data = (await res.json().catch(() => ({}))) as { data?: T; errors?: unknown[] };
	if (!res.ok) {
		throw new Error(`Telnyx ${method} ${path} failed (${res.status}): ${JSON.stringify(data.errors ?? data).slice(0, 400)}`);
	}
	return data.data as T;
}

// ---------------------------------------------------------------- 1. outbound voice profile
interface Ovp {
	id: string;
	name: string;
}
const ovps = await telnyx<Ovp[]>("GET", "/outbound_voice_profiles?page[size]=50");
let ovp = ovps.find((o) => o.name === NAME);
if (!ovp) {
	ovp = await telnyx<Ovp>("POST", "/outbound_voice_profiles", {
		name: NAME,
		traffic_type: "conversational",
		service_plan: "global",
	});
	console.log(`✅ outbound voice profile: ${ovp.id}`);
} else {
	console.log(`✓ outbound voice profile exists: ${ovp.id}`);
}

// ---------------------------------------------------------------- 2. FQDN SIP connection
interface Connection {
	id: string;
	connection_name: string;
	user_name?: string;
}
const conns = await telnyx<Connection[]>("GET", "/fqdn_connections?page[size]=50");
let conn = conns.find((c) => c.connection_name === NAME);
const username = `voiceengine${randomBytes(3).toString("hex")}`;
let password: string | null = null;
if (!conn) {
	password = `Va${randomBytes(12).toString("base64url")}1`;
	conn = await telnyx<Connection>("POST", "/fqdn_connections", {
		connection_name: NAME,
		transport_protocol: "TCP",
		user_name: username,
		password,
		outbound: {
			outbound_voice_profile_id: ovp.id,
			ani_override_type: "always",
		},
		inbound: {
			ani_number_format: "+E.164",
			dnis_number_format: "+e164",
		},
	});
	console.log(`✅ SIP connection: ${conn.id} (username: ${username})`);
} else {
	console.log(`✓ SIP connection exists: ${conn.id} (username: ${conn.user_name})`);
}

// ---------------------------------------------------------------- 3. FQDN → LiveKit
interface Fqdn {
	id: string;
	fqdn: string;
}
const fqdns = await telnyx<Fqdn[]>("GET", `/fqdns?filter[connection_id]=${conn.id}`);
if (!fqdns.some((f) => f.fqdn === sipHost)) {
	await telnyx<Fqdn>("POST", "/fqdns", {
		connection_id: conn.id,
		fqdn: sipHost,
		dns_record_type: "a",
		port: 5060,
	});
	console.log(`✅ FQDN → ${sipHost}`);
} else {
	console.log(`✓ FQDN already points at ${sipHost}`);
}

// ---------------------------------------------------------------- 4. number (buy if none)
interface OwnedNumber {
	id: string;
	phone_number: string;
	connection_id?: string | null;
}
const owned = await telnyx<OwnedNumber[]>("GET", "/phone_numbers?page[size]=20");
let number = owned.find((n) => n.connection_id === conn.id) ?? owned[0];
if (!number) {
	const avail = await telnyx<{ phone_number: string }[]>(
		"GET",
		`/available_phone_numbers?filter[national_destination_code]=${AREA_CODE}&filter[country_code]=US&filter[limit]=1`,
	);
	const candidate = avail[0]?.phone_number;
	if (!candidate) throw new Error(`No numbers available in area code ${AREA_CODE}`);
	await telnyx("POST", "/number_orders", {
		phone_numbers: [{ phone_number: candidate }],
		connection_id: conn.id,
	});
	console.log(`✅ number purchased: ${candidate}`);
	// order is async — poll briefly until it shows up
	for (let i = 0; i < 10 && !number; i++) {
		await new Promise((r) => setTimeout(r, 2000));
		const refreshed = await telnyx<OwnedNumber[]>("GET", "/phone_numbers?page[size]=20");
		number = refreshed.find((n) => n.phone_number === candidate);
	}
	if (!number) throw new Error("Number order placed but number not visible yet — re-run in a minute");
} else {
	console.log(`✓ number owned: ${number.phone_number}`);
}

// ensure the number is assigned to our connection
if (number.connection_id !== conn.id) {
	await telnyx("PATCH", `/phone_numbers/${number.id}`, { connection_id: conn.id });
	console.log("✅ number assigned to SIP connection");
} else {
	console.log("✓ number already assigned to SIP connection");
}

// ---------------------------------------------------------------- summary
const summary = {
	SIP_NUMBER: number.phone_number,
	SIP_ADDRESS: "sip.telnyx.com",
	SIP_USERNAME: conn.user_name ?? username,
	SIP_PASSWORD: password ?? "<from first run — see ./.telnyx-sip.json>",
};
if (password) writeFileSync("./.telnyx-sip.json", JSON.stringify(summary, null, 2));

console.log(`
──────────────────────────────────────────────────────
Telnyx is wired. Next:

  SIP_NUMBER=${summary.SIP_NUMBER} SIP_ADDRESS=sip.telnyx.com \\
  SIP_USERNAME=${summary.SIP_USERNAME} SIP_PASSWORD=${password ?? "<from ./.telnyx-sip.json>"} \\
  pnpm tsx scripts/setup-sip.ts
${password ? "\n  (credentials saved to ./.telnyx-sip.json — gitignored)" : ""}
──────────────────────────────────────────────────────`);
process.exit(0);
