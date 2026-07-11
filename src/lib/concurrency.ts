import { sql } from "../db/index.js";
import { env } from "../env.js";

/**
 * Per-tenant concurrency limiting for calls (multi-account plan §2). Enforces
 * concurrent-call caps at the three call-birth choke points (outbound dispatch,
 * inbound resolution, web session). Three scopes stack: `project` (per engine
 * project), `agent` (per agent id), `group` (per opaque group_ref tenant tag).
 *
 * A live call is one with status IN ('dialing','active') — a call that has left
 * the queue and is holding (or about to hold) a media session. Turn-based text
 * conversations carry no concurrency cost and are NOT counted here.
 *
 * Limits live in the `concurrency_limits` table (one row per project+scope+ref);
 * absence of a row means unlimited for that scope, except `project` which falls
 * back to the DEFAULT_MAX_CONCURRENT_CALLS env. Limit rows are cached in-process
 * for 30s (invalidated on write via the /v1/limits admin route).
 */

export type Scope = "project" | "agent" | "group";

export interface CapacityCheck {
	allowed: boolean;
	/** The scope that is at capacity (only set when `allowed` is false). */
	blockedBy?: Scope;
	/** Live-call count for the reported scope. */
	current: number;
	/** The cap for the reported scope, or null when that scope is unlimited. */
	limit: number | null;
}

interface LimitRow {
	scope: Scope;
	ref: string;
	max_concurrent: number;
}

const CACHE_TTL_MS = 30_000;
const limitsCache = new Map<string, { limits: LimitRow[]; expires: number }>();

async function getLimits(project: string): Promise<LimitRow[]> {
	const hit = limitsCache.get(project);
	if (hit && hit.expires > Date.now()) return hit.limits;
	const rows = await sql<{ scope: Scope; ref: string; max_concurrent: number }[]>`
		SELECT scope, ref, max_concurrent FROM concurrency_limits WHERE project = ${project}`;
	const limits = rows.map((r) => ({ scope: r.scope, ref: r.ref, max_concurrent: Number(r.max_concurrent) }));
	limitsCache.set(project, { limits, expires: Date.now() + CACHE_TTL_MS });
	return limits;
}

/** Drop cached limits for a project so the next check re-reads (called on write). */
export function invalidateLimitsCache(project: string): void {
	limitsCache.delete(project);
}

/**
 * Is there capacity to birth a call for {project, agentId, groupRef}? One SQL
 * query counts live calls per scope; limits come from the 30s-cached table +
 * env default. When no scope has a limit, the count query is skipped entirely.
 * The narrowest-blocking scope is reported (project → agent → group order).
 */
export async function checkCapacity(input: {
	project: string;
	agentId: string;
	groupRef?: string | null;
}): Promise<CapacityCheck> {
	const { project, agentId } = input;
	const groupRef = input.groupRef ?? null;

	const limits = await getLimits(project);
	const find = (scope: Scope, ref: string): number | null =>
		limits.find((l) => l.scope === scope && l.ref === ref)?.max_concurrent ?? null;

	const projectLimit = find("project", "") ?? env.DEFAULT_MAX_CONCURRENT_CALLS ?? null;
	const agentLimit = find("agent", agentId);
	const groupLimit = groupRef ? find("group", groupRef) : null;

	// Nothing to enforce — no count query needed.
	if (projectLimit == null && agentLimit == null && groupLimit == null) {
		return { allowed: true, current: 0, limit: null };
	}

	const rows = await sql<
		{ project_current: number; agent_current: number; group_current: number }[]
	>`
		SELECT
			count(*)::int AS project_current,
			count(*) FILTER (WHERE agent_id = ${agentId})::int AS agent_current,
			count(*) FILTER (WHERE group_ref IS NOT DISTINCT FROM ${groupRef})::int AS group_current
		FROM calls
		WHERE project = ${project} AND status IN ('dialing', 'active')`;
	const row = rows[0]!;

	const checks: { scope: Scope; current: number; limit: number | null }[] = [
		{ scope: "project", current: Number(row.project_current), limit: projectLimit },
		{ scope: "agent", current: Number(row.agent_current), limit: agentLimit },
		{ scope: "group", current: Number(row.group_current), limit: groupLimit },
	];
	for (const ch of checks) {
		if (ch.limit != null && ch.current >= ch.limit) {
			return { allowed: false, blockedBy: ch.scope, current: ch.current, limit: ch.limit };
		}
	}
	return { allowed: true, current: Number(row.project_current), limit: projectLimit };
}
