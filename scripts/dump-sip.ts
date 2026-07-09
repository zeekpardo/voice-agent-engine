import { SipClient } from "livekit-server-sdk";
import { env } from "../src/env.js";

/** Full JSON dump of LiveKit SIP config — trunks + dispatch rules. Read-only. */
const sip = new SipClient(
	env.LIVEKIT_URL!.replace(/^wss:/, "https:"),
	env.LIVEKIT_API_KEY!,
	env.LIVEKIT_API_SECRET!,
);
console.log("── inbound trunks");
for (const t of await sip.listSipInboundTrunk()) console.log(JSON.stringify(t, null, 1));
console.log("── dispatch rules");
for (const r of await sip.listSipDispatchRule()) console.log(JSON.stringify(r, null, 1));
