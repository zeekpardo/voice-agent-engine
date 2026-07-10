# voice-agent-engine — orchestration guide

The **engine**: a generic LiveKit runtime + deploy platform for AI voice agents
(phone + browser calls that run a configurable conversation flow and call tools
as webhooks). pnpm workspace, TypeScript throughout, ESM (`"type": "module"`).

## THE architectural rule (read first)

**The engine is generic. NO business/CRM logic or vocabulary belongs here.**

All CRM shaping, field mapping, normalization, and vertical/business logic live
in the **SaaS repo** (`voiceagent-saas`), which compiles business config down
into the neutral `AgentConfig`/flow document this engine executes. The engine
only ever sees: `instructions` (language), `toolIds` (webhooks the consuming app
implements), flow nodes, and named `postCall.extract` fields.

Concretely, when working here:
- Do **not** add CRM/vertical field names, provider-specific business concepts,
  or "what a booking means" logic. Tools are opaque signed webhooks; the engine
  POSTs and relays the response — it runs no business logic.
- A cleanup removing residual CRM-flavored tool names is queued. Do not add new
  ones; prefer neutral names. If you see business vocabulary, flag it rather
  than building on it.
- Flow node kinds are deliberately generic primitives (`agent`, `router`,
  `statement`, `transfer`, `set_field`, `modify_tags`). `set_field`/`modify_tags`
  carry an opaque field name / tag string the SaaS side gives meaning to.

## Architecture map

Two independently deployed units + two libraries:

| Unit | Path | What it is |
|------|------|-----------|
| **Gateway** | `src/` (root `Dockerfile`, Railway) | Hono HTTP control plane + Postgres. Agent/tool/webhook CRUD + versioning, call dispatch, inbound number resolution, browser sessions, and the worker-only `/internal/*` API. |
| **Worker** | `worker/` (`worker/Dockerfile`, `lk agent deploy`) | LiveKit Agents media-plane worker on LiveKit Cloud. One binary serves every project/agent: per dispatch it fetches the pinned config, assembles an `AgentSession` (LiveKit Inference), runs the flow with tools-as-webhooks, flushes transcript + usage back to the gateway. |
| **Kit** | `kit/` (`@noba/voice-kit`) | Consumer SDK for apps talking to the engine: browser/react session hooks, server-side webhook/tool verification. |
| **Shared** | `packages/shared/` (`@voice-engine/shared`) | Canonical shared code: `./hmac` (webhook signing/verify), `./slugify` (id-safe slugs), and `./agent-config` (the `AgentConfig`/flow **zod schema** — single source for gateway + worker). Imported directly by gateway + kit; **vendored** into the worker (see below). |

Gateway internals (`src/`):
- `routes/*` — `agents`, `tools`, `webhooks`, `sessions`, `calls`, `numbers`,
  `internal` (worker-only, gated by internal key), `admin` (key issuance),
  `usage`, `health`.
- `lib/` — `http.ts` (`parseBody`/`parseOrThrow`), `call-events.ts`
  (`logCallEvent`), `webhooks.ts` (`emitEvent`), `agent-config.ts` (a thin
  re-export of the `AgentConfig`/`FlowNode` Zod schema, which now lives in
  `@voice-engine/shared/agent-config` so gateway + worker share ONE source),
  `sessions.ts`, `outbound.ts`, `postcall.ts`, `usage.ts`, `errors.ts`, `id.ts`.
- `providers/agent-runtime/` — LiveKit dispatch/token provider.
- `db/index.ts` — `postgres` client + `jsonb` helper.

Worker internals (`worker/src/`):
- `main.ts` — `defineAgent` orchestrator: parse dispatch → fetch config →
  interpolate → wire the flow modules behind one `FlowRuntimeContext` → hand off
  to `session-lifecycle.ts`.
- `flow/` — `context.ts` (pure helpers + `FlowRuntimeContext` type),
  `router.ts`, `transfer.ts`, `agent-builder.ts`, `objectives.ts`
  (explicit-deps factory pattern: `createX(deps)` returns the module).
- `session-lifecycle.ts` — runs the assembled session; owns ordering-sensitive
  teardown.
- `gateway.ts` — stateless gateway internal-API client; config types come from
  `./vendor/agent-config` (`z.infer` of the vendored schema), not hand-written.
- `vendor/` — **generated** (`pnpm sync:worker`) copies of `packages/shared/src/*`
  (`hmac`, `slugify`, `agent-config`). DO NOT EDIT; edit the canonical files.
- `tools.ts` — tools-as-webhooks (signed POST) + `buildTools`.
- `env.ts`.

## ⚠️ Worker build-context constraint + vendored shared code

`lk agent deploy` builds the worker's Docker image using **`worker/` as the
ENTIRE build context**. `worker/Dockerfile` runs `pnpm install` before the rest
of the repo is even copied, so **the worker cannot import workspace packages**
(`@voice-engine/shared`, or anything from `src/`). To compensate, the canonical
shared code is **vendored** into `worker/src/vendor/` by a sync script — the
worker imports `./vendor/*`, and the vendored files are committed so they're
present in the standalone build.

**Single source, then regenerate.** Edit the canonical file, then run the copy:

```
pnpm sync:worker           # regenerate worker/src/vendor/ from packages/shared/src/
pnpm sync:worker --check   # verify no drift (CI/verify gate; nonzero on stale)
```

| Canonical (edit here) | Vendored copy (generated) | Consumed by |
|-----------------------|---------------------------|-------------|
| `packages/shared/src/hmac.ts` (`signPayload`) | `worker/src/vendor/hmac.ts` | `worker/src/tools.ts` (as `sign`) |
| `packages/shared/src/slugify.ts` (`slugify`) | `worker/src/vendor/slugify.ts` | `worker/src/flow/agent-builder.ts` (as `sanitize`) |
| `packages/shared/src/agent-config.ts` (zod `AgentConfig` + derived `FlowNode`/`FlowScenario`/`FlowObjective`) | `worker/src/vendor/agent-config.ts` | `worker/src/gateway.ts` (`z.infer`, re-exported as `AgentConfig`) |

The `AgentConfig`/flow schema lives in `packages/shared` and is re-exported by
`src/lib/agent-config.ts` (gateway) and derived via `z.infer` in the worker, so
a schema change is a **one-place edit** in `packages/shared/src/agent-config.ts`
followed by `pnpm sync:worker` — no hand-mirrored interface to drift.

Notes:
- **Never hand-edit `worker/src/vendor/*`** — generated, DO-NOT-EDIT header, and
  `pnpm sync:worker` will overwrite it. Edit the canonical file in
  `packages/shared/src/` instead.
- A PostToolUse hook (`.claude/hooks/sync-reminder.sh`) reminds you to run
  `pnpm sync:worker` when you edit `packages/shared/src/*`, and warns loudly if
  you edit a generated vendor file. The `sync-checker` subagent and the
  `sync-worker-copies` skill detect/fix drift.

## Commands

Root (gateway):
- `pnpm install`
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm dev` — gateway on :8787 (`tsx watch src/index.ts`)
- `pnpm key:mint` / `pnpm key:list` — issue/list API keys
- `pnpm sync:worker` — regenerate `worker/src/vendor/` from `packages/shared/src/`
  (run after editing shared code / the AgentConfig schema); `--check` fails on drift

Worker (`cd worker`):
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm dev` — registers with LiveKit Cloud (`tsx src/main.ts dev`)
- deploy: `lk agent deploy` (from `worker/`; builds the standalone image)

**There is no test runner in this repo.** Verification is typecheck-based:
`pnpm typecheck` at root, `pnpm typecheck` in `worker/`, and (kit has no
tsconfig) an ad-hoc `tsc` for `kit/`. See the `verify-engine` skill.

## Conventions

- Tabs for indentation (root/shared); match the file you're editing.
- ESM everywhere; worker imports use explicit `.js` extensions.
- Routes: parse input with `parseBody(c, schema, msg)` / `parseOrThrow` from
  `lib/http.ts` — do not hand-roll bad-request handling.
- Record call moments with `logCallEvent(db, {...}, emit?)` from
  `lib/call-events.ts` (writes `call_events` + optionally fans out a webhook).
- Postgres via the `sql` client / `jsonb()` from `src/db`; `logCallEvent`
  accepts either `sql` or a `sql.begin(...)` transaction.
- Worker flow modules use the explicit-deps factory pattern (`createRouter(deps)`
  etc.) — pass dependencies in, don't reach for globals.
- Do NOT edit source under an active refactor without checking — `main.ts` is
  being split into `flow/{router,transfer,agent-builder}` + `session-lifecycle`.

## Subagents & skills

- `.claude/agents/gateway-dev.md` — Hono routes / lib / Postgres work.
- `.claude/agents/worker-dev.md` — LiveKit worker; knows the constraints above.
- `.claude/agents/sync-checker.md` — read-only drift detector for the pairs.
- `.claude/skills/verify-engine` — typecheck root + worker + ad-hoc kit.
- `.claude/skills/sync-worker-copies` — how to re-sync the hand-copied code.
- `.claude/skills/deploy-worker` — `lk agent deploy` flow.
