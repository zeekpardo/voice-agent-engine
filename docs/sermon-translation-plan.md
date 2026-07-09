# Sermon Translation — Plans, Discoveries & Recommendations

*Planning doc. Status: **exploration only, nothing built.** Likely deferred until after MVP.*
*Last updated: July 2026*

---

## TL;DR

- **Goal:** let non-English speakers in a congregation follow a sermon in their own
  language (captions first; spoken audio later).
- **The unlock:** pastors already **practice their sermon out loud into Cadence** using
  the transcription tool. That single action produces a clean manuscript for free — which
  can be **pre-translated** ahead of the service. This turns a hard real-time problem into
  a much easier offline one.
- **Your stated preference:** start with **live translation** (the real-world scenario),
  layer **pre-rendered** on later.
- **My recommendation:** the reverse — **pre-rendered first** (easier, cheaper, higher
  quality, valuable on its own), live sync as the ambitious later layer. Both paths are
  documented below so you can decide when you pick this up.
- **Reality:** probably **not touching any of this until after MVP.**

---

## Background: how we got here

- We built **`voice-gateway`** — a standalone Hono API that fronts xAI for voice. It already
  does: batch STT, **streaming STT** (live, with speaker diarization), media extraction
  (video files + YouTube/URLs with in/out trim), issued API keys, and a reusable client
  (`@noba/voice-kit`). See that repo's README.
- **Cadence** (separate app) already has a large **sermon-writing feature** — this is how the
  whole project started.
- Connecting the two: Cadence + the gateway's STT = a pastor can **speak their sermon and get
  a manuscript**, which becomes the input for translation.

---

## The core flywheel (the elegant part)

> Pastors **practice their entire sermon out loud into Cadence** (using the transcription
> tool). No typing, no formatting — just rehearse.

One action, three payoffs:

- **Pastor** rehearses the sermon (they'd do this anyway) and gets a written manuscript.
- **App** gets a clean, structured sermon transcript for free.
- **Non-English speakers** get translations derived from that transcript.

This is the foundation everything else builds on. It also means **the manuscript exists
*before* the service** — which is the key architectural lever (see below).

---

## Two architectures

### A) Live real-time translation (your preferred starting point)

```
Live audio → STT (streaming) → chunk → translate → [captions | TTS] → congregant phones
```

- **Pros:** works even with no prepared manuscript; handles ad-lib and full improvisation;
  the "obvious" product.
- **Cons:** hard. Every stage races a latency budget (~4–8 s end-to-end is realistic — and
  that's disorienting when the listener also hears the live voice in the room). Cumulative
  **drift** if speech outpaces synthesis. Live STT accuracy is lower. Scripture/terms
  handled on the fly, worse. Most expensive.
- **Chunking:** trigger on the STT's `speech_final`/`is_final` events (we already emit these),
  with a hard word/time cap. Don't re-implement pause detection.

### B) Pre-rendered from the manuscript (my recommendation to start)

Because the sermon is captured during practice, translate the **whole manuscript offline**,
ahead of the service. The only *live* problem left is tracking **where in the script the
pastor currently is** — an alignment problem, not a translation problem.

- **Sidesteps the worst parts of live:** no live-STT accuracy problem (you have the exact
  text), no translation latency (done beforehand), no drift, scripture/terminology handled
  carefully with review, highest quality (full-document context).
- **Live component shrinks** to position-tracking — can even be **manual** in v1 (operator
  advances, or the pastor's own screen).
- **Valuable even without live delivery:** translated handouts, a multilingual sermon
  **archive**, accessibility, pastor can review the translation before Sunday. This de-risks
  the whole thing — ship the 80% without the hard live layer.
- **The catch:** pastors **go off-script** (ad-libs, skipped paragraphs, unplanned stories).
  Pure script-following breaks on deviation → eventually needs a **hybrid**: follow the
  pre-translated script when on it, fall back to live translation when off it, re-sync when
  they return. *That hybrid is the genuinely hard part — and it's exactly the part you can
  defer.*

### Decision note

You want **live first**; I'd argue **pre-rendered first** is the faster path to real value
and reuses the manuscript you're already capturing. A reasonable compromise: build the
**pre-render** (batch translate the manuscript) as the foundation — it's needed for the
hybrid anyway — then add a **live fallback** for off-script moments. That gets you toward the
"live" experience without paying the full real-time cost up front.

---

## Decisions locked (from the planning discussion)

For a live/caption MVP, we'd previously agreed on the "recommended" defaults:

- **Captions-first (text on phone)**, not audio. ~10× cheaper (no TTS), sub-second latency,
  scales trivially, doubles as accessibility. Audio is the premium upgrade.
- **One language first** (Spanish is the obvious US #1), architected for N.
- **Browser soundboard capture** — a page on the church laptop with the soundboard's USB
  audio interface selected, streaming PCM to the gateway's STT WS. Reuses what we built.
- **A new "session" service** holds live sessions/fan-out (stateful) — *not* baked into the
  gateway (stateless).
- **Transcript persisted** (searchable sermon archive — nearly free byproduct, real value).
- **Delivery:** congregants are on their **own cellular data** (no shared-WiFi bottleneck),
  so CDN/cloud delivery scales; for audio, WebRTC (e.g. LiveKit) keeps latency down; captions
  go over plain WebSocket/SSE.

---

## Where things live (clean seams)

Guiding principle: **the gateway holds stateless capabilities; products hold stateful
orchestration + UX.** Test: *"would Cadence or WAGOAT ever want this exact thing?"* → yes &
stateless = gateway; church/session/listener-specific = product.

```
      voice-gateway (stateless primitives)
      STT · streaming STT · media · TRANSLATE (planned) · TTS (later)
             ▲ issued keys + HTTP/WS
   ┌─────────┴───────────────┬───────────────────────────┐
 Cadence                  sermon-live (or a Cadence      WAGOAT
 (sermon manuscript,      "present/broadcast" mode)      (other app)
  pre-rendered            sessions · fan-out ·
  translations —          listener captions ·
  operates on its         live position sync
  core asset)
```

- **Pre-render** ("translate this sermon") **belongs in Cadence** — it operates on Cadence's
  core asset (the manuscript) and just calls the gateway's `/v1/translate`.
- **Live delivery** (sessions, phones, position sync) is the separable, harder piece — a new
  product or a Cadence "broadcast" mode.
- **The gateway** stays a lean primitives API — it gains `/v1/translate` (and later
  `/v1/speak` for audio); it must never learn what a "church," "session," or "listener" is.

---

## Fan-out economics (important)

**Translate once per language, not once per listener.** 300 people listening in Spanish = ONE
Spanish pipeline, broadcast to all 300 — not 300 pipelines. Cost scales with number of
**languages** (2–5), not **listeners** (hundreds). This is what makes it viable.

---

## Translation providers — comparison & recommendation

Because the core workflow is **batch** (translate the manuscript offline), quality/context
matter more than streaming speed.

| Provider | Best at | Weak for preaching | Role |
|---|---|---|---|
| **Anthropic / Claude** | Context, idiom, metaphor, **scripture** (can substitute canonical verses), theological terms, huge language coverage, multi-language in one call, prompt caching on big manuscripts | Pricier per token than MT; not a millisecond-streaming engine (irrelevant for batch) | **Default engine for the pre-render core** |
| **DeepL** | Superb quality on major languages (Spanish/German/French/PT), fast, cheap, glossary + formality, great formatting-tag handling | Segment-level MT — no document context/intent/scripture; **narrower language coverage** (~30, thin on Tagalog/Vietnamese/Creole/Amharic); the "WebSocket/real-time" pitch is **oversold** (it's mainly fast REST — verify before relying on streaming) | **Strong secondary**: fast/cheap **live fallback**, and per-language quality A/B |
| **OpenAI Realtime** | Speech-to-speech in one pipe (translate + native audio out), low latency | Mis-scoped for now: it's for **live spoken audio** (the tier we deferred); wasted for captions; adds a **third vendor** (xAI + Anthropic already). Could stay in-family with **xAI realtime/TTS** instead | **Parked** until a live *audio* tier is on the roadmap |

**Recommendation:** default **Claude** for the pre-rendered manuscript; keep **DeepL**
pluggable behind the same interface for the fast-live / major-language cases; **shelve OpenAI
Realtime**. This is exactly what a `TranslationProvider` abstraction is for — the engine is a
config/routing choice, not an architectural one.

**What actually decides Claude-vs-DeepL** (do this before committing):
1. **List the real target languages** for the first churches. Spanish + European → DeepL very
   much in play. Tagalog/Vietnamese/Amharic/Creole → LLM coverage is decisive.
2. **20-minute bake-off** on a real sermon paragraph (with a scripture quote, a metaphor, and
   a theological term) through Claude vs DeepL in the top 2–3 languages; native speaker judges.

---

## Prompt caching — findings

- **Minimum cacheable prefix:** Opus 4.8 = **4,096 tokens**; Sonnet 4.6 = 2,048; Sonnet 4.5 =
  1,024. Shorter prefixes silently **do not cache**.
- **Per-chunk source won't cache** — a sermon chunk is ~40 tokens, far below the floor. (This
  was the "minimum data requirement" concern — it's real.)
- **The real multi-language saver is a single call that returns all target languages** —
  source billed **once**, all translations out. Beats caching for the first render.
- **Where caching actually pays off:** a **large stable prefix** — system prompt + per-church
  **glossary/style guide** + the **full manuscript** (6k–9k tokens, above the floor). Then the
  edit-and-re-render loop (pastor tweaks Thursday → re-translate → unchanged prefix reads at
  ~0.1×), adding languages later, or per-section translation with the manuscript as context.
- **Net:** the **manuscript is the right caching base**; the pre-render workflow is where
  caching finally makes sense.

---

## Draft design: `/v1/translate` primitive (gateway)

*(We started scaffolding this, then paused — see "Scaffolding left in repo" below.)*

- **Provider:** Anthropic via the official SDK (`@anthropic-ai/sdk`), behind a
  `TranslationProvider` interface (swap point; DeepL impl slots in later).
- **Model:** default `claude-opus-4-8` (quality). **Flag:** for high-volume/live captions,
  consider a `quality` knob or default to **Claude Haiku 4.5** ($1/$5, fast) on the live path
  — translation is well within Haiku's competence.
- **Request (JSON):**
  ```json
  { "text": "...", "to": "es" | ["es","zh"], "from": "en",
    "context": "prior text for coherence (not translated)",
    "glossary": "term list / style guide (cacheable if large)" }
  ```
- **Response:** single-target → `{ "text": "...", "to": "es", "model", "cached" }`;
  multi-target → `{ "translations": { "es": "...", "zh": "..." }, "model", "cached" }`.
- **Internals:** one Anthropic call returns **all target languages** (structured JSON via
  `output_config.format`); **no thinking** (latency); `cache_control` on the system/glossary
  block so a large glossary/manuscript prefix caches; log `cache_read_input_tokens` for
  visibility.
- **Domain feature (later):** detect scripture references → substitute the **canonical
  target-language verse** instead of re-translating. Design the translate step so this is
  insertable. Same idea for a per-church glossary.

---

## Hard parts / risks

- **Off-script deviation** — the core reason live sync is hard; needs the on/off-script hybrid.
- **Drift** (audio tier) — if TTS can't keep up with dense speech it falls progressively behind;
  can't drop content (it's the message). Lean on pastor pauses + slightly faster TTS.
- **Latency budget** — in-room listeners also hear the live voice; >6 s delay is disorienting.
  Bias toward lower latency (captions help; smaller chunks; streaming output).
- **Delivery/fan-out** — getting captions/audio to many phones; cellular data removes the WiFi
  bottleneck, but audio to many subscribers still wants an SFU (LiveKit) rather than hand-rolled.
- **Provider sprawl** — every added vendor (DeepL, OpenAI) is a key/bill/maintenance surface;
  the abstraction contains it but don't add one without a reason.
- **Does xAI TTS stream?** — unverified. REST-only TTS adds a per-chunk latency tax; may push
  toward a realtime API for the audio stage.

---

## What's already built (the foundation)

In `voice-gateway` today (verified working):
- Batch STT (`POST /v1/transcribe`), incl. **video files + YouTube/URLs** with **in/out trim**.
- **Streaming STT** (`WS /v1/stt/stream`) — live, with **speaker diarization**.
- Issued API keys (hashed), usage metering, consistent error envelope.
- `@noba/voice-kit` — browser (live mic + upload + url), React hook, server proxy helpers.
- A demo app (xAI-styled UI) that dogfoods the kit.

So the **STT half of the sermon pipeline already exists** — the pastor-practice capture path
is essentially the streaming/batch STT we shipped. What's missing for translation: the
`/v1/translate` primitive, and (for live) the session/fan-out/delivery product.

---

## Recommended sequencing (when you return, post-MVP)

1. **`/v1/translate` primitive** in the gateway (Claude default, provider-abstracted). Small,
   reusable, unblocks everything. *(Scaffolding already started.)*
2. **Pre-render in Cadence** — "translate this sermon" on the manuscript → multilingual
   handouts / archive. High value, no live complexity, reuses #1.
3. **Language list + Claude-vs-DeepL bake-off** — decide the engine per language.
4. **Live layer** (the ambitious part): session service + browser soundboard capture +
   caption fan-out to phones; start **one language, captions only, manual position advance**.
5. **Hybrid on/off-script sync**, then the **audio/TTS tier** (LiveKit for delivery,
   xAI/OpenAI realtime for spoken output).

---

## Open questions to resolve later

- **Manuscript vs outline:** do target pastors preach near-verbatim (pre-render is gold) or
  from a loose outline (live layer matters sooner)?
- **Target languages** for the first churches (drives Claude-vs-DeepL).
- **Captions-first vs audio-first** for the real first deployment.
- **Where the live layer lives:** a standalone `sermon-live` product vs a Cadence "broadcast"
  mode.
- **Does xAI TTS stream** (for the eventual audio tier)?

---

## Scaffolding left in the repo (from the paused build)

Two inert edits were made before pausing — nothing imports them, no deps installed, gateway
still runs:

- `src/env.ts` — added optional translate env vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`,
  `TRANSLATE_MODEL` default `claude-opus-4-8`, `TRANSLATE_MAX_TOKENS`).
- `src/providers/translate/types.ts` — the `TranslationProvider` interface + `TranslateInput`/
  `TranslateResult` types.

Either keep as a head-start for step 1, or delete to fully reset. (Not wired into anything.)
