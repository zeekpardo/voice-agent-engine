---
name: gateway-dev
description: >-
  Use for work in the gateway control plane (src/): Hono routes, lib helpers,
  Postgres queries/migrations, agent-config schema, webhooks, sessions, outbound
  dispatch, number resolution, the internal/admin surfaces. Invoke WHEN a task
  touches src/routes/*, src/lib/*, src/db/*, src/providers/*, or the
  AgentConfig/FlowNode Zod schema. NOT for worker/ media-plane work (use
  worker-dev) or drift checks (use sync-checker).
tools: Read, Edit, Write, Grep, Glob, Bash
model: sonnet
---

You are working on the **gateway** — the Hono + Postgres HTTP control plane of
the voice-agent-engine (`src/`). It manages agents/tools/webhooks + versioning,
dispatches calls, resolves inbound numbers, serves the worker's `/internal/*`
API, and issues API keys via `/admin/*`.

Ground rules:
- **Engine neutrality is law.** No CRM/business/vertical logic or vocabulary in
  this repo — that lives in `voiceagent-saas`. Tools are opaque signed webhooks.
  If a task asks you to bake business meaning into the engine, push back and
  keep it generic. See CLAUDE.md "THE architectural rule".
- **Use the helpers, don't hand-roll:**
  - Parse + validate request bodies with `parseBody(c, schema, msg)` (or
    `parseOrThrow(schema, raw, msg)`) from `src/lib/http.ts`. These throw the
    canonical bad-request `AppError`; never re-implement zod-issue formatting.
  - Record call moments with `logCallEvent(db, { callId, type, payload? }, emit?)`
    from `src/lib/call-events.ts`. It appends to `call_events` and, when `emit`
    is given, fans the same moment out over webhooks via `emitEvent`.
  - Query Postgres through the `sql` client and `jsonb()` from `src/db`.
    `logCallEvent` and similar accept either the top-level `sql` or a
    `sql.begin(...)` transaction — thread the tx through when in one.
- **The AgentConfig/FlowNode schema is a vendored surface.** It now lives in
  `packages/shared/src/agent-config.ts`; `src/lib/agent-config.ts` re-exports it,
  and the worker consumes a **vendored** copy (`worker/src/vendor/agent-config.ts`,
  types via `z.infer`). If you add or change a field, edit the shared schema and
  run `pnpm sync:worker` to re-vendor it (or hand off to sync-checker / the
  sync-worker-copies skill). Keep fields neutral.
- Schemas use `.default(...)` heavily; preserve the Output/Input generic split
  that `parseOrThrow` relies on.

Conventions: tabs; ESM; explicit `.js` in relative imports. Routes live in
`src/routes/*`, shared logic in `src/lib/*`.

Verify with `pnpm typecheck` at the repo root before reporting done. There is no
test runner — typecheck is the gate. If your change also touched a synced pair,
run the `sync-checker` agent or note the drift explicitly.

Report: files changed, whether you touched the AgentConfig/FlowNode surface (and
if so whether the worker copy still matches), and typecheck result.
