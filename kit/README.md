# @noba/voice-kit

Reusable voice transcription for your apps — **so you build it once, not per project.**
Two features, two layers:

|  | Browser | Server (your app's backend) |
|--|---------|------------------------------|
| **Live mic** | `createLiveTranscriber()` / `useVoiceTranscription()` | `openGatewayStream()` (proxy) |
| **File upload** | `transcribeFile()` | `transcribeAudio()` (proxy) |

The browser talks to **your app's own backend**, which holds the gateway key and
forwards to the [voice-gateway](../README.md). **The gateway key never reaches the
browser.**

```
your UI ──(kit/browser)──► your backend ──(kit/server)──► voice-gateway ──► xAI
```

## Install

While it lives in this repo, consume it by path (or copy the `kit/` folder):

```bash
pnpm add file:../voice-gateway/kit      # or publish to your registry
```

Requirements: the calling app needs its own gateway key (`vk_live_...`) — mint one
with `pnpm key:mint <project>` in the gateway repo — plus the gateway URL.

---

## Browser — vanilla (any framework)

```js
import { createLiveTranscriber, transcribeFile } from "@noba/voice-kit/browser";

// Live: point at YOUR backend's WS proxy route
const live = createLiveTranscriber({ url: "/api/voice/stream", language: "en" });
live.subscribe((s) => {
  // s.status: idle | connecting | recording | stopped | error
  // s.text = committed + interim, ready to render
  render(s.text);
});
recordBtn.onclick = () => live.start();
stopBtn.onclick   = () => live.stop();

// Upload: POST a file to YOUR backend's transcribe route
const { text } = await transcribeFile(file, { url: "/api/voice/transcribe" });
```

## Browser — React (the "shell": headless, style it yourself)

```tsx
import { useVoiceTranscription } from "@noba/voice-kit/react";

function Dictation() {
  const v = useVoiceTranscription({
    streamUrl: "/api/voice/stream",       // your backend WS proxy
    uploadUrl: "/api/voice/transcribe",   // your backend upload proxy
  });

  return (
    <div>
      <button onClick={v.isRecording ? v.stop : v.start}>
        {v.isRecording ? "Stop" : "Record"}
      </button>
      <input type="file" accept="audio/*"
        onChange={(e) => e.target.files?.[0] && v.uploadFile(e.target.files[0])} />

      {v.status === "error" ? <p className="err">{v.error}</p> : <p>{v.text}</p>}
    </div>
  );
}
```

The hook returns `{ status, committed, interim, text, error, isRecording, uploading,
start, stop, uploadFile }`. **No styles are imposed** — you own the markup.

## Server — your app's two proxy routes

The kit gives you the gateway calls; you mount them on whatever framework you use.

**Upload proxy** (works in any Node handler — Next.js route, Express, Hono):

```ts
import { transcribeAudio } from "@noba/voice-kit/server";

// e.g. Next.js app/api/voice/transcribe/route.ts
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file") as File;
  const result = await transcribeAudio(file, {
    gatewayUrl: process.env.VOICE_GATEWAY_URL!,   // http://localhost:8787
    apiKey:     process.env.VOICE_GATEWAY_KEY!,   // vk_live_... (this app's key)
    filename:   file.name,
    language:   "en",
  });
  return Response.json(result); // { text, language, provider }
}
```

**Streaming proxy** — bridge your client WS to the gateway with `openGatewayStream()`.
Full working reference: [`examples/browser-demo/server.ts`](../examples/browser-demo/server.ts).
The essence:

```ts
import { openGatewayStream } from "@noba/voice-kit/server";

// on a new browser WS connection:
const upstream = openGatewayStream({
  gatewayUrl: process.env.VOICE_GATEWAY_URL!,
  apiKey:     process.env.VOICE_GATEWAY_KEY!,
  language:   "en",
});
// pipe: browser binary/audio.done  →  upstream
//       upstream JSON events        →  browser
```

> Streaming needs a persistent WebSocket server. Frameworks with long-lived WS
> (Hono/Node, Express+ws, a standalone ws server) work directly. Next.js route
> handlers don't hold WebSockets — run the stream proxy in a small side service
> (like the demo) or a custom server.

## Wire-up checklist for a new app (Cadence, WAGOAT, …)

1. Mint a key: `pnpm key:mint cadence` → set `VOICE_GATEWAY_KEY` + `VOICE_GATEWAY_URL`.
2. Add two backend routes: upload (`transcribeAudio`) and stream proxy (`openGatewayStream`).
3. Drop `useVoiceTranscription({ streamUrl, uploadUrl })` into a component; style to taste.

## Speaker diarization

Pass `diarize: true` and the transcript is grouped by speaker in `state.segments`:

```ts
const v = useVoiceTranscription({
  streamUrl: "/api/voice/stream",
  uploadUrl: "/api/voice/transcribe",
  diarize: true,
});

// render speaker-labeled turns
{v.segments.map((seg, i) => (
  <p key={i}>
    {seg.speaker != null && <b>Speaker {seg.speaker + 1}: </b>}
    {seg.text}
  </p>
))}
```

Each segment is `{ speaker: number | null, text: string }`. Consecutive same-speaker
words are merged into one segment; a single spoken turn maps to one segment. The
plain `text` field still works if you don't care about speakers. Your backend must
forward `diarize` to the gateway (the demo reads `?diarize=true` and passes it to
`openGatewayStream({ …, diarize })`).

## API

- `createLiveTranscriber({ url, language?, diarize?, onStateChange? })` → `{ start, stop, subscribe, getState }`
  - state adds `segments: { speaker, text }[]` and `interimSpeaker` when `diarize` is on
- `transcribeFile(file, { url, language? })` → `Promise<{ text, language?, provider? }>`
- `useVoiceTranscription({ streamUrl, uploadUrl, language? })` → state + `{ start, stop, uploadFile }`
- `transcribeFile(file, { url, language? })` → upload an audio/**video** file (browser)
- `transcribeUrl(link, { url, language? })` → transcribe a **YouTube/video link** (browser)
- `transcribeAudio(audio, { gatewayUrl, apiKey, filename?, language? })` → `Promise<{ text, language, provider }>`
- `transcribeUrl(link, { gatewayUrl, apiKey, language? })` → transcribe a video/YouTube link (server)
- `openGatewayStream({ gatewayUrl, apiKey, language?, diarize? })` → `ws.WebSocket` to the gateway

**Video & links:** `transcribeFile` accepts video files (audio is extracted
server-side); `transcribeUrl` takes any yt-dlp-supported link. Your backend needs
a route that calls the server-side `transcribeUrl` (see the demo's
`/api/transcribe-url`).

**Time window:** all four transcribe helpers accept `start` / `end`
(`"MM:SS"`, `"HH:MM:SS"`, or seconds) to transcribe just a slice — e.g. the sermon
inside a full-service recording:

```ts
await transcribeUrl(serviceUrl, { url: "/api/voice/url", start: "35:00", end: "70:00" });
```
