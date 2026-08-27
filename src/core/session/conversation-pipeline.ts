/**
 * conversation-pipeline.ts
 *
 * Drives one session's LISTENING -> THINKING -> SPEAKING -> (repeat)
 * cycle against whatever streaming capabilities its resolved
 * provider stack happens to expose:
 *
 *  - STT: if `transcribeStream` exists, runs ONE continuous
 *    streaming transcription for the whole call and derives turn
 *    boundaries from the `AdaptiveTurnDetector`. Otherwise falls
 *    back to acquiring one whole `AudioPayload` at a time and
 *    treating each as a complete turn (the only option a batch
 *    `transcribe()` call allows).
 *
 *  - LLM: if `generateCompletionStream` exists, sentence-chunks the
 *    incoming token deltas and starts TTS on each sentence as soon
 *    as it's complete — real overlap between "the model is still
 *    thinking" and "the assistant has already started speaking".
 *    Otherwise waits for the full `generateCompletion` result before
 *    speaking at all.
 *
 *  - TTS: if `synthesizeStream` exists, plays audio chunks as they
 *    arrive. Otherwise synthesizes the whole utterance at once and
 *    simulates its playback duration so barge-in cancellation still
 *    behaves correctly even without a live audio transport.
 *
 * Barge-in ("the AI is speaking and the user starts talking") is
 * handled the same way regardless of which capabilities are
 * present: `BargeInController.triggerBargeIn()` aborts whatever is
 * currently in flight and the pipeline immediately falls back to
 * LISTENING.
 */
import type { TranscriptSegment } from "../../types/provider.types";
import { SessionState } from "../../types/enums";
import type { SupportedLanguage } from "../../types/enums";
import type { AudioPayload, ConversationTurn } from "../../types/provider.types";
import type { CompletionRequest } from "../../interfaces/providers/language-model-provider.interface";
import type { LanguageModelProvider } from "../../interfaces/providers/language-model-provider.interface";
import type { LlmStreamEvent } from "../../types/streaming.types";
import type { SpeechToTextProvider } from "../../interfaces/providers/speech-to-text-provider.interface";
import type { TextToSpeechProvider, SynthesisTaskRequest } from "../../interfaces/providers/text-to-speech-provider.interface";
import type { TelephonyProvider } from "../../interfaces/providers/telephony-provider.interface";

import type { SessionRecord } from "./session-record";
import { detectLanguage, type LanguageDetectionResult } from "./language-detector";
import { currentTurnNote, languageHintFor, openingLineFor } from "./system-prompt";
import { SentenceChunker } from "./sentence-chunker";
import { isBareAcknowledgement } from "./turn-detection";
import { voicemailPhraseIn } from "./voicemail-detection";
import { combineSignals, abortableSleep } from "./abort-utils";
import { estimateAudioSeconds, withByteCounter } from "./audio-utils";
import { estimateLlmCost, estimateSttCost, estimateTtsCost, estimateTokenCount } from "./cost-estimator";
import { withGracefulRetry, RecoverableTurnError, toSessionErrorInfo } from "./error-recovery";
import { formatForSpeech } from "../../utils/speech-formatter";
import { pronounceForSpeech } from "../../utils/speech-pronunciation";

export interface ResolvedProviderStack {
  readonly telephony: TelephonyProvider;
  readonly stt: SpeechToTextProvider;
  readonly llm: LanguageModelProvider;
  readonly tts: TextToSpeechProvider;
}

/**
 * The slice of the VoiceSessionManager the pipeline needs in order
 * to move a session between states without duplicating the
 * transition-validation logic that already lives on the manager.
 */
export interface PipelineHost {
  transition(record: SessionRecord, to: SessionState, reason?: string): void;
  markError(record: SessionRecord, sourceCategory: string, error: unknown): void;
  /**
   * The manager's existing public `end` — the one path that stops
   * playback, aborts the loop, closes the media stream AND tells the
   * telephony provider to hang up the carrier leg. Declared here so the
   * pipeline can end a call it has established there is no point
   * continuing: a voicemail or any other machine that answered.
   *
   * `DefaultVoiceSessionManager` already satisfies this — no new method
   * was added to it, and this is the same call the Dashboard's End Call
   * and the campaign watchdog already make.
   */
  end(sessionId: SessionRecord["id"]): Promise<unknown>;
}

interface AcquiredTurn {
  readonly text: string;
  /** How long the caller spoke. Context, NOT a latency — see benchmark.types.ts. */
  readonly userSpeechMs: number;
  /** STT recognition lag of the final segment that completed this turn. */
  readonly sttLagMs: number | undefined;
  /** Wall clock at which the caller's audio actually ended, back-dated by the recognition lag. */
  readonly userSpeechEndedAtMs: number | undefined;
  readonly sttCostUsd: number;
  /**
   * FIX #7A — wall clock at which the turn detector's `emitTurnEnd`
   * actually ran, captured at the top of the `onTurnEnd` listener it
   * calls synchronously (so no measurable gap from the real event).
   * Used as this turn's `TurnTimer` t0 instead of a fresh `Date.now()`
   * taken a microtask later in the main loop.
   */
  readonly turnReleasedAtMs: number;
  /** FIX #7A — arrival time of the Deepgram evidence that ended this turn, if it was directly observed (see `lastEndpointEvidenceAtMs`). */
  readonly endpointEvidenceAtMs: number | undefined;
  readonly endpointEvidenceKind: "utterance_end" | "speech_final" | undefined;
}

/**
 * FIX #8 — an LLM request PRE-OPENED during the turn detector's evidenced
 * confirmation window, so the provider's time-to-first-token overlaps the
 * one hold the pipeline still pays after Deepgram has declared end of
 * speech — instead of starting only once that hold has expired.
 *
 * WHAT IT IS. The SAME request `runThinkingAndSpeaking` would build after
 * the turn is released: same provider method, same `sessionId`, and a
 * history that is identical role-for-role and content-for-content
 * (`ConversationMemory.previewRecentHistory` + the same
 * `buildRequestHistory` annotation). Adoption re-derives the normal
 * request and compares; on ANY difference the pre-opened stream is
 * abandoned and the normal request is sent exactly as today.
 *
 * WHEN IT STARTS. Only on `AdaptiveTurnDetector.onTurnPending` — the
 * detector telling us it has armed the EVIDENCED confirmation window:
 * Deepgram's own endpointer explicitly declared end of speech
 * (`speech_final: true` on the words, or the standalone end-of-speech
 * marker), no interim is outstanding, and the text reads as finished.
 * Never on an interim, never on a bare `is_final`, never on silence or a
 * timer. The detector's own guards (filler, hold phrase, incomplete
 * thought, pending interim, chunk-boundary grace) run BEFORE that hook
 * fires, so a turn they hold is never speculated on.
 *
 * WHEN IT IS ABANDONED. Any further caller speech reaching the detector
 * (interim or final — the same segment that cancels the pending turn
 * inside the detector), the turn being released with different text,
 * voicemail, an attention-check turn, the loop ending — and, at
 * adoption, any mismatch with the normally-built request. Abandonment
 * aborts the provider stream through the signal it was given, the same
 * way a barge-in does.
 *
 * WHAT IT DOES NOT TOUCH. Turn release is still `onTurnEnd`, unchanged.
 * Barge-in, backchannel and interruption handling are untouched: a
 * speculation only exists while the pipeline is LISTENING and awaiting
 * a turn, so nothing here is alive while the assistant is speaking.
 * The user turn is committed to memory at release, as before; nothing is
 * recorded early. Sentence chunking, TTS, and every log/metric mark the
 * existing path emits are emitted at the same points.
 */
interface SpeculativeCompletion {
  /** The pending turn text this request was built for, exactly as the detector reported it. */
  readonly text: string;
  readonly request: CompletionRequest;
  /** Wall clock at which the provider stream was opened. */
  readonly openedAtMs: number;
  /** Wall clock of the Deepgram evidence this was started on, for the trace. */
  readonly evidenceAtMs: number | undefined;
  readonly abort: AbortController;
  readonly iterator: AsyncIterator<LlmStreamEvent>;
  /** The one `next()` issued at pre-open time — what actually opens the connection. */
  readonly first: Promise<IteratorResult<LlmStreamEvent>>;
  /** Wall clock at which `first` settled with a token, if it has yet. */
  firstTokenAtMs: number | undefined;
}

interface ThinkingAndSpeakingResult {
  readonly assistantText: string;
  /** LLM time-to-first-token. */
  readonly llmMs: number | undefined;
  /** Full generation span with TTS blocking time subtracted out. */
  readonly llmGenerationMs: number | undefined;
  readonly llmCostUsd: number;
  /** TTS time-to-first-audio-chunk for the first utterance of the turn. */
  readonly ttsMs: number | undefined;
  /** Total synthesis wall-clock across every sentence chunk of the turn. */
  readonly ttsSynthesisMs: number;
  readonly ttsCostUsd: number;
  /**
   * OpenAI-reported prompt tokens for this turn's LLM request (distinct
   * from the character-count `promptTokens` heuristic used for cost
   * estimation above). Only a streaming provider that reports usage
   * populates this — see `LlmFinalEvent`.
   */
  readonly reportedPromptTokens?: number;
  /** Of `reportedPromptTokens`, how many were served from the prompt-prefix cache. */
  readonly cachedPromptTokens?: number;
  /** Reasoning tokens generated before the first visible content token. */
  readonly reasoningTokens?: number;
  /**
   * FIX #7A — OpenAI-reported completion tokens for this turn's reply,
   * when the provider supplied them (see `LlmFinalEvent.completionTokens`).
   * Telemetry only, and a real measurement rather than the
   * character-count heuristic `estimateTokenCount` falls back to.
   */
  readonly reportedCompletionTokens?: number;
  /** FIX #7A — number of sentence-level TTS invocations this turn produced (1 on the non-streaming LLM path). Telemetry only. */
  readonly ttsChunkCount: number;
}

// ------------------------------------------------------------------
// Voice-safe output validation
// ------------------------------------------------------------------

/**
 * Strips markdown formatting that would sound wrong when read aloud
 * by TTS. Only removes formatting — NOT content. Prompt-echo
 * contamination is handled by `isContaminatedOutput` + retry, not
 * by regex stripping.
 */
function stripMarkdown(raw: string): string {
  let text = raw;

  // Remove markdown bullet points and numbered lists (e.g. "- ", "* ", "1. ")
  text = text.replace(/^[\t ]*[-*•]\s+/gm, "");
  text = text.replace(/^[\t ]*\d+\.\s+/gm, "");

  // Remove markdown headers ("# ", "## ", etc.)
  text = text.replace(/^[\t ]*#{1,6}\s+/gm, "");

  // Remove bold / italic markers (* ** _ __ ` ``)
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  text = text.replace(/_{1,3}([^_]+)_{1,3}/g, "$1");
  text = text.replace(/`{1,3}([^`]+)`{1,3}/g, "$1");

  // Collapse multiple newlines into a single space (voice is continuous)
  text = text.replace(/\n{2,}/g, " ");
  text = text.replace(/\n/g, " ");

  // Collapse multiple spaces
  text = text.replace(/ {2,}/g, " ");

  return text.trim();
}

/**
 * The full text -> speech conversion applied to everything the caller
 * hears: strip formatting TTS would read aloud, then enforce the
 * conversational rules the system prompt only asks for (no hesitation
 * openers, no stacked acknowledgements, no textbook Hindi, no ellipsis
 * dead air).
 */
function toSpokenText(raw: string): string {
  return formatForSpeech(stripMarkdown(raw));
}

/**
 * Detects prompt-contaminated output — the model has echoed system
 * instructions instead of producing a natural reply. Any output
 * matching this check is NEVER spoken. The pipeline retries with
 * a simplified prompt instead.
 */
const CONTAMINATION_MARKERS = [
  "role:",
  "persona:",
  "constraint",
  "language:",
  "how to talk:",
  "remember:",
  "context:",
  "instructions:",
  "system prompt:",
  "developer notes:",
  "as a voice assistant",
  "i was instructed",
  "my role is",
  "voice assistant on a",
];

function isContaminatedOutput(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTAMINATION_MARKERS.filter((m) => lower.includes(m)).length >= 2;
}

/** Language-appropriate fallback greetings when the LLM fails or produces contaminated output. */
function fallbackGreeting(language: SupportedLanguage): string {
  switch (language) {
    case "hi":
      return "नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?";
    case "hi-en":
      return "Hey, namaste! Kaise help kar sakta hoon aapki?";
    default:
      return "Hey! How can I help you today?";
  }
}

/** Maximum characters for a greeting — anything longer is almost certainly a prompt echo. */
const MAX_GREETING_CHARS = 200;

/**
 * Compensates for the small startup buffer the telephony bridges fill
 * before their playback pump sends its first frame. Keeps the drain
 * from finishing marginally early and re-opening the "queue still
 * playing while state says LISTENING" gap it exists to close.
 */
const PLAYBACK_PREROLL_ALLOWANCE_MS = 150;

/**
 * How much of its own reply the assistant must still have left to
 * speak before a bare acknowledgement counts as backchannel rather
 * than as an answer.
 *
 * This is the whole safety margin of the backchannel rule, so it is
 * set from the approved script rather than from taste. The
 * commitment question is the second-to-last line of its block —
 * "Would you be interested to attend?" is followed by "The
 * registration is completely FREE.", roughly two seconds of speech.
 * A caller answering that question therefore has at most ~2s of reply
 * left when their "haan" is recognised, and must be heard normally:
 * that answer is the registration.
 *
 * 4000ms is double that, so an answer at the gate is never absorbed,
 * while the long explanation blocks — where the queued reply runs many
 * seconds ahead of playback — are fully covered. A short reply (a
 * one-sentence answer to a question) never reaches this threshold at
 * all and so keeps exactly today's barge-in behaviour.
 *
 * Measured from the same span `drainPlayback` waits out, so "still
 * speaking" means here what it already means everywhere else.
 */
const BACKCHANNEL_MIN_REMAINING_SPEECH_MS = 4_000;

/**
 * A bare greeting and nothing else.
 *
 * `isBareAcknowledgement` deliberately EXCLUDES "hello": said over a
 * reply that is already playing it means the line has gone bad, and it
 * must interrupt. That reasoning is about audio the caller is failing
 * to hear, so it does not apply while the assistant is still THINKING —
 * nothing is playing to have gone bad. A caller who says "hello" into
 * that gap is filling a silence, not opening a new subject, and
 * throwing away the answer they are waiting for is the "the script
 * restarted because I said hello" complaint in its other form.
 *
 * So this is read at exactly one place — the supersession test in
 * `newerUserTurnWaiting`, where nothing has been spoken yet. Barge-in
 * keeps `isBareAcknowledgement` and is completely unaffected: a "hello"
 * over a playing reply still interrupts it, exactly as today.
 */
const BARE_GREETING_ONLY =
  /^(?:(?:hello|hallo|helo|hullo|hi|hii+|hey|haan ji|haanji|hanji|namaste|namaskar|हैलो|हेलो|नमस्ते|नमस्कार)[\s,.!?…।-]*)+$/iu;

/**
 * ---------------- "Hello? Can you hear me?" ----------------
 *
 * A caller who says nothing but "Hello?" over a reply that is already
 * PLAYING is not opening a subject and is not objecting. They are
 * asking one question — "is this line still alive?" — and the only
 * answer to it is a short one, said quickly.
 *
 * `isBareAcknowledgement` deliberately excludes "hello" and must keep
 * excluding it: over audio the caller is hearing, it means the line may
 * have gone bad, so it MUST still interrupt. That judgement is correct
 * and is not touched here. What was missing is what happens AFTER the
 * interruption. The reply was cancelled, the part the caller heard was
 * committed, and the part they did not hear — already computed by
 * `unspokenTail` — was dropped on the floor the instant the "hello"
 * became a turn (`resumeAfterStrandedBargeIn` abandons on any turn
 * material, by design). The next request was then a full generation
 * over the campaign prompt with no record of where the block stopped,
 * so the likeliest completion was the block's own opening sentence —
 * which is the reported "it starts the script again", and once per
 * "hello".
 *
 * So this is a turn CLASS, read in the main loop between the user turn
 * being committed and the language model being called. It uses the
 * position the pipeline already computes rather than adding a second
 * one, it never reaches the model, and it is bounded to the exact case
 * it is for: an attention check is only ever handled here when a
 * cancelled reply left an unheard remainder to resume. With no
 * remainder held, every utterance below takes the normal contextual
 * path it takes today.
 *
 * THE WHOLE UTTERANCE MUST BE THE CHECK. "Hello? What is this about?"
 * is a real question with a greeting in front of it and is matched by
 * nothing here, so it is answered by the normal path exactly as it is
 * today. That distinction is the entire safety case for this class,
 * which is why it is a closed vocabulary and not a prompt instruction.
 */
const ATTENTION_PRESENCE_PHRASES = [
  // English
  "can you hear me", "can u hear me", "can you hear", "do you hear me",
  "are you hearing me", "am i audible", "is my voice audible",
  "are you there", "are u there", "you there", "still there",
  "are you still there", "are you listening", "is anyone there",
  "anybody there", "anyone there", "is somebody there",
  // Hinglish (transliterated)
  "sun rahe ho", "sun rahe hain", "sun rahe hai", "aap sun rahe hain",
  "aap sun rahe ho", "sunai de raha hai", "sunai de rahi hai",
  "awaaz aa rahi hai", "awaz aa rahi hai", "aawaz aa rahi hai",
  "suniye", "sun paa rahe hain", "sun pa rahe hain", "hain aap", "aap hain",
  // Devanagari
  "सुन रहे हो", "सुन रहे हैं", "आप सुन रहे हैं", "सुनाई दे रहा है",
  "आवाज़ आ रही है", "आवाज आ रही है", "सुनिए", "आप हैं", "क्या आप हैं",
];

/**
 * Words that may surround a presence check without making it something
 * else — greetings, vocatives and politeness. Nothing here carries a
 * subject, so an utterance made only of these plus the phrases above
 * still asks one question and nothing more.
 *
 * The greeting alternation deliberately DUPLICATES `BARE_GREETING_ONLY`
 * rather than being factored out of it. That constant is read by the
 * backchannel and supersession paths, which this fix must leave
 * byte-identical; a shared table would mean a future edit here silently
 * changing those.
 */
const ATTENTION_FILLER =
  "hello|hallo|helo|hullo|hi|hii+|hey|namaste|namaskar|हैलो|हेलो|नमस्ते|नमस्कार" +
  "|please|kya|क्या|ji|जी|sir|madam|ma'am|aap|आप|to|toh";

/**
 * The WHOLE utterance is a presence check — a greeting, a "can you hear
 * me", or the two stacked, and nothing else. Anything with content of
 * its own falls through to the normal contextual path.
 */
const ATTENTION_PRESENCE_ONLY = new RegExp(
  `^(?:(?:${ATTENTION_FILLER}|${ATTENTION_PRESENCE_PHRASES.join("|")})[\\s,.!?…।-]*)+$`,
  "iu",
);

/**
 * Is this utterance nothing but the caller checking we are still here?
 *
 * `BARE_GREETING_ONLY` is reused for the pure-greeting half so a
 * repeated "hello hello" is read the same way in both places.
 *
 * Exported for the same reason `unspokenTail` is: the boundary between
 * "Hello?" and "Hello? What is this about?" is the entire safety case
 * for this turn class, and a table is only safe if a test can assert
 * both sides of it directly.
 */
export function isAttentionCheck(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return BARE_GREETING_ONLY.test(trimmed) || ATTENTION_PRESENCE_ONLY.test(trimmed);
}

/**
 * "Yes, I can hear you." — the caller answering the acknowledgement's
 * own question, which is the cue to carry on from where the reply
 * stopped.
 *
 * Read at ONE place and only while an attention episode is open, i.e.
 * only in the turn immediately after the assistant asked "can you hear
 * me?". A bare "yes" anywhere else is untouched by this and reaches the
 * classifier and the registration gate exactly as it does today.
 */
const HEARING_CONFIRMATION_ONLY = new RegExp(
  "^(?:(?:yes|yeah|yep|yup|ya|yaa|yes i can|yes i can hear you|i can hear you|" +
    "i can hear|can hear you|i hear you|loud and clear|clear|perfectly|" +
    "haan|haa|han|hanji|han ji|haan ji|ji|ji haan|theek hai|thik hai|" +
    "sun raha hoon|sun rahi hoon|sun raha hu|haan sun raha hoon|" +
    "sunai de raha hai|awaaz aa rahi hai|aa rahi hai|" +
    "हाँ|हां|जी|जी हाँ|सुन रहा हूँ|सुन रही हूँ|आवाज़ आ रही है|ठीक है)" +
    "[\\s,.!?…।-]*)+$",
  "iu",
);

/**
 * The one short line an attention check is answered with. Deliberately
 * fixed text, for the same reason the greeting is: it must be said
 * within a TTS request rather than a language-model round trip, and it
 * must never be an opportunity to regenerate the campaign script.
 *
 * Every form survives `toSpokenText` unchanged — none of the leading
 * fillers, stacked acknowledgements or phrase substitutions in
 * `speech-formatter.ts` matches any of them — which is what lets the
 * commit site below compare what was spoken against what was heard.
 */
function attentionAcknowledgementFor(language: SupportedLanguage): string {
  switch (language) {
    case "hi":
      return "हैलो, क्या आप मुझे सुन पा रहे हैं? मैं यहीं हूँ।";
    case "hi-en":
      return "Hello, aap mujhe sun paa rahe hain? Main yahin hoon.";
    default:
      return "Hello, can you hear me? I'm here.";
  }
}

/**
 * ---------------- Reached a machine, not a person ----------------
 *
 * A voicemail greeting opens the media stream exactly like a human
 * answer does, so the pipeline used to start its script and deliver the
 * whole pitch to an answering machine — a call paid for, a script
 * spent, and a transcript of a recording for the classifier to read.
 *
 * There is no carrier verdict to consult (`external-limits.ts` records
 * answering-machine detection as unavailable on both providers), so the
 * only signal available is the one thing a machine reliably does: it
 * says machine things. `voicemail-detection.ts` owns that vocabulary —
 * the SAME table the outcome classifier has always used to keep a
 * voicemail from being read as a registration.
 *
 * ONLY EVER A HEURISTIC, so the window it may fire in is deliberately
 * narrow, and both bounds are load-bearing:
 *
 *   - `turnIndex === 0` — nothing the agent said has been answered yet.
 *     A machine never answers, so it never leaves this window; a person
 *     who has had one exchange with the agent can never be silenced by
 *     this, whatever they go on to say.
 *   - the time window — a machine's greeting is the FIRST thing on the
 *     line and is over in seconds. Later in a call, "leave a message"
 *     is a person talking about their phone.
 *
 * A false positive costs one attempt and nothing else: the call is
 * classified `no_engagement`, which for a registration campaign is NOT
 * terminal — `planRegistrationRetry` schedules the contact again.
 */
const VOICEMAIL_DETECTION_WINDOW_MS = 20_000;
/**
 * Cap on the early transcript held for matching. A marker phrase is at
 * most a few words, so this only has to span the seam between two
 * finals — it is not a buffer of the call.
 */
const VOICEMAIL_TRANSCRIPT_CAP = 400;

/**
 * ---------------- Is this the CALLER interrupting us? ----------------
 *
 * A transcript arriving while the assistant is speaking is not, on its
 * own, evidence that the caller is talking over it. Deepgram is handed
 * one mixed mono telephony channel and transcribes everything on it:
 * a television, a second person across the room, a shop counter, and
 * the echo of our own audio out of the caller's earpiece. Every one of
 * those used to trigger a barge-in, which aborts the LLM/TTS stream and
 * drops the whole outbound queue — so the assistant fell silent
 * mid-sentence for a voice that was never speaking to it. That is the
 * reported "it recognises background voices and goes quiet" behaviour.
 *
 * Nothing in a transcript can separate those from the caller. What
 * separates them is LOUDNESS: the near-end speaker's mouth is
 * centimetres from the microphone and everything else in the room is
 * metres away. The transports already measure that (see the loud gate
 * in `vad-segmenter.ts`) and stamp `record.lastCallerEnergyAt`, so a
 * barge-in now needs BOTH signals to agree — words from Deepgram, and
 * loud near-end speech from the transport at the same moment.
 *
 * A transcript that is NOT corroborated is treated exactly like a
 * backchannel: ignored, so the assistant finishes its sentence. This
 * cannot strand a soft-spoken caller, because the whole test only
 * applies while the assistant is SPEAKING — every segment that arrives
 * while it is LISTENING or THINKING feeds the turn detector completely
 * ungated, exactly as before.
 */
const BARGE_IN_ENERGY_WINDOW_MS = 2_000;
/**
 * Confidence floor for a segment allowed to interrupt.
 *
 * Distant and overlapped speech scores markedly lower than near-end
 * speech, so this is a second, independent filter on the same class of
 * false interruption. Applied ONLY when the provider reports a non-zero
 * confidence: `0` means "not reported" (batch results, providers with
 * no such field) and must not be read as "no confidence at all".
 *
 * Deliberately low. Deepgram runs here in `multi` language mode for
 * Hinglish code-switching, where genuine near-end speech scores lower
 * than it would on monolingual audio, and blocking a real interruption
 * is a worse failure than allowing a marginal one — the energy gate
 * above is what does the heavy lifting.
 */
const BARGE_IN_MIN_CONFIDENCE = 0.4;

/**
 * ---------------- The STT stream clock can rewind ----------------
 *
 * The interruption test below asks "did these words happen AFTER I
 * started speaking", and answers it by comparing Deepgram's word times
 * (`segment.endedAtMs`) against `speakingStartedAtStreamMs`, a snapshot
 * of `inboundStreamMs`. That comparison is only meaningful while the
 * two are the same clock, and they are not:
 *
 *   - `inboundStreamMs` counts every byte handed to the STT provider
 *     and is monotonic for the WHOLE CALL.
 *   - `segment.endedAtMs` is measured from the start of the audio the
 *     provider's CURRENT WEBSOCKET has received.
 *
 * `@deepgram/sdk` hands back a reconnecting socket, and the provider
 * deliberately keeps the transcript stream alive across a reconnect
 * (ending it on the first blip used to kill the rest of the call). A
 * reconnect opens a NEW Deepgram stream, so its word clock restarts at
 * zero while `inboundStreamMs` keeps climbing. From that instant
 * `endedAtMs` is a small number and the snapshot is a large one, the
 * test is false for every segment, and BARGE-IN IS DEAD FOR THE REST
 * OF THE CALL — silently, because a segment that fails the test is not
 * logged: it simply falls through to the turn detector, so the caller
 * is still transcribed and still answered, just never able to
 * interrupt. "Deepgram hears my 'hello?' and the agent talks over it."
 *
 * So a rewind is detected and the offset between the two clocks is
 * recorded, rather than the reported time being trusted raw. On a call
 * that never reconnects the offset stays `0` and every comparison is
 * byte-for-byte the one made before.
 */
/**
 * How far behind the furthest point the call has reached a segment may
 * land before it is read as a NEW stream rather than as noise.
 *
 * Within one connection the word clock is effectively monotonic —
 * interim results extend the utterance, they do not retract seconds of
 * it — so nothing legitimate moves it back this far. A reconnect moves
 * it back by however long the call had been running, which is larger
 * than this from two seconds into any call onwards.
 */
const STT_CLOCK_REWIND_TOLERANCE_MS = 2_000;

/**
 * ---------------- Stranded after a barge-in ----------------
 *
 * A barge-in cancels the reply in flight and drops the outbound queue.
 * Normally the caller's interrupting words then become the next turn
 * and are answered — but they do not always become a turn at all. A
 * cough, a door, a half-word, a hesitation sound (`FILLER_ONLY` is
 * dropped by the turn detector by design), a transcript Deepgram never
 * finalised: each of those can cancel the reply and leave nothing
 * behind to reply TO. The session then sits in LISTENING with the
 * assistant mid-sentence and no reply on the way, and the caller hears
 * dead air. They say "hello?", which is answered, or they hang up.
 *
 * So a cancelled reply that leaves the caller in silence is resumed
 * from exactly where playback stopped — the words that were already
 * synthesized or generated and never heard. No LLM round trip, so it
 * starts speaking within a TTS request rather than in a couple of
 * seconds, and it continues the script rather than restarting it.
 *
 * Guarded to the one case it is for: the resume is abandoned the moment
 * the caller produces any turn material at all, so a real interruption
 * is answered by the normal contextual path and never by this.
 */
/** Silence from the caller that says the barge-in produced no turn. */
const STRANDED_RESUME_QUIET_MS = 700;
/** Never wait longer than this for the line to go quiet before deciding. */
const STRANDED_RESUME_MAX_WAIT_MS = 2_500;
/** How often the wait re-checks, so a real turn is picked up promptly. */
const STRANDED_RESUME_POLL_MS = 100;
/**
 * Hard cap per call. Bounds the pathological case — a caller on a noisy
 * line whose every barge-in yields no turn — so this can never become a
 * loop that talks over them repeatedly.
 */
const MAX_STRANDED_RESUMES = 3;

/**
 * The part of `fullText` the caller has NOT heard, given the prefix
 * they have (`heardText`, from `heardSoFarText`).
 *
 * `heardText` is the spoken utterances joined by single spaces, and
 * each of those is a trimmed slice of `fullText`, so the two agree on
 * every non-whitespace character and can disagree on whitespace. The
 * walk below compares them ignoring whitespace and returns the rest of
 * `fullText` from the point the prefix ends.
 *
 * Returns `""` — resume nothing — the moment they diverge. Speech
 * formatting is applied per utterance as well as to the whole reply, so
 * the two are not guaranteed to line up; when they do not, saying
 * nothing is correct and guessing is not.
 */
export function unspokenTail(fullText: string, heardText: string): string {
  const heard = heardText.trim();
  if (heard.length === 0) return fullText.trim();

  const isSpace = (ch: string): boolean => /\s/u.test(ch);
  let i = 0;
  let j = 0;
  while (i < fullText.length && j < heard.length) {
    if (isSpace(fullText[i]!)) {
      i += 1;
      continue;
    }
    if (isSpace(heard[j]!)) {
      j += 1;
      continue;
    }
    if (fullText[i] !== heard[j]) return "";
    i += 1;
    j += 1;
  }
  while (j < heard.length && isSpace(heard[j]!)) j += 1;
  // The "heard" text is not a prefix of the reply at all.
  if (j < heard.length) return "";
  return fullText.slice(i).trim();
}

/**
 * Upper bound on a believable STT recognition lag, used only to
 * discard nonsense samples from the benchmark (see
 * `lastFinalSttLagMs`). Purely a metrics guard — it gates no
 * transcript, no turn and no audio.
 */
const MAX_PLAUSIBLE_STT_LAG_MS = 10_000;

/**
 * One end-to-end latency trace per turn.
 *
 * The pipeline's stages run across three different async contexts
 * (the STT listener, the LLM stream, the TTS stream), so "where did
 * the time go" was previously only answerable by diffing wall-clock
 * timestamps across unrelated log lines. This emits every stage of a
 * single turn on a shared clock instead:
 *
 *   greeting:     call-connected -> tts-first-chunk -> audio-queued
 *   normal turn:  turn-detected -> llm-request -> llm-first-token
 *                 -> tts-first-chunk -> audio-queued
 *
 * `audio-queued` is the moment the first frame reaches the transport;
 * the caller hears it one bridge pre-roll (~100ms) later.
 */
class TurnTimer {
  private readonly startedAt: number;
  private readonly marks: string[] = [];
  /** Same instants as `marks`, keyed by stage, as absolute wall clock — lets `printLatencyBreakdown` compute a delta between any two named stages instead of only "since turn start". */
  private readonly absoluteMarks = new Map<string, number>();

  constructor(
    private readonly sessionId: string,
    private readonly label: string,
    /**
     * Overrides the timer's t0. Used for a normal/attention turn so
     * "elapsed since start" is elapsed since the ACTUAL turn release
     * (`AcquiredTurn.turnReleasedAtMs`) rather than since this object
     * happened to be constructed a microtask or two later. Omitted by
     * the greeting/resume timers, which have no such external t0.
     */
    startedAtOverride?: number,
  ) {
    this.startedAt = startedAtOverride ?? Date.now();
  }

  mark(stage: string): void {
    const now = Date.now();
    const at = now - this.startedAt;
    this.marks.push(`${stage}=${at}ms`);
    this.absoluteMarks.set(stage, now);
    // eslint-disable-next-line no-console
    console.log(`[TIMING:${this.sessionId}] ${this.label} ${stage} +${at}ms`);
  }

  summarize(): void {
    // eslint-disable-next-line no-console
    console.log(
      `[TIMING:${this.sessionId}] ${this.label} SUMMARY total=${Date.now() - this.startedAt}ms ${this.marks.join(" ")}`,
    );
  }

  /**
   * FIX #7A — read-only latency trace for one turn, printed in
   * addition to (never instead of) `summarize()` above. Every value
   * here is either an absolute timestamp captured at the actual event
   * (passed in via `opts`, or recorded by a prior `mark()` call) or a
   * subtraction of two such timestamps — never inferred from an
   * unrelated total. A boundary with no timestamp on either side
   * prints "NOT DIRECTLY MEASURABLE" rather than a guessed number.
   */
  printLatencyBreakdown(opts: {
    readonly speechEndAtMs: number | undefined;
    readonly endpointEvidenceAtMs: number | undefined;
    readonly endpointEvidenceKind: string | undefined;
  }): void {
    const turnRelease = this.startedAt;
    const at = (stage: string): number | undefined => this.absoluteMarks.get(stage);
    const llmRequest = at("llm-request");
    const llmFirstToken = at("llm-first-token");
    const firstSentence = at("first-sentence-ready");
    const ttsRequest = at("tts-request");
    const ttsFirstAudio = at("tts-first-chunk");
    const audioQueued = at("audio-queued");

    const ts = (ms: number | undefined): string => (ms === undefined ? "NOT DIRECTLY MEASURABLE" : new Date(ms).toISOString());
    const delta = (fromMs: number | undefined, toMs: number | undefined): string =>
      fromMs === undefined || toMs === undefined ? "NOT DIRECTLY MEASURABLE" : `${toMs - fromMs}ms`;

    // eslint-disable-next-line no-console
    console.log(
      `[TIMING:${this.sessionId}] ${this.label}\n` +
        `speech-end=${ts(opts.speechEndAtMs)}\n` +
        `endpoint-evidence=${ts(opts.endpointEvidenceAtMs)}${opts.endpointEvidenceKind ? ` (${opts.endpointEvidenceKind})` : ""}\n` +
        `turn-release=${ts(turnRelease)}\n` +
        `llm-request=${ts(llmRequest)}\n` +
        `llm-first-token=${ts(llmFirstToken)}\n` +
        `first-sentence-ready=${ts(firstSentence)}\n` +
        `tts-request=${ts(ttsRequest)}\n` +
        `tts-first-audio=${ts(ttsFirstAudio)}\n` +
        `audio-queued=${ts(audioQueued)}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[TIMING:${this.sessionId}] ${this.label} DELTAS\n` +
        `endpoint-to-release=${delta(opts.endpointEvidenceAtMs, turnRelease)}\n` +
        `release-to-llm-request=${delta(turnRelease, llmRequest)}\n` +
        `llm-to-first-token=${delta(llmRequest, llmFirstToken)}\n` +
        `first-token-to-sentence=${delta(llmFirstToken, firstSentence)}\n` +
        `sentence-to-tts=${delta(firstSentence, ttsRequest)}\n` +
        `tts-to-first-audio=${delta(ttsRequest, ttsFirstAudio)}\n` +
        `first-audio-to-queue=${delta(ttsFirstAudio, audioQueued)}\n` +
        `speech-end-to-audio=${delta(opts.speechEndAtMs, audioQueued)}`,
    );
  }
}

/**
 * FIX #7A — telemetry only. Caller-requested brevity ("keep it short",
 * "one line", "just briefly") is checked against the raw user text so
 * we can report whether the model honored it — nothing here alters
 * the request, the prompt, or the response.
 */
const BREVITY_PHRASES = [
  "short",
  "briefly",
  "brief",
  "one line",
  "one-line",
  "one word",
  "quick answer",
  "quickly",
  "concise",
  "in short",
  "just answer",
  "straight answer",
];

function detectBrevityRequest(userText: string): string | undefined {
  const lower = userText.toLowerCase();
  return BREVITY_PHRASES.find((phrase) => lower.includes(phrase));
}

export class ConversationPipeline {
  private readonly usesStreamingStt: boolean;
  private sinceLastTurnBytes = 0;
  private sinceLastTurnEncoding: AudioPayload["encoding"] | undefined;
  private sinceLastTurnSampleRateHz: number | undefined;
  private batchAudioIterator: AsyncIterator<AudioPayload> | undefined;
  /** Total inbound audio (ms) handed to the STT stream so far — the same clock Deepgram's word times use. */
  private inboundStreamMs = 0;
  /** Value of `inboundStreamMs` when the current SPEAKING phase began. */
  private speakingStartedAtStreamMs = 0;
  /**
   * Furthest point the STT stream has reached ON THE CALL-LONG
   * TIMELINE — i.e. after the offset below has been applied. A segment
   * that lands far behind this is the stream having restarted; see
   * `STT_CLOCK_REWIND_TOLERANCE_MS`. Held in re-based terms rather than
   * as-reported so that a SECOND restart is measured against real call
   * progress: a per-connection mark restarts low with its stream, and
   * would go blind to the next restart until it had climbed back.
   */
  private sttClockHighWaterMs = 0;
  /**
   * Milliseconds to add to a reported `endedAtMs` to place it on
   * `inboundStreamMs`'s call-long timeline. Zero — and therefore
   * arithmetically invisible — until the STT stream restarts.
   */
  private sttClockOffsetMs = 0;
  /** Latency trace for the turn currently in flight, if any. */
  private activeTimer: TurnTimer | undefined;
  /** Guards `tts-first-chunk` / `audio-queued` so they mark the FIRST occurrence of each per turn. */
  private markedTtsThisTurn = false;
  private markedAudioThisTurn = false;
  /** FIX #7A — guards `first-sentence-ready` / `tts-request` the same way, one mark per turn. */
  private markedFirstSentenceThisTurn = false;
  private markedTtsRequestThisTurn = false;
  /**
   * FIX #7A — arrival time of the most recent Deepgram end-of-speech
   * evidence (`UtteranceEnd`, or a final segment with `speech_final`)
   * that actually reached the turn detector — i.e. was not filtered
   * out as backchannel/uncorroborated speech first. Snapshotted and
   * cleared by `waitForTurnDetectorEnd`'s `onTurnEnd` handler the same
   * way `lastFinalSttLagMs`/`lastFinalSegmentAtMs` already are, so it
   * cannot leak into the next turn's trace.
   */
  private lastEndpointEvidenceAtMs: number | undefined;
  private lastEndpointEvidenceKind: "utterance_end" | "speech_final" | undefined;
  /**
   * True while the caller's CURRENT utterance has already been judged
   * backchannel. Keeps one utterance treated consistently: its interim
   * may be recognised with seconds of reply left and its final only
   * once the reply is nearly over, and half of an ignored "okay"
   * becoming a turn is the one outcome worse than either choice.
   * Cannot outlive the assistant's turn — every read of it is guarded
   * by `spokeOverTheAssistant`.
   */
  private backchannelInFlight = false;
  /**
   * False until the greeting has finished. The STT listener now runs
   * from call-connect (see `run()`), so this is what keeps the
   * greeting's own SPEAKING phase from being barge-in-able — exactly
   * the property deferring the listener used to provide.
   */
  private greetingDone = false;
  /**
   * Set once, when the live transcript shows we are talking to a
   * machine. From that instant the agent says NOTHING for the rest of
   * the call — see `synthesizeAndPlay`, which is the single choke point
   * every spoken word goes through. Never cleared: a machine does not
   * turn into a person.
   */
  private voicemailDetected = false;
  /** Wall clock at which `run()` started — the origin of the detection window. */
  private runStartedAtMs = 0;
  /** Finals heard so far inside the detection window, bounded. */
  private earlyTranscript = "";
  /**
   * ---------------- Assistant response lifecycle ----------------
   *
   * PENDING/SPEAKING -> COMPLETED -> committed to `memory`
   * PENDING/SPEAKING -> CANCELLED -> discarded, never committed
   *
   * `runThinkingAndSpeaking` returns NORMALLY on barge-in (the LLM
   * stream breaks, `drainPlayback` resolves early) and hands back
   * whatever text had accumulated — including the complete reply when
   * the model finished streaming while its audio was still queued on
   * the transport. Nothing in that result says "this was cut off", so
   * the commit site had no way to tell an interrupted reply from a
   * finished one and committed both.
   *
   * An id rather than a boolean flag: the cancellation is recorded
   * against the specific response that was in flight, so a stream that
   * produces its last chunk (or its `final` event) after the barge-in
   * handler has already run cannot commit itself, and — equally — a
   * barge-in that lands when no response is pending cannot cancel the
   * NEXT one, which takes a fresh id.
   */
  /** Id of the assistant response currently PENDING/SPEAKING. */
  private currentResponseId = 0;
  /** Id of the response a barge-in cancelled, if any. */
  private cancelledResponseId: number | undefined;
  /**
   * The part of the cancelled response the caller had ACTUALLY HEARD,
   * frozen at the instant of cancellation.
   *
   * A cancelled response is still not committed as if it had been
   * delivered — that design is unchanged and correct. But discarding
   * ALL of it, including the sentences the caller already listened to,
   * is what let the script restart: the model's history said it had
   * never spoken, so the next request regenerated the same block from
   * the top and the caller heard the introduction again.
   *
   * So the two halves of an interrupted reply are now separated. What
   * played is history (it happened, the caller heard it, and it is what
   * "continue from where you were" is relative to). What was still
   * queued, or never synthesized at all, is discarded exactly as
   * before. Computed inside `triggerExternalBargeIn` — the single
   * choke point every cancellation goes through — because playback
   * stops there, and reading the clock any later would count audio the
   * transport had already thrown away.
   */
  private cancelledHeardText = "";
  /**
   * Resumes spent on this call, against `MAX_STRANDED_RESUMES`. Bounds
   * the pathological case where a noisy line barges in over and over
   * and never produces a turn.
   */
  private strandedResumes = 0;
  /**
   * WHERE THE SCRIPT STOPPED — the part of the last cancelled reply the
   * caller never heard, kept across loop iterations so an attention
   * check can be resumed from it instead of regenerated.
   *
   * This is the one piece of state the fix adds, and existing state
   * genuinely cannot carry it. `unspokenTail` already computes the
   * value, but only as a local in the iteration that was interrupted;
   * conversation memory holds only what the caller HEARD, by design,
   * so the unheard tail exists nowhere else once that local goes out of
   * scope. It is a slice of an LLM reply, so it is not recoverable from
   * the script either.
   *
   * Set only when a cancelled reply left a remainder that
   * `resumeAfterStrandedBargeIn` did not speak, and cleared by the
   * first turn that is not an attention check — so it can never be
   * spoken into a conversation that has moved on.
   */
  private heldScriptRemainder = "";
  /**
   * An acknowledgement has been given and the caller has said nothing
   * since but more attention checks. This is what coalesces a repeated
   * "Hello? Hello? Hello?" into ONE acknowledgement.
   *
   * A boolean rather than a reading of the history, because the
   * acknowledgement can itself be barged in on: what is committed is
   * then a TRUNCATED PREFIX of it, so no exact test over the last
   * assistant turn identifies an open episode — which is precisely the
   * case (a second "hello" over the acknowledgement) this flag exists
   * to handle.
   */
  private attentionEpisodeOpen = false;
  /**
   * FIX #8 — the LLM request pre-opened for the turn the detector is
   * currently holding in its evidenced confirmation window, if any. See
   * `SpeculativeCompletion`. At most one at a time; replaced or
   * abandoned by the sites listed there.
   */
  private speculation: SpeculativeCompletion | undefined;
  /**
   * FIX #8 — true only while `waitForTurnDetectorEnd` is subscribed,
   * i.e. the main loop is idle in LISTENING waiting for the caller's
   * next turn. That is the ONLY window a speculation may start in: any
   * other time (greeting, THINKING, SPEAKING, the barge-in unwind, an
   * attention utterance) the pending-turn hook is ignored, so the
   * barge-in and buffered-turn paths see exactly the traffic they did.
   */
  private awaitingTurn = false;
  /**
   * ---------------- Metrics bookkeeping (read-only observers) ----------------
   * Everything below is written from points that already exist in the
   * flow and is read only by `recordTurn`. Nothing here feeds turn
   * detection, barge-in, STT, LLM, TTS or transport decisions.
   */
  /** Wall clock at which the most recent non-empty FINAL transcript segment arrived. */
  private lastFinalSegmentAtMs: number | undefined;
  /**
   * Recognition lag of that segment: `inboundStreamMs - segment.endedAtMs`.
   * Both operands are positions on the same audio-stream clock (the
   * barge-in check above already relies on that equivalence), so the
   * difference is how far behind the audio the transcript arrived.
   */
  private lastFinalSttLagMs: number | undefined;
  /** Wall clock at which this turn's FIRST audio frame reached the transport. */
  private firstAudioQueuedAtMs: number | undefined;

  constructor(
    private readonly record: SessionRecord,
    private readonly providers: ResolvedProviderStack,
    private readonly host: PipelineHost,
  ) {
    this.usesStreamingStt = typeof providers.stt.transcribeStream === "function";
  }

  /** Runs until the session's loop-abort signal fires or a fatal error occurs. */
  async run(): Promise<void> {
    const sid = this.record.id;
    // The media stream has just opened, so this is the moment the callee
    // picked up — the origin the voicemail detection window is measured
    // from. Stamped before the listener starts, so a marker in the very
    // first segment is inside the window.
    this.runStartedAtMs = Date.now();
    const loopSignal = this.record.loopAbortController?.signal;
    if (!loopSignal) {
      // eslint-disable-next-line no-console
      console.error(`[PIPELINE:${sid}] run() aborted — no loopAbortController on session record`);
      return;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[PIPELINE:${sid}] run() started — state=${this.record.state} streamingSTT=${this.usesStreamingStt} llm=${this.providers.llm.descriptor.id} tts=${this.providers.tts.descriptor.id} stt=${this.providers.stt.descriptor.id}`,
    );

    // --- Start the continuous listener BEFORE the greeting ---
    //
    // The listener used to start after the greeting had finished
    // playing, to stop the greeting being barged in on by the caller's
    // "Hello?" as they pick up. That worked, but it made the FIRST user
    // turn pay three costs no later turn pays:
    //
    //   1. Deepgram's websocket handshake (connect + waitForOpen) sat
    //      directly on the first turn's critical path — the provider's
    //      `checkHealth` does no network I/O, so warm-up never opens it.
    //   2. Inbound audio has been accumulating in the session's
    //      unbounded `AsyncQueue` since call-connect (no telephony
    //      provider implements `openMediaStream`, so that is always the
    //      source). By greeting-end that is ~4.5s of audio, which then
    //      burst-replayed into the socket — leaving Deepgram several
    //      hundred ms behind the live edge for the whole first turn.
    //   3. The caller's first words were therefore transcribed late,
    //      which delayed the turn detector, the LLM and the reply.
    //
    // Starting here removes all three: the handshake completes while
    // the greeting is playing, and audio streams in real time from the
    // first frame, so there is no backlog to catch up on. The greeting
    // stays exactly as protected as before — `greetingDone` gates the
    // barge-in check below, which is the only thing that could have
    // interrupted it. Everything else (turn detection, the display
    // transcript, metrics) runs live, so anything the caller says
    // during the greeting is already recognized and waiting to become
    // their first turn instead of arriving in a post-greeting burst.
    if (this.usesStreamingStt && !loopSignal.aborted) {
      this.startContinuousStt(loopSignal);
    }

    // --- Greeting phase: a dedicated startup action, NOT a turn ---
    // Skipped outright when the machine announced itself before we got
    // this far, which is the common case: its greeting starts the
    // instant the line opens and ours needs a TTS round trip first.
    if (!loopSignal.aborted && !this.voicemailDetected) {
      // --- The greeting is spoken, not generated ---
      //
      // The system prompt mandates ONE fixed opening line per language
      // ("Use one opening line only ... then stop and let them
      // answer"), so an LLM round trip here only regenerates a line
      // that is already decided — at a measured cost of ~2.0s on
      // GPT-5.1 and ~5.7s on Gemma 4 before a single audio frame can
      // exist. Speaking `openingLineFor` directly removes the entire
      // LLM leg from call-connect, which is the only way time-to-first-
      // audio can reach the ~1s target: even the fastest configured
      // model's time-to-first-token exceeds that budget on its own.
      //
      // Everything downstream is unchanged — the greeting is still
      // recorded in memory as the assistant's first turn, so the
      // model has full context from the caller's very first reply.
      // Benchmark metrics are unaffected: `metrics.recordTurn` was
      // never called for the greeting (it is a startup action, not a
      // turn), and every LLM-served turn is still measured.
      const timer = new TurnTimer(sid, "GREETING");
      // eslint-disable-next-line no-console
      console.log(`[PIPELINE:${sid}] Conversation started — speaking fixed greeting, state=${this.record.state}`);
      try {
        const greetingText = openingLineFor(this.record.memory.currentLanguage, this.record.voiceGender, this.record.campaignOpeningLine);
        timer.mark("greeting-text-ready");

        this.beginTurnTiming(timer);
        // Runs WHILE the greeting is being spoken, and is never awaited
        // — see `primeLlmPrefixCache`. It is started here rather than
        // after the greeting so the prefill overlaps greeting playback
        // instead of the caller's first reply.
        this.primeLlmPrefixCache(loopSignal);
        await this.speakFixedUtterance(greetingText, loopSignal);
        this.activeTimer = undefined;
        timer.summarize();

        if (this.voicemailDetected) {
          // Cut mid-line by the detection below. Deliberately NOT
          // committed: the transcript the outcome classifier reads
          // should contain the machine's greeting, which is the evidence
          // for the label, and not a fragment of ours that no person
          // heard.
          // eslint-disable-next-line no-console
          console.log(`[PIPELINE:${sid}] Greeting CUT SHORT — voicemail detected while it was playing`);
        } else {
          // eslint-disable-next-line no-console
          console.log(`[PIPELINE:${sid}] Greeting spoken: text="${greetingText}" state=${this.record.state}`);
          this.record.memory.recordAssistantTurn(greetingText);
        }
        this.record.bargeIn.reset();
      } catch (error) {
        this.activeTimer = undefined;
        if (!(error instanceof RecoverableTurnError)) {
          // eslint-disable-next-line no-console
          console.error(
            `[PIPELINE:${sid}] Greeting FATAL error: state=${this.record.state} error=${error instanceof Error ? error.message : String(error)} errorType=${error?.constructor?.name}`,
          );
          this.host.markError(this.record, "PIPELINE", error);
          return;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[PIPELINE:${sid}] Greeting RecoverableTurnError (recovering): state=${this.record.state} error=${error.message} source=${error.sourceCategory} cause=${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
        );
        // State may be THINKING or SPEAKING here after the error.
        // Recover to LISTENING so the main loop can proceed. The
        // state machine now allows THINKING → LISTENING for exactly
        // this recovery case.
        if (this.record.state !== SessionState.LISTENING) {
          try {
            this.host.transition(this.record, SessionState.LISTENING, "recovering from greeting error");
          } catch {
            // eslint-disable-next-line no-console
            console.error(`[PIPELINE:${sid}] Could not recover to LISTENING from state=${this.record.state} — ending pipeline`);
            this.host.markError(this.record, "PIPELINE", error);
            return;
          }
        }
      }
    }

    // --- Hand off to the normal contextual conversation flow ---
    // The greeting is done (or failed and recovered to LISTENING).
    // Release the barge-in gate: from here on, everything — turn
    // detection, barge-in, contextual replies — behaves exactly as it
    // always has. The listener itself has been running since before
    // the greeting (see above), so nothing has to be caught up here.
    this.greetingDone = true;

    // --- Main loop ---
    // eslint-disable-next-line no-console
    console.log(`[PIPELINE:${sid}] entering main loop — state=${this.record.state} aborted=${loopSignal.aborted}`);

    while (!loopSignal.aborted) {
      try {
        if (this.record.state !== SessionState.LISTENING) {
          this.host.transition(this.record, SessionState.LISTENING, "awaiting user speech");
        }

        const turn = await this.acquireNextUserTurn(loopSignal);
        if (!turn || loopSignal.aborted) {
          // eslint-disable-next-line no-console
          console.log(`[PIPELINE:${sid}] acquireNextUserTurn returned null or aborted — exiting loop`);
          break;
        }

        // eslint-disable-next-line no-console
        console.log(`[STT:${sid}] Transcript received: "${turn.text.slice(0, 80)}${turn.text.length > 80 ? "..." : ""}" userSpeechMs=${turn.userSpeechMs} sttLagMs=${turn.sttLagMs ?? "n/a"}`);

        // ── A machine, not a person ─────────────────────────────────
        //
        // Still RECORDED, and that is not incidental: the outcome
        // classifier reads this transcript and it is what labels the
        // call `suspected_voicemail` rather than an ordinary silent
        // call. But no reply is generated and nothing is spoken, so the
        // machine costs no language-model request, no synthesis and no
        // script. The call then ends on the existing silence watchdog
        // once the recording stops talking — no hangup logic is added
        // to the pipeline, exactly as before.
        if (this.voicemailDetected) {
          this.abandonSpeculation("voicemail — no reply is generated");
          const machineLanguage = detectLanguage(turn.text, this.record.memory.currentLanguage);
          this.record.memory.recordUserTurn(turn.text, machineLanguage.language);
          this.record.liveUserTranscript = "";
          // eslint-disable-next-line no-console
          console.log(`[PIPELINE:${sid}] voicemail — transcript recorded, nothing answered and nothing spoken`);
          continue;
        }

        // t0 for this turn's latency trace: the turn detector has just
        // endpointed, i.e. the caller has stopped speaking as far as
        // the pipeline is concerned. Everything after this is ours.
        const timer = new TurnTimer(sid, `TURN#${this.record.turnIndex}`, turn.turnReleasedAtMs);
        timer.mark("turn-detected");
        // The trace above starts at turn RELEASE, so everything the
        // caller actually waited through before that — Deepgram's
        // endpointing window, its delivery lag, and the detector's
        // confirmation hold — was invisible in the logs while being a
        // real part of the "why is the reply 2-3s late" question. This
        // is that span, from the wall clock at which the caller stopped
        // talking (`userSpeechEndedAtMs`, already computed for the
        // end-to-end metric) to the release this trace begins at.
        // Diagnostic only: read by nothing, changes no timing.
        if (turn.userSpeechEndedAtMs !== undefined) {
          // eslint-disable-next-line no-console
          console.log(
            `[TIMING:${sid}] TURN#${this.record.turnIndex} stt-to-release=${Date.now() - turn.userSpeechEndedAtMs}ms (sttLag=${turn.sttLagMs ?? "n/a"}ms)`,
          );
        }
        this.beginTurnTiming(timer);

        const detected = detectLanguage(turn.text, this.record.memory.currentLanguage);
        this.record.memory.recordUserTurn(turn.text, detected.language);
        // The committed turn now carries this text — drop the
        // display-only preview so it is not rendered twice.
        this.record.liveUserTranscript = "";

        // ── An attention check, not a new subject ─────────────────
        //
        // "Hello?" / "Can you hear me?" and nothing else, from a caller
        // whose interruption left part of a reply unheard. Answered
        // here — one short fixed line, or the unheard remainder itself
        // — and never handed to the language model, which is what stops
        // the campaign block being regenerated once per "hello".
        //
        // Returns false for everything else, including a greeting with
        // a real question attached to it, so every other turn reaches
        // `runThinkingAndSpeaking` on exactly the path it takes today.
        // Reached only after `metrics.recordTurn` has advanced
        // `turnIndex` at least once, so the voicemail window is closed
        // before this can run.
        // FIX #8 — `handleAttentionCheck` can only answer a turn itself
        // while a script position is held or an episode is open, and
        // `startSpeculation` already declines to start in either state,
        // so no pre-opened request should exist here. Belt to that
        // brace: if one somehow does, it is closed BEFORE the attention
        // utterance is spoken rather than left open for the seconds that
        // takes. Decided on the same two flags the handler reads.
        if (this.speculation !== undefined && (this.attentionEpisodeOpen || this.heldScriptRemainder.length > 0)) {
          this.abandonSpeculation("attention-check turn is answered without the language model");
        }
        if (await this.handleAttentionCheck(turn.text, loopSignal)) {
          this.abandonSpeculation("attention-check turn was handled without the language model");
          timer.summarize();
          // FIX #7A — attention-check turns still went through real
          // STT endpointing and turn release above; labelled ATTENTION
          // by `label` alone (see `speakAttentionUtterance`'s own
          // timer), so this one keeps reporting under its TURN# label
          // with whatever LLM/TTS stages did NOT run left as
          // "NOT DIRECTLY MEASURABLE" rather than fabricated.
          timer.printLatencyBreakdown({
            speechEndAtMs: turn.userSpeechEndedAtMs,
            endpointEvidenceAtMs: turn.endpointEvidenceAtMs,
            endpointEvidenceKind: turn.endpointEvidenceKind,
          });
          this.activeTimer = undefined;
          continue;
        }

        // The reply about to be generated is PENDING from here until it
        // either completes normally (committed below) or is cancelled by
        // a barge-in (discarded below). Taken BEFORE generation starts so
        // the id belongs to this response and no other.
        const responseId = this.beginAssistantResponse();
        const result = await this.runThinkingAndSpeaking(turn.text, detected, loopSignal);
        timer.summarize();
        timer.printLatencyBreakdown({
          speechEndAtMs: turn.userSpeechEndedAtMs,
          endpointEvidenceAtMs: turn.endpointEvidenceAtMs,
          endpointEvidenceKind: turn.endpointEvidenceKind,
        });
        this.activeTimer = undefined;
        // eslint-disable-next-line no-console
        console.log(`[PIPELINE:${sid}] Turn complete: assistant="${result.assistantText.slice(0, 80)}${result.assistantText.length > 80 ? "..." : ""}" llmMs=${result.llmMs} ttsMs=${result.ttsMs}`);
        // FIX #7A — response-length telemetry only: does not read from
        // or alter generation in any way. `estimateTokenCount` is the
        // same heuristic already used for cost above, reused here
        // rather than re-implemented; `reportedCompletionTokens` is the
        // real OpenAI usage count when the provider supplied one.
        {
          const brevityPhrase = detectBrevityRequest(turn.text);
          // eslint-disable-next-line no-console
          console.log(
            `[RESPONSE-LEN:${sid}] TURN#${this.record.turnIndex} userChars=${turn.text.length} assistantChars=${result.assistantText.length} ` +
              `estTokens=${estimateTokenCount(result.assistantText)} reportedCompletionTokens=${result.reportedCompletionTokens ?? "NOT DIRECTLY MEASURABLE"} ` +
              `ttsChunks=${result.ttsChunkCount} audioQueuedMs=${Math.round(this.outboundQueuedMs)} ` +
              `briefRequested=${brevityPhrase !== undefined}${brevityPhrase ? ` matchedPhrase="${brevityPhrase}"` : ""}`,
          );
        }
        // An interrupted reply is CANCELLED, not a completed assistant
        // turn: the caller talked over it, so committing it would put a
        // sentence the caller never let us finish between their own two
        // utterances and feed it to the next LLM request as if it had
        // been a real exchange. Their words are not lost — the turn
        // detector holds the interrupting utterance (see
        // `AdaptiveTurnDetector.pendingEvent`) and it becomes the next
        // user turn on the following iteration, so the model sees the
        // caller's latest thought as the live conversational state.
        // The unheard tail of a reply the caller cut off, if the
        // barge-in turns out to have produced no turn to answer. See
        // `resumeAfterStrandedBargeIn`, which runs at the end of this
        // iteration — after the metrics below — and decides.
        let strandedRemainder = "";
        if (this.isResponseCancelled(responseId)) {
          // The part that PLAYED is what the caller heard, so it is
          // what the conversation actually contains — see
          // `cancelledHeardText`. Committing it is what makes "carry on
          // from where you left off" a statement about something the
          // model can see; committing nothing is what made the next
          // request start the block again. The unplayed remainder is
          // still discarded, so nothing the caller never heard is ever
          // put into the assistant's mouth.
          const heard = this.cancelledHeardText;
          // eslint-disable-next-line no-console
          console.log(
            `[PIPELINE:${sid}] Response #${responseId} CANCELLED by barge-in — heard="${heard.slice(0, 80)}${heard.length > 80 ? "..." : ""}" discarded="${result.assistantText.slice(heard.length, heard.length + 80)}${result.assistantText.length > heard.length + 80 ? "..." : ""}"`,
          );
          if (heard.length > 0) this.record.memory.recordAssistantTurn(heard);
          strandedRemainder = unspokenTail(result.assistantText, heard);
        } else {
          this.record.memory.recordAssistantTurn(result.assistantText);
        }
        this.record.bargeIn.reset();

        // TRUE end-to-end response latency: the caller stopped talking
        // -> the first AI audio frame reached the transport. Both
        // endpoints are wall-clock stamps captured where those events
        // actually happen, so this is one measured span rather than a
        // sum of stages. It is deliberately NOT extended to cover the
        // rest of the reply — synthesis of later sentences, queue
        // drain and playback all happen while the caller is already
        // being spoken to, so none of it is latency they wait on.
        // Absent when the turn produced no audio at all (e.g. an
        // immediate barge-in), which reports as N/A rather than 0.
        const totalMs =
          turn.userSpeechEndedAtMs !== undefined && this.firstAudioQueuedAtMs !== undefined
            ? this.firstAudioQueuedAtMs - turn.userSpeechEndedAtMs
            : undefined;

        this.record.metrics.recordTurn({
          turnIndex: this.record.turnIndex++,
          sttMs: turn.sttLagMs,
          llmMs: result.llmMs,
          ttsMs: result.ttsMs,
          totalMs,
          llmGenerationMs: result.llmGenerationMs,
          ttsSynthesisMs: result.ttsSynthesisMs,
          userSpeechMs: turn.userSpeechMs,
          sttCostUsd: turn.sttCostUsd,
          llmCostUsd: result.llmCostUsd,
          ttsCostUsd: result.ttsCostUsd,
          promptTokens: result.reportedPromptTokens,
          cachedPromptTokens: result.cachedPromptTokens,
          reasoningTokens: result.reasoningTokens,
        });

        // Last, after everything this turn owns has been committed and
        // measured: if the barge-in that cancelled the reply produced no
        // turn of its own, the caller is now sitting in silence. Resume
        // rather than leave them there.
        if (strandedRemainder.length > 0) {
          const resumed = await this.resumeAfterStrandedBargeIn(strandedRemainder, loopSignal);
          // NOT resumed means the caller produced a turn of their own,
          // so the remainder is still exactly where the reply stopped.
          // Held — not spoken — so that if that turn turns out to be a
          // bare attention check, the script can be picked up from here
          // instead of being regenerated. Any other turn clears it on
          // the next iteration (see `handleAttentionCheck`), so it can
          // never be spoken into a conversation that has moved on.
          this.heldScriptRemainder = resumed ? "" : strandedRemainder;
        }
      } catch (error) {
        if (error instanceof RecoverableTurnError) {
          // eslint-disable-next-line no-console
          console.warn(`[PIPELINE:${sid}] RecoverableTurnError (continuing): ${error.message}`);
          // Recover state to LISTENING so the next iteration can proceed.
          if (this.record.state !== SessionState.LISTENING) {
            try {
              this.host.transition(this.record, SessionState.LISTENING, "recovering from turn error");
            } catch {
              // eslint-disable-next-line no-console
              console.error(`[PIPELINE:${sid}] Cannot recover to LISTENING from state=${this.record.state}`);
            }
          }
          continue;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[PIPELINE:${sid}] FATAL error — state=${this.record.state} errorType=${error?.constructor?.name} error=${error instanceof Error ? error.message : String(error)}`,
        );
        this.host.markError(this.record, "PIPELINE", error);
        return;
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[PIPELINE:${sid}] run() exiting — state=${this.record.state} aborted=${loopSignal.aborted}`);
  }

  /**
   * A barge-in cancelled the reply. If the caller then produced nothing
   * to answer, speak the part of that reply they never heard.
   *
   * See the note on `STRANDED_RESUME_QUIET_MS` for why this exists: a
   * cough, a door, a half-word, a hesitation sound or a transcript that
   * never finalised can all cancel a reply and leave nothing behind to
   * reply to, and the caller then hears dead air with the assistant
   * stopped mid-sentence.
   *
   * THE GUARD IS THE WHOLE DESIGN. Any turn material at all — a
   * completed turn already buffered for the next subscriber, or finals
   * the detector is still holding — abandons the resume, because a
   * genuine interruption must be answered by the normal contextual
   * path and never by this. Both are guaranteed to become a turn (see
   * `newerUserTurnWaiting` for why), so abandoning here always hands
   * the call straight back to the main loop.
   *
   * Nothing here changes what a reply says, how it is generated, or how
   * a barge-in behaves: it only fills a silence that would otherwise
   * end the call, using text that was already generated for this
   * caller and never reached them.
   *
   * @returns whether the remainder was actually spoken. Every path that
   *   declines returns `false`, which is the caller's signal that the
   *   remainder is still an unspoken script position and may be HELD —
   *   see `heldScriptRemainder`. Purely additive: the decision to
   *   resume, and every guard on it, is byte-for-byte the one this
   *   method already made.
   */
  private async resumeAfterStrandedBargeIn(remainder: string, loopSignal: AbortSignal): Promise<boolean> {
    const sid = this.record.id;
    if (this.voicemailDetected) return false;
    if (this.strandedResumes >= MAX_STRANDED_RESUMES) return false;

    // Wait for the line to go quiet, re-checking often so a real turn
    // is handed back to the main loop with no added latency.
    const deadline = Date.now() + STRANDED_RESUME_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      if (loopSignal.aborted) return false;
      if (this.callerHasTurnMaterial()) return false;
      if (Date.now() - this.record.lastConversationActivityAt >= STRANDED_RESUME_QUIET_MS) break;
      await abortableSleep(STRANDED_RESUME_POLL_MS, loopSignal);
    }

    if (loopSignal.aborted) return false;
    if (this.callerHasTurnMaterial()) return false;
    // Anything other than LISTENING means the loop has already moved on
    // (a turn is being answered, or the session is ending).
    if (this.record.state !== SessionState.LISTENING) return false;

    this.strandedResumes += 1;
    // eslint-disable-next-line no-console
    console.log(
      `[PIPELINE:${sid}] barge-in produced no turn — RESUMING the unheard remainder (${this.strandedResumes}/${MAX_STRANDED_RESUMES}): "${remainder.slice(0, 80)}${remainder.length > 80 ? "..." : ""}"`,
    );
    const timer = new TurnTimer(sid, "RESUME");
    this.beginTurnTiming(timer);
    try {
      await this.speakFixedUtterance(remainder, loopSignal, "resuming an interrupted reply");
    } finally {
      this.activeTimer = undefined;
      timer.summarize();
    }
    // Committed for the same reason the interrupted part was: the caller
    // heard it, so the model must be able to see it and carry on from
    // there instead of starting the block again.
    this.record.memory.recordAssistantTurn(remainder);
    this.record.bargeIn.reset();
    return true;
  }

  /**
   * The caller is checking whether we are still on the line. Answer
   * that, and only that.
   *
   * Called from the main loop after the user turn has been committed
   * and before the language model is reached, so everything it declines
   * takes the normal contextual path untouched. Three outcomes:
   *
   *   RESUME — an acknowledgement already stands and the caller has
   *     said nothing since but attention checks or a confirmation that
   *     they can hear. Speak the part of the interrupted reply they
   *     never heard, from `heldScriptRemainder`. No language-model
   *     request, so it cannot restate a line and cannot restart the
   *     block: the text is a suffix of a reply already generated for
   *     this caller, and the prefix of it they DID hear is in the
   *     history as their own assistant turn.
   *
   *   ACKNOWLEDGE — the first attention check of an episode. One short
   *     fixed line, exactly once, and the episode is then open so no
   *     further "hello" can produce a second one.
   *
   *   DECLINE — everything else. A real question, an objection, a
   *     backchannel that reached a turn, an attention check with
   *     nothing held to resume. The episode closes, the held position
   *     is released, and the turn is answered by the contextual path
   *     exactly as it is today.
   *
   * The RESUME branch is bounded without a counter: every resume speaks
   * a strict suffix of what was held and re-holds only what is still
   * unheard, so each round is strictly shorter and the remainder
   * reaches "" in at most as many rounds as the reply has utterances.
   * A caller who keeps interrupting therefore hears the block advance,
   * never repeat.
   *
   * @returns whether this turn was handled here.
   */
  private async handleAttentionCheck(userText: string, loopSignal: AbortSignal): Promise<boolean> {
    const sid = this.record.id;
    const trimmed = userText.trim();
    const isCheck = isAttentionCheck(trimmed);
    // Only ever read inside an open episode: this is the caller
    // answering OUR "can you hear me?", not a bare "yes" in open
    // conversation, which is never seen by this method.
    const confirmsHearing =
      this.attentionEpisodeOpen && HEARING_CONFIRMATION_ONLY.test(trimmed);

    if (!isCheck && !confirmsHearing) {
      // A real contribution. The episode is over and the held position
      // is released — an unheard remainder must never be spoken into a
      // conversation that has moved on to something else.
      this.attentionEpisodeOpen = false;
      this.heldScriptRemainder = "";
      return false;
    }

    const remainder = this.heldScriptRemainder;

    // ── Carry on from exactly where the reply stopped ───────────────
    if (this.attentionEpisodeOpen && remainder.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[PIPELINE:${sid}] attention check answered — RESUMING from where the reply stopped: "${remainder.slice(0, 80)}${remainder.length > 80 ? "..." : ""}"`,
      );
      this.heldScriptRemainder = "";
      const spoken = await this.speakAttentionUtterance(
        remainder,
        loopSignal,
        "resuming after an attention check",
      );
      // Cut off again: whatever is STILL unheard is still the position.
      this.heldScriptRemainder = spoken.unheard;
      return true;
    }

    // ── One short acknowledgement, once per episode ─────────────────
    if (isCheck && !this.attentionEpisodeOpen && remainder.length > 0) {
      // Set BEFORE the line is spoken. A second "hello" over the
      // acknowledgement itself must find the episode already open, or
      // it produces the second acknowledgement this exists to prevent.
      this.attentionEpisodeOpen = true;
      const line = attentionAcknowledgementFor(this.record.memory.currentLanguage);
      // eslint-disable-next-line no-console
      console.log(`[PIPELINE:${sid}] attention check — acknowledging once: "${line}"`);
      await this.speakAttentionUtterance(line, loopSignal, "acknowledging an attention check");
      return true;
    }

    // An attention check with nothing to resume — the block finished,
    // or the caller heard all of it. There is no position to carry on
    // from, so the contextual path answers, exactly as it does today.
    this.attentionEpisodeOpen = false;
    return false;
  }

  /**
   * Speaks one fixed line for the attention path and commits what the
   * caller actually HEARD of it.
   *
   * Reuses the existing response-cancellation mechanism rather than
   * adding one: `beginAssistantResponse` takes the id (and clears the
   * previous reply's playback accounting), `triggerExternalBargeIn`
   * freezes `cancelledHeardText` at the instant playback stopped, and
   * `isResponseCancelled` says which of the two to commit. Identical to
   * what the main loop does for a generated reply — a caller who talks
   * over the acknowledgement is a barge-in like any other, and nothing
   * they did not hear is ever put into the assistant's mouth.
   *
   * A barge-in cannot land before the id is taken: it requires
   * SPEAKING, and the session is in LISTENING until `speakFixedUtterance`
   * transitions through THINKING to SPEAKING below.
   */
  private async speakAttentionUtterance(
    text: string,
    loopSignal: AbortSignal,
    transitionReason: string,
  ): Promise<{ readonly heard: string; readonly unheard: string }> {
    const responseId = this.beginAssistantResponse();
    const timer = new TurnTimer(this.record.id, "ATTENTION");
    this.beginTurnTiming(timer);
    try {
      await this.speakFixedUtterance(text, loopSignal, transitionReason);
    } finally {
      this.activeTimer = undefined;
      timer.summarize();
    }

    const cancelled = this.isResponseCancelled(responseId);
    const heard = cancelled ? this.cancelledHeardText : text;
    if (heard.length > 0) this.record.memory.recordAssistantTurn(heard);
    this.record.bargeIn.reset();
    return { heard, unheard: cancelled ? unspokenTail(text, heard) : "" };
  }

  /**
   * READ-ONLY. Does the caller have something in flight that is going to
   * become a turn? Pure observation over the turn detector's two
   * existing read-only accessors — it consumes nothing, arms no timer
   * and clears nothing, and in particular it does NOT subscribe (a
   * subscriber would receive the turn and the main loop would never see
   * it).
   */
  private callerHasTurnMaterial(): boolean {
    return (
      this.record.turnDetector.hasBufferedTurn() ||
      this.record.turnDetector.getPendingTurnText().trim().length > 0
    );
  }

  /** Installs `timer` as the trace for the turn now starting. */
  private beginTurnTiming(timer: TurnTimer): void {
    this.activeTimer = timer;
    this.markedTtsThisTurn = false;
    this.markedAudioThisTurn = false;
    this.markedFirstSentenceThisTurn = false;
    this.markedTtsRequestThisTurn = false;
    this.firstAudioQueuedAtMs = undefined;
  }

  /**
   * Sends the system prompt to the LLM once, while the greeting is
   * still playing, so the caller's FIRST reply is answered from the
   * provider's prompt-prefix cache instead of a cold prefill.
   *
   * WHY THE SECOND RESPONSE IS THE SLOW ONE. The greeting is fixed text
   * and deliberately makes no LLM request (see the greeting block
   * above), so the reply to the caller's first "Yes." is this call's
   * FIRST LLM request — and it is the one request that cannot hit the
   * prefix cache. Measured against the live prompt stack on gpt-5.1
   * (12,411 prompt tokens, `verbosity: "low"`, 0 reasoning tokens):
   *
   *   cold  `cached_tokens: 0`      first visible token 2726ms
   *   warm  `cached_tokens: 12288`  first visible token 1326ms
   *
   * Turn detection for a short endpointed "Yes." already releases in
   * ~300ms and TTS is warm from the greeting, so that ~1.4s prefill is
   * the bottleneck on this exact transition, and it is the only turn
   * that pays it.
   *
   * COSTS NOTHING IT DOES NOT ALREADY COST. The prefill happens once
   * per call either way — this only moves it off the caller's clock and
   * onto greeting playback. The stream is abandoned at its first event,
   * so it generates no reply.
   *
   * TOUCHES NOTHING. Not awaited, so no path waits on it; sends only
   * the system turn, so it cannot alter what the model is later told;
   * writes nothing to `memory`, records no metrics, and swallows every
   * error — a provider that refuses this leaves the call exactly as it
   * behaves today.
   */
  private primeLlmPrefixCache(loopSignal: AbortSignal): void {
    const generate = this.providers.llm.generateCompletionStream;
    if (!generate) return;
    // The shared prefix of every later request, and nothing else.
    const prefix = this.record.memory.recentHistory().filter(turn => turn.role === "system");
    if (prefix.length === 0) return;

    void (async () => {
      const abort = new AbortController();
      const signal = combineSignals([abort.signal, loopSignal]);
      try {
        const stream = generate.call(
          this.providers.llm,
          { sessionId: this.record.id, history: prefix },
          signal,
        );
        if (!stream) return;
        // The prefill — the part being cached — is complete before the
        // first event can arrive, so there is nothing to gain by
        // reading further.
        for await (const _event of stream) {
          void _event;
          break;
        }
      } catch {
        // A cold cache is the current behaviour, not a failure.
      } finally {
        abort.abort();
      }
    })();
  }

  // ---------------------------------------------------------------
  /**
   * FIX #11 — ask the TTS provider to open its transport now, while the
   * detector's evidenced confirmation window, the model's
   * time-to-first-token and the chunker's accumulation still lie between
   * here and the first synthesis call.
   *
   * This is a NETWORK HINT AND NOTHING ELSE, and every part of that is
   * deliberate:
   *
   *   - it cannot produce audio, an LLM call, a transcript, a turn
   *     release, an interruption or a barge-in. It opens a socket. The
   *     provider contract (`prepareSession`) forbids sending anything on
   *     it, and the Sarvam adapter's socket stays virgin until
   *     `synthesizeStream` claims it;
   *   - it decides nothing about turn-taking. `onTurnPending` is
   *     OBSERVED here exactly as FIX #8 observes it — the release is
   *     still `onTurnEnd` and the detector's guards are untouched;
   *   - if the caller turns out to still be speaking, the turn is
   *     cancelled inside the detector as before and the unused socket
   *     simply expires. Nothing downstream is aware it existed;
   *   - a provider that does not implement `prepareSession` (Cartesia,
   *     Smallest AI, ElevenLabs — all three reach their vendor over
   *     `fetch`, which `http-keepalive.ts` already keeps warm) is not
   *     called at all;
   *   - it never throws. A failed hint means the handshake is paid on
   *     the caller's clock, which is exactly what happened before.
   *
   * The session's loop signal is passed so a call that ends mid-window
   * releases the socket immediately rather than waiting out its TTL.
   */
  private prepareTtsTransport(): void {
    const prepare = this.providers.tts.prepareSession;
    if (typeof prepare !== "function") return;
    const loopSignal = this.record.loopAbortController?.signal;
    if (!loopSignal || loopSignal.aborted) return;
    try {
      prepare.call(this.providers.tts, this.record.id, loopSignal);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[TTS-PREOPEN:${this.record.id}] provider hint failed — synthesis is unaffected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // FIX #8 — speculative LLM pre-open. See `SpeculativeCompletion`.
  // ---------------------------------------------------------------

  /**
   * The detector has armed its EVIDENCED confirmation window for `text`
   * (see `AdaptiveTurnDetector.onTurnPending`). Open the request that
   * turn will need, now, so the provider's time-to-first-token runs
   * during that window instead of after it.
   *
   * Every guard here is a reason the released turn would NOT reach
   * `runThinkingAndSpeaking`'s LLM call as this text, or would reach it
   * in a state this request cannot match:
   *   - not idle in LISTENING awaiting a turn (greeting, thinking,
   *     speaking, barge-in unwind, attention utterance): the pending
   *     turn hook is simply ignored — those paths are untouched;
   *   - voicemail: the machine gets no reply;
   *   - an attention episode is open or a script position is held:
   *     `handleAttentionCheck` may answer the turn without the model;
   *   - no streaming provider: nothing to pre-open.
   *
   * Nothing is committed to memory here. The history is the memory's
   * own PREVIEW of the window it will produce once the turn is recorded,
   * annotated by the same `buildRequestHistory`.
   */
  private startSpeculation(text: string): void {
    if (!this.awaitingTurn || this.voicemailDetected) return;
    if (this.record.state !== SessionState.LISTENING) return;
    if (this.attentionEpisodeOpen || this.heldScriptRemainder.length > 0) return;
    const generate = this.providers.llm.generateCompletionStream;
    if (typeof generate !== "function") return;
    const loopSignal = this.record.loopAbortController?.signal;
    if (!loopSignal || loopSignal.aborted) return;
    if (text.trim().length === 0) return;

    if (this.speculation !== undefined) {
      // The same pending turn re-announced (e.g. `speech_final` on the
      // words AND a standalone marker for the same utterance): the open
      // request already is this request.
      if (this.speculation.text === text) return;
      this.abandonSpeculation("pending turn text changed");
    }

    const sid = this.record.id;
    const evidenceAtMs = this.lastEndpointEvidenceAtMs;
    const evidenceKind = this.lastEndpointEvidenceKind;
    try {
      const detected = detectLanguage(text, this.record.memory.currentLanguage);
      const request: CompletionRequest = {
        sessionId: sid,
        history: this.buildRequestHistory(detected.language, this.record.memory.previewRecentHistory(text)),
      };
      const abort = new AbortController();
      const stream = generate.call(this.providers.llm, request, combineSignals([abort.signal, loopSignal]));
      const iterator = stream[Symbol.asyncIterator]();
      // An async generator runs nothing until its first `next()` — this
      // call is what actually opens the provider connection.
      const openedAtMs = Date.now();
      const first = iterator.next();
      const speculation: SpeculativeCompletion = {
        text,
        request,
        openedAtMs,
        evidenceAtMs,
        abort,
        iterator,
        first,
        firstTokenAtMs: undefined,
      };
      // Observe (for the trace) and mark handled: an abandoned request
      // whose connection fails must not surface as an unhandled
      // rejection. The adopter still sees the rejection through `first`.
      first.then(
        (result) => {
          if (!result.done && result.value.type === "token") speculation.firstTokenAtMs = Date.now();
        },
        () => undefined,
      );
      this.speculation = speculation;
      // eslint-disable-next-line no-console
      console.log(
        `[SPECULATE:${sid}] LLM request PRE-OPENED on ${evidenceKind ?? "endpoint"} evidence: text="${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"` +
          `${evidenceAtMs !== undefined ? ` evidence-to-llm-open=${openedAtMs - evidenceAtMs}ms` : ""} historyLength=${request.history.length}`,
      );
    } catch (error) {
      // Nothing is lost: the turn is released and sent exactly as today.
      // eslint-disable-next-line no-console
      console.warn(
        `[SPECULATE:${sid}] could not pre-open the LLM request — falling back to the normal path: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Drop the pre-opened request. Aborts the provider stream through the
   * signal it was given — the same mechanism a barge-in uses — and
   * releases the generator. Idempotent.
   */
  private abandonSpeculation(reason: string): void {
    const speculation = this.speculation;
    if (speculation === undefined) return;
    this.speculation = undefined;
    speculation.abort.abort();
    void Promise.resolve(speculation.iterator.return?.()).catch(() => undefined);
    // eslint-disable-next-line no-console
    console.log(
      `[SPECULATE:${this.record.id}] pre-opened LLM request ABANDONED (${reason}) text="${speculation.text.slice(0, 80)}${speculation.text.length > 80 ? "..." : ""}"` +
        ` openMs=${Date.now() - speculation.openedAtMs} firstToken=${speculation.firstTokenAtMs !== undefined ? "received" : "not yet"}`,
    );
  }

  /**
   * Hand the pre-opened request to the turn that has just been released,
   * IF it is that turn's request: same user text, and a history equal
   * role-for-role and content-for-content to the one
   * `runThinkingAndSpeaking` has just built the normal way. Any
   * difference — different text, memory changed underneath, stream
   * already aborted — abandons it and the caller sends its own request
   * exactly as today.
   *
   * On adoption the reply's `thinkingSignal` is linked to the stream's
   * abort, so a barge-in cancels it precisely as it cancels a stream the
   * caller opened itself.
   */
  private adoptSpeculation(
    userText: string,
    request: CompletionRequest,
    thinkingSignal: AbortSignal,
  ): SpeculativeCompletion | undefined {
    const speculation = this.speculation;
    if (speculation === undefined) return undefined;
    if (speculation.text !== userText) {
      this.abandonSpeculation("released turn text differs");
      return undefined;
    }
    if (speculation.abort.signal.aborted) {
      this.abandonSpeculation("pre-opened stream already aborted");
      return undefined;
    }
    const same =
      speculation.request.sessionId === request.sessionId &&
      speculation.request.history.length === request.history.length &&
      speculation.request.history.every((turn, i) => {
        const other = request.history[i];
        return other !== undefined && other.role === turn.role && other.content === turn.content;
      });
    if (!same) {
      this.abandonSpeculation("pre-opened request does not match the request built at release");
      return undefined;
    }
    this.speculation = undefined;
    if (thinkingSignal.aborted) {
      speculation.abort.abort();
    } else {
      thinkingSignal.addEventListener("abort", () => speculation.abort.abort(), { once: true });
    }
    return speculation;
  }

  /**
   * The adopted stream, as the ordinary `for await` in
   * `runStreamingCompletion` expects it: the result of the `next()`
   * issued at pre-open time first, then the rest of the generator. A
   * rejection from the pre-open surfaces here, where the existing
   * dropped-connection handling already is. Breaking out of this
   * generator returns the underlying one, as it does today.
   */
  private async *resumeSpeculativeStream(speculation: SpeculativeCompletion): AsyncIterable<LlmStreamEvent> {
    try {
      const first = await speculation.first;
      if (first.done) return;
      yield first.value;
      for (;;) {
        const next = await speculation.iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await speculation.iterator.return?.();
    }
  }

  /**
   * Real-time ms of already-synthesized reply audio the transport has
   * been handed but has not played yet — the same span `drainPlayback`
   * waits out before leaving SPEAKING. `0` when nothing is playing.
   */
  private remainingSpeechMs(): number {
    if (this.outboundPlaybackStartedAt === 0 || this.outboundQueuedMs <= 0) return 0;
    return this.outboundQueuedMs - (Date.now() - this.outboundPlaybackStartedAt);
  }

  /**
   * The part of the reply currently being spoken that the transport has
   * already PLAYED — i.e. what the caller has actually heard.
   *
   * Every utterance handed to `synthesizeAndPlay` is recorded with the
   * playback offset it starts at (`spokenUtterances`), and playback
   * runs in real time from `outboundPlaybackStartedAt`, so an utterance
   * whose start offset is behind the play head has been heard. The one
   * still playing when this is read counts as heard: the caller is
   * listening to it, and the alternative — dropping it — is the
   * repetition this exists to prevent.
   *
   * Read-only over counters that already exist for `drainPlayback` and
   * `remainingSpeechMs`. Nothing here changes what is synthesized,
   * queued, played or cancelled.
   */
  private heardSoFarText(): string {
    if (this.outboundPlaybackStartedAt === 0 || this.spokenUtterances.length === 0) return "";
    const playedMs = Date.now() - this.outboundPlaybackStartedAt;
    return this.spokenUtterances
      .filter((utterance) => utterance.startsAtMs < playedMs)
      .map((utterance) => utterance.text)
      .join(" ")
      .trim();
  }

  /**
   * Has the caller moved on from the turn this reply is answering?
   *
   * TWO signals, and the second is why this method exists rather than
   * being one call at each site.
   *
   * 1. `hasBufferedTurn()` — the caller spoke, STOPPED, and their words
   *    passed every release guard while we were still preparing a reply
   *    to what they said before that. The original signal, unchanged.
   *
   * 2. The caller has RESUMED SPEAKING, and their new contribution has
   *    not endpointed yet.
   *
   * Signal 1 alone was blind to the commonest shape of the reported
   * defect. A caller finishes a thought, the detector releases it, and
   * ~0.3-1.5s later they carry on — a clarification, the question the
   * first line was leading up to, the context for it. `pendingEvent` is
   * null the whole time, because nothing has endpointed yet, so nothing
   * stopped the reply to the older, partial thought: it was spoken OVER
   * the caller mid-sentence, and their real question was then answered
   * separately. Three utterances that were one thought came back as
   * three isolated answers — exactly the reported "responds to
   * individual utterances instead of the conversation" behaviour.
   *
   * `getPendingTurnText()` is what closes it: the FINAL transcript
   * words the detector is holding for the utterance in progress. Three
   * properties make it safe to read here.
   *
   *   - It can never be the turn we are answering. `emitTurnEnd` calls
   *     `reset()` — which clears `pendingFinalText` — BEFORE it
   *     dispatches to listeners, so anything held here arrived strictly
   *     after the release of the turn this reply belongs to.
   *   - It cannot strand the call. Non-empty, non-filler pending text
   *     is guaranteed to become a turn: every `emitTurnEnd` path that
   *     does not release rearms the timer, and every hold is bounded
   *     (`MAX_CONTINUATION_GRACES`, `MAX_CHUNK_BOUNDARY_GRACES`,
   *     `MAX_INTERIM_CONFIRMATIONS`). So a supersession is always
   *     followed by a real turn — the same guarantee signal 1 relies
   *     on.
   *   - FINALS ONLY, deliberately. An interim-only utterance is NOT
   *     used: Deepgram owing a final it never delivers would leave a
   *     discarded reply and no turn to replace it, and silence is a
   *     worse failure than a stale sentence. That case keeps exactly
   *     the behaviour it has today — the reply is spoken and the
   *     caller's speech barges in on it.
   *
   * A bare acknowledgement is excluded. "Haan" / "okay" / "hmm"
   * landing while we are still THINKING is the caller showing they are
   * listening, not a new contribution — the same judgement
   * `isBackchannel` makes while the assistant is SPEAKING, for the same
   * reason. Cancelling a reply for one would restart the block the
   * acknowledgement was agreeing with.
   *
   * Read only at the two existing sites, and only while nothing has
   * been spoken yet, so the barge-in path is untouched.
   */
  private newerUserTurnWaiting(): boolean {
    if (this.record.turnDetector.hasBufferedTurn()) return true;

    const resumed = this.record.turnDetector.getPendingTurnText().trim();
    if (resumed.length === 0) return false;
    if (BARE_GREETING_ONLY.test(resumed)) return false;
    return !isBareAcknowledgement(resumed);
  }

  /**
   * Is this segment the caller acknowledging, rather than taking a
   * turn? Only ever asked while the assistant is speaking.
   *
   * Judged on the WHOLE pending utterance — the finals the turn
   * detector already holds plus this segment — so a turn that started
   * with real content is never mistaken for an acknowledgement.
   */
  private isBackchannel(segment: TranscriptSegment): boolean {
    const pending = this.record.turnDetector.getPendingTurnText();
    const utterance = pending.length > 0 ? `${pending} ${segment.text}` : segment.text;
    // A bare greeting, before a single frame of this reply has PLAYED.
    //
    // `isBareAcknowledgement` excludes "hello" because over audio the
    // caller is hearing it means the line has gone bad, and it must
    // interrupt. That reasoning is about audio they are failing to
    // hear — and here there is none: the state is SPEAKING but the
    // transport has not started playing, so nothing exists to have gone
    // bad. It is the same case `BARE_GREETING_ONLY` already covers while
    // THINKING, and the window is real (TTS time-to-first-chunk sits
    // inside SPEAKING).
    //
    // Cancelling here is what produced the reported "the script starts
    // again" defect: `heardSoFarText` is empty before playback begins,
    // so a barge-in commits NOTHING to memory, and the next request
    // regenerates the identical script line — once per "hello?".
    //
    // Bounded and non-stranding: it holds only while SPEAKING has no
    // audio, so the moment playback starts a "hello" interrupts exactly
    // as it does today, and once the turn ends the segment feeds the
    // turn detector normally.
    if (this.outboundPlaybackStartedAt === 0 && BARE_GREETING_ONLY.test(utterance.trim())) {
      return true;
    }
    if (!isBareAcknowledgement(utterance)) return false;
    return (
      this.backchannelInFlight ||
      this.remainingSpeechMs() > BACKCHANNEL_MIN_REMAINING_SPEECH_MS
    );
  }

  /** Records a stage on the in-flight turn's trace, if one is active. */
  private markTiming(stage: string): void {
    this.activeTimer?.mark(stage);
  }

  /**
   * Marks a new assistant response as PENDING and returns its id. The
   * id is what the commit site checks against `cancelledResponseId`.
   */
  private beginAssistantResponse(): number {
    this.currentResponseId += 1;
    // Whatever the PREVIOUS reply spoke belongs to the previous reply.
    // Cleared here, at the response boundary, and not only in
    // `resetPlaybackAccounting`: a reply cancelled before it ever
    // entered SPEAKING never calls that, and would otherwise be
    // credited with the utterances of the reply before it — which is
    // the last reply's text being committed a second time.
    this.spokenUtterances = [];
    this.cancelledHeardText = "";
    return this.currentResponseId;
  }

  /** True if `responseId` was cancelled by a barge-in while in flight. */
  private isResponseCancelled(responseId: number): boolean {
    return this.cancelledResponseId === responseId;
  }

  /**
   * Externally-triggered barge-in (e.g. from a telephony transport's own
   * energy VAD, or a test harness).
   *
   * @returns whether the barge-in was ACCEPTED, so a transport that
   *   clears its own playback buffer for latency knows whether to.
   *   Declining is not a failure: it means the assistant is saying
   *   something that is not interruptible, and a transport that dropped
   *   its queue anyway would leave the caller in silence with nothing
   *   left to play and no reply on the way.
   */
  triggerExternalBargeIn(): boolean {
    // THE OPENING LINE IS NOT INTERRUPTIBLE.
    //
    // `greetingDone` has always gated the transcript-confirmed barge-in
    // path below (see `startContinuousStt`) — a caller saying "hello?"
    // as they lift the phone must not destroy the very first thing the
    // assistant says. The transports' own energy VAD reached this method
    // WITHOUT that gate, so a "hello" on pickup truncated the opening
    // line ~120ms in and left the caller listening to nothing while the
    // next reply was generated. Saying "hello" again cancelled that
    // reply too, and the call could livelock there until they hung up.
    //
    // Nothing the caller says during the greeting is lost: the listener
    // has been running since call-connect and the turn detector buffers
    // the turn (`AdaptiveTurnDetector.pendingEvent`), so it is answered
    // the moment the opening line finishes.
    if (!this.greetingDone) {
      // eslint-disable-next-line no-console
      console.log(
        `[PIPELINE:${this.record.id}] barge-in DECLINED — the fixed opening line is still playing`,
      );
      return false;
    }
    // Recorded FIRST, before anything can observe the aborts below:
    // whichever response is in flight is now CANCELLED and stays
    // cancelled, so a chunk or `final` event that arrives after this
    // handler has run cannot commit it. Marking the id of an already
    // committed response (a barge-in signalled with nothing pending) is
    // harmless — the next response takes a fresh id.
    this.cancelledResponseId = this.currentResponseId;
    // Frozen HERE, before the aborts below stop the transport: this is
    // the last instant at which "how much of the reply has played" is
    // still a true statement about what the caller heard. Read by the
    // commit site in the main loop — see `cancelledHeardText`.
    this.cancelledHeardText = this.heardSoFarText();
    this.record.bargeIn.triggerBargeIn();
    if (this.record.state === SessionState.SPEAKING) {
      this.host.transition(this.record, SessionState.LISTENING, "external barge-in signal");
    }
    return true;
  }

  /**
   * Does this transcript segment corroborate as the CALLER talking over
   * the assistant, rather than something else the microphone can hear?
   *
   * See the note on `BARGE_IN_ENERGY_WINDOW_MS` for why a transcript
   * alone is not evidence. Only ever asked while the assistant is
   * SPEAKING, and it gates nothing else: no turn, no timer, no
   * threshold, no state.
   */
  private interruptionCorroborated(segment: TranscriptSegment): boolean {
    // A transport that never reports energy at all — the in-process
    // audio fallback, the test harnesses — keeps exactly the
    // transcript-only behaviour this had before the energy gate existed.
    // `noteCallerEnergy` is the only writer, so `0` is "never stamped".
    if (this.record.lastCallerEnergyAt !== 0) {
      const energyAgeMs = Date.now() - this.record.lastCallerEnergyAt;
      if (energyAgeMs > BARGE_IN_ENERGY_WINDOW_MS) return false;
    }
    // `0` is "not reported", not "no confidence" — see the constant.
    if (segment.confidence > 0 && segment.confidence < BARGE_IN_MIN_CONFIDENCE) {
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------
  // STT
  // ---------------------------------------------------------------

  private inboundAudioSource(): AsyncIterable<AudioPayload> {
    return this.record.mediaStream?.inbound ?? this.record.inboundAudioFallback;
  }

  /**
   * `segment.endedAtMs`, placed on the same call-long timeline
   * `inboundStreamMs` uses — see `STT_CLOCK_REWIND_TOLERANCE_MS` for
   * why the reported value cannot be compared against it raw.
   *
   * Called once per segment, before anything reads the result, and it
   * is the only writer of either clock field.
   *
   * `0` is passed straight back. The provider reports `0` for "no word
   * timings in this result" (see the Deepgram adapter), NOT for "the
   * start of the stream", so it must neither move the high-water mark
   * (a spurious rewind) nor be shifted by the offset (which would let
   * a segment with no timings at all read as an interruption). Keeping
   * it at `0` is exactly the arithmetic this had before.
   */
  private sttStreamMsOf(segment: TranscriptSegment): number {
    const reported = segment.endedAtMs;
    if (reported <= 0) return 0;

    let onCallTimelineMs = this.sttClockOffsetMs + reported;
    if (onCallTimelineMs + STT_CLOCK_REWIND_TOLERANCE_MS < this.sttClockHighWaterMs) {
      // The stream restarted. `inboundStreamMs` is the audio position
      // this segment's words are near, and `reported` is where the new
      // stream thinks they are, so the difference is where the new
      // stream's zero sits on our timeline. Recomputed from absolute
      // values, so a second and third reconnect are handled the same
      // way rather than compounding.
      //
      // It lands a recognition-lag too FAR forward, because
      // `inboundStreamMs` is the live edge while `reported` is the end
      // of the last recognised word. That bias makes the interruption
      // test marginally more permissive for the rest of the call, which
      // is the safe direction: a wrongly-allowed barge-in still has to
      // clear the backchannel and near-end-energy gates, and if it
      // produces no turn `resumeAfterStrandedBargeIn` continues the
      // reply. A wrongly-BLOCKED one is silent and permanent.
      this.sttClockOffsetMs = Math.max(0, this.inboundStreamMs - reported);
      onCallTimelineMs = this.sttClockOffsetMs + reported;
      // eslint-disable-next-line no-console
      console.warn(
        `[TURN:${this.record.id}] STT stream clock restarted (reported=${Math.round(reported)}ms, call was at ${Math.round(this.sttClockHighWaterMs)}ms) — re-basing interruption timing by ${Math.round(this.sttClockOffsetMs)}ms so barge-in keeps working`,
      );
    }

    if (onCallTimelineMs > this.sttClockHighWaterMs) {
      this.sttClockHighWaterMs = onCallTimelineMs;
    }
    return onCallTimelineMs;
  }

  private startContinuousStt(loopSignal: AbortSignal): void {
    const wrapped = withByteCounter(this.inboundAudioSource(), (chunk) => {
      this.sinceLastTurnBytes += chunk.data.byteLength;
      this.sinceLastTurnEncoding ??= chunk.encoding;
      this.sinceLastTurnSampleRateHz ??= chunk.sampleRateHz;
      // Monotonic clock over the audio actually handed to the STT
      // stream, in the SAME units Deepgram reports word times in
      // (ms from the start of the stream). Used below to tell
      // "the caller is interrupting me" apart from "the caller
      // spoke before I started, and the transcript only just landed".
      this.inboundStreamMs += estimateAudioSeconds(chunk) * 1000;
    });

    void (async () => {
      try {
        const stream = this.providers.stt.transcribeStream?.({
          sessionId: this.record.id,
          audio: wrapped,
          language: this.record.memory.currentLanguage,
          signal: loopSignal,
        });
        if (!stream) return;

        for await (const segment of stream) {
          if (loopSignal.aborted) break;

          // ── An end-of-speech MARKER, not a transcript ────────────
          //
          // The provider's endpointer reporting that the words it has
          // already delivered are finished — see
          // `TranscriptSegment.isEndOfSpeechMarker`. It carries no text
          // and no word timings, so it is routed straight to the turn
          // detector and to nothing else: it must not reach the display
          // preview, the recognition-lag metric, the STT stream clock
          // (`endedAtMs` of 0 is not a position on it), the barge-in
          // corroboration gates, or `feed` — where a text-less final
          // would restart the turn clock and be measured as an enormous
          // inter-final pause.
          //
          // Nothing else in this loop changes, and a provider that
          // never sends a marker never reaches this branch.
          if (segment.isEndOfSpeechMarker) {
            // FIX #7A — telemetry only: arrival of the `UtteranceEnd`
            // evidence itself, before it is handed to the detector.
            //
            // FIX #9 — stamped ONLY when the detector is actually holding
            // words for the marker to be about. Deepgram delivers
            // `UtteranceEnd` ~1s after the last word, which on a clean
            // line is long AFTER the 150ms evidenced release of that
            // turn; a marker landing on an empty detector describes a
            // turn already answered, and stamping it here made the NEXT
            // turn's `endpoint-to-release` read as multi-second stale
            // evidence whenever that turn released by inference.
            // `noteEndOfSpeech` itself already ignores a marker with
            // nothing held, so this changes no decision — only what the
            // trace attributes.
            if (this.record.turnDetector.getPendingTurnText().trim().length > 0) {
              this.lastEndpointEvidenceAtMs = Date.now();
              this.lastEndpointEvidenceKind = "utterance_end";
            }
            this.record.turnDetector.noteEndOfSpeech();
            continue;
          }

          // DISPLAY ONLY: surface what the caller is saying as soon
          // as Deepgram reports it (interim segments included) so the
          // Dashboard transcript no longer lags turn-end. Nothing
          // downstream reads this — turn detection, barge-in and the
          // LLM continue to work off `segment` / the turn detector
          // exactly as before.
          if (segment.text.trim().length > 0) {
            // The caller is audibly speaking right now. Stamped here
            // because this is the earliest point the pipeline knows
            // that — before any state transition — so the campaign
            // silence watchdog cannot mistake a caller mid-utterance
            // for a silent line.
            this.record.lastConversationActivityAt = Date.now();
            // Prefix the finals already accumulated for this turn. A
            // Deepgram interim/final is only the tail since the last
            // final, so without this the preview snaps back to the
            // latest fragment ("50,000 rupees") halfway through an
            // utterance the detector is correctly still buffering.
            // Still one field, so still one bubble — display only.
            const buffered = this.record.turnDetector.getPendingTurnText();
            this.record.liveUserTranscript =
              buffered.length > 0 ? `${buffered} ${segment.text}`.trim() : segment.text;
          }

          // Checked BEFORE anything downstream: while a machine is
          // announcing itself, its greeting must not become a barge-in
          // judgement, a turn, or a reply.
          this.checkForVoicemail(segment);

          // Placed on the call-long timeline BEFORE anything reads it:
          // both the recognition-lag metric just below and the
          // interruption test further down compare this against
          // `inboundStreamMs`-based values, and the raw `endedAtMs` is
          // only meaningful while the provider's CURRENT socket is the
          // call's first — a reconnect restarts it at zero. See
          // `STT_CLOCK_REWIND_TOLERANCE_MS`. Called once per segment,
          // and before the two `continue`s below, so every segment
          // maintains the clock. On a call whose STT stream never
          // restarts the offset is `0` and every value is identical to
          // the raw one.
          const segmentEndedAtStreamMs = this.sttStreamMsOf(segment);

          // METRICS ONLY — pure observation, no control flow. Records
          // when this final landed and how far behind the audio it
          // was, so `recordTurn` can report real recognition latency
          // instead of the caller's speaking duration.
          if (segment.isFinal && segment.text.trim().length > 0) {
            this.lastFinalSegmentAtMs = Date.now();
            // On the RE-BASED clock, not raw `endedAtMs`. After an STT
            // stream reconnect the raw value restarts at zero, so the
            // lag computed from it inflates by however long the call
            // had been running — which back-dated `userSpeechEndedAtMs`
            // by that whole span and printed nonsense `stt-to-release`
            // figures for every turn after the "STT stream clock
            // restarted" line. `0` is "no word timings in this result"
            // (see `sttStreamMsOf`), never a position, so it is
            // excluded rather than measured.
            const lagMs =
              segmentEndedAtStreamMs > 0
                ? this.inboundStreamMs - segmentEndedAtStreamMs
                : Number.NaN;
            // Bounded: during the initial replay of audio buffered
            // while the greeting played, the stream clock advances far
            // faster than real time and a segment landing inside that
            // burst yields a meaningless span.
            if (Number.isFinite(lagMs) && lagMs >= 0 && lagMs <= MAX_PLAUSIBLE_STT_LAG_MS) {
              this.lastFinalSttLagMs = lagMs;
            }
          }

          // The user has started talking while the assistant was
          // speaking — cut TTS immediately and resume listening,
          // then keep feeding this segment into the turn detector so
          // nothing the user said is lost.
          //
          // `segment.endedAtMs` is the stream-relative end of the last
          // word Deepgram has transcribed. A segment only counts as an
          // interruption if that speech happened AFTER the assistant
          // started speaking. Without this check the very first turn is
          // always destroyed: the caller says "Hello?" as they pick up
          // (while we are still in THINKING), Deepgram's transcript for
          // it lands a second later — by which time the greeting has
          // entered SPEAKING — and the greeting is barged-in before a
          // single audio frame reaches the caller.
          //
          // `greetingDone` keeps that guarantee now that the listener
          // starts before the greeting rather than after it: until the
          // greeting has finished, no segment can trigger a barge-in,
          // which is precisely the protection deferring the listener
          // used to provide. The segment is still fed to the turn
          // detector below, so the words are not lost.
          //
          // Read through `sttStreamMsOf` rather than raw (computed
          // above, before the metrics block): the reported time is
          // measured from the start of the STT provider's CURRENT
          // connection, and a reconnect restarts it at zero while
          // `speakingStartedAtStreamMs` keeps counting the whole call —
          // after which this test is false forever and the assistant
          // becomes uninterruptible. See
          // `STT_CLOCK_REWIND_TOLERANCE_MS`.
          const spokeOverTheAssistant =
            this.greetingDone &&
            this.record.state === SessionState.SPEAKING &&
            segmentEndedAtStreamMs > this.speakingStartedAtStreamMs;

          // ── Backchannel, not barge-in ─────────────────────────────
          //
          // "Ok." / "haan" / "hmm" said while the assistant is still
          // several seconds into its own reply is the caller showing
          // they are listening, not asking it to stop. Treating it as
          // an interruption is what produced the reported "the agent
          // stops and repeats the explanation" behaviour, and the
          // mechanism is not the prompt:
          //
          //   1. barge-in aborts the LLM/TTS stream mid-paragraph;
          //   2. an interrupted reply is CANCELLED, so it is never
          //      committed to `memory` (see the commit site in the main
          //      loop) — the model's history says it never spoke;
          //   3. the next request therefore generates the SAME block
          //      again from the top, and the caller hears the pitch
          //      restart. `conversation-policy.ts` cannot prevent that:
          //      "never repeat a line they have already heard" is
          //      unactionable when history shows the line was never
          //      said.
          //
          // So an acknowledgement here does nothing at all: no
          // interruption, and it is not fed to the turn detector, so it
          // creates no turn and the assistant simply finishes its
          // sentence — which also means the reply IS committed, and the
          // commitment question inside it stays in the transcript the
          // FINAL_YES gate reads.
          //
          // The whole utterance is tested, not just this segment, so
          // "ok, but what's the price?" is not an acknowledgement and
          // interrupts exactly as it does today. Deepgram's interims
          // accumulate until its next final, so the "ok" is still part
          // of the turn when the caller carries on.
          if (spokeOverTheAssistant && this.isBackchannel(segment)) {
            // Deepgram finalising the utterance ends it; until then the
            // same utterance keeps being treated as backchannel even if
            // the reply is nearly finished by the time its final lands.
            this.backchannelInFlight = !segment.isFinal;
            // Display-only preview. Cleared because no turn will
            // replace it, and `getTranscript` appends it as a trailing
            // user turn — a stale one would sit after the assistant's
            // last turn and block the final-answer hangup check, which
            // requires the assistant to have spoken last.
            this.record.liveUserTranscript = "";
            // eslint-disable-next-line no-console
            console.log(
              `[TURN:${this.record.id}] backchannel ignored (not a barge-in): "${segment.text.trim()}" — ${Math.round(this.remainingSpeechMs())}ms of reply still to play`,
            );
            continue;
          }
          this.backchannelInFlight = false;

          // ── Not the caller, so not an interruption ────────────────
          //
          // Words, over the assistant, that the transport's energy VAD
          // does not corroborate as loud near-end speech — a television,
          // a second person in the room, our own audio echoing back out
          // of the caller's earpiece. Ignored exactly like the
          // backchannel above: no barge-in, and NOT fed to the turn
          // detector, so it creates no turn either and the assistant
          // simply finishes its sentence.
          //
          // Only reachable while the assistant is SPEAKING. A caller
          // speaking while it is LISTENING or THINKING is never touched
          // by this, so a soft-spoken caller cannot be filtered out of
          // the conversation — and if these words really were theirs,
          // they are still talking when the reply ends, and everything
          // from that point on becomes their turn as usual.
          if (spokeOverTheAssistant && !this.interruptionCorroborated(segment)) {
            this.record.liveUserTranscript = "";
            // eslint-disable-next-line no-console
            console.log(
              `[TURN:${this.record.id}] uncorroborated speech ignored (not the caller interrupting): "${segment.text.trim()}" — confidence=${segment.confidence} loudSpeechAgeMs=${this.record.lastCallerEnergyAt === 0 ? "n/a" : Date.now() - this.record.lastCallerEnergyAt}`,
            );
            continue;
          }

          if (spokeOverTheAssistant) {
            this.triggerExternalBargeIn();
          }

          // FIX #7A — telemetry only: arrival of `speech_final`
          // evidence on a segment that is actually about to reach the
          // detector (i.e. survived the backchannel/uncorroborated
          // filters above), so this only records evidence that could
          // plausibly have participated in the release it precedes.
          if (segment.isSpeechFinal) {
            this.lastEndpointEvidenceAtMs = Date.now();
            this.lastEndpointEvidenceKind = "speech_final";
          } else {
            // FIX #9 — telemetry only. This segment (interim or
            // chunk-boundary final) is the caller CONTINUING past
            // whatever endpoint claim was recorded for the words before
            // it, so that claim no longer describes the end of the turn
            // that will eventually be released. Left in place it was
            // printed against a later inferred release as a multi-second
            // `endpoint-to-release`. Cleared here; a fresh claim for the
            // extended utterance re-stamps it. The detector receives
            // exactly the same segment it always did.
            this.lastEndpointEvidenceAtMs = undefined;
            this.lastEndpointEvidenceKind = undefined;
          }

          // FIX #8 — the caller is still speaking (this segment, interim
          // or final, is about to cancel the detector's pending turn
          // exactly as it always has), so a request pre-opened for that
          // pending turn is for text that will not be released. Abandon
          // it BEFORE the feed, so the detector's own handling — and any
          // fresh pending-turn notification it produces — starts clean.
          if (this.speculation !== undefined) this.abandonSpeculation("caller resumed speaking");

          this.record.turnDetector.feed(segment);
        }
      } catch {
        // A broken streaming STT connection here degrades to
        // "no more live transcription" rather than crashing the
        // session; `acquireNextUserTurn` will simply stop resolving
        // new turns, and `end()` still works normally.
      }
    })();
  }

  /**
   * Have we reached a machine? Read on every segment inside the
   * detection window and at most once per call — see the note on
   * `VOICEMAIL_DETECTION_WINDOW_MS` for why the window is narrow and
   * what a false positive costs.
   *
   * Interim segments are TESTED but not accumulated: testing them is
   * what makes the gate fast enough to cut our own opening line while
   * it is still playing, and accumulating them would count the same
   * words several times over.
   */
  private checkForVoicemail(segment: TranscriptSegment): void {
    if (this.voicemailDetected) return;
    const text = segment.text.trim();
    if (text.length === 0) return;
    // Both bounds are load-bearing — see the constant.
    if (this.record.turnIndex !== 0) return;
    if (Date.now() - this.runStartedAtMs > VOICEMAIL_DETECTION_WINDOW_MS) return;

    const heard = this.earlyTranscript.length > 0 ? `${this.earlyTranscript} ${text}` : text;
    const phrase = voicemailPhraseIn(heard);
    if (phrase === undefined) {
      if (segment.isFinal) this.earlyTranscript = heard.slice(-VOICEMAIL_TRANSCRIPT_CAP);
      return;
    }
    this.hangUpOnVoicemail(phrase, heard);
  }

  /**
   * We reached a machine: stop talking and HANG UP.
   *
   * Three things, in this order, and the order matters.
   *
   *   1. Stop mid-sentence. `voicemailDetected` closes
   *      `synthesizeAndPlay` — the one choke point every spoken word on
   *      every path goes through — so nothing further can be
   *      synthesized even while the hangup is in flight. The transition
   *      reason says "barge-in" because that is exactly what the
   *      transports must do with it: their existing
   *      SPEAKING -> LISTENING handler reads the reason and clears both
   *      our outbound queue and the carrier's playback buffer, so the
   *      machine stops hearing us in the same tick. That is why no new
   *      transport message is needed.
   *
   *   2. Record what the machine said. The outcome classifier reads the
   *      transcript, and this phrase is the whole evidence for the
   *      `suspected_voicemail` label. Hanging up before the turn
   *      detector had released a turn would leave an empty transcript
   *      and the call would be filed as an ordinary silent one.
   *
   *   3. End the call, through the manager's existing public `end` —
   *      the same one the Dashboard's End Call and the campaign
   *      watchdog use. It aborts the loop, closes the media stream and
   *      tells the telephony provider to hang up the carrier leg, so
   *      the line is released immediately rather than held open for the
   *      silence watchdog to time out on. Not awaited: this runs on the
   *      STT listener task, and `end` itself awaits the conversation
   *      loop it is aborting.
   */
  private hangUpOnVoicemail(phrase: string, heard: string): void {
    this.voicemailDetected = true;
    // FIX #8 — a machine gets no reply, so nothing pre-opened for it is wanted.
    this.abandonSpeculation("voicemail detected");
    // eslint-disable-next-line no-console
    console.warn(
      `[PIPELINE:${this.record.id}] VOICEMAIL DETECTED ("${phrase}") — stopping the agent and hanging up`,
    );
    // Whatever reply is in flight is cancelled and must never be
    // committed as something a person heard.
    this.cancelledResponseId = this.currentResponseId;
    this.cancelledHeardText = "";
    this.record.bargeIn.triggerBargeIn();
    if (this.record.state === SessionState.SPEAKING) {
      this.host.transition(
        this.record,
        SessionState.LISTENING,
        "voicemail detected — barge-in to stop the agent speaking",
      );
    }

    // See (2) above: the evidence, committed before the call ends.
    const machineText = heard.trim();
    if (machineText.length > 0) {
      this.record.memory.recordUserTurn(
        machineText,
        detectLanguage(machineText, this.record.memory.currentLanguage).language,
      );
      this.record.liveUserTranscript = "";
    }

    void Promise.resolve(this.host.end(this.record.id)).catch(() => {
      // Already ending, or ended by the transport dropping first —
      // `end` is idempotent and there is nothing left to do here.
    });
  }

  private async acquireNextUserTurn(loopSignal: AbortSignal): Promise<AcquiredTurn | null> {
    if (this.usesStreamingStt) {
      return this.waitForTurnDetectorEnd(loopSignal);
    }
    return this.acquireBatchTurn(loopSignal);
  }

  private waitForTurnDetectorEnd(loopSignal: AbortSignal): Promise<AcquiredTurn | null> {
    return new Promise((resolve) => {
      let settled = false;
      // FIX #8 — the speculation window is exactly this subscription.
      this.awaitingTurn = true;

      const finish = (result: AcquiredTurn | null): void => {
        if (settled) return;
        settled = true;
        this.awaitingTurn = false;
        unsubscribe();
        unsubscribePending();
        loopSignal.removeEventListener("abort", onAbort);
        // FIX #8 — the loop is ending, or a turn was released with text
        // other than the one speculated on; either way that request is
        // for a turn that will never be sent. Matching text is adopted
        // (or abandoned) in `runThinkingAndSpeaking`, never here.
        if (result === null || (this.speculation !== undefined && this.speculation.text !== result.text)) {
          this.abandonSpeculation(result === null ? "turn acquisition ended" : "released turn differs from the speculated text");
        }
        resolve(result);
      };

      // FIX #8 — see `SpeculativeCompletion`. Observation of the
      // detector's evidenced confirmation window; it decides nothing
      // about the release.
      const unsubscribePending = this.record.turnDetector.onTurnPending((text) => {
        // FIX #11 — pre-open the TTS transport. First, because it is the
        // longest lead time available to it and it costs nothing to
        // start: it opens a network connection and nothing else.
        this.prepareTtsTransport();
        this.startSpeculation(text);
      });

      const unsubscribe = this.record.turnDetector.onTurnEnd((event) => {
        // FIX #7A — captured at the top of this listener, which
        // `AdaptiveTurnDetector.emitTurnEnd` invokes synchronously, so
        // this IS the turn-release instant, not an approximation of it.
        const turnReleasedAtMs = Date.now();
        // eslint-disable-next-line no-console
        console.log(
          `[TIMING:${this.record.id}] TURN END turn-release=${turnReleasedAtMs} text="${event.text}" sttMs=${event.turnDurationMs}`,
        );
        const audioSeconds = this.consumeSinceLastTurnAudioSeconds();
        const providerId = this.providers.stt.descriptor.id;

        // Snapshot the metrics observers for THIS turn before the next
        // one starts overwriting them. `userSpeechEndedAtMs` back-dates
        // the last final's arrival by its own recognition lag, giving
        // the wall clock at which the caller actually stopped talking —
        // the t0 the end-to-end latency is measured from.
        const sttLagMs = this.lastFinalSttLagMs;
        const lastSegmentAtMs = this.lastFinalSegmentAtMs;
        const userSpeechEndedAtMs =
          lastSegmentAtMs !== undefined ? lastSegmentAtMs - (sttLagMs ?? 0) : undefined;
        this.lastFinalSttLagMs = undefined;
        this.lastFinalSegmentAtMs = undefined;
        // Same snapshot-then-clear pattern for the Deepgram endpoint
        // evidence that triggered this release (see the field docs).
        const endpointEvidenceAtMs = this.lastEndpointEvidenceAtMs;
        const endpointEvidenceKind = this.lastEndpointEvidenceKind;
        this.lastEndpointEvidenceAtMs = undefined;
        this.lastEndpointEvidenceKind = undefined;

        finish({
          text: event.text,
          userSpeechMs: event.turnDurationMs,
          sttLagMs,
          userSpeechEndedAtMs,
          sttCostUsd: estimateSttCost(providerId, audioSeconds),
          turnReleasedAtMs,
          endpointEvidenceAtMs,
          endpointEvidenceKind,
        });
      });

      const onAbort = (): void => finish(null);
      loopSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private consumeSinceLastTurnAudioSeconds(): number {
    if (this.sinceLastTurnBytes === 0 || !this.sinceLastTurnSampleRateHz) return 0;
    const seconds = estimateAudioSeconds({
      data: new Uint8Array(this.sinceLastTurnBytes),
      encoding: this.sinceLastTurnEncoding ?? "PCM_16",
      sampleRateHz: this.sinceLastTurnSampleRateHz,
    });
    this.sinceLastTurnBytes = 0;
    return seconds;
  }

  private async acquireBatchTurn(loopSignal: AbortSignal): Promise<AcquiredTurn | null> {
    this.batchAudioIterator ??= this.inboundAudioSource()[Symbol.asyncIterator]();

    while (!loopSignal.aborted) {
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<IteratorResult<AudioPayload>>((resolve) => {
        onAbort = () => resolve({ value: undefined as unknown as AudioPayload, done: true });
        loopSignal.addEventListener("abort", onAbort, { once: true });
      });

      const next = await Promise.race([this.batchAudioIterator.next(), abortPromise]);
      if (onAbort) loopSignal.removeEventListener("abort", onAbort);

      if (next.done || loopSignal.aborted) return null;

      const providerId = this.providers.stt.descriptor.id;
      let segments: TranscriptSegment[] = [];

if (this.usesStreamingStt && this.providers.stt.transcribeStream) {
  segments = [];

  for await (const segment of this.providers.stt.transcribeStream({
    sessionId: this.record.id,
    audio: (async function* () {
      yield next.value;
    })(),
    language: this.record.memory.currentLanguage,
    signal: loopSignal,
  })) {
    segments.push(segment);
  }
} else {
  segments = [
    ...(await withGracefulRetry("SPEECH_TO_TEXT", () =>
    this.providers.stt.transcribe({
      sessionId: this.record.id,
      audio: next.value,
      language: this.record.memory.currentLanguage,
    }),
    )),
];
}

      const text = segments
        .filter((segment) => segment.isFinal)
        .map((segment) => segment.text)
        .join(" ")
        .trim();

      if (text.length === 0) continue; // silence/noise chunk — keep listening

      // A batch `transcribe()` exposes no per-segment stream
      // timestamps, so recognition lag and end-of-speech are genuinely
      // unmeasurable here — reported as absent rather than as 0.
      return {
        text,
        userSpeechMs: 0,
        sttLagMs: undefined,
        userSpeechEndedAtMs: undefined,
        sttCostUsd: estimateSttCost(providerId, estimateAudioSeconds(next.value)),
        // Batch STT has no incremental endpointing event to speak of —
        // the whole utterance resolves at once, right here.
        turnReleasedAtMs: Date.now(),
        endpointEvidenceAtMs: undefined,
        endpointEvidenceKind: undefined,
      };
    }

    return null;
  }

  // ---------------------------------------------------------------
  // LLM + TTS
  // ---------------------------------------------------------------

  /**
   * Builds the turn array sent to the LLM.
   *
   * Rules:
   *   1. Exactly ONE system turn — the leading prompt from ConversationMemory.
   *   2. The language hint and the current-turn marker are folded into
   *      the latest user message, never added as separate system turns
   *      (doing so caused
   *      Gemma's `toGoogleContents` to merge ALL system turns into
   *      the first user message, growing it each turn and triggering
   *      prompt-echo).
   *   3. History order: system → user → assistant → user → assistant …
   */
 private buildRequestHistory(
  detectedLanguage: SupportedLanguage,
  // FIX #8 — optional, additive: the window to annotate. Defaults to
  // exactly what it always read; `startSpeculation` passes the memory's
  // preview of that same window with the pending user turn appended.
  recent: readonly ConversationTurn[] = this.record.memory.recentHistory(),
): readonly ConversationTurn[] {

  const turns = recent.map(turn => ({ ...turn }));

  const hint = languageHintFor(detectedLanguage);

  for (let i = turns.length - 1; i >= 0; i--) {

      const turn = turns[i];

      if (!turn) continue;

      if (turn.role === "user") {

          // Marked as well as language-hinted. History has no "this one
          // is now" signal of its own, and a barge-in leaves two user
          // turns in a row with no assistant turn between them (the
          // interrupted reply is never committed) — which is exactly
          // when a reply comes back continuing the previous topic
          // instead of answering what was just asked.
          turn.content = `${currentTurnNote()}\n${hint}\n${turn.content}`;

          break;
      }
  }

  return turns;
}

  /**
   * Speaks a known utterance with no LLM call in the path — used for
   * the greeting, whose text the system prompt already fixes.
   *
   * Goes through the same THINKING -> SPEAKING -> drain sequence as a
   * generated reply so state transitions, barge-in and playback
   * accounting behave identically; only the token-generation stage is
   * absent. THINKING is entered because the state machine has no
   * LISTENING -> SPEAKING edge, and skipping it would also hide the
   * greeting from the dashboard's state stepper.
   */
  private async speakFixedUtterance(
    text: string,
    loopSignal: AbortSignal,
    transitionReason = "preparing the greeting",
  ): Promise<void> {
    this.host.transition(this.record, SessionState.THINKING, transitionReason);
    const speakingSignal = this.enterSpeaking();
    if (speakingSignal.aborted || loopSignal.aborted) return;

    const spoken = await this.synthesizeAndPlay(toSpokenText(text), speakingSignal);
    // The greeting is a startup action, not a turn, so it is correctly
    // absent from `turnLatencies` — but it still consumes real TTS
    // characters, and that cost used to be dropped on the floor.
    this.record.metrics.recordAuxiliaryCost({ textToSpeech: spoken.ttsCostUsd });
    await this.drainPlayback(speakingSignal);
  }

  private async runThinkingAndSpeaking(
    userText: string,
    detected: LanguageDetectionResult,
    loopSignal: AbortSignal,
  ): Promise<ThinkingAndSpeakingResult> {
    const sid = this.record.id;
    const isGreeting = userText === "";

    this.host.transition(this.record, SessionState.THINKING, "generating a reply");
    const thinkingSignal = combineSignals([this.record.bargeIn.beginThinking(), loopSignal]);
    const request: CompletionRequest = { sessionId: this.record.id, history: this.buildRequestHistory(detected.language) };
    const llmProviderId = this.providers.llm.descriptor.id;
    // FIX #8 — the request above is STILL built, exactly as before, and
    // is the reference a pre-opened request must match to be adopted.
    // Anything else falls through to sending `request` as today.
    const preOpened = this.adoptSpeculation(userText, request, thinkingSignal);

    // eslint-disable-next-line no-console
    console.log(
      `[LLM:${sid}] Sending to ${llmProviderId}: historyLength=${request.history.length} roles=[${request.history.map((t) => t.role).join(",")}] streaming=${typeof this.providers.llm.generateCompletionStream === "function"}`,
    );
    this.markTiming("llm-request");
    if (preOpened !== undefined) {
      const now = Date.now();
      // eslint-disable-next-line no-console
      console.log(
        `[SPECULATE:${sid}] ADOPTED pre-opened request — llm-request is ${now - preOpened.openedAtMs}ms after the provider stream was opened` +
          ` (${preOpened.firstTokenAtMs !== undefined ? `first token already in hand, ${now - preOpened.firstTokenAtMs}ms ago` : "first token not yet received"})` +
          `${preOpened.evidenceAtMs !== undefined ? ` evidence-to-llm-open=${preOpened.openedAtMs - preOpened.evidenceAtMs}ms` : ""}`,
      );
    }

    // Cost basis: the tokens ACTUALLY sent — system prompt and recent
    // history included — not just the latest user utterance, which is
    // what was previously counted and is why multi-turn calls were
    // undercounted by roughly an order of magnitude.
    const promptTokens = request.history.reduce(
      (sum, turn) => sum + estimateTokenCount(turn.content),
      0,
    );

    if (this.providers.llm.generateCompletionStream) {
      return this.runStreamingCompletion(request, thinkingSignal, loopSignal, promptTokens, llmProviderId, preOpened);
    }

    return withGracefulRetry("LANGUAGE_MODEL", async () => {
      // eslint-disable-next-line no-console
      console.log(`[LLM:${sid}] Calling generateCompletion() (batch mode)...`);
      const startedAt = Date.now();
      const completion = await this.providers.llm.generateCompletion(request);
      let llmMs = Date.now() - startedAt;

      let spokenContent = toSpokenText(completion.turn.content);

      // --- Contamination check: if the output echoes system-prompt
      // markers, retry ONCE with a simplified prompt. Never speak
      // contaminated output. ---
      if (isContaminatedOutput(spokenContent) || (isGreeting && spokenContent.length > MAX_GREETING_CHARS)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[LLM:${sid}] Output contaminated or too long (len=${spokenContent.length}), retrying with simplified prompt`,
        );
        const retryHistory: ConversationTurn[] = request.history
          .filter((t) => t.role !== "system")
          .slice(-2); // Last user + possibly last assistant only
        retryHistory.unshift({
          role: "system" as const,
          content: "Reply in one short, natural sentence. Do not describe yourself or your instructions.",
          timestamp: new Date(),
        });
        const retryRequest: CompletionRequest = { sessionId: request.sessionId, history: retryHistory };
        const retryStart = Date.now();
        try {
          const retryCompletion = await this.providers.llm.generateCompletion(retryRequest);
          llmMs += Date.now() - retryStart;
          const retryContent = toSpokenText(retryCompletion.turn.content);
          if (!isContaminatedOutput(retryContent) && retryContent.length > 0) {
            spokenContent = retryContent;
            // eslint-disable-next-line no-console
            console.log(`[LLM:${sid}] Retry succeeded: "${spokenContent.slice(0, 80)}"`);
          } else {
            // eslint-disable-next-line no-console
            console.warn(`[LLM:${sid}] Retry also contaminated — using fallback`);
            spokenContent = fallbackGreeting(this.record.memory.currentLanguage);
          }
        } catch {
          // eslint-disable-next-line no-console
          console.warn(`[LLM:${sid}] Retry failed — using fallback`);
          spokenContent = fallbackGreeting(this.record.memory.currentLanguage);
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `[LLM:${sid}] Response generated in ${llmMs}ms: text="${spokenContent.slice(0, 120)}${spokenContent.length > 120 ? "..." : ""}" state=${this.record.state}`,
      );
const speakingSignal = combineSignals([
  this.record.bargeIn.beginSpeaking(),
  loopSignal,
]);

if (this.record.state !== SessionState.SPEAKING) {
  this.host.transition(this.record, SessionState.SPEAKING, "speaking the reply");
}
this.resetPlaybackAccounting();

const { ttsMs, ttsCostUsd, firstChunkMs } =
  await this.synthesizeAndPlay(spokenContent, speakingSignal);

// Streaming TTS only enqueues; hold SPEAKING until playback drains.
// (The batch-TTS branch already sleeps for its own playback and will
// simply find nothing left to wait for here.)
await this.drainPlayback(speakingSignal);

      // A non-streaming provider emits nothing until generation is
      // complete, so time-to-first-token and full generation time are
      // necessarily the same measurement. Neither is contaminated by
      // TTS here: `generateCompletion` is a single await with no
      // synthesis interleaved inside it.
      return {
        assistantText: spokenContent,
        llmMs,
        llmGenerationMs: llmMs,
        llmCostUsd: estimateLlmCost(llmProviderId, promptTokens, estimateTokenCount(spokenContent)),
        ttsMs: firstChunkMs,
        ttsSynthesisMs: ttsMs,
        ttsCostUsd,
        // Non-streaming LLM path: exactly one synthesizeAndPlay call for the whole reply.
        ttsChunkCount: 1,
      };
    });
  }

  private async runStreamingCompletion(
    request: CompletionRequest,
    thinkingSignal: AbortSignal,
    loopSignal: AbortSignal,
    promptTokens: number,
    llmProviderId: string,
    // FIX #8 — optional, additive: an adopted pre-opened stream for THIS
    // request. When present it is consumed in place of opening a new
    // one, and `startedAt` is the instant it was really opened, so
    // `llmMs` stays what it is documented as: provider time-to-first-token.
    preOpened?: SpeculativeCompletion,
  ): Promise<ThinkingAndSpeakingResult> {
    const chunker = new SentenceChunker();
    let fullText = "";
    let finalText: string | undefined;
    let ttsSynthesisMs = 0;
    let ttsCostUsd = 0;
    let speakingSignal: AbortSignal | undefined;
    // --- Metrics accumulators (no effect on generation or playback) ---
    /** Request -> first token. The only LLM figure TTS cannot contaminate. */
    let llmFirstTokenMs: number | undefined;
    /** Time-to-first-audio of the FIRST utterance spoken this turn. */
    let ttsFirstChunkMs: number | undefined;
    /**
     * Wall clock spent inside `synthesizeAndPlay` while the LLM stream
     * was still open. The provider's generator is suspended at its
     * `yield` for exactly this long, so its own `latencyMs` silently
     * includes it — subtracting it back out is what makes
     * `llmGenerationMs` a real generation measurement.
     */
    let ttsBlockedDuringStreamMs = 0;
    /** Wall clock at which the LLM stream finished producing. */
    let llmStreamEndedAtMs: number | undefined;
    // --- OpenAI usage telemetry, carried through from the final event.
    // Purely diagnostic: never read to alter this turn's request or
    // response, only forwarded into `TurnLatencyBreakdown`. ---
    let reportedPromptTokens: number | undefined;
    let cachedPromptTokens: number | undefined;
    let reasoningTokens: number | undefined;
    let reportedCompletionTokens: number | undefined;
    /** FIX #7A — telemetry only: count of sentence-level synthesizeAndPlay invocations this turn. */
    let ttsChunkCount = 0;
    // Set once contamination is detected mid-stream: stops speaking any
    // further sentences from this turn. See the contamination check
    // below for why this exists — the batch path's isContaminatedOutput
    // + retry safety net never runs for a streaming provider, and both
    // configured LLM providers (GPT-5.1, Gemma) implement streaming.
    let contaminated = false;
    /**
     * Set when the caller's newer turn cancelled this reply before a
     * word of it was spoken. Only used to keep the two checks below
     * from cancelling — and logging — the same reply twice.
     */
    let superseded = false;
    const startedAt = preOpened?.openedAtMs ?? Date.now();

    try {
      const stream =
        preOpened !== undefined
          ? this.resumeSpeculativeStream(preOpened)
          : this.providers.llm.generateCompletionStream?.(request, thinkingSignal);
      if (!stream) throw new Error("generateCompletionStream unexpectedly unavailable");

      for await (const event of stream) {
        if (thinkingSignal.aborted) break;

        if (event.type === "token") {
          if (fullText.length === 0) {
            // FIX #8 — for an adopted pre-opened stream whose first token
            // arrived BEFORE adoption, measure to its real arrival, not
            // to the moment this loop got round to reading it.
            llmFirstTokenMs ??= (preOpened?.firstTokenAtMs ?? Date.now()) - startedAt;
            this.markTiming("llm-first-token");
          }
          fullText += event.delta;
          const readySentences = chunker.push(event.delta);
          for (const sentence of readySentences) {
            const cleaned = toSpokenText(sentence);
            if (cleaned.length === 0) continue;

            // FIX #7A — the chunker has just produced a TTS-ready
            // sentence. Marked here, before the contamination/
            // supersession checks below, because those decide whether
            // the sentence gets SPOKEN, not whether it was READY.
            if (!this.markedFirstSentenceThisTurn) {
              this.markedFirstSentenceThisTurn = true;
              this.markTiming("first-sentence-ready");
            }

            // Check the ACCUMULATED text so far, not just this sentence
            // in isolation — a leak's markers are often split across
            // sentence boundaries (e.g. "Persona: ..." / "Constraints:
            // ..."), and isContaminatedOutput requires two markers to
            // avoid false positives on an innocent single word. This
            // can't prevent an EARLIER sentence in the same turn from
            // having already been spoken (streaming speaks as it goes,
            // by design, for latency) — but it stops the turn the
            // moment contamination becomes detectable, rather than
            // speaking the entire echoed prompt to the caller.
            if (isContaminatedOutput(fullText)) {
              contaminated = true;
              break;
            }

            // ── Superseded, not interrupted ───────────────────────
            //
            // Nothing of this reply has been spoken yet
            // (`speakingSignal` is still unset), and the caller has
            // ALREADY finished saying something newer — a correction, a
            // clarification, a different question. Speaking this now
            // answers a question they have moved on from, and then
            // makes them wait through it before their real one is
            // answered. That is the stale-backlog behaviour: old
            // question, old answer, new question, new answer.
            //
            // So the reply is cancelled through the SAME path a
            // barge-in takes — the caller's newer turn wins, this
            // response is never committed, and the buffered turn (the
            // turn detector merges consecutive ones, so a correction
            // and the thought it corrects arrive together) is picked up
            // as the next turn on the following iteration. One current
            // response instead of a queue of stale ones.
            //
            // Deliberately only BEFORE the first sentence. Once audio
            // is playing, the caller talking is a barge-in and is
            // handled exactly as it is today; nothing about that path
            // changes. And the loop cannot stall: a buffered turn is
            // delivered to the next subscriber immediately, so every
            // supersession is followed by a real turn.
            if (speakingSignal === undefined && this.newerUserTurnWaiting()) {
              // eslint-disable-next-line no-console
              console.log(
                `[PIPELINE:${this.record.id}] reply SUPERSEDED before it was spoken — the caller has already said something newer`,
              );
              superseded = true;
              this.triggerExternalBargeIn();
              break;
            }

            speakingSignal ??= this.enterSpeaking();
            if (speakingSignal.aborted) break;
            const synthesisStartedAt = Date.now();
            const spoken = await this.synthesizeAndPlay(cleaned, speakingSignal);
            ttsBlockedDuringStreamMs += Date.now() - synthesisStartedAt;
            ttsFirstChunkMs ??= spoken.firstChunkMs;
            ttsSynthesisMs += spoken.ttsMs;
            ttsCostUsd += spoken.ttsCostUsd;
            ttsChunkCount += 1;
          }
        } else {
          finalText = event.turn.content;
          llmStreamEndedAtMs = Date.now();
          reportedPromptTokens = event.promptTokens;
          cachedPromptTokens = event.cachedPromptTokens;
          reasoningTokens = event.reasoningTokens;
          reportedCompletionTokens = event.completionTokens;
        }

        if (contaminated || speakingSignal?.aborted) break;
      }
    } catch {
      // Streaming LLM connection dropped mid-reply — speak whatever
      // was generated so far rather than losing the turn entirely.
    }

    // The stream may end without a final event (abort, dropped
    // connection); fall back to "now" so generation time is still
    // bounded by something real.
    llmStreamEndedAtMs ??= Date.now();
    const llmGenerationMs = Math.max(
      0,
      llmStreamEndedAtMs - startedAt - ttsBlockedDuringStreamMs,
    );

    if (contaminated) {
      // eslint-disable-next-line no-console
      console.warn(
        `[LLM:${this.record.id}] Streaming output contaminated (prompt echo) — suppressing remainder of turn, using fallback`,
      );
      const fallback = fallbackGreeting(this.record.memory.currentLanguage);
      if (!(speakingSignal?.aborted ?? false)) {
        speakingSignal ??= this.enterSpeaking();
        if (!speakingSignal.aborted) {
          const spoken = await this.synthesizeAndPlay(fallback, speakingSignal);
          ttsFirstChunkMs ??= spoken.firstChunkMs;
          ttsSynthesisMs += spoken.ttsMs;
          ttsCostUsd += spoken.ttsCostUsd;
          ttsChunkCount += 1;
        }
      }
      // Stay in SPEAKING until the queued audio has actually played.
      // The TTS metrics are already fixed above, so the drain never
      // leaks into them.
      if (speakingSignal) await this.drainPlayback(speakingSignal);
      return {
        assistantText: fallback,
        llmMs: llmFirstTokenMs,
        llmGenerationMs,
        llmCostUsd: estimateLlmCost(llmProviderId, promptTokens, estimateTokenCount(fallback)),
        ttsMs: ttsFirstChunkMs,
        ttsSynthesisMs,
        ttsCostUsd,
        ttsChunkCount,
        ...(reportedPromptTokens !== undefined ? { reportedPromptTokens } : {}),
        ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        ...(reportedCompletionTokens !== undefined ? { reportedCompletionTokens } : {}),
      };
    }

    const rawRemainder = chunker.flush();
    const remainder = rawRemainder ? toSpokenText(rawRemainder) : "";
    // The same supersession test, for the reply that never reached a
    // sentence cut and so arrives here whole. Same two conditions:
    // nothing spoken yet, and the caller has already moved on.
    if (superseded) {
      // Already cancelled above; the remainder belongs to the reply the
      // caller has moved on from, so none of it is spoken.
    } else if (remainder.length > 0 && speakingSignal === undefined && this.newerUserTurnWaiting()) {
      // eslint-disable-next-line no-console
      console.log(
        `[PIPELINE:${this.record.id}] reply SUPERSEDED before it was spoken — the caller has already said something newer`,
      );
      this.triggerExternalBargeIn();
    } else if (remainder.length > 0 && !(speakingSignal?.aborted ?? false)) {
      speakingSignal ??= this.enterSpeaking();
      if (!speakingSignal.aborted) {
        const spoken = await this.synthesizeAndPlay(remainder, speakingSignal);
        ttsFirstChunkMs ??= spoken.firstChunkMs;
        ttsSynthesisMs += spoken.ttsMs;
        ttsCostUsd += spoken.ttsCostUsd;
        ttsChunkCount += 1;
      }
    }

    // Hold SPEAKING open for the audio still queued on the transport.
    // Aborts instantly on barge-in; the TTS metrics were accumulated
    // from generation time only, so they are unaffected.
    if (speakingSignal) await this.drainPlayback(speakingSignal);

    const assistantText = toSpokenText(finalText ?? fullText);

    // If nothing was ever spoken (e.g. immediate barge-in), still
    // make sure we transitioned through SPEAKING at least nominally
    // isn't required — LISTENING is re-entered naturally by the
    // caller's next loop iteration either way.
    void loopSignal;

    return {
      assistantText,
      llmMs: llmFirstTokenMs,
      llmGenerationMs,
      llmCostUsd: estimateLlmCost(llmProviderId, promptTokens, estimateTokenCount(assistantText)),
      ttsMs: ttsFirstChunkMs,
      ttsSynthesisMs,
      ttsCostUsd,
      ttsChunkCount,
      ...(reportedPromptTokens !== undefined ? { reportedPromptTokens } : {}),
      ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      ...(reportedCompletionTokens !== undefined ? { reportedCompletionTokens } : {}),
    };
  }

  private enterSpeaking(): AbortSignal {
    if (this.record.state !== SessionState.SPEAKING) {
      this.host.transition(this.record, SessionState.SPEAKING, "speaking the reply");
    }
    this.resetPlaybackAccounting();
    return combineSignals([this.record.bargeIn.beginSpeaking(), this.record.loopAbortController!.signal]);
  }

  // ---------------------------------------------------------------
  // Real-time playback accounting
  //
  // A streaming TTS provider hands us a whole reply far faster than
  // real time, and `playAudioChunk` only ENQUEUES it on the transport
  // (both the Plivo and Vobiz bridges pace their own 20ms pumps).
  // Without the drain below, SPEAKING ended the moment the last byte
  // was queued — leaving several seconds of assistant audio still
  // playing while the session already claimed to be LISTENING. That
  // single fact broke barge-in (`state === SPEAKING` was false, so no
  // interruption was ever triggered) and let a new turn's audio be
  // appended behind the previous turn's backlog.
  // ---------------------------------------------------------------

  /** Total real-time duration of audio handed to the transport this speaking phase. */
  private outboundQueuedMs = 0;
  /** Wall clock at which the transport began playing this speaking phase. */
  private outboundPlaybackStartedAt = 0;
  /**
   * Every utterance handed to the transport this speaking phase, with
   * the playback offset (ms into this phase's audio) at which it
   * starts — i.e. `outboundQueuedMs` as it stood before the utterance
   * was queued. Read only by `heardSoFarText`, to tell the part of an
   * interrupted reply the caller heard from the part they did not.
   */
  private spokenUtterances: Array<{ readonly text: string; readonly startsAtMs: number }> = [];

  private resetPlaybackAccounting(): void {
    this.outboundQueuedMs = 0;
    this.outboundPlaybackStartedAt = 0;
    // Belongs to one reply, like the two counters above it.
    this.spokenUtterances = [];
    // Called at exactly the two places the session enters SPEAKING, so
    // this is the stream-clock mark the barge-in check above compares
    // incoming transcript segments against.
    this.speakingStartedAtStreamMs = this.inboundStreamMs;
    // A backchannel judgement belongs to one utterance during one
    // reply. If Deepgram never sent the final that would have closed it
    // (a dropped socket mid-"okay"), it must not carry into the next
    // reply and absorb the first acknowledgement heard there.
    this.backchannelInFlight = false;
  }

  /**
   * Holds SPEAKING open until the audio already handed to the
   * transport has actually played out. Resolves immediately when
   * `signal` aborts, so barge-in cuts the wait with no added latency.
   */
  private async drainPlayback(signal: AbortSignal): Promise<void> {
    if (this.outboundPlaybackStartedAt === 0 || this.outboundQueuedMs <= 0) return;
    if (signal.aborted) return;

    const elapsedMs = Date.now() - this.outboundPlaybackStartedAt;
    // Small allowance for the bridge's startup pre-roll: the pump waits
    // for a few frames before its first send, so playback starts
    // marginally later than the first enqueue.
    const remainingMs = this.outboundQueuedMs - elapsedMs + PLAYBACK_PREROLL_ALLOWANCE_MS;
    if (remainingMs <= 0) return;

    // eslint-disable-next-line no-console
    console.log(
      `[PLAYBACK:${this.record.id}] draining ${Math.round(remainingMs)}ms of queued audio before leaving SPEAKING (queued=${Math.round(this.outboundQueuedMs)}ms elapsed=${elapsedMs}ms)`,
    );
    await abortableSleep(remainingMs, signal);
  }

  private async synthesizeAndPlay(
    text: string,
    speakingSignal: AbortSignal,
  ): Promise<{ ttsMs: number; ttsCostUsd: number; firstChunkMs?: number }> {
    const sid = this.record.id;
    // THE choke point. Every spoken word on every path — the greeting,
    // a generated reply, the contamination fallback, a resumed
    // remainder — is synthesized here, so one condition here is what
    // makes "the agent does not speak on a voicemail" a guarantee
    // instead of a list of places that remembered to check.
    if (speakingSignal.aborted || text.trim().length === 0 || this.voicemailDetected) {
      // eslint-disable-next-line no-console
      console.log(`[TTS:${sid}] synthesizeAndPlay skipped (aborted=${speakingSignal.aborted} emptyText=${text.trim().length === 0} voicemail=${this.voicemailDetected})`);
      return { ttsMs: 0, ttsCostUsd: 0 };
    }

    // FIX #7A — this utterance is actually going to be synthesized;
    // marks the first such call this turn, i.e. the moment TTS is
    // requested for the turn's first chunk.
    if (!this.markedTtsRequestThisTurn) {
      this.markedTtsRequestThisTurn = true;
      this.markTiming("tts-request");
    }

    // The text of this utterance, against the playback offset it starts
    // at. Recorded before synthesis so it is recorded whether or not
    // the provider, the transport or the caller cuts it short —
    // `heardSoFarText` decides what of it was heard from the play head,
    // not from whether this call returned. The original wording is
    // stored, NOT the `pronounceForSpeech` rewrite below: history, the
    // classifier and the sheet all read approved wording.
    this.spokenUtterances.push({ text, startsAtMs: this.outboundQueuedMs });

    const ttsProviderId = this.providers.tts.descriptor.id;
    const language = this.record.memory.currentLanguage;
    const task: SynthesisTaskRequest = {
      sessionId: this.record.id,
      // Numeric notation ("7:30 PM", "₹1,50,000+") is read aloud
      // differently in English than in Hindi/Hinglish, and every TTS
      // vendor mangles it the same way. Rewriting it HERE, on the way
      // into `synthesize`, is what keeps that fix identical across
      // Cartesia, Smallest AI, Sarvam and ElevenLabs while leaving the
      // transcript, the classifier and the sheet reading the original
      // approved wording.
      request: { text: pronounceForSpeech(text, language), language },
    };
    const startedAt = Date.now();

    if (this.providers.tts.synthesizeStream) {
      let chunkCount = 0;
      // Synthesis time-to-first-chunk for THIS utterance. Independent
      // of `markedTtsThisTurn`, which fires once per turn and so
      // cannot measure the second and later sentences.
      let firstChunkMs: number | undefined;
      /**
       * Real-time duration of the audio this utterance actually
       * yielded. Accumulated per chunk, so a barge-in halfway through
       * bills for the half that was generated rather than for a whole
       * clip that never was. See the cost note below.
       */
      let generatedAudioSeconds = 0;
      this.transportBackpressureMs = 0;
      try {
       for await (const chunk of this.providers.tts.synthesizeStream(task, speakingSignal)) {
   if (chunkCount === 0) {
    firstChunkMs = Date.now() - startedAt;
    if (!this.markedTtsThisTurn) {
      this.markedTtsThisTurn = true;
      this.markTiming("tts-first-chunk");
    }
}
  if (speakingSignal.aborted) {
    console.log(`[TTS:${sid}] Barge-in detected, interrupting playback`);

    await this.record.mediaStream?.interruptPlayback();

    break;
  }

  chunkCount += 1;
  generatedAudioSeconds += estimateAudioSeconds(chunk.audio);

  await this.playAudioChunk(chunk.audio);
}
      } catch (err) {
        if (!speakingSignal.aborted) {
          // eslint-disable-next-line no-console
          console.warn(`[TTS:${sid}] streaming TTS error after ${chunkCount} chunks: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const ttsMs = Math.max(0, Date.now() - startedAt - this.transportBackpressureMs);
      // Charged once for this utterance's text, not per chunk.
      //
      // BOTH billing units are handed over and the provider's own rate
      // table picks the one it actually bills in — exactly as the batch
      // branch below already does. This used to pass characters only,
      // with a note saying ElevenLabs was the sole provider here and
      // billed per character, and that a duration-billed vendor gaining
      // a streaming path would have to supply its duration at this call
      // site. Cartesia is that vendor: it bills per generated audio
      // minute, so with no duration `estimateTtsCost` would warn and
      // return 0, silently zeroing the TTS cost of every campaign call.
      //
      // `generatedAudioSeconds` is summed from the chunks actually
      // yielded, so an utterance cut short by a barge-in is billed for
      // what was generated, not for the clip it would have been.
      return {
        ttsMs,
        ttsCostUsd: estimateTtsCost(ttsProviderId, text.length, generatedAudioSeconds),
        ...(firstChunkMs !== undefined ? { firstChunkMs } : {}),
      };
    }

    return withGracefulRetry("TEXT_TO_SPEECH", async () => {
      const audio = await this.providers.tts.synthesize(task);
      const ttsCallMs = Date.now() - startedAt;
      // Trace parity with the streaming branch above.
      //
      // `tts-first-chunk` existed ONLY there, so on a batch provider the
      // per-turn trace jumped straight from `llm-first-token` to
      // `audio-queued` and the span between them — chunk accumulation
      // plus the whole synthesis round trip — could not be attributed
      // from the logs at all. That gap is why "where do the 635ms go"
      // had to be answered by probing the vendor directly instead of by
      // reading a production call. Marks the same instant the streaming
      // branch does: the first audio this utterance produced.
      if (!this.markedTtsThisTurn) {
        this.markedTtsThisTurn = true;
        this.markTiming("tts-first-chunk");
      }
      await this.playAudioChunk(audio);

      // ── Do NOT wait out this clip's playback here ──────────────────
      //
      // This branch runs for every TTS provider that exposes only
      // `synthesize()`. As of the Smallest AI streaming change that is
      // NONE of the four configured providers: ElevenLabs, Sarvam,
      // Cartesia and Smallest AI all implement `synthesizeStream` and
      // all take the streaming branch above, which enqueues and returns
      // immediately. This branch is now the fallback for a provider
      // that does not stream, and the guarantee below is why it stays.
      // (This comment previously named Cartesia, Sarvam and Smallest AI
      // as batch-only and ElevenLabs as the sole streamer; every part
      // of that is now out of date. The feature detection above was
      // always correct — only the comment was wrong.)
      // The difference was the entire dead-air problem:
      //
      //   `runStreamingCompletion` awaits `synthesizeAndPlay` once per
      //   sentence chunk. `playAudioChunk` has already handed the whole
      //   clip to the transport and parked on the bridge's outbound
      //   backpressure until the queue drained back to its low-water
      //   mark (~0.8s still buffered). Sleeping the FULL clip duration
      //   on top of that waited for the same audio a second time, so
      //   the pump ran dry — and only then did the next sentence's
      //   synthesis round trip start, with nothing queued to cover it.
      //   Measured silence per chunk boundary: (clipDuration - 0.8s) +
      //   the next request's latency, i.e. the reported 1-3s pauses,
      //   landing on exactly the `.`/`,` boundaries the chunker cuts at.
      //
      // Dropping the sleep makes this branch behave like the streaming
      // one: the next sentence is synthesized while the current one is
      // still playing out of the transport queue, so the queue stays
      // fed across the boundary. Nothing is lost — SPEAKING is still
      // held open for queued-but-unplayed audio by `drainPlayback`,
      // which accounts for it from `outboundQueuedMs` (incremented in
      // `playAudioChunk` whether or not a transport is attached) and
      // aborts instantly on barge-in.
      const playbackMs = estimateAudioSeconds(audio) * 1000;
      if (speakingSignal.aborted) {
        await this.record.mediaStream?.interruptPlayback();
      }

      // Batch synthesis returns the whole utterance in one piece, so
      // first-audio and full-synthesis are the same measurement.
      //
      // Both billing units are handed over and the provider's own rate
      // table picks the one it actually bills in: characters for Sarvam
      // and Smallest AI, generated audio minutes for Cartesia. The
      // duration is `playbackMs` — the length of the synthesized audio
      // — NOT `ttsCallMs`, which is synthesis latency.
      return {
        ttsMs: ttsCallMs,
        ttsCostUsd: estimateTtsCost(ttsProviderId, text.length, playbackMs / 1000),
        firstChunkMs: ttsCallMs,
      };
    });
  }

  private playAudioChunkCount = 0;
  private outboundReadyResolved = false;
  /**
   * Wall-clock ms the current `synthesizeAndPlay` call spent parked on
   * transport backpressure. Subtracted from `ttsMs` so the benchmark
   * metric keeps measuring how fast the TTS provider generated audio,
   * not how long the telephony pump took to play it — the same
   * separation `drainPlayback` already preserves.
   */
  private transportBackpressureMs = 0;

  /**
   * Waits until at least one outbound delivery path (mediaStream or
   * a listener) is available, up to a timeout. Called once before
   * the first audio chunk to handle the edge case where the pipeline
   * starts before the bridge has registered its listener.
   */
  private async waitForOutboundReady(timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (this.outboundReadyResolved) return;
    const hasPath = () => !!this.record.mediaStream || this.record.outboundAudioListeners.size > 0;
    if (hasPath()) { this.outboundReadyResolved = true; return; }

    // eslint-disable-next-line no-console
    console.warn(
      `[PLAYBACK:${this.record.id}] No outbound delivery path yet — waiting up to ${timeoutMs}ms for bridge to attach`,
    );

    const deadline = Date.now() + timeoutMs;
    while (!hasPath() && Date.now() < deadline && !signal.aborted) {
      await new Promise((r) => setTimeout(r, 50));
    }

    this.outboundReadyResolved = true;
    if (!hasPath()) {
      // eslint-disable-next-line no-console
      console.error(
        `[PLAYBACK:${this.record.id}] WARNING: No outbound delivery path after ${timeoutMs}ms — audio will be lost. hasMediaStream=${!!this.record.mediaStream} listenerCount=${this.record.outboundAudioListeners.size}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[PLAYBACK:${this.record.id}] Outbound delivery path ready: hasMediaStream=${!!this.record.mediaStream} listenerCount=${this.record.outboundAudioListeners.size}`,
      );
    }
  }

  private async playAudioChunk(audio: AudioPayload): Promise<void> {
    this.playAudioChunkCount += 1;

    // On the first chunk, wait for the bridge to register its listener.
    if (this.playAudioChunkCount === 1) {
      await this.waitForOutboundReady(500, this.record.loopAbortController?.signal ?? AbortSignal.abort());
    }

    // Account for the real-time duration handed to the transport so
    // `drainPlayback` can hold SPEAKING open until it has actually
    // played. Zero-byte chunks are stream-end markers, not audio.
    if (audio.data.byteLength > 0) {
      if (this.outboundPlaybackStartedAt === 0) {
        this.outboundPlaybackStartedAt = Date.now();
      }
      if (!this.markedAudioThisTurn) {
        this.markedAudioThisTurn = true;
        // First frame handed to the transport. The caller hears it one
        // bridge pre-roll later (~100ms on the Plivo/Vobiz pumps).
        // This is the t1 of the end-to-end latency metric — the same
        // instant the `audio-queued` trace has always logged, now also
        // retained as a number instead of only reaching the console.
        this.firstAudioQueuedAtMs = Date.now();
        this.markTiming("audio-queued");
      }
      this.outboundQueuedMs += estimateAudioSeconds(audio) * 1000;
    }

    if (this.record.mediaStream) {
      await this.record.mediaStream.sendAudio(audio);
    }
    for (const listener of this.record.outboundAudioListeners) {
      // A transport may return a promise to apply backpressure once its
      // outbound queue is full (see SessionRecord.outboundAudioListeners).
      // Awaiting it paces this loop to roughly real time, which is what
      // keeps the bridge's queue — and therefore the audio at risk of
      // being discarded on barge-in or socket close — bounded.
      // Bridges resolve pending waiters on barge-in/close, so this can
      // never outlive the utterance it belongs to.
      const pending = listener(audio);
      if (pending) {
        const parkedAt = Date.now();
        await pending;
        this.transportBackpressureMs += Date.now() - parkedAt;
      }
    }
  }
}

export { toSessionErrorInfo };