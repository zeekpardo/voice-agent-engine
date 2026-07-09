/**
 * Smoke-test helper: joins a gateway web session as a silent participant so
 * the worker job dispatches (rooms only spin up when someone joins). Watches
 * for the agent to publish audio, then leaves.
 *
 *   pnpm tsx scripts/join-test.ts <vk_key> <agent_id>
 */
import { Room, RoomEvent } from "../node_modules/.pnpm/@livekit+rtc-node@0.13.30/node_modules/@livekit/rtc-node/dist/index.js";

const [key, agentId] = process.argv.slice(2);
if (!key || !agentId) {
	console.error("usage: tsx scripts/join-test.ts <vk_key> <agent_id>");
	process.exit(1);
}

const res = await fetch("http://localhost:8787/v1/sessions", {
	method: "POST",
	headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
	body: JSON.stringify({ agent_id: agentId }),
});
const session = (await res.json()) as { call_id: string; room_url: string; token: string };
console.log("call:", session.call_id);

const room = new Room();
let sawAgentAudio = false;
room.on(RoomEvent.TrackSubscribed, (_track, _pub, participant) => {
	console.log("agent audio track received from", participant.identity);
	sawAgentAudio = true;
});
room.on(RoomEvent.ParticipantConnected, (p) => console.log("participant joined:", p.identity));

await room.connect(session.room_url, session.token, { autoSubscribe: true, dynacast: false });
console.log("joined room, waiting 20s for agent...");
await new Promise((r) => setTimeout(r, 20_000));
console.log(sawAgentAudio ? "RESULT: agent published audio (greeting spoken)" : "RESULT: no agent audio seen");
await room.disconnect();
process.exit(0);
