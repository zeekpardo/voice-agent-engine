import { createHmac } from "node:crypto";
import { llm } from "@livekit/agents";
import type { JSONSchema7 } from "json-schema";
import type { DispatchMetadata, ToolDef } from "./gateway.js";
import { reportEvent } from "./gateway.js";

/**
 * Tools-as-webhooks (spec §8): each gateway-registered tool becomes an LLM
 * function tool whose execute() POSTs to the consuming app's endpoint, signed
 * with the per-tool secret. The engine runs no business logic.
 */

function sign(secret: string, timestamp: string, body: string): string {
	return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

type JSONValue = null | string | number | boolean | JSONValue[] | { [key: string]: JSONValue };

/**
 * Signed POST to a tool's webhook endpoint. Shared by the LLM-facing function
 * tools below and engine-initiated invocations (objective auto-writes), so
 * both paths emit the same events and signature. Throws on failure.
 */
export async function invokeTool(
	t: ToolDef,
	dispatch: DispatchMetadata,
	args: unknown,
): Promise<JSONValue> {
	const body = JSON.stringify({
		tool: t.name,
		call_id: dispatch.callId,
		agent_id: dispatch.agentId,
		metadata: dispatch.metadata,
		arguments: args ?? {},
	});
	const ts = Math.floor(Date.now() / 1000).toString();
	reportEvent(dispatch.callId, "tool.invoked", { tool: t.name, arguments: args ?? {} });

	try {
		const res = await fetch(t.endpoint_url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Voice-Timestamp": ts,
				"X-Voice-Signature": `hmac-sha256=${sign(t.secret, ts, body)}`,
			},
			body,
			signal: AbortSignal.timeout(t.timeout_ms),
		});
		if (!res.ok) throw new Error(`tool endpoint returned ${res.status}`);
		const data = (await res.json()) as { result?: unknown };
		return (data.result ?? data) as JSONValue;
	} catch (err) {
		reportEvent(dispatch.callId, "tool.failed", {
			tool: t.name,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

export function buildTools(
	tools: ToolDef[],
	dispatch: DispatchMetadata,
): Record<string, ReturnType<typeof llm.tool>> {
	const out: Record<string, ReturnType<typeof llm.tool>> = {};

	for (const t of tools) {
		out[t.name] = llm.tool({
			description: t.description,
			parameters: t.json_schema as JSONSchema7,
			execute: async (args: unknown) => {
				try {
					const result = await invokeTool(t, dispatch, args);
					// Fire-and-forget writes: a {silent: true} result becomes NO tool
					// output, so the SDK skips the post-tool continuation generation
					// (replyRequired = output !== undefined). Without this, every
					// mid-speech CRM write triggered a second generation that
					// re-spoke the agent's question.
					if (
						result !== null &&
						typeof result === "object" &&
						!Array.isArray(result) &&
						(result as { silent?: boolean }).silent === true
					) {
						return undefined;
					}
					return result;
				} catch {
					// Tell the LLM the tool failed so the agent can recover verbally
					// ("let me have someone follow up on that") — spec §8.
					return {
						error: "tool_failed",
						message:
							"The tool could not be reached. Apologize briefly and offer to follow up. Do NOT repeat your last question.",
					};
				}
			},
		});
	}

	return out;
}
