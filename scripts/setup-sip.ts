import { SIPTransport } from "@livekit/protocol";
import { RoomAgentDispatch, RoomConfiguration, SipClient } from "livekit-server-sdk";
import { env } from "../src/env.js";

/**
 * One-time LiveKit SIP setup — carrier-agnostic (Twilio Elastic SIP, Telnyx,
 * or any SIP trunk). Idempotent by name.
 *
 * TWILIO prereqs (console → Elastic SIP Trunking):
 *   1. Create a Trunk. Under Termination, pick a URI (e.g. noba.pstn.twilio.com)
 *      and attach a Credential List (username/password).
 *   2. Under Origination, add: sip:<project>.sip.livekit.cloud;transport=tcp
 *   3. Buy a number and assign it to the trunk (Numbers section of the trunk).
 *   Usage:
 *     SIP_NUMBER=+1... SIP_ADDRESS=noba.pstn.twilio.com \
 *     SIP_USERNAME=... SIP_PASSWORD=... pnpm tsx scripts/setup-sip.ts
 *
 * TELNYX prereqs: SIP Connection (FQDN <project>.sip.livekit.cloud, TCP) with
 *   credentials + Outbound Voice Profile; number assigned to it.
 *   Usage: same, with SIP_ADDRESS=sip.telnyx.com (the default).
 *
 * Prints LIVEKIT_SIP_OUTBOUND_TRUNK_ID for the gateway .env.
 */

const NUMBER = process.env.SIP_NUMBER ?? process.env.TELNYX_NUMBER;
const SIP_USERNAME = process.env.SIP_USERNAME ?? process.env.TELNYX_SIP_USERNAME;
const SIP_PASSWORD = process.env.SIP_PASSWORD ?? process.env.TELNYX_SIP_PASSWORD;
const SIP_ADDRESS = process.env.SIP_ADDRESS ?? process.env.TELNYX_SIP_ADDRESS ?? "sip.telnyx.com";
const AGENT_NAME = process.env.LIVEKIT_AGENT_NAME ?? "voice-agent";

if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
	console.error("Set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env first.");
	process.exit(1);
}
if (!NUMBER || !SIP_USERNAME || !SIP_PASSWORD) {
	console.error(
		"Usage: TELNYX_NUMBER=+1... TELNYX_SIP_USERNAME=... TELNYX_SIP_PASSWORD=... pnpm tsx scripts/setup-sip.ts",
	);
	process.exit(1);
}

const sip = new SipClient(
	env.LIVEKIT_URL.replace(/^wss:/, "https:"),
	env.LIVEKIT_API_KEY,
	env.LIVEKIT_API_SECRET,
);

// ---------------------------------------------------------------- outbound trunk
const outboundName = "voice-engine-outbound";
let outbound = (await sip.listSipOutboundTrunk()).find((t) => t.name === outboundName);
if (!outbound) {
	outbound = await sip.createSipOutboundTrunk(outboundName, SIP_ADDRESS, [NUMBER], {
		transport: SIPTransport.SIP_TRANSPORT_UDP,
		authUsername: SIP_USERNAME,
		authPassword: SIP_PASSWORD,
	});
	console.log(`✅ outbound trunk created: ${outbound.sipTrunkId}`);
} else {
	console.log(`✓ outbound trunk exists: ${outbound.sipTrunkId}`);
}

// ---------------------------------------------------------------- inbound trunk
const inboundName = "voice-engine-inbound";
let inbound = (await sip.listSipInboundTrunk()).find((t) => t.name === inboundName);
if (!inbound) {
	inbound = await sip.createSipInboundTrunk(inboundName, [NUMBER], {
		krispEnabled: true,
	});
	console.log(`✅ inbound trunk created: ${inbound.sipTrunkId}`);
} else {
	console.log(`✓ inbound trunk exists: ${inbound.sipTrunkId}`);
}

// ---------------------------------------------------------------- dispatch rule
const ruleName = "voice-agent-inbound";
const rules = await sip.listSipDispatchRule();
let rule = rules.find((r) => r.name === ruleName);
if (!rule) {
	rule = await sip.createSipDispatchRule(
		{ type: "individual", roomPrefix: "call-in" },
		{
			name: ruleName,
			trunkIds: [inbound.sipTrunkId],
			roomConfig: new RoomConfiguration({
				agents: [
					new RoomAgentDispatch({
						agentName: AGENT_NAME,
						metadata: JSON.stringify({ inbound: true }),
					}),
				],
			}),
		},
	);
	console.log(`✅ dispatch rule created: ${rule.sipDispatchRuleId}`);
} else {
	console.log(`✓ dispatch rule exists: ${rule.sipDispatchRuleId}`);
}

const sipHost = new URL(env.LIVEKIT_URL.replace(/^wss:/, "https:")).host.replace(
	/\.livekit\.cloud$/,
	".sip.livekit.cloud",
);

console.log(`
──────────────────────────────────────────────────────
Add to voice-gateway .env:

  LIVEKIT_SIP_OUTBOUND_TRUNK_ID="${outbound.sipTrunkId}"

Carrier side (confirm in the portal):
  • Twilio: trunk Origination URI = sip:${sipHost};transport=tcp
  • Telnyx: SIP Connection FQDN = ${sipHost} (TCP)
  • Number ${NUMBER} assigned to the trunk/connection

Then register the number with the engine:
  curl -X POST http://localhost:8787/v1/numbers \\
    -H "Authorization: Bearer <vk_live_key>" -H 'Content-Type: application/json' \\
    -d '{"e164":"${NUMBER}","inbound_agent_id":"agt_…"}'
──────────────────────────────────────────────────────`);
process.exit(0);
