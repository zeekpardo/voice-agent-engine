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
| **Shared** | `packages/shared/` (`@voice-engine/shared`) | Zero-dependency helpers: `./hmac` (webhook signing/verify) and `./slugify` (id-safe slugs). Imported by gateway + kit. **NOT** by the worker (see below). |

Gateway internals (`src/`):
- `routes/*` — `agents`, `tools`, `webhooks`, `sessions`, `calls`, `numbers`,
  `internal` (worker-only, gated by internal key), `admin` (key issuance),
  `usage`, `health`.
- `lib/` — `http.ts` (`parseBody`/`parseOrThrow`), `call-events.ts`
  (`logCallEvent`), `webhooks.ts` (`emitEvent`), `agent-config.ts` (the
  `AgentConfig`/`FlowNode` Zod schemas — the neutral agent document),
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
- `gateway.ts` — stateless gateway internal-API client + **mirrored** config types.
- `tools.ts` — tools-as-webhooks (signed POST) + `buildTools`.
- `env.ts`.

## ⚠️ Worker build-context constraint + hand-synced files

`lk agent deploy` builds the worker's Docker image using **`worker/` as the
ENTIRE build context**. `worker/Dockerfile` runs `pnpm install` before the rest
of the repo is even copied, so **the worker cannot import workspace packages**
(`@voice-engine/shared`, or anything from `src/`). To compensate, a few pieces of
code/types are **hand-copied** into the worker and must be kept in sync by hand.

Editing either side of a pair means you must update the other. The pairs:

| Canonical source | Hand-synced copy in worker | What |
|------------------|----------------------------|------|
| `packages/shared/src/hmac.ts` (`signPayload`) | `worker/src/tools.ts` (`sign`) | HMAC-SHA256 over `${timestamp}.${body}`, hex |
| `packages/shared/src/slugify.ts` (`slugify`) | `worker/src/flow/agent-builder.ts` (`sanitize`) | id-safe slug: lowercase, non-alnum runs → `_`, trim `_` |
| `src/lib/agent-config.ts` (Zod `AgentConfig`/`FlowNode`) | `worker/src/gateway.ts` (`AgentConfig`/`FlowNode`/`FlowNode` TS interfaces) | shape of the neutral agent document the worker consumes |

Notes:
- The slugify copy historically lived in `worker/src/main.ts`; the main.ts split
  moved it to `worker/src/flow/agent-builder.ts` (function name `sanitize`). If
  you find a copy elsewhere in the worker, sync that too.
- Each copy carries a pointer comment explaining why it's duplicated — preserve
  those comments.
- A PostToolUse hook (`.claude/hooks/sync-reminder.sh`) prints a reminder when
  you edit any file in a pair. The `sync-checker` subagent and the
  `sync-worker-copies` skill exist to detect/fix drift.

## Commands

Root (gateway):
- `pnpm install`
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm dev` — gateway on :8787 (`tsx watch src/index.ts`)
- `pnpm key:mint` / `pnpm key:list` — issue/list API keys

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
