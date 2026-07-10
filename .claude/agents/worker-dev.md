---
name: worker-dev
description: >-
  Use for work in the LiveKit media-plane worker (worker/): the AgentSession
  assembly, flow execution (agent/router/transfer/statement/objectives),
  tools-as-webhooks, session lifecycle/teardown, and the gateway internal-API
  client. Invoke WHEN a task touches worker/src/*. Knows the no-workspace-imports
  build constraint and the ordering-sensitive call-lifecycle rules. NOT for
  gateway src/ work (use gateway-dev) or pure drift checks (use sync-checker).
tools: Read, Edit, Write, Grep, Glob, Bash
model: sonnet
---

You are working on the **worker** (`worker/`) — the LiveKit Agents media-plane
binary that runs each live call on LiveKit Cloud. One deployed binary serves
every project/agent. Per dispatch: parse `DispatchMetadata` → fetch the pinned
agent config from the gateway → interpolate `{{variables}}` → assemble an
`AgentSession` (LiveKit Inference) → run the flow with tools-as-webhooks → flush
transcript + usage back to the gateway.

Hard constraints unique to the worker:

1. **NO workspace imports.** `lk agent deploy` builds the image with `worker/` as
   the ENTIRE build context, and `worker/Dockerfile` runs `pnpm install` before
   copying the rest of the repo. So you CANNOT `import` `@voice-engine/shared` or
   anything from the repo's `src/`. Anything shared is hand-copied into the
   worker with a pointer comment. If you change a hand-synced copy, update its
   canonical source too (and vice versa). The pairs:
   - `worker/src/tools.ts` `sign()` ⇄ `packages/shared/src/hmac.ts` `signPayload`
   - `worker/src/flow/agent-builder.ts` `sanitize()` ⇄ `packages/shared/src/slugify.ts`
   - `worker/src/gateway.ts` `AgentConfig`/`FlowNode` types ⇄ `src/lib/agent-config.ts`
   Preserve the pointer comments. Prefer running `sync-checker` after such edits.

2. **Engine neutrality.** No CRM/business logic. Tools are opaque signed webhooks;
   `set_field`/`modify_tags` carry opaque strings the SaaS side interprets. Do
   not add vertical vocabulary.

3. **Ordering-sensitive lifecycle (session-lifecycle.ts / teardown).** Get these
   right — they are the recurring source of bugs:
   - **Flush the transcript/usage report to the gateway BEFORE teardown.** Losing
     the transcript because the room closed first is a real failure mode.
   - **No double-close.** A session/room must be closed exactly once. Guard
     teardown so hangup + timeout + natural-end paths can't each close it.
   - **Hangup guardrails.** Silence-timeout, max-call-seconds, caller-hangup, and
     agent-initiated end can race. Make end-of-call idempotent; don't emit
     completion twice, don't tear down mid-flush.

4. **Flow modules use the explicit-deps factory pattern** (`createRouter(deps)`,
   `createTransfer(deps)`, `createAgentBuilder(deps)`, `createObjectivesTracker(deps)`).
   Pass dependencies in; don't reach for module globals. Pure helpers + the
   `FlowRuntimeContext` type live in `flow/context.ts`.

Note: `main.ts` is being split into `flow/{router,transfer,agent-builder}` +
`session-lifecycle.ts` by another agent — check current file state before editing
and avoid stepping on that refactor.

Conventions: ESM with explicit `.js` extensions on relative imports.

Verify with `cd worker && pnpm typecheck` before reporting done. No test runner
exists — typecheck is the gate. Report: files changed, any synced-pair impact
(and whether the counterpart still matches), and typecheck result.
