# voice-agent-engine

The control plane + media worker for AI voice **agents** — phone and browser
calls that run a configurable conversation flow, call tools as webhooks, and
sync results to a CRM.

Extracted from `voice-gateway` (which remains the standalone transcription API
that Cadence/WAGOAT call). This service is fully independent: its **own** xAI
key, its **own** issued API keys, its **own** Postgres. Nothing here is shared
at runtime with the transcription gateway.

```
  Your app / dashboard (voiceagent-saas)
        │  Authorization: Bearer vk_live_...   (keys this service issues)
        ▼
   voice-agent-engine  ── Hono control plane (agents, calls, sessions, numbers)
        │  internal API                     + Postgres
        ▼
   agent-worker (LiveKit Cloud)  ── runs the live conversation, tools-as-webhooks
```

## Two deploy units
- **Gateway** (`src/`, root `Dockerfile`) — the Hono HTTP control plane. Manages
  agents/versions/tools/flows, dispatches calls, resolves inbound numbers, and
  serves the worker's internal API. Postgres-backed.
- **Worker** (`worker/`, `worker/Dockerfile`) — the LiveKit Agents worker that
  runs each call: fetches the pinned agent config, assembles the session
  (LiveKit Inference), executes the flow (agent/objective/router/statement/
  scenario/true_false/switch/transfer/handoff/set_field/modify_tags/booking/
  conversation/stop_responding nodes), and reports transcript + usage. The same
  flow runtime drives text channels (widget/test) via a `ChannelAdapter` seam.

## Routes
- `GET /health`
- `/v1/agents`, `/v1/tools`, `/v1/webhooks` — agent CRUD + versioning
- `/v1/sessions` — browser voice session (LiveKit room + token)
- `/v1/calls`, `/v1/numbers` — outbound dispatch + inbound number registry
- `/v1/conversations` — room-less, turn-based text conversations (SMS/omnichannel
  backbone; one agent turn per inbound message, no LiveKit room). `GET
  /v1/conversations/:id/events` returns the AI-log event stream (ai.turn/tool/http).
- `/internal/*` — worker-only surface (gated by `GATEWAY_INTERNAL_KEY`)
- `/admin/*` — key issuance (gated by `ADMIN_TOKEN`)

## Setup

```bash
pnpm install
cp .env.example .env      # then edit
```

Required env: `XAI_API_KEY` (this service's own key), `DATABASE_URL` (Postgres),
`GATEWAY_INTERNAL_KEY`. For telephony/agents: `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
`LIVEKIT_API_SECRET`, `TELNYX_API_KEY`, `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`.

```bash
pnpm dev                # gateway (tsx watch)
cd worker && pnpm dev   # worker (registers with LiveKit Cloud)
```

## Related repos
- `voice-gateway` — standalone transcription/TTS API (Cadence's dependency). Not shared with this service.
- `voiceagent-saas` — dashboard + CRM live-tools webhook the worker calls.
