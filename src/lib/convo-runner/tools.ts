import { signPayload } from "@voice-engine/shared/hmac";
import { assertSafeUrl } from "../safe-url.js";
import type { ToolDef, TurnContext } from "./types.js";

/**
 * Write-tool layer for the turn-runner — the gateway-side mirror of the
 * worker's tools.ts invokeTool. Objective field writes, set_field and
 * modify_tags nodes all POST to the consuming app's webhook endpoint, signed
 * with the per-tool secret using the SAME canonical HMAC scheme
 * (@voice-engine/shared/hmac — the gateway CAN import the workspace package,
 * unlike the worker which vendors it). Body shape is identical to the worker's
 * so a consuming app's tool handler treats a text turn exactly like a voice one.
 *
 * ENGINE NEUTRALITY: which tool performs a write is resolved from config ids
 * (fieldWriteToolId / tagWriteToolId / tagRemoveToolId), never a hardcoded CRM
 * tool name. v1 exposes NO model-callable tools — only these engine-initiated
 * deterministic writes.
 */

/** Match a config tool id/name against ToolDef.name, then ToolDef.id (worker parity). */
export function resolveToolDef(
	tools: ToolDef[],
	idOrName: string | undefined,
	fallbackIdOrName?: string,
): ToolDef | undefined {
	const pick = (needle: string | undefined): ToolDef | undefined => {
		if (!needle) return undefined;
		return tools.find((t) => t.name === needle) ?? tools.find((t) => t.id === needle);
	};
	return pick(idOrName) ?? pick(fallbackIdOrName);
}

/**
 * Signed POST to a tool's webhook endpoint. Fire-and-forget semantics like the
 * worker's engine-initiated writes: throws on failure, callers log + continue —
 * a turn never blocks a reply on a CRM webhook. Records tool.invoked /
 * tool.failed events on the conversation.
 */
export async function invokeWriteTool(t: ToolDef, ctx: TurnContext, args: Record<string, unknown>): Promise<void> {
	const body = JSON.stringify({
		tool: t.name,
		call_id: ctx.conversationId,
		agent_id: ctx.agentId,
		metadata: ctx.metadata,
		arguments: args,
	});
	const ts = Math.floor(Date.now() / 1000).toString();
	ctx.events.push({ type: "tool.invoked", payload: { tool: t.name, arguments: args } });

	try {
		// SSRF re-check at fetch time: re-validate the tool's stored endpoint host
		// before dialing out (defends rows written before the create-time guard).
		// FOLLOW-UP: validates the literal host, not the resolved socket — full DNS-
		// rebinding protection needs a pinned-lookup fetch agent.
		assertSafeUrl(t.endpoint_url);
		const res = await fetch(t.endpoint_url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Voice-Timestamp": ts,
				"X-Voice-Signature": `hmac-sha256=${signPayload(t.secret, ts, body)}`,
			},
			body,
			signal: AbortSignal.timeout(t.timeout_ms),
		});
		if (!res.ok) throw new Error(`tool endpoint returned ${res.status}`);
	} catch (err) {
		ctx.events.push({
			type: "tool.failed",
			payload: { tool: t.name, error: err instanceof Error ? err.message : String(err) },
		});
		throw err;
	}
}
