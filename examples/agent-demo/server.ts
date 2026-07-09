import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Voice agent demo server — the "consuming app" in miniature.
 * Serves the demo page and proxies POST /session → gateway /v1/sessions,
 * holding the vk_live_ key server-side (the browser never sees it).
 *
 * Usage:
 *   GATEWAY_URL=http://localhost:8787 GATEWAY_KEY=vk_live_… AGENT_ID=agt_… \
 *     pnpm tsx examples/agent-demo/server.ts
 */
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8787";
const GATEWAY_KEY = process.env.GATEWAY_KEY ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "";
const PORT = Number(process.env.DEMO_PORT ?? 8890);

if (!GATEWAY_KEY || !AGENT_ID) {
	console.error("Set GATEWAY_KEY (vk_live_…) and AGENT_ID (agt_…) env vars.");
	process.exit(1);
}

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.html"));

createServer(async (req, res) => {
	if (req.method === "POST" && req.url === "/session") {
		try {
			const upstream = await fetch(`${GATEWAY_URL}/v1/sessions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${GATEWAY_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					agent_id: AGENT_ID,
					variables: { caller_name: "Demo Visitor" },
					metadata: { source: "agent-demo" },
				}),
			});
			res.writeHead(upstream.status, { "Content-Type": "application/json" });
			res.end(await upstream.text());
		} catch (err) {
			res.writeHead(502, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: String(err) } }));
		}
		return;
	}
	res.writeHead(200, { "Content-Type": "text/html" });
	res.end(html);
}).listen(PORT, () => {
	console.log(`🎧 agent demo on http://localhost:${PORT} (agent ${AGENT_ID})`);
});
