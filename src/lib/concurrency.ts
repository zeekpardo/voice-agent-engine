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
 *
 * DAILY VOLUME (spend backstop): folded into the same admission check. On top of
 * the concurrency scopes, a per-org rolling-24h call-count ceiling is enforced
 * for calls tagged with a `group_ref`. The daily cap comes from the
 * `daily_call_limits` table (project|group scope, same cache pattern) and falls
 * back to DEFAULT_MAX_CALLS_PER_DAY. It is GENEROUS by default and is ONLY
 * checked when group_ref is present, so untagged/legacy calls are never blocked
 * by it. When the daily ceiling is hit, `checkCapacity` reports blockedBy:'daily'
 * with `current`/`limit` set to the 24h count/cap — the exact same reject shape
 * every call site already handles for concurrency (park/429/{rejected}).
 */

export type Scope = "project" | "agent" | "group";
/** What a blocked admission was blocked by: a concurrency scope, or the daily cap. */
export type BlockReason = Scope | "daily";

export interface CapacityCheck {
	allowed: boolean;
	/** What is at capacity (only set when `allowed` is false). */
	blockedBy?: BlockReason;
	/** Live-call count (concurrency block) or 24h call count (daily block). */
	current: number;
	/** The cap for the reported blocker, or null when nothing is enforced. */
	limit: number | null;
}

interface LimitRow {
	scope: Scope;
	ref: string;
	max_concurrent: number;
}

interface DailyLimitRow {
	scope: "project" | "group";
	ref: string;
	max_per_day: number;
}

/** Real placed/attempted calls counted toward the daily ceiling. Excludes
 * 'queued'/'scheduled' (not yet dispatched — a capacity-parked call must NOT
 * count against its own group or it could never drain) and 'canceled' (never
 * dialed, e.g. queue_expired). Mirrors "count calls that actually incurred a
 * dial", the analogue of concurrency's live-call filter. */
const DAILY_COUNTED_STATUSES = ["dialing", "active", "completed", "failed", "no_answer"];

const CACHE_TTL_MS = 30_000;
const limitsCache = new Map<string, { limits: LimitRow[]; expires: number }>();
const dailyLimitsCache = new Map<string, { limits: DailyLimitRow[]; expires: number }>();

async function getLimits(project: string): Promise<LimitRow[]> {
	const hit = limitsCache.get(project);
	if (hit && hit.expires > Date.now()) return hit.limits;
	const rows = await sql<{ scope: Scope; ref: string; max_concurrent: number }[]>`
		SELECT scope, ref, max_concurrent FROM concurrency_limits WHERE project = ${project}`;
	const limits = rows.map((r) => ({ scope: r.scope, ref: r.ref, max_concurrent: Number(r.max_concurrent) }));
	limitsCache.set(project, { limits, expires: Date.now() + CACHE_TTL_MS });
	return limits;
}

async function getDailyLimits(project: string): Promise<DailyLimitRow[]> {
	const hit = dailyLimitsCache.get(project);
	if (hit && hit.expires > Date.now()) return hit.limits;
	const rows = await sql<{ scope: "project" | "group"; ref: string; max_per_day: number }[]>`
		SELECT scope, ref, max_per_day FROM daily_call_limits WHERE project = ${project}`;
	const limits = rows.map((r) => ({ scope: r.scope, ref: r.ref, max_per_day: Number(r.max_per_day) }));
	dailyLimitsCache.set(project, { limits, expires: Date.now() + CACHE_TTL_MS });
	return limits;
}

/**
 * The daily call ceiling for {project, groupRef}: a group-scope row overrides a
 * project-scope row, which overrides the DEFAULT_MAX_CALLS_PER_DAY env. Because
 * the env has a default, this is never null when a group_ref is present — the
 * daily cap is always enforced for tagged calls, but always generous with no
 * config. Untagged calls (groupRef null) are never subject to it.
 */
export function resolveDailyLimit(rows: DailyLimitRow[], groupRef: string): number | null {
	const groupOverride = rows.find((r) => r.scope === "group" && r.ref === groupRef)?.max_per_day;
	const projectOverride = rows.find((r) => r.scope === "project" && r.ref === "")?.max_per_day;
	return groupOverride ?? projectOverride ?? env.DEFAULT_MAX_CALLS_PER_DAY ?? null;
}

/** Drop cached limits (concurrency + daily) for a project so the next check
 * re-reads. Called on any /v1/limits write. */
export function invalidateLimitsCache(project: string): void {
	limitsCache.delete(project);
	dailyLimitsCache.delete(project);
}

/**
 * Is there capacity to birth a call for {project, agentId, groupRef}? Enforces
 * two layers, both at the same call-birth choke points:
 *   1. Concurrency — live-call caps per project/agent/group scope (as before).
 *   2. Daily volume — a per-org rolling-24h call-count ceiling, ONLY when the
 *      call is tagged with a group_ref (untagged calls skip it entirely).
 * Concurrency is reported first (narrowest-blocking scope: project → agent →
 * group), then the daily ceiling. Both surface via the same CapacityCheck shape,
 * so every existing call site (outbound park, /v1/sessions 429, inbound
 * {rejected}) handles a daily block with no site-specific wiring.
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

	// Daily ceiling only applies to org-tagged calls; resolved from the cached
	// daily table + generous env default (so it is always set for tagged calls).
	const dailyLimit = groupRef
		? resolveDailyLimit(await getDailyLimits(project), groupRef)
		: null;

	// Concurrency layer: a single query counts live calls per scope; skipped
	// when no concurrency scope has a limit.
	if (projectLimit != null || agentLimit != null || groupLimit != null) {
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
	}

	// Daily layer: count real placed/attempted calls for this org over the last
	// 24h (uses idx_calls_group). Only runs for tagged calls with a resolved cap.
	if (groupRef != null && dailyLimit != null) {
		const rows = await sql<{ day_current: number }[]>`
			SELECT count(*)::int AS day_current
			FROM calls
			WHERE project = ${project}
			  AND group_ref = ${groupRef}
			  AND status = ANY(${DAILY_COUNTED_STATUSES})
			  AND created_at > now() - interval '24 hours'`;
		const dayCurrent = Number(rows[0]!.day_current);
		if (dayCurrent >= dailyLimit) {
			return { allowed: false, blockedBy: "daily", current: dayCurrent, limit: dailyLimit };
		}
	}

	return { allowed: true, current: 0, limit: projectLimit };
}
