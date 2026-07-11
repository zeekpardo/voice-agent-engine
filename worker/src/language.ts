import { reportEvent } from "./gateway.js";

/**
 * Mid-call language alignment (voice channel only).
 *
 * Live failure mode this addresses: a caller starts in English, switches to
 * Spanish mid-conversation, and either recognition dies (STT stayed pinned to
 * the config language) or the agent keeps answering in English (LLM prompt
 * never told it to follow the caller). The fix keeps ONE continuous session
 * and re-aligns the pipeline pieces when the caller's language changes:
 *
 *  - STT: language-scoped providers (Deepgram, AssemblyAI, …) get their
 *    language hint updated in place via `inference.STT.updateOptions` — the
 *    live stream picks it up without recreating the session. xAI STT is
 *    deliberately left UNhinted (it auto-detects and code-switches; a hint
 *    forces monolingual decoding — observed live as slow/empty finals).
 *  - LLM: assemble.ts injects an unconditional "reply in the caller's current
 *    language" rule into every voice agent's instructions (see languageRules).
 *  - TTS: our TTS options pin no language (xAI TTS follows the text), so
 *    nothing to update there.
 *
 * Every confirmed switch is reported as a `language.switch` call event so it
 * shows in the call logs.
 */

/** Compact stopword fingerprints for the languages we can cheaply tell apart.
 * Deliberately tiny: high-frequency function words + a few unmistakable words
 * (greetings, "do you speak …"). Accented forms double as diacritic evidence. */
const STOPWORDS: Record<string, string[]> = {
	en: ["the", "and", "you", "are", "is", "what", "that", "this", "have", "not", "can", "do", "for", "with", "yes", "hello", "thanks", "please", "speak", "english", "want", "need", "how"],
	es: ["el", "la", "los", "las", "es", "está", "qué", "que", "por", "para", "con", "una", "sí", "usted", "hablas", "habla", "español", "gracias", "pero", "cómo", "tiene", "hola", "bueno", "quiero", "necesito", "puede", "puedes", "más", "también", "muy", "mi", "yo", "no"],
	pt: ["o", "os", "as", "é", "você", "não", "sim", "uma", "para", "com", "por", "mas", "como", "obrigado", "obrigada", "olá", "fala", "português", "quero", "preciso", "pode", "muito", "também", "meu", "minha", "eu", "tem"],
	fr: ["le", "les", "est", "vous", "je", "oui", "non", "une", "pour", "avec", "mais", "comme", "merci", "bonjour", "parlez", "français", "veux", "besoin", "pouvez", "très", "aussi", "mon", "ne", "pas", "des", "du"],
	de: ["der", "die", "das", "und", "ist", "nicht", "ich", "sie", "ja", "nein", "eine", "für", "mit", "aber", "wie", "danke", "hallo", "sprechen", "deutsch", "möchte", "brauche", "können", "sehr", "auch", "mein", "bitte"],
	it: ["il", "gli", "sono", "lei", "io", "sì", "una", "per", "con", "ma", "come", "grazie", "ciao", "parla", "italiano", "voglio", "bisogno", "può", "molto", "anche", "mio", "non", "che", "di", "questo"],
};

const WORD_SETS: [lang: string, words: Set<string>][] = Object.entries(STOPWORDS).map(
	([lang, words]) => [lang, new Set(words)],
);

/** Strong single-character evidence (characters essentially unique to one
 * language among the set above). */
const CHAR_HINTS: [re: RegExp, lang: string][] = [
	[/[¿¡]/u, "es"],
	[/ñ/u, "es"],
	[/ß/u, "de"],
	[/[ãõ]/u, "pt"],
];

/** Regional BCP-47 hint per detected primary language. xAI's guidance: STT
 * hints must be regional ("es-MX", "pt-BR"), never bare "es"/"pt"; other
 * providers accept regional codes too. */
const REGIONAL_HINTS: Record<string, string> = {
	en: "en-US",
	es: "es-MX",
	pt: "pt-BR",
	fr: "fr-FR",
	de: "de-DE",
	it: "it-IT",
};

/** Primary subtag of a BCP-47 code ("es-MX" → "es"). */
export function primaryLanguage(code: string): string {
	return code.split(/[-_]/)[0]!.toLowerCase();
}

/**
 * Cheap heuristic language detection over a final transcript. Returns the
 * primary language code, or null when unconfident (short utterance, mixed or
 * unrecognized vocabulary) — callers must treat null as "no evidence", not
 * "same language".
 */
export function detectLanguage(text: string): string | null {
	const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
	if (tokens.length < 3) return null; // too short to judge
	const scores = new Map<string, number>();
	for (const [lang, words] of WORD_SETS) {
		let s = 0;
		for (const t of tokens) if (words.has(t)) s++;
		scores.set(lang, s);
	}
	for (const [re, lang] of CHAR_HINTS) {
		if (re.test(text)) scores.set(lang, (scores.get(lang) ?? 0) + 2);
	}
	let best: string | null = null;
	let bestScore = 0;
	let second = 0;
	for (const [lang, s] of scores) {
		if (s > bestScore) {
			second = bestScore;
			bestScore = s;
			best = lang;
		} else if (s > second) {
			second = s;
		}
	}
	// Confident only with real evidence and a clear margin over the runner-up.
	if (!best || bestScore < 2 || bestScore < second + 2) return null;
	return best;
}

export interface LanguageAligner {
	/** Feed every FINAL caller transcript. `sttLanguage` is the language the
	 * STT reported on the event, when the provider supplies one. */
	onFinalTranscript(text: string, sttLanguage?: string | null): void;
	/** Current confirmed caller language (primary subtag). */
	current(): string;
}

/**
 * Debounced caller-language tracker. Switches only after two consecutive
 * confident detections of the same new language (never on a single short
 * utterance), then invokes `apply` with a regional BCP-47 hint and reports a
 * `language.switch` call event. Detection prefers the STT-reported language
 * and falls back to the stopword heuristic.
 */
export function createLanguageAligner(opts: {
	callId: string;
	/** Configured agent language (BCP-47, e.g. "en"). */
	initialLanguage: string;
	/** Applies the confirmed language to the media pipeline (STT hint update). */
	apply(regionalHint: string, primary: string): void;
}): LanguageAligner {
	let current = primaryLanguage(opts.initialLanguage || "en");
	let pending: string | null = null;
	let pendingCount = 0;

	return {
		current: () => current,
		onFinalTranscript(text, sttLanguage) {
			const tokenCount = (text.match(/\p{L}+/gu) ?? []).length;
			if (tokenCount < 2) return; // "sí" / "ok" — never evidence of a switch
			const source = sttLanguage ? "stt" : "heuristic";
			const detected = sttLanguage ? primaryLanguage(sttLanguage) : detectLanguage(text);
			if (!detected) return; // unconfident: keep pending state as-is
			if (detected === current) {
				pending = null;
				pendingCount = 0;
				return;
			}
			if (detected === pending) {
				pendingCount++;
			} else {
				pending = detected;
				pendingCount = 1;
			}
			if (pendingCount < 2) return;

			const from = current;
			current = detected;
			pending = null;
			pendingCount = 0;
			const hint = REGIONAL_HINTS[detected] ?? detected;
			try {
				opts.apply(hint, detected);
			} catch (err) {
				console.error("[language] pipeline update failed", err);
			}
			console.log(`[language] caller switched ${from} -> ${detected} (hint ${hint}, via ${source})`);
			reportEvent(opts.callId, "language.switch", { from, to: detected, hint, source });
		},
	};
}
