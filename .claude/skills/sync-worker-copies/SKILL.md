---
name: sync-worker-copies
description: >-
  Re-vendor the worker's copy of shared code + the AgentConfig/flow schema after
  editing packages/shared. Use WHEN you edited packages/shared/src/* (hmac,
  slugify, or agent-config), or the sync-reminder hook / `pnpm sync:worker --check`
  flagged drift. One command does it: `pnpm sync:worker`.
---

# sync-worker-copies

The worker CANNOT import workspace packages: `lk agent deploy` builds its Docker
image from `worker/` alone (`worker/Dockerfile` runs `pnpm install` before the
rest of the repo is copied). So the canonical shared code is **vendored** into
`worker/src/vendor/` by a script — no more hand-copying.

## Single source of truth

| Canonical (edit here) | Vendored copy (generated) | Consumed by |
|-----------------------|---------------------------|-------------|
| `packages/shared/src/hmac.ts` (`signPayload`) | `worker/src/vendor/hmac.ts` | `worker/src/tools.ts` (`import … as sign`) |
| `packages/shared/src/slugify.ts` (`slugify`) | `worker/src/vendor/slugify.ts` | `worker/src/flow/agent-builder.ts` (`import … as sanitize`) |
| `packages/shared/src/agent-config.ts` (zod `AgentConfig` + derived `FlowNode`/`FlowScenario`/`FlowObjective` types) | `worker/src/vendor/agent-config.ts` | `worker/src/gateway.ts` (re-exports `AgentConfigT` as `AgentConfig` via `z.infer`) |

The gateway side (`src/lib/agent-config.ts`) is a thin re-export of
`@voice-engine/shared/agent-config`, so it and the worker share ONE schema.
`worker/src/gateway.ts` derives its config types from the vendored schema with
`z.infer` — there is no longer a hand-written interface to drift.

## The workflow — one command

1. Edit the canonical file(s) under `packages/shared/src/`.
2. Regenerate the vendored copies:
   ```
   pnpm sync:worker
   ```
   Each file under `worker/src/vendor/` is rewritten verbatim (with a DO-NOT-EDIT
   header). Idempotent — safe to run repeatedly.
3. Verify no drift and that both sides typecheck (the `verify-engine` skill):
   ```
   pnpm sync:worker --check        # exits nonzero if vendor is stale
   pnpm typecheck                  # root (gateway)
   cd worker && pnpm typecheck     # worker
   ```

A schema change is now a **one-place edit**: change
`packages/shared/src/agent-config.ts`, run `pnpm sync:worker`, typecheck. Adding
or renaming a field / `FlowNode.kind` / per-kind sub-object flows through to the
worker's types automatically (they're `z.infer` of the vendored schema).

## Rules

- **Never hand-edit `worker/src/vendor/*`** — it's generated and will be
  overwritten. The sync-reminder hook warns loudly if you do.
- `pnpm sync:worker --check` is the CI/verify gate; keep it green (commit the
  regenerated vendor files alongside the schema change).
- kit CAN import `@voice-engine/shared`, so it just imports the real package
  (`verifySignature`, etc.) — only the worker needs the vendored copies.
