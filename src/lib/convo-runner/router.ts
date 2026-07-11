import { interpolate } from "@voice-engine/shared/agent-config";
import { chatComplete } from "../llm.js";
import { resolveToolDef } from "./tools.js";
import { invokeWriteTool } from "./tools.js";
import { type ResolvedTarget, recordUsage, type TurnContext } from "./types.js";
import { tagRulesSatisfied, upsertContactState } from "./util.js";

/**
 * Exit-target resolution for the turn-runner — the gateway-side port of the
 * worker's flow/router.ts resolveTarget. Follows an exit's target through
 * router / statement / set_field / modify_tags nodes until it reaches the first
 * AGENT node (or the end). Statement `say` lines encountered along the way are
 * collected into `saySoFar` and become part of the turn's reply.
 *
 * handoff / transfer nodes are NOT supported in v1: reaching one resolves to
 * `{ kind: "unsupported" }`, and the orchestrator ends the conversation with a
 * conversation.unsupported_node event. The chain is bounded to 5 hops so a
 * misconfigured graph can't wedge a turn.
 */
export async function resolveTarget(ctx: TurnContext, targetId: string | undefined): Promise<ResolvedTarget> {
	const saySoFar: string[] = [];
	let current = targetId;
	let hops = 0;

	while (current) {
		const node = ctx.nodesById.get(current);
		if (!node) throw new Error(`flow node "${current}" not found`);

		if (
			node.kind !== "router" &&
			node.kind !== "statement" &&
			node.kind !== "set_field" &&
			node.kind !== "modify_tags" &&
			node.kind !== "handoff" &&
			node.kind !== "transfer"
		) {
			return { kind: "agent", id: current, saySoFar };
		}
		if (++hops > 5) {
			ctx.events.push({ type: "conversation.chain_overflow", payload: { node: node.id } });
			return { kind: "end", saySoFar };
		}

		if (node.kind === "handoff" || node.kind === "transfer") {
			// v1 does not run agent handoffs or transfers over the text turn path.
			return { kind: "unsupported", nodeId: node.id, reason: node.kind, saySoFar };
		}

		if (node.kind === "set_field") {
			const sf = node.setField;
			ctx.events.push({ type: "conversation.node", payload: { node: node.id, kind: "set_field" } });
			const tool = resolveToolDef(ctx.tools, sf?.toolId, ctx.config.fieldWriteToolId);
			if (sf?.field && tool) {
				const written = interpolate(sf.value ?? "", ctx.state.variables);
				upsertContactState(ctx.state.contactState, sf.field, written);
				await invokeWriteTool(tool, ctx, { field_name: sf.field, value: written }).catch(() => {});
			}
			current = node.exits[0]?.target;
			continue;
		}

		if (node.kind === "modify_tags") {
			ctx.events.push({ type: "conversation.node", payload: { node: node.id, kind: "modify_tags" } });
			const add = node.modifyTags?.add ?? [];
			const remove = node.modifyTags?.remove ?? [];
			const addTool = resolveToolDef(ctx.tools, node.modifyTags?.toolId, ctx.config.tagWriteToolId);
			for (const tag of add) {
				ctx.tagSet.add(tag);
				if (addTool) await invokeWriteTool(addTool, ctx, { tag }).catch(() => {});
			}
			const removeTool = resolveToolDef(ctx.tools, undefined, ctx.config.tagRemoveToolId);
			for (const tag of remove) {
				ctx.tagSet.delete(tag);
				if (removeTool) await invokeWriteTool(removeTool, ctx, { tag }).catch(() => {});
			}
			current = node.exits[0]?.target;
			continue;
		}

		if (node.kind === "statement") {
			ctx.events.push({ type: "conversation.node", payload: { node: node.id, kind: "statement" } });
			const line = interpolate(node.statement?.say ?? "", ctx.state.variables);
			if (line) saySoFar.push(line);
			const exit = node.exits[0];
			if (!exit?.target) return { kind: "end", saySoFar };
			current = exit.target;
			continue;
		}

		// router: one LLM evaluation over the transcript picks an exit.
		ctx.events.push({ type: "conversation.node", payload: { node: node.id, kind: "router" } });
		const availableExits = node.exits.filter((e) => tagRulesSatisfied(e.tagRules, ctx.tagSet));
		const routableExits = availableExits.length > 0 ? availableExits : node.exits;
		const fallbackExit =
			routableExits.find((e) => ["otherwise", "none", "default"].includes(e.name.toLowerCase())) ??
			routableExits[routableExits.length - 1]!;
		const transcript = ctx.turns
			.filter((t) => t.role !== "system")
			.slice(-40)
			.map((t) => `${t.role === "user" ? "person" : "agent"}: ${t.text}`)
			.join("\n");

		const matchExit = (text: string) => {
			const lower = text.trim().toLowerCase();
			return (
				routableExits.find((e) => e.name.toLowerCase() === lower) ??
				routableExits.find((e) => lower.includes(e.name.toLowerCase()))
			);
		};

		let chosen = fallbackExit;
		let decision = "";
		const routerModel = node.llm?.model ?? ctx.config.models?.router ?? ctx.config.llm.model;
		try {
			const res = await chatComplete({
				model: routerModel,
				temperature: node.llm?.temperature ?? 0,
				maxTokens: 20,
				messages: [
					{
						role: "system",
						content:
							"You are routing a conversation. Given the transcript, evaluate the statement/question and answer with EXACTLY one option name from the list — the option name only, nothing else.",
					},
					{
						role: "user",
						content: `Statement/question: ${node.router?.condition ?? ""}\n\nOptions:\n${routableExits
							.map((e) => `- ${e.name}: ${e.description}`)
							.join("\n")}\n\nConversation transcript:\n${transcript}`,
					},
				],
			});
			recordUsage(ctx.state, "router", res.usage.promptTokens, res.usage.completionTokens);
			decision = res.text.trim();
			chosen = matchExit(decision) ?? fallbackExit;
		} catch (err) {
			decision = "evaluation_error";
			ctx.events.push({ type: "conversation.router_error", payload: { node: node.id, error: err instanceof Error ? err.message : String(err) } });
		}
		ctx.events.push({
			type: "conversation.exit",
			payload: { node: node.id, exit: chosen.name, target: chosen.target ?? null, decision: decision.slice(0, 120) },
		});
		current = chosen.target;
	}

	return { kind: "end", saySoFar };
}
