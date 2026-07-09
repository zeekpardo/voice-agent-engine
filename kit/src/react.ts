import { useCallback, useEffect, useRef, useState } from "react";
import {
	createLiveTranscriber,
	transcribeFile,
	type LiveTranscriber,
	type TranscriberState,
} from "./browser.js";

export interface UseVoiceTranscriptionOptions {
	/** WS endpoint on your backend that proxies to the gateway (e.g. "/api/voice/stream"). */
	streamUrl: string;
	/** POST endpoint on your backend for file uploads (e.g. "/api/voice/transcribe"). */
	uploadUrl: string;
	language?: string;
	/** Label speakers — exposes state.segments with speaker numbers. */
	diarize?: boolean;
}

/**
 * Headless React hook — bring your own UI, style it however you like.
 *
 *   const v = useVoiceTranscription({ streamUrl: "/api/voice/stream", uploadUrl: "/api/voice/transcribe" });
 *   <button onClick={v.isRecording ? v.stop : v.start}>{v.isRecording ? "Stop" : "Record"}</button>
 *   <p>{v.text}</p>
 */
export function useVoiceTranscription(opts: UseVoiceTranscriptionOptions) {
	const [state, setState] = useState<TranscriberState>({
		status: "idle",
		committed: "",
		interim: "",
		text: "",
		segments: [],
		interimSpeaker: null,
	});
	const [uploading, setUploading] = useState(false);
	const ctrl = useRef<LiveTranscriber | null>(null);

	const ensure = useCallback(() => {
		if (!ctrl.current) {
			ctrl.current = createLiveTranscriber({
				url: opts.streamUrl,
				language: opts.language,
				diarize: opts.diarize,
			});
			ctrl.current.subscribe(setState);
		}
		return ctrl.current;
	}, [opts.streamUrl, opts.language, opts.diarize]);

	const start = useCallback(() => ensure().start(), [ensure]);
	const stop = useCallback(() => ctrl.current?.stop(), []);

	const uploadFile = useCallback(
		async (file: Blob) => {
			setUploading(true);
			try {
				const r = await transcribeFile(file, { url: opts.uploadUrl, language: opts.language });
				setState((s) => ({ ...s, status: "stopped", committed: r.text, interim: "", text: r.text }));
				return r;
			} catch (e) {
				setState((s) => ({ ...s, status: "error", error: (e as Error).message }));
				throw e;
			} finally {
				setUploading(false);
			}
		},
		[opts.uploadUrl, opts.language],
	);

	// Clean up on unmount.
	useEffect(() => () => ctrl.current?.stop(), []);

	return {
		...state,
		isRecording: state.status === "recording" || state.status === "connecting",
		uploading,
		start,
		stop,
		uploadFile,
	};
}
