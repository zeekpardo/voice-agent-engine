---
name: sync-worker-copies
description: >-
  Re-sync the worker's hand-copied code/types after shared code or the
  AgentConfig/FlowNode schema changes. Use WHEN you edited packages/shared
  (hmac/slugify) or src/lib/agent-config.ts, or the sync-reminder hook / sync-checker
  flagged drift. Step-by-step: what to copy where, with the exact file pairs.
---

# sync-worker-copies

The worker CANNOT import workspace packages: `lk agent deploy` builds its Docker
image from `worker/` alone (`worker/Dockerfile` runs `pnpm install` before the
rest of the repo is copied). So a few pieces are **hand-duplicated** into the
worker and must be re-synced manually whenever the canonical source changes.

Each copy has a pointer comment explaining why it's duplicated — **preserve
those comments**. Only bring the logic/shape across; keep the local names
(`sign`, `sanitize`) and formatting.

## The three pairs

### 1. HMAC signing scheme
- **Canonical:** `packages/shared/src/hmac.ts` → `signPayload(secret, timestamp, body)`
- **Copy:** `worker/src/tools.ts` → `sign(secret, timestamp, body)`
- **Sync:** the digest must be identical:
  `createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")`.
  If you changed the scheme (algorithm, the `${timestamp}.${body}` construction,
  or hex encoding), update `sign` to match. Also check kit's verifier
  (`kit/src/agent/server.ts`) uses the same scheme — kit CAN import shared, so it
  should just call `verifySignature`; only the worker needs the hand copy.

### 2. Slug / sanitize
- **Canonical:** `packages/shared/src/slugify.ts` → `slugify(s)`
- **Copy:** `worker/src/flow/agent-builder.ts` → `sanitize(s)`
  (was in `worker/src/main.ts` before the split; grep the worker for other copies)
- **Sync:** the transform must be identical:
  `s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")`.
  This matters because exit-tool ids the LLM sees (`exit_${sanitize(name)}`) must
  equal the ids the gateway generated with `slugify` — divergence silently breaks
  flow transitions.

### 3. AgentConfig / FlowNode document shape
- **Canonical:** `src/lib/agent-config.ts` → Zod `AgentConfig`, `FlowNode`,
  `FlowScenario`, `FlowObjective`.
- **Copy:** `worker/src/gateway.ts` → the matching TS `interface`s.
- **Sync:** mirror field names, optionality, enum members, and nested object
  shape. The Zod side carries defaults/validation the TS side legitimately omits
  — you're syncing the *shape the worker consumes*, not the validation. When you
  add/rename/remove a field or a `FlowNode.kind`, or change a per-kind sub-object
  (`router`, `statement`, `setField`, `modifyTags`, `transfer`, `objectives`,
  `judge`), update the interface in `gateway.ts` to match.

## Procedure

1. Identify which pair(s) your change touched (the sync-reminder hook names the
   file you just edited).
2. Open both files in the pair side by side. Apply the change to the copy,
   keeping local naming, formatting, and the pointer comment.
3. Run `sync-checker` (read-only) to confirm no residual drift.
4. Run the `verify-engine` skill: `pnpm typecheck` (root) and
   `cd worker && pnpm typecheck`. Typecheck catches shape drift in pair 3; it
   will NOT catch logic drift in pairs 1–2, so eyeball those.
