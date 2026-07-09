export interface TranscriptSegment {
	/** Speaker number (0-indexed) when diarize is on; null otherwise. */
	speaker: number | null;
	text: string;
}

export interface TranscriberState {
	status: "idle" | "connecting" | "recording" | "stopped" | "error";
	/** Finalized transcript (all speakers, plain text). */
	committed: string;
	/** In-progress words (may still change). */
	interim: string;
	/** committed + interim, ready to render. */
	text: string;
	/** Finalized transcript grouped by speaker (populated when diarize is on). */
	segments: TranscriptSegment[];
	/** Best-guess speaker for the current interim text. */
	interimSpeaker: number | null;
	/** Set when status === "error". */
	error?: string;
}

export interface LiveTranscriberOptions {
	/** WS endpoint on YOUR backend (absolute ws(s):// or a path like "/api/voice/stream"). */
	url: string;
	/** BCP-47 language code, default "en". */
	language?: string;
	/** Label speakers — populates state.segments with speaker numbers. */
	diarize?: boolean;
	onStateChange?: (state: TranscriberState) => void;
}

export interface LiveTranscriber {
	start(): Promise<void>;
	stop(): void;
	subscribe(cb: (state: TranscriberState) => void): () => void;
	getState(): TranscriberState;
}

export function createLiveTranscriber(options: LiveTranscriberOptions): LiveTranscriber;

export interface MediaRange {
	/** Window start — "MM:SS", "HH:MM:SS", or seconds. Transcribe only this slice. */
	start?: string | number;
	/** Window end. */
	end?: string | number;
}

export interface TranscribeFileOptions extends MediaRange {
	/** POST endpoint on YOUR backend (e.g. "/api/voice/transcribe"). */
	url: string;
	language?: string;
}

export interface TranscribeResult {
	text: string;
	language?: string;
	provider?: string;
}

export function transcribeFile(file: Blob, options: TranscribeFileOptions): Promise<TranscribeResult>;

export interface TranscribeUrlOptions extends MediaRange {
	/** POST endpoint on YOUR backend (e.g. "/api/voice/url"). */
	url: string;
	language?: string;
}

/** Transcribe a video/audio URL (YouTube, Vimeo, direct link) via your backend. */
export function transcribeUrl(url: string, options: TranscribeUrlOptions): Promise<TranscribeResult>;
