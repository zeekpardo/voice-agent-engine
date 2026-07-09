# voice-gateway — Deployment & Cadence Wiring

*Operational record. Last updated: July 2026.*

## Production engine (Railway)

- **URL:** https://voice-gateway-production-dd11.up.railway.app
- **Railway project:** `voice-gateway` (own project — `06ca6043-0051-4aa1-8447-8e07e78e2819`),
  service `voice-gateway`, env `production`.
- **Build:** `Dockerfile` (Node 22 + ffmpeg + yt-dlp standalone binary; better-sqlite3
  prebuilt binary fetched explicitly to avoid pnpm's build-approval flakiness).
- **Persistence:** a Railway **volume mounted at `/data`**; `DB_PATH=/data/gateway.db`.
  Keys + usage survive redeploys. (The volume was created via the GraphQL API because the
  `railway volume add` CLI panics in v4.30.x.)
- **Env vars set:** `XAI_API_KEY`, `ADMIN_TOKEN`, `DB_PATH=/data/gateway.db`. `PORT` is
  injected by Railway.
- Verified: `/health` 200, live transcription (Railway → xAI) ~0.6s, usage recorded.

## Admin API (issue keys + track usage) — gated by `ADMIN_TOKEN`

```bash
BASE=https://voice-gateway-production-dd11.up.railway.app
ADMIN=<ADMIN_TOKEN>   # set on the Railway service; also saved locally at /tmp/prod_admin_token during setup

# issue a key for a new project
curl -X POST "$BASE/admin/keys" -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"project":"my-app"}'
#  → { "key": "vk_live_...", "project": "my-app", ... }   (shown once)

curl "$BASE/admin/keys"  -H "Authorization: Bearer $ADMIN"   # list issued keys
curl "$BASE/admin/usage" -H "Authorization: Bearer $ADMIN"   # usage per project+endpoint (billing basis)
```

This is the mechanism for **per-project usage tracking** (and future per-usage billing):
each project gets its own `vk_live_` key; every request is recorded in `usage_events` and
aggregated by `/admin/usage`.

## Endpoints (all `/v1/*` require `Authorization: Bearer vk_live_...`)

- `POST /v1/transcribe` — audio **or video** file → text (+ optional `start`/`end` trim)
- `POST /v1/transcribe/url` — YouTube/Vimeo/direct link → text (+ trim)
- `WS   /v1/stt/stream` — live streaming STT (+ `diarize`)
- (planned) `POST /v1/translate` — scaffolded, not wired (see sermon-translation-plan.md)

## Cadence wiring (project `SERMON-TRACKER`)

Cadence is the Supastarter monorepo at `/Users/zeek/Projects/SERMON-TRACKER` (Railway project
`Cadence`, saas service **manuscript**).

- **Server proxy:** `apps/saas/app/api/voice/transcribe/route.ts` — auth-gated; holds the
  `VOICE_GATEWAY_KEY`, forwards to the engine. Takes precedence over the oRPC catch-all.
- **Reusable component:** `apps/saas/modules/shared/components/VoiceCaptureButton.tsx` —
  mic → transcript via `onTranscript` callback. Drop it next to any text field.
- **Wired surfaces:**
  - **Meeting notes** — `modules/manuscript/components/MeetingCanvas.tsx` + a new `appendText`
    on `canvas/useMeetingBlocks.ts`: **"Dictate note"** → speech appended as a new note block.
    (Notes live under Meetings in Cadence.)
  - Sermons — `modules/quick-create/SermonQuickCreateForm.tsx` (dictate a sermon idea → draft title)
  - Stories — `modules/manuscript/components/StoryForm.tsx` (title)
  - Concepts — `modules/manuscript/components/ConceptForm.tsx` (title)
- **Env:** `VOICE_GATEWAY_URL` + `VOICE_GATEWAY_KEY` (project `cadence` key) set in local
  `.env.local` **and** on the Railway `manuscript` service (production).
- **Typecheck:** `apps/saas` — 0 errors.

### Follow-ups (not done)
- **Manuscript-canvas dictation** (speak the sermon *body*, not just the title) needs the
  Tiptap editor (`SimpleRichTextEditor` / `RichBlockEditor`) to expose a text-insert API;
  that's the richer "practice your whole sermon into Cadence" experience and pairs with the
  gateway's **streaming** STT for long-form.
- **Runtime test in Cadence** requires its dev server (Postgres + full env); the proxy is a
  thin pass-through to the already-verified engine.
