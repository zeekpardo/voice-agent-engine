---
name: deploy-worker
description: >-
  Deploy the LiveKit media-plane worker to LiveKit Cloud with `lk agent deploy`.
  Use WHEN asked to deploy/ship/release the worker (worker/), or to understand
  how the worker gets built and what the standalone-build constraint means for a
  deploy. NOT for the gateway (that deploys from the repo root via Railway).
---

# deploy-worker

The worker (`worker/`) runs on **LiveKit Cloud** and is deployed with the
LiveKit CLI (`lk`, installed at `/opt/homebrew/bin/lk`). It is a SEPARATE deploy
unit from the gateway (the gateway deploys from the repo root `Dockerfile` via
Railway — `railway.json`).

## ⚠️ The worker builds STANDALONE

`lk agent deploy` uses **`worker/` as the entire Docker build context**. Read
`worker/Dockerfile` to see this: it `COPY package.json`s and `pnpm install`s
using only the worker's own `package.json`, THEN `COPY . .` (still just
`worker/`). Consequences:

- The image has **no access to `@voice-engine/shared` or the repo `src/`**. This
  is exactly why the hand-synced copies exist (see the `sync-worker-copies`
  skill). Before deploying, make sure those copies are in sync — a stale copy
  ships silently.
- `worker/.dockerignore` excludes `node_modules`, `.env`, `.claude/`, docs, etc.
  The build runs a fresh `pnpm install` and pre-downloads the turn-detector model
  (`npx livekit-agents download-files`) so cold starts don't fetch it.
- The image runs `pnpm start` (`tsx src/main.ts start`) as a non-root `appuser`.

## Config that identifies the deploy

- `worker/livekit.toml` — the LiveKit project + agent id this deploys to:
  `[project].subdomain` and `[agent].id`. `lk agent deploy` reads this.
- The agent registers under an agent name that must match the gateway's
  `LIVEKIT_AGENT_NAME` (worker env `AGENT_NAME`, default `voice-agent`) — a
  mismatch means dispatched jobs never reach the worker.
- Runtime env (`worker/.env.example`): `LIVEKIT_URL/API_KEY/API_SECRET`
  (auto-provided on LiveKit Cloud), `GATEWAY_URL`, `GATEWAY_INTERNAL_KEY` (must
  match the gateway's internal key). Set these as LiveKit Cloud secrets, not in
  the image.

## Pre-deploy checklist

1. `cd worker && pnpm typecheck` is clean.
2. Run `sync-checker` — the standalone build ships hand-copied code; drift ships
   with it. Fix via `sync-worker-copies` if needed.
3. Confirm `worker/livekit.toml` points at the intended project/agent.

## Deploy

```bash
cd worker
lk agent deploy
```

(Optional smoke checks that exist in `worker/`: `join-test.ts` / `_join-prod.ts`
drive a test/prod room join. `lk` also offers status/logs subcommands — run
`lk agent --help` to see what your CLI version exposes.)

## Notes

- Do NOT modify `worker/Dockerfile`, `worker/livekit.toml`, or any
  `package.json` as part of a routine deploy.
- If you changed shared code (`packages/shared`) or the AgentConfig schema and
  did not re-sync the worker copies, STOP and run `sync-worker-copies` first —
  otherwise the gateway and the deployed worker will disagree at runtime.
