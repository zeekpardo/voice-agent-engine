// @ts-check
/**
 * @noba/voice-kit — browser core (framework-agnostic, zero dependencies, ESM).
 *
 * Talks to YOUR app's backend (which proxies to the voice-gateway). The gateway
 * key never lives here. Two features:
 *   - createLiveTranscriber(): mic → PCM16 → WebSocket → live transcript
 *   - transcribeFile():        upload an audio file → transcript
 */

const TARGET_RATE = 16000;

/**
 * @typedef {Object} TranscriberState
 * @property {'idle'|'connecting'|'recording'|'stopped'|'error'} status
 * @property {string} committed  Finalized transcript.
 * @property {string} interim    In-progress words (may change).
 * @property {string} text       committed + interim, ready to render.
 * @property {string=} error     Message when status === 'error'.
 */

/**
 * Create a live microphone transcriber.
 * @param {Object} options
 * @param {string} options.url        WS endpoint on YOUR backend (absolute ws(s):// or a path like "/api/voice/stream").
 * @param {string} [options.language] BCP-47 code, default "en".
 * @param {boolean} [options.diarize] Label speakers — populates state.segments with speaker numbers.
 * @param {(s: TranscriberState) => void} [options.onStateChange]
 */
export function createLiveTranscriber(options) {
	const { url, language = "en", diarize = false, onStateChange } = options;
	const AC =
		typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;

	let ws = null;
	let audioCtx = null;
	let source = null;
	let processor = null;
	let sink = null;
	let stream = null;
	let chunks = 0;
	let silenceTimer = null;

	/** @type {TranscriberState} */
	let state = {
		status: "idle",
		committed: "",
		interim: "",
		text: "",
		segments: [],
		interimSpeaker: null,
		error: undefined,
	};
	/** @type {Set<(s: TranscriberState) => void>} */
	const subs = new Set();

	function set(patch) {
		state = { ...state, ...patch };
		state.text = state.committed + (state.interim ? (state.committed ? " " : "") + state.interim : "");
		for (const cb of subs) cb(state);
		if (onStateChange) onStateChange(state);
	}

	function subscribe(cb) {
		subs.add(cb);
		cb(state);
		return () => subs.delete(cb);
	}

	async function start() {
		if (state.status === "recording" || state.status === "connecting") return;
		if (!AC) return set({ status: "error", error: "Web Audio not supported in this environment" });
		set({
			status: "connecting",
			committed: "",
			interim: "",
			text: "",
			segments: [],
			interimSpeaker: null,
			error: undefined,
		});
		chunks = 0;

		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
			});
		} catch {
			return set({ status: "error", error: "Microphone access denied" });
		}

		try {
			audioCtx = new AC();
			await audioCtx.resume(); // contexts often start suspended
		} catch (e) {
			return set({ status: "error", error: "AudioContext error: " + e.message });
		}

		ws = new WebSocket(resolveWsUrl(url, { language, diarize }));
		ws.binaryType = "arraybuffer";
		ws.onopen = () => set({ status: "recording" });
		ws.onmessage = onEvent;
		ws.onerror = () => set({ status: "error", error: "Connection error" });

		source = audioCtx.createMediaStreamSource(stream);
		processor = audioCtx.createScriptProcessor(4096, 1, 1);
		sink = audioCtx.createGain();
		sink.gain.value = 0; // silence local monitor
		processor.onaudioprocess = (e) => {
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			const pcm = floatToPCM16(downsample(e.inputBuffer.getChannelData(0), audioCtx.sampleRate, TARGET_RATE));
			if (pcm.byteLength) {
				ws.send(pcm);
				chunks++;
			}
		};
		source.connect(processor);
		processor.connect(sink);
		sink.connect(audioCtx.destination);

		silenceTimer = setTimeout(() => {
			if (state.status === "recording" && chunks === 0) {
				set({ status: "error", error: "No audio detected — check the selected microphone" });
			}
		}, 3000);
	}

	function onEvent(msg) {
		let ev;
		try {
			ev = JSON.parse(msg.data);
		} catch {
			return;
		}
		if (ev.type === "transcript.partial") {
			if (ev.is_final) {
				const text = ev.text || "";
				// A finalized chunk can contain multiple speakers — split its words[]
				// into per-speaker runs so each speaker becomes its own segment.
				let segments = state.segments;
				if (ev.words && ev.words.length) {
					for (const run of wordsToRuns(ev.words)) {
						segments = appendSegment(segments, run.speaker, run.text);
					}
				} else {
					segments = appendSegment(segments, null, text);
				}
				set({
					committed: state.committed + (state.committed ? " " : "") + text,
					interim: "",
					interimSpeaker: null,
					segments,
				});
			} else {
				set({ interim: ev.text || "", interimSpeaker: dominantSpeaker(ev.words) });
			}
		} else if (ev.type === "transcript.done") {
			set({ interim: "", interimSpeaker: null });
		} else if (ev.type === "error") {
			set({ status: "error", error: ev.message || "Transcription error" });
		}
	}

	function stop() {
		clearTimeout(silenceTimer);
		try { if (processor) processor.onaudioprocess = null; } catch {}
		try { source && source.disconnect(); } catch {}
		try { processor && processor.disconnect(); } catch {}
		try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
		try { audioCtx && audioCtx.close(); } catch {}
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "audio.done" }));
		if (state.status !== "error") set({ status: "stopped" });
	}

	return { start, stop, subscribe, getState: () => state };
}

/**
 * Upload an audio file to YOUR backend for transcription.
 * @param {Blob} file
 * @param {Object} options
 * @param {string} options.url        POST endpoint on YOUR backend (e.g. "/api/voice/transcribe").
 * @param {string} [options.language]
 * @param {string|number} [options.start] Time window start ("MM:SS"/seconds) — transcribe only a slice.
 * @param {string|number} [options.end]   Time window end.
 * @returns {Promise<{ text: string, language?: string, provider?: string }>}
 */
export async function transcribeFile(file, options) {
	const fd = new FormData();
	if (options.language) fd.append("language", options.language);
	if (options.start != null) fd.append("start", String(options.start));
	if (options.end != null) fd.append("end", String(options.end));
	fd.append("file", file, file.name || "audio");

	const res = await fetch(options.url, { method: "POST", body: fd });
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.text == null) {
		const m = data?.error?.message || data?.error || `Transcription failed (${res.status})`;
		throw new Error(typeof m === "string" ? m : JSON.stringify(m));
	}
	return data;
}

/**
 * Transcribe a video/audio URL (YouTube, Vimeo, direct link) via YOUR backend.
 * @param {string} url  The media link to transcribe.
 * @param {Object} options
 * @param {string} options.url        POST endpoint on YOUR backend (e.g. "/api/voice/url").
 * @param {string} [options.language]
 * @param {string|number} [options.start] Time window start ("MM:SS"/seconds).
 * @param {string|number} [options.end]   Time window end.
 * @returns {Promise<{ text: string, language?: string, provider?: string }>}
 */
export async function transcribeUrl(url, options) {
	const res = await fetch(options.url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ url, language: options.language, start: options.start, end: options.end }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.text == null) {
		const m = data?.error?.message || data?.error || `Transcription failed (${res.status})`;
		throw new Error(typeof m === "string" ? m : JSON.stringify(m));
	}
	return data;
}

// --- internals ---

function resolveWsUrl(url, { language, diarize } = {}) {
	const base = typeof location !== "undefined" ? location.origin.replace(/^http/, "ws") : undefined;
	const u = /^wss?:\/\//.test(url) ? new URL(url) : new URL(url, base);
	if (language && !u.searchParams.has("language")) u.searchParams.set("language", language);
	if (diarize && !u.searchParams.has("diarize")) u.searchParams.set("diarize", "true");
	return u.toString();
}

/** Most-frequent speaker across a chunk's words[], or null when diarization is off. */
function dominantSpeaker(words) {
	if (!words || !words.length) return null;
	const counts = new Map();
	for (const w of words) {
		if (w.speaker == null) continue;
		counts.set(w.speaker, (counts.get(w.speaker) || 0) + 1);
	}
	let best = null;
	let bestN = 0;
	for (const [sp, n] of counts) if (n > bestN) ((bestN = n), (best = sp));
	return best;
}

/** Split a chunk's words[] into consecutive same-speaker runs of text. */
function wordsToRuns(words) {
	const runs = [];
	for (const w of words) {
		const sp = w.speaker ?? null;
		const t = (w.text ?? "").trim();
		if (!t) continue;
		const last = runs[runs.length - 1];
		if (last && last.speaker === sp) last.text += " " + t;
		else runs.push({ speaker: sp, text: t });
	}
	for (const r of runs) r.text = r.text.replace(/\s+([,.!?;:])/g, "$1"); // tidy spacing
	return runs;
}

/** Append a finalized run to the speaker-grouped segment list (immutably). */
function appendSegment(segments, speaker, text) {
	if (!text) return segments;
	const last = segments[segments.length - 1];
	if (last && last.speaker === speaker) {
		return [...segments.slice(0, -1), { speaker, text: last.text ? last.text + " " + text : text }];
	}
	return [...segments, { speaker, text }];
}

/** Float32 [-1,1] @ inRate → Float32 @ outRate (averaging decimation). */
function downsample(input, inRate, outRate) {
	if (outRate >= inRate) return input;
	const ratio = inRate / outRate;
	const outLen = Math.floor(input.length / ratio);
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.floor((i + 1) * ratio);
		let sum = 0;
		let n = 0;
		for (let j = start; j < end && j < input.length; j++) {
			sum += input[j];
			n++;
		}
		out[i] = n ? sum / n : 0;
	}
	return out;
}

/** Float32 → Int16 LE ArrayBuffer. */
function floatToPCM16(f) {
	const buf = new ArrayBuffer(f.length * 2);
	const view = new DataView(buf);
	for (let i = 0; i < f.length; i++) {
		const s = Math.max(-1, Math.min(1, f[i]));
		view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return buf;
}
