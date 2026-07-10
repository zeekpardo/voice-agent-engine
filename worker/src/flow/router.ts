import { llm } from "@livekit/agents";
import { reportEvent } from "../gateway.js";
import { invokeTool } from "../tools.js";
import type { FlowRuntimeContext } from "./context.js";
import type { ResolvedTarget } from "./objectives.js";

/**
 * Router-node evaluation and the exit-target chain (spec §7).
 *
 * resolveTarget follows an exit's target through any router / statement /
 * set_field / modify_tags / transfer nodes until it reaches the first AGENT
 * node (or the end / a transfer). None of these node kinds ever become agents:
 *
 *  - router:      one standalone LLM evaluation over the transcript picks an
 *                 exit; the fallback ("otherwise"/"none"/"default", else the
 *                 last exit) is used on a miss or evaluation error.
 *  - statement:   speaks its fixed line (queued on the session) and continues
 *                 to its single exit — or, with no exit target, ends the call
 *                 once the line finishes playing.
 *  - set_field /
 *    modify_tags: fire the CRM webhook(s) silently and continue.
 *  - transfer:    handed back to the caller as { kind: "transfer" } so the
 *                 detached transfer sequence can run.
 *
 * The chain is bounded to 5 hops so a misconfigured graph can't wedge a call.
 */
export interface Router {
	resolveTarget(targetId: string | undefined): Promise<ResolvedTarget>;
}

export function createRouter(ctx: FlowRuntimeContext): Router {
	const { nodesById, dispatch } = ctx;

	const resolveTarget = async (targetId: string | undefined): Promise<ResolvedTarget> => {
		let current = targetId;
		let hops = 0;
		while (current) {
			const node = nodesById.get(current);
			if (!node) throw new Error(`flow node "${current}" not found`);
			if (
				node.kind !== "router" &&
				node.kind !== "statement" &&
				node.kind !== "transfer" &&
				node.kind !== "set_field" &&
				node.kind !== "modify_tags"
			) {
				return { kind: "agent", id: current };
			}
			if (++hops > 5) {
				console.error(`flow: node chain exceeded 5 hops at node "${node.id}" — ending call`);
				return { kind: "end" };
			}

			if (node.kind === "transfer") {
				// Handled by the transfer module as a detached timed sequence — never
				// inline: the announcement/music must play out AFTER the current
				// tool turn completes, and the agent switch must not ride a
				// tool-returned handoff (the SDK drops it in mixed-tool turns).
				return { kind: "transfer", nodeId: node.id };
			}

			// Deterministic CRM action nodes: fire the webhook(s) silently and
			// continue to the single exit — they never speak or wait.
			if (node.kind === "set_field") {
				reportEvent(dispatch.callId, "flow.node", {
					node: node.id,
					name: node.name ?? null,
					kind: "set_field",
				});
				const sf = node.setField;
				if (sf?.field && ctx.updateContactDef) {
					void invokeTool(ctx.updateContactDef, dispatch, {
						field_name: sf.field,
						value: ctx.interpolate(sf.value ?? ""),
					}).catch((err) => console.error(`flow: set_field "${sf.field}" failed`, err));
				}
				const exit = node.exits[0];
				reportEvent(dispatch.callId, "flow.exit", {
					node: node.id,
					exit: exit?.name ?? "end",
					target: exit?.target ?? null,
				});
				current = exit?.target;
				continue;
			}

			if (node.kind === "modify_tags") {
				reportEvent(dispatch.callId, "flow.node", {
					node: node.id,
					name: node.name ?? null,
					kind: "modify_tags",
				});
				const add = node.modifyTags?.add ?? [];
				if (add.length > 0 && ctx.addTagDef) {
					for (const tag of add) {
						void invokeTool(ctx.addTagDef, dispatch, { tag }).catch((err) =>
							console.error(`flow: modify_tags add "${tag}" failed`, err),
						);
					}
				}
				if ((node.modifyTags?.remove ?? []).length > 0) {
					console.warn(
						`flow: modify_tags node "${node.id}" requested tag removal, which is not wired yet`,
					);
				}
				const exit = node.exits[0];
				reportEvent(dispatch.callId, "flow.exit", {
					node: node.id,
					exit: exit?.name ?? "end",
					target: exit?.target ?? null,
				});
				current = exit?.target;
				continue;
			}

			if (node.kind === "statement") {
				reportEvent(dispatch.callId, "flow.node", {
					node: node.id,
					name: node.name ?? null,
					kind: "statement",
				});
				const handle = ctx.session.say(ctx.interpolateSpoken(node.statement?.say ?? ""));
				const exit = node.exits[0];
				reportEvent(dispatch.callId, "flow.exit", {
					node: node.id,
					exit: exit?.name ?? "end",
					target: exit?.target ?? null,
				});
				if (!exit?.target) {
					// Terminal statement: hang up once the line finishes playing.
					// NOT awaited — awaiting a queued speech's playout from inside
					// a tool execution risks the drain deadlock (see onEnter note).
					handle
						.waitForPlayout()
						.then(() => ctx.hangUp("flow_complete"))
						.catch((err) => console.error("flow: terminal statement playout failed", err));
					return { kind: "end_after_speech" };
				}
				current = exit.target;
				continue;
			}

			reportEvent(dispatch.callId, "flow.node", {
				node: node.id,
				name: node.name ?? null,
				kind: "router",
			});

			const fallbackExit =
				node.exits.find((e) => ["otherwise", "none", "default"].includes(e.name.toLowerCase())) ??
				node.exits[node.exits.length - 1]!;
			const transcript = ctx.turns
				.filter((t) => t.role !== "system")
				.slice(-40)
				.map((t) => `${t.role === "user" ? "caller" : "agent"}: ${t.text}`)
				.join("\n");

			const evalCtx = new llm.ChatContext();
			evalCtx.addMessage({
				role: "system",
				content:
					"You are routing a phone call. Given the conversation transcript, evaluate the statement/question and answer with EXACTLY one option name from the list — the option name only, nothing else.",
			});
			evalCtx.addMessage({
				role: "user",
				content: `Statement/question: ${node.router?.condition ?? ""}\n\nOptions:\n${node.exits
					.map((e) => `- ${e.name}: ${e.description}`)
					.join("\n")}\n\nConversation transcript:\n${transcript}`,
			});

			let chosen = fallbackExit;
			let decision = "";
			try {
				const evalLlm = node.llm ? ctx.buildLlm(node.llm) : ctx.defaultLlm;
				const res = await evalLlm.chat({ chatCtx: evalCtx }).collect();
				decision = res.text.trim();
				const lower = decision.toLowerCase();
				chosen =
					node.exits.find((e) => e.name.toLowerCase() === lower) ??
					node.exits.find((e) => lower.includes(e.name.toLowerCase())) ??
					fallbackExit;
			} catch (err) {
				console.error(`flow: router node "${node.id}" evaluation failed, using fallback exit`, err);
				decision = "evaluation_error";
			}
			reportEvent(dispatch.callId, "flow.exit", {
				node: node.id,
				exit: chosen.name,
				target: chosen.target ?? null,
				decision: decision.slice(0, 200),
			});
			current = chosen.target;
		}
		return { kind: "end" };
	};

	return { resolveTarget };
}
