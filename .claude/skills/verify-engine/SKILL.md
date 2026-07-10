---
name: verify-engine
description: >-
  Verify the voice-agent-engine compiles across all units. Use after any code
  change here, before reporting done, or when asked to "verify"/"check"/"typecheck"
  the engine. There is NO test runner in this repo — verification is typecheck
  across gateway (root), worker, and an ad-hoc tsc for kit (which has no tsconfig).
---

# verify-engine

This repo has **no test runner**. "Verified" means: everything typechecks. Run
all three, from the repo root (`/Users/zeek/Projects/voice-agent-engine`).

## 1. Gateway (root) + shared

```bash
pnpm typecheck
```

Runs `tsc --noEmit` for the root project. Covers `src/` and, transitively,
`packages/shared` (imported via `@voice-engine/shared`).

## 2. Worker

Separate tsconfig, separate constraints (no workspace imports):

```bash
cd worker && pnpm typecheck
```

Runs `tsc --noEmit` in `worker/`.

## 3. Kit (ad-hoc — no tsconfig)

`kit/` ships `.ts` sources but has **no `tsconfig.json`**, so there's no
`pnpm typecheck` for it. Typecheck its entrypoints ad-hoc with `skipLibCheck`
(it pulls in react + livekit-client types):

```bash
cd kit && npx tsc --noEmit --skipLibCheck --strict \
  --module esnext --target es2022 --moduleResolution bundler \
  --jsx react-jsx \
  src/react.ts src/server.ts src/agent/react.ts src/agent/server.ts
```

This is best-effort: peer deps (react) are optional, so a handful of
missing-type diagnostics from optional peers may be expected. Focus on errors in
`kit/src/**` itself, not in `node_modules`. If it's noisy, at minimum confirm the
kit sources parse and their `@voice-engine/shared` imports resolve.

## Reporting

State pass/fail for each of the three steps. If a synced-pair file changed as
part of the work, also run the `sync-checker` agent (typecheck won't catch
logic/scheme drift between hand-copied code). Do not claim "verified" unless
steps 1 and 2 are clean.
