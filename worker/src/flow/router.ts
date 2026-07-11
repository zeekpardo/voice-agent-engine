import { llm } from "@livekit/agents";
import { z } from "zod";
import { reportEvent } from "../gateway.js";
import { invokeTool } from "../tools.js";
import { type FlowRuntimeContext, tagRulesSatisfied, upsertContactState } from "./context.js";
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
 *    modify_tags: fire the config-designated write tool(s) silently and continue.
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
				node.kind !== "modify_tags" &&
				node.kind !== "handoff"
			) {
				return { kind: "agent", id: current };
			}
			if (++hops > 5) {
				console.error(`flow: node chain exceeded 5 hops at node "${node.id}" — ending call`);
				return { kind: "end" };
			}

			if (node.kind === "handoff") {
				// Hand the live call off to a DIFFERENT published agent (flow/handoff
				// does the fetch + entry-agent build + session swap). Resolved inline
				// like transfer: the agent switch can't ride a tool-returned handoff in
				// a mixed-tool turn, so the caller does the detached swap. Terminal for
				// this flow (schema-guarded: no exits) — the chain stops here.
				if (!node.handoffAgentId) {
					console.error(`flow: handoff node "${node.id}" has no handoffAgentId — ending call`);
					return { kind: "end" };
				}
				return {
					kind: "handoff",
					agentId: node.handoffAgentId,
					fromNode: node.id,
					transition: node.handoff,
				};
			}

			if (node.kind === "transfer") {
				// Handled by the transfer module as a detached timed sequence — never
				// inline: the announcement/music must play out AFTER the current
				// tool turn completes, and the agent switch must not ride a
				// tool-returned handoff (the SDK drops it in mixed-tool turns).
				return { kind: "transfer", nodeId: node.id };
			}

			// Deterministic write-action nodes: fire the configured tool(s) silently and
			// continue to the single exit — they never speak or wait.
			if (node.kind === "set_field") {
				reportEvent(dispatch.callId, "flow.node", {
					node: node.id,
					name: node.name ?? null,
					kind: "set_field",
				});
				const sf = node.setField;
				// Config-driven: the node may name its own write tool; otherwise the
				// config's designated field-write tool is used (engine neutrality).
				const fieldWriteDef = ctx.resolveToolDef(sf?.toolId, ctx.fieldWriteDef);
				if (sf?.field && fieldWriteDef) {
					const written = ctx.interpolate(sf.value ?? "");
					// Reflect the write into the in-memory contactState so a later
					// node's prompt shows the value instead of UNRESOLVED (Phase 1).
					upsertContactState(ctx.contactState, sf.field, written);
					void invokeTool(fieldWriteDef, dispatch, {
						field_name: sf.field,
						value: written,
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
				const remove = node.modifyTags?.remove ?? [];
				const tagWriteDef = ctx.resolveToolDef(node.modifyTags?.toolId, ctx.tagWriteDef);
				if (add.length > 0) {
					for (const tag of add) {
						// Update the in-memory tag set (Phase 5b) regardless of whether a
						// write tool is registered — exit gating is deterministic and local.
						ctx.contactTags.add(tag);
						if (tagWriteDef) {
							void invokeTool(tagWriteDef, dispatch, { tag }).catch((err) =>
								console.error(`flow: modify_tags add "${tag}" failed`, err),
							);
						}
					}
				}
				// Tag removal (Phase 5b): invoke the config-designated removal tool
				// (config.tagRemoveToolId) and prune the in-memory tag set.
				if (remove.length > 0) {
					const tagRemoveDef = ctx.tagRemoveDef;
					for (const tag of remove) {
						ctx.contactTags.delete(tag);
						if (tagRemoveDef) {
							void invokeTool(tagRemoveDef, dispatch, { tag }).catch((err) =>
								console.error(`flow: modify_tags remove "${tag}" failed`, err),
							);
						} else {
							console.warn(
								`flow: modify_tags node "${node.id}" wants to remove "${tag}" but no removal tool (config.tagRemoveToolId) is registered`,
							);
						}
					}
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

			// Tag-gated exits (Phase 5b) are skipped as router target candidates.
			// Fall back to the full list only if gating leaves nothing to pick.
			const availableExits = node.exits.filter((e) => tagRulesSatisfied(e.tagRules, ctx.contactTags));
			if (availableExits.length < node.exits.length) {
				reportEvent(dispatch.callId, "flow.exits_gated", {
					node: node.id,
					gated: node.exits.filter((e) => !tagRulesSatisfied(e.tagRules, ctx.contactTags)).map((e) => e.name),
				});
			}
			const routableExits = availableExits.length > 0 ? availableExits : node.exits;
			const fallbackExit =
				routableExits.find((e) => ["otherwise", "none", "default"].includes(e.name.toLowerCase())) ??
				routableExits[routableExits.length - 1]!;
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
				content: `Statement/question: ${node.router?.condition ?? ""}\n\nOptions:\n${routableExits
					.map((e) => `- ${e.name}: ${e.description}`)
					.join("\n")}\n\nConversation transcript:\n${transcript}`,
			});

			// Resolve a raw LLM reply to a listed exit — the same lenient match the
			// router has always used (exact name, then substring), extracted so both
			// the zod refinement and the final pick share one definition.
			const matchExit = (text: string) => {
				const lower = text.trim().toLowerCase();
				return (
					routableExits.find((e) => e.name.toLowerCase() === lower) ??
					routableExits.find((e) => lower.includes(e.name.toLowerCase()))
				);
			};
			// Structured-output validation (audit Tier 1 #6): validate that the
			// decision names one of the listed options. Previously an unlisted reply
			// silently fell to the fallback exit with no trace. Now: one corrective
			// retry, then the deterministic fallback (existing behavior) — but the
			// unlisted attempts are logged so mis-routes are visible.
			const decisionSchema = z
				.string()
				.transform((s) => s.trim())
				.refine((s) => s.length > 0 && matchExit(s) !== undefined, "decision does not name a listed option");
			let chosen = fallbackExit;
			let decision = "";
			// Router tier (Phase 4): a DEDICATED instance (never the shared defaultLlm)
			// so this standalone evaluation's tokens are metered as "router" and never
			// double-counted by the session's responder MetricsCollected. node.llm
			// override wins; else config.models.router, else config.llm.model.
			const evalLlm = node.llm ? ctx.buildLlm(node.llm) : ctx.buildLlm({ model: ctx.models.router });
			for (let attempt = 0; attempt < 2; attempt++) {
				// Corrective retry stays OFF the speech path (router eval is a standalone
				// background pass). The nudge matches the router's option-name contract —
				// this node expects a bare option name, not JSON.
				if (attempt > 0) {
					evalCtx.addMessage({
						role: "user",
						content:
							"Your last reply did not name one of the listed options. Reply with EXACTLY one option name from the list — the option name only, nothing else.",
					});
				}
				try {
					const res = await evalLlm.chat({ chatCtx: evalCtx }).collect();
					ctx.recordUsage("router", res.usage?.promptTokens ?? 0, res.usage?.completionTokens ?? 0);
					decision = res.text.trim();
					const validated = decisionSchema.safeParse(decision);
					if (validated.success) {
						chosen = matchExit(validated.data)!;
						break;
					}
					console.error(
						`flow: router node "${node.id}" returned an unlisted option (attempt ${attempt + 1}): ${decision.slice(0, 120)}`,
					);
				} catch (err) {
					// A thrown LLM/transport error won't fix on retry — fall straight to
					// the deterministic fallback exit (unchanged behavior).
					console.error(`flow: router node "${node.id}" evaluation failed, using fallback exit`, err);
					decision = "evaluation_error";
					break;
				}
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
