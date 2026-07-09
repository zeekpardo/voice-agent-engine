import { SipClient } from "livekit-server-sdk";
import { env } from "../src/env.js";

/**
 * Diagnose the SIP call path: LiveKit trunks/dispatch rules on one side,
 * the Telnyx connection + outbound voice profile on the other.
 * Read-only. Usage: pnpm tsx scripts/check-sip.ts
 */

if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
	console.error("Set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env first.");
	process.exit(1);
}

const sip = new SipClient(
	env.LIVEKIT_URL.replace(/^wss:/, "https:"),
	env.LIVEKIT_API_KEY,
	env.LIVEKIT_API_SECRET,
);

console.log("── LiveKit outbound trunks");
for (const t of await sip.listSipOutboundTrunk()) {
	const active = t.sipTrunkId === process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID ? "  ← .env" : "";
	console.log(
		`  ${t.sipTrunkId}  ${t.name}  →  ${t.address}  numbers=[${t.numbers.join(", ")}]  auth=${t.authUsername || "none"}${active}`,
	);
}

console.log("── LiveKit inbound trunks");
for (const t of await sip.listSipInboundTrunk()) {
	console.log(`  ${t.sipTrunkId}  ${t.name}  numbers=[${t.numbers.join(", ")}]`);
}

console.log("── LiveKit dispatch rules");
for (const r of await sip.listSipDispatchRule()) {
	console.log(`  ${r.sipDispatchRuleId}  ${r.name}  trunks=[${r.trunkIds.join(", ")}]`);
}

const telnyxKey = process.env.TELNYX_API_KEY;
if (!telnyxKey) {
	console.log("── Telnyx: TELNYX_API_KEY not set, skipping carrier-side check");
	process.exit(0);
}

const telnyx = async (path: string) => {
	const res = await fetch(`https://api.telnyx.com/v2${path}`, {
		headers: { Authorization: `Bearer ${telnyxKey}` },
	});
	if (!res.ok) throw new Error(`Telnyx GET ${path} → ${res.status}: ${await res.text()}`);
	return (await res.json()) as { data: Record<string, unknown>[] };
};

console.log("── Telnyx SIP connections (credential)");
const conns = await telnyx("/credential_connections");
for (const c of conns.data) {
	console.log(
		`  ${c.id}  ${c.connection_name}  user=${c.user_name}  active=${c.active}  outbound_profile=${
			(c.outbound as Record<string, unknown> | undefined)?.outbound_voice_profile_id ?? "NONE"
		}`,
	);
}
console.log("── Telnyx FQDN connections");
const fqdns = await telnyx("/fqdn_connections");
for (const c of fqdns.data) {
	console.log(
		`  ${c.id}  ${c.connection_name}  active=${c.active}  outbound_profile=${
			(c.outbound as Record<string, unknown> | undefined)?.outbound_voice_profile_id ?? "NONE"
		}`,
	);
}

console.log("── Telnyx outbound voice profiles");
const profiles = await telnyx("/outbound_voice_profiles");
for (const p of profiles.data) {
	console.log(
		`  ${p.id}  ${p.name}  enabled=${p.enabled}  traffic_type=${p.traffic_type}  service_plan=${p.service_plan}`,
	);
}

console.log("── Telnyx numbers");
const numbers = await telnyx("/phone_numbers");
for (const n of numbers.data) {
	console.log(`  ${n.phone_number}  status=${n.status}  connection=${n.connection_name ?? n.connection_id ?? "NONE"}`);
}
