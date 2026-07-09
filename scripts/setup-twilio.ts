import { randomBytes } from "node:crypto";
import { env } from "../src/env.js";

/**
 * Zero-click Twilio provisioning for the voice engine: creates the Elastic
 * SIP trunk, credential list, LiveKit origination, buys a number, and wires
 * it all together. Idempotent — safe to re-run.
 *
 * Usage:
 *   TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... [AREA_CODE=661] \
 *     pnpm tsx scripts/setup-twilio.ts
 *
 * Prints the SIP_* env values for scripts/setup-sip.ts (or run that next —
 * the values are also written to ./.twilio-sip.json for convenience).
 */

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const AREA_CODE = process.env.AREA_CODE ?? "661";
const TRUNK_NAME = "voice-engine";

if (!ACCOUNT_SID || !AUTH_TOKEN) {
	console.error("Usage: TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... pnpm tsx scripts/setup-twilio.ts");
	process.exit(1);
}
if (!env.LIVEKIT_URL) {
	console.error("LIVEKIT_URL missing from .env");
	process.exit(1);
}

const auth = `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`;

async function twilio<T>(
	base: string,
	method: string,
	path: string,
	form?: Record<string, string>,
): Promise<T> {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: {
			Authorization: auth,
			...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
		},
		...(form ? { body: new URLSearchParams(form).toString() } : {}),
	});
	if (!res.ok) {
		throw new Error(`Twilio ${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
	}
	return (await res.json()) as T;
}

const TRUNKING = "https://trunking.twilio.com/v1";
const API = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`;

const sipHost = new URL(env.LIVEKIT_URL.replace(/^wss:/, "https:")).host.replace(
	/\.livekit\.cloud$/,
	".sip.livekit.cloud",
);

// ---------------------------------------------------------------- 1. trunk
interface Trunk {
	sid: string;
	domain_name: string | null;
	friendly_name: string;
}
const trunks = await twilio<{ trunks: Trunk[] }>(TRUNKING, "GET", "/Trunks?PageSize=50");
let trunk = trunks.trunks.find((t) => t.friendly_name === TRUNK_NAME);
if (!trunk) {
	// Domain must be globally unique and end in .pstn.twilio.com
	const domain = `noba-voice-${ACCOUNT_SID.slice(-6).toLowerCase()}.pstn.twilio.com`;
	trunk = await twilio<Trunk>(TRUNKING, "POST", "/Trunks", {
		FriendlyName: TRUNK_NAME,
		DomainName: domain,
	});
	console.log(`✅ trunk created: ${trunk.sid} (${trunk.domain_name})`);
} else {
	console.log(`✓ trunk exists: ${trunk.sid} (${trunk.domain_name})`);
}

// ---------------------------------------------------------------- 2. credential list + credential
interface CredList {
	sid: string;
	friendly_name: string;
}
const credLists = await twilio<{ credential_lists: CredList[] }>(
	API,
	"GET",
	"/SIP/CredentialLists.json?PageSize=50",
);
let credList = credLists.credential_lists.find((c) => c.friendly_name === TRUNK_NAME);
const username = `voiceengine${ACCOUNT_SID.slice(-6).toLowerCase()}`;
let password: string | null = null;
if (!credList) {
	credList = await twilio<CredList>(API, "POST", "/SIP/CredentialLists.json", {
		FriendlyName: TRUNK_NAME,
	});
	password = randomBytes(12).toString("base64url") + "aA1"; // meets Twilio complexity rules
	await twilio(API, "POST", `/SIP/CredentialLists/${credList.sid}/Credentials.json`, {
		Username: username,
		Password: password,
	});
	console.log(`✅ credential list created (username: ${username})`);
} else {
	console.log(`✓ credential list exists (username: ${username}) — password unchanged from first run`);
}

// attach to trunk termination (idempotent-ish: ignore duplicate errors)
try {
	await twilio(TRUNKING, "POST", `/Trunks/${trunk.sid}/CredentialLists`, {
		CredentialListSid: credList.sid,
	});
	console.log("✅ credential list attached to trunk");
} catch (err) {
	if (String(err).includes("already")) console.log("✓ credential list already attached");
	else if (!String(err).includes("400")) throw err;
	else console.log("✓ credential list attachment: already present");
}

// ---------------------------------------------------------------- 3. origination → LiveKit
interface OrigUrl {
	sip_url: string;
}
const origs = await twilio<{ origination_urls: OrigUrl[] }>(
	TRUNKING,
	"GET",
	`/Trunks/${trunk.sid}/OriginationUrls?PageSize=50`,
);
const sipUrl = `sip:${sipHost};transport=tcp`;
if (!origs.origination_urls.some((o) => o.sip_url === sipUrl)) {
	await twilio(TRUNKING, "POST", `/Trunks/${trunk.sid}/OriginationUrls`, {
		FriendlyName: "livekit",
		SipUrl: sipUrl,
		Weight: "1",
		Priority: "1",
		Enabled: "true",
	});
	console.log(`✅ origination → ${sipUrl}`);
} else {
	console.log(`✓ origination already points at ${sipUrl}`);
}

// ---------------------------------------------------------------- 4. number (buy if none on trunk)
interface PhoneNumber {
	sid: string;
	phone_number: string;
}
const trunkNumbers = await twilio<{ phone_numbers: PhoneNumber[] }>(
	TRUNKING,
	"GET",
	`/Trunks/${trunk.sid}/PhoneNumbers?PageSize=10`,
);
let number = trunkNumbers.phone_numbers[0];
if (!number) {
	const owned = await twilio<{ incoming_phone_numbers: PhoneNumber[] }>(
		API,
		"GET",
		"/IncomingPhoneNumbers.json?PageSize=10",
	);
	let ownedNumber = owned.incoming_phone_numbers[0];
	if (!ownedNumber) {
		const avail = await twilio<{ available_phone_numbers: { phone_number: string }[] }>(
			API,
			"GET",
			`/AvailablePhoneNumbers/US/Local.json?AreaCode=${AREA_CODE}&PageSize=1`,
		);
		const candidate = avail.available_phone_numbers[0]?.phone_number;
		if (!candidate) throw new Error(`No available numbers in area code ${AREA_CODE}`);
		ownedNumber = await twilio<PhoneNumber>(API, "POST", "/IncomingPhoneNumbers.json", {
			PhoneNumber: candidate,
		});
		console.log(`✅ number purchased: ${ownedNumber.phone_number}`);
	} else {
		console.log(`✓ using already-owned number: ${ownedNumber.phone_number}`);
	}
	await twilio(TRUNKING, "POST", `/Trunks/${trunk.sid}/PhoneNumbers`, {
		PhoneNumberSid: ownedNumber.sid,
	});
	number = ownedNumber;
	console.log("✅ number assigned to trunk");
} else {
	console.log(`✓ trunk already has number: ${number.phone_number}`);
}

// ---------------------------------------------------------------- summary
const summary = {
	SIP_NUMBER: number.phone_number,
	SIP_ADDRESS: trunk.domain_name,
	SIP_USERNAME: username,
	SIP_PASSWORD: password ?? "<set on first run — check ./.twilio-sip.json or reset in console>",
};
if (password) {
	const { writeFileSync } = await import("node:fs");
	writeFileSync("./.twilio-sip.json", JSON.stringify(summary, null, 2));
}
console.log(`
──────────────────────────────────────────────────────
Twilio is wired. Next:

  SIP_NUMBER=${summary.SIP_NUMBER} SIP_ADDRESS=${summary.SIP_ADDRESS} \\
  SIP_USERNAME=${summary.SIP_USERNAME} SIP_PASSWORD=${password ?? "<from ./.twilio-sip.json>"} \\
  pnpm tsx scripts/setup-sip.ts
${password ? "\n  (credentials also saved to ./.twilio-sip.json — gitignored)" : ""}
──────────────────────────────────────────────────────`);
process.exit(0);
