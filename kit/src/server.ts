import WebSocket from "ws";

/**
 * @noba/voice-kit — server helpers. Use in YOUR app's backend; these hold the
 * gateway key and talk to the voice-gateway so the browser never sees it.
 */

export interface GatewayConfig {
	/** Base URL of the voice-gateway, e.g. "http://localhost:8787". */
	gatewayUrl: string;
	/** An issued gateway key (vk_live_...). */
	apiKey: string;
}

export interface TranscribeResult {
	text: string;
	language: string;
	provider: string;
}

/** Optional time window ("MM:SS", "HH:MM:SS", or seconds) to transcribe only a slice. */
export interface MediaRange {
	start?: string | number;
	end?: string | number;
}

/** Batch transcription — forward an audio/video file to the gateway. */
export async function transcribeAudio(
	audio: Blob | Uint8Array,
	opts: GatewayConfig & { filename?: string; language?: string; contentType?: string } & MediaRange,
): Promise<TranscribeResult> {
	const blob =
		audio instanceof Blob
			? audio
			: new Blob([audio], { type: opts.contentType ?? "application/octet-stream" });

	const fd = new FormData();
	if (opts.language) fd.append("language", opts.language);
	if (opts.start != null) fd.append("start", String(opts.start));
	if (opts.end != null) fd.append("end", String(opts.end));
	fd.append("file", blob, opts.filename ?? "audio");

	const res = await fetch(`${opts.gatewayUrl.replace(/\/$/, "")}/v1/transcribe`, {
		method: "POST",
		headers: { Authorization: `Bearer ${opts.apiKey}` },
		body: fd,
	});
	const data = (await res.json().catch(() => ({}))) as
		| TranscribeResult
		| { error?: { message?: string } };
	if (!res.ok || !("text" in data)) {
		const m = (data as { error?: { message?: string } }).error?.message;
		throw new Error(m ?? `Transcription failed (${res.status})`);
	}
	return data;
}

/** Transcribe a video/audio URL (YouTube, Vimeo, direct link) via the gateway. */
export async function transcribeUrl(
	url: string,
	opts: GatewayConfig & { language?: string } & MediaRange,
): Promise<TranscribeResult> {
	const res = await fetch(`${opts.gatewayUrl.replace(/\/$/, "")}/v1/transcribe/url`, {
		method: "POST",
		headers: { Authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({ url, language: opts.language, start: opts.start, end: opts.end }),
	});
	const data = (await res.json().catch(() => ({}))) as
		| TranscribeResult
		| { error?: { message?: string } };
	if (!res.ok || !("text" in data)) {
		const m = (data as { error?: { message?: string } }).error?.message;
		throw new Error(m ?? `Transcription failed (${res.status})`);
	}
	return data;
}

/**
 * Open a streaming-STT WebSocket to the gateway (server → gateway). Wire this
 * to your app's client-facing WS to build a proxy (see the demo server).
 */
export function openGatewayStream(
	opts: GatewayConfig & { language?: string; diarize?: boolean },
): WebSocket {
	const base = opts.gatewayUrl.replace(/^http/, "ws").replace(/\/$/, "");
	const url = new URL(`${base}/v1/stt/stream`);
	url.searchParams.set("interim_results", "true");
	if (opts.language) url.searchParams.set("language", opts.language);
	if (opts.diarize) url.searchParams.set("diarize", "true");
	return new WebSocket(url.toString(), { headers: { Authorization: `Bearer ${opts.apiKey}` } });
}
