/**
 * metrics-collector.ts
 *
 * Accumulates the latency and cost measurements the
 * VoiceSessionManager is required to expose via
 * `getBenchmarkMetrics` — per-stage (STT/LLM/TTS) latency per turn,
 * end-to-end per-turn latency, call duration, and estimated cost —
 * without owning any timing logic itself (the pipeline measures;
 * this class only aggregates and shapes the result).
 *
 * Two rules this class enforces on behalf of every consumer:
 *
 *   1. Call duration is measured from the TELEPHONY-CONFIRMED ANSWER
 *      (`markCallAnswered`), never from construction. Construction
 *      happens at `createSession`, i.e. before provider warm-up,
 *      before the outbound REST call, and before the phone has even
 *      started ringing — using it as the origin inflated every call
 *      by the whole dial-and-ring period.
 *
 *   2. A measurement that does not exist is `undefined`, never 0.
 *      Zero is a legitimate latency value and would be averaged in as
 *      one; "not measured" must survive all the way to the UI so it
 *      can render N/A.
 */

import type {
  BenchmarkMetrics,
  CallDurationMetric,
  EstimatedCostMetric,
  LatencyMeasurementMs,
  TurnLatencyBreakdown,
} from "../../types/benchmark.types";
import type { ProviderStackSelection, SessionId } from "../../types/session.types";
import { estimateTelephonyCost } from "./cost-estimator";
import { ALLOWED_ENDPOINTING_MS, type EndpointingAssignment } from "./stt-endpointing-experiment";

export interface TurnLatencyInput {
  readonly turnIndex: number;
  /** STT recognition lag, or `undefined` if the provider exposed no usable timestamps. */
  readonly sttMs: number | undefined;
  /** LLM time-to-first-token. */
  readonly llmMs: number | undefined;
  /** TTS time-to-first-audio-chunk. */
  readonly ttsMs: number | undefined;
  /** Measured end-of-speech -> first-audio-on-the-wire span. */
  readonly totalMs: number | undefined;
  readonly llmGenerationMs: number | undefined;
  readonly ttsSynthesisMs: number | undefined;
  readonly userSpeechMs: number | undefined;
  // PHASE 3 BATCH 1. OPTIONAL (`?:`), not merely nullable, and that is
  // deliberate: every field above is required-but-nullable, so adding
  // these as required would break every existing construction site of
  // this type — including tests that must not be edited to accommodate
  // a telemetry addition. Omitting them is identical to passing
  // `undefined`: both report "not measured".
  /** Endpoint claim observed -> turn released. `undefined` when the turn was released by inference. */
  readonly endpointToReleaseMs?: number | undefined;
  /** Caller's audio ended -> turn released. */
  readonly speechEndToReleaseMs?: number | undefined;
  /** First frame queued on the transport -> first frame the bridge actually sent. */
  readonly playbackStartupMs?: number | undefined;
  // PHASE 3 BATCH 3 — ABSOLUTE wall-clock observations, not durations.
  // Optional for the same backward-compatibility reason every batch
  // before them is: existing construction sites omit them, and omitting
  // is identical to "not observed". See `TurnLatencyBreakdown`.
  /** Wall clock of the most recent caller audio chunk received. */
  readonly lastInboundAudioAtMs?: number | undefined;
  /** Wall clock of the latest non-empty INTERIM transcript for this turn. */
  readonly lastInterimTranscriptAtMs?: number | undefined;
  /** Wall clock of the latest non-empty FINAL transcript for this turn. */
  readonly lastFinalTranscriptAtMs?: number | undefined;
  /** Wall clock at which this turn's endpoint evidence arrived. */
  readonly endpointEvidenceAtMs?: number | undefined;
  /** WHICH endpoint claim it was, preserved verbatim from the pipeline. */
  readonly endpointEvidenceKind?: "speech_final" | "utterance_end" | undefined;
  // PHASE 3 BATCH 4 — the audio-bytes clock read at the same event
  // `lastFinalTranscriptAtMs` reads the wall clock at. Measurement
  // validation only; see `TurnLatencyBreakdown`.
  /** `inboundStreamMs` at final-transcript arrival. A counter, so 0 is meaningful. */
  readonly inboundStreamMsAtFinalTranscript?: number | undefined;
  // PHASE 3 BATCH 6 — the other half of the STT-lag subtraction, and
  // the clock offset in force when it was taken.
  /** Re-based end of the last recognised word, in stream ms. A position, so 0 is meaningful. */
  readonly lastFinalWordEndStreamMs?: number | undefined;
  /** `sttClockOffsetMs` in force at that final. 0 means no re-base had occurred. */
  readonly sttClockOffsetMs?: number | undefined;
  /** PHASE 3 BATCH 5 — which guard the endpoint marker met in `noteEndOfSpeech`. */
  readonly endpointMarkerOutcome?: TurnLatencyBreakdown["endpointMarkerOutcome"];
  readonly sttCostUsd: number;
  readonly llmCostUsd: number;
  readonly ttsCostUsd: number;
  /** OpenAI-reported prompt tokens for this turn's LLM request, when the provider exposed them. */
  readonly promptTokens: number | undefined;
  /** Of `promptTokens`, how many were served from the prompt-prefix cache. */
  readonly cachedPromptTokens: number | undefined;
  /** Reasoning tokens generated before the first visible content token. */
  readonly reasoningTokens: number | undefined;
  // PHASE 3 BATCH 2A — optional for the same backward-compatibility
  // reason the Batch 1 boundaries are: existing construction sites
  // omit them, and omitting is identical to "not measured".
  /** HTTP attempts the SDK made for this turn's LLM request. */
  readonly llmAttempts?: number | undefined;
  /** Attempts beyond the first. */
  readonly llmRetries?: number | undefined;
  /** Measured wall clock spent on failed attempts plus backoff sleeps. */
  readonly llmRetryOverheadMs?: number | undefined;
  /** Compact non-sensitive retry reasons. */
  readonly llmRetryReasons?: string | undefined;
  /** PHASE 3 PHASE 0 — non-empty finals delivered for this turn. */
  readonly finalTranscriptCount?: number | undefined;
  /** PHASE 3 PHASE 0 — gaps between consecutive finals within the turn. */
  readonly interFinalGapsMs?: readonly number[] | undefined;
  // PHASE A — TURN DISPOSITION. Optional for the same
  // backward-compatibility reason every batch above is: existing
  // construction sites omit them, and omitting is identical to "not
  // reported". Counts and one closed string union — never text.
  /** What became of this turn's reply. See `TurnOutcome`. */
  readonly turnOutcome?: TurnLatencyBreakdown["turnOutcome"];
  /** Raw model-output characters this turn produced. A count, so 0 is meaningful. */
  readonly charsGenerated?: number | undefined;
  /** Sentence-level TTS invocations this turn made. A count, so 0 is meaningful. */
  readonly ttsChunkCount?: number | undefined;
  /** Did the newer caller utterance observed at the supersession check take the floor? */
  readonly supersederTakesFloor?: boolean | undefined;
  // TURN-RELEASE TRACE (2026-09-21) — see `TurnLatencyBreakdown` for
  // what each one is and why it exists. Indexed access rather than a
  // re-declared union, matching `endpointMarkerOutcome` and
  // `turnOutcome` above, so the two files cannot drift.
  readonly releaseReason?: TurnLatencyBreakdown["releaseReason"];
  readonly heldTextReadsUnfinished?: boolean | undefined;
  readonly continuationGracesAtRelease?: number | undefined;
  readonly continuationGraceTrace?: TurnLatencyBreakdown["continuationGraceTrace"];
  readonly continuationGraceResets?: TurnLatencyBreakdown["continuationGraceResets"];
  readonly bargeInPhase?: TurnLatencyBreakdown["bargeInPhase"];
  readonly bargeInTrigger?: TurnLatencyBreakdown["bargeInTrigger"];
  readonly cutSentence?: TurnLatencyBreakdown["cutSentence"];
}

/**
 * Cost incurred outside a recorded conversational turn — currently
 * the greeting, which is a startup action rather than a turn and
 * whose synthesis cost was previously discarded.
 */
export interface AuxiliaryCostInput {
  readonly speechToText?: number;
  readonly languageModel?: number;
  readonly textToSpeech?: number;
}

/** Rejects non-finite and negative spans so a clock glitch can't enter the averages. */
function measurementOf(
  milliseconds: number | undefined,
  measuredAt: Date,
): LatencyMeasurementMs | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return undefined;
  }
  return { milliseconds, measuredAt };
}

/** The closed set `endpointMarkerOutcome` may hold — see `TurnLatencyBreakdown`. */
const ENDPOINT_MARKER_OUTCOMES: ReadonlySet<string> = new Set([
  "no_pending_turn",
  "stage_not_silence",
  "chunk_boundary_grace_collapsed",
  "pending_interim",
  "not_releasable_filler",
  "not_releasable_hold_phrase",
  "not_releasable_incomplete",
  "evidenced_confirmation",
]);

/** PHASE A — the closed set `turnOutcome` may hold. See `TurnOutcome`. */
const TURN_OUTCOMES: ReadonlySet<string> = new Set([
  "spoken",
  "superseded_buffered",
  "superseded_pending",
  "contaminated",
  "stream_error",
  "empty_response",
  "aborted",
]);

/** The closed set `releaseReason` may hold. See `TurnReleaseReason`. */
const RELEASE_REASONS: ReadonlySet<string> = new Set([
  "forced",
  "grace_cap_reached",
  "chunk_grace_cap_reached",
  "interim_cap_reached",
  "confirmed",
]);

/** The closed set `bargeInPhase` may hold. See `BargeInPhase`. */
const BARGE_IN_PHASES: ReadonlySet<string> = new Set(["thinking", "speaking", "idle"]);

/** The closed set a `continuationGraceResets` entry's `source` may hold. */
const GRACE_RESET_SOURCES: ReadonlySet<string> = new Set(["chunk_final", "endpointed_final"]);

/** The closed set `bargeInTrigger.source` may hold. See `BargeInTriggerTelemetry`. */
const BARGE_IN_TRIGGER_SOURCES: ReadonlySet<string> = new Set(["transcript", "external", "buffered_turn", "supersession"]);

/**
 * DIAGNOSTIC ONLY — validates a `bargeInTrigger` record field by field.
 * An unknown source drops the record; a non-finite number or a
 * non-boolean drops that field. Nothing here is read by a decision.
 */
function sanitizeBargeInTrigger(
  input: TurnLatencyBreakdown["bargeInTrigger"] | undefined,
): TurnLatencyBreakdown["bargeInTrigger"] | undefined {
  if (input === undefined || !BARGE_IN_TRIGGER_SOURCES.has(input.source as string)) return undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
  const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
  const words = num(input.words);
  const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence) ? input.confidence : undefined;
  const isFinal = bool(input.isFinal);
  const energyAgeMs = num(input.energyAgeMs);
  const beganBeforeReply = bool(input.beganBeforeReply);
  const replyRemainingMs = num(input.replyRemainingMs);
  const replyFullyQueued = bool(input.replyFullyQueued);
  return {
    source: input.source,
    ...(words !== undefined ? { words } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(isFinal !== undefined ? { isFinal } : {}),
    ...(energyAgeMs !== undefined ? { energyAgeMs } : {}),
    ...(beganBeforeReply !== undefined ? { beganBeforeReply } : {}),
    ...(replyRemainingMs !== undefined ? { replyRemainingMs } : {}),
    ...(replyFullyQueued !== undefined ? { replyFullyQueued } : {}),
  };
}

/**
 * DIAGNOSTIC ONLY — validates a `cutSentence` record. Every required
 * field must be a finite number or a boolean, or the record is dropped
 * whole; the two optional numbers are dropped alone. Numbers only and
 * booleans only, so no text can reach the stored record through it.
 * Nothing here is read by a decision.
 */
function sanitizeCutSentence(
  input: TurnLatencyBreakdown["cutSentence"] | undefined,
): TurnLatencyBreakdown["cutSentence"] | undefined {
  if (input === undefined) return undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
  const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
  const sentenceIndex = num(input.sentenceIndex);
  const sentencesHandedOver = num(input.sentencesHandedOver);
  const sentenceChars = num(input.sentenceChars);
  const sentenceWords = num(input.sentenceWords);
  const sentenceComplete = bool(input.sentenceComplete);
  const sentenceStartOffsetMs = num(input.sentenceStartOffsetMs);
  const playheadAtCancelMs = num(input.playheadAtCancelMs);
  const playedMs = num(input.playedMs);
  const endsWithQuestion = bool(input.endsWithQuestion);
  const proposedRuleQualifies = bool(input.proposedRuleQualifies);
  const currentHeardChars = num(input.currentHeardChars);
  const proposedHeardChars = num(input.proposedHeardChars);
  if (
    sentenceIndex === undefined || sentencesHandedOver === undefined || sentenceChars === undefined ||
    sentenceWords === undefined || sentenceComplete === undefined || sentenceStartOffsetMs === undefined ||
    playheadAtCancelMs === undefined || playedMs === undefined || endsWithQuestion === undefined ||
    proposedRuleQualifies === undefined || currentHeardChars === undefined || proposedHeardChars === undefined
  ) {
    return undefined;
  }
  const sentenceDurationMs = num(input.sentenceDurationMs);
  const playedFraction =
    typeof input.playedFraction === "number" && Number.isFinite(input.playedFraction)
      ? Math.round(input.playedFraction * 1000) / 1000
      : undefined;
  return {
    sentenceIndex,
    sentencesHandedOver,
    sentenceChars,
    sentenceWords,
    ...(sentenceDurationMs !== undefined ? { sentenceDurationMs } : {}),
    sentenceComplete,
    sentenceStartOffsetMs,
    playheadAtCancelMs,
    playedMs,
    ...(playedFraction !== undefined ? { playedFraction } : {}),
    endsWithQuestion,
    proposedRuleQualifies,
    currentHeardChars,
    proposedHeardChars,
  };
}

function positiveOrUndefined(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export class SessionMetricsCollector {
  private readonly turnLatencies: TurnLatencyBreakdown[] = [];
  private readonly costTotals = { speechToText: 0, languageModel: 0, textToSpeech: 0 };
  /** Session construction. Diagnostic only — never the call-duration origin. */
  private readonly createdAt = new Date();
  private answeredAt: Date | undefined;
  private endedAt: Date | undefined;
  /** First outbound audio frame of the call, reported by the media bridge. */
  private firstOutboundAudioAt: Date | undefined;
  /** PHASE 3 PHASE 0 — the STT model this call resolved to. */
  private sttModel: string | undefined;
  /** PHASE 3 — the endpointing arm this call was assigned, and the value it actually ran. */
  private sttEndpointing: EndpointingAssignment | undefined;

  constructor(
    private readonly sessionId: SessionId,
    private readonly providerStack: ProviderStackSelection,
  ) {}

  recordTurn(input: TurnLatencyInput): void {
    const measuredAt = new Date();

    const stt = measurementOf(input.sttMs, measuredAt);
    const llm = measurementOf(input.llmMs, measuredAt);
    const tts = measurementOf(input.ttsMs, measuredAt);
    const total = measurementOf(input.totalMs, measuredAt);
    const llmGenerationMs = positiveOrUndefined(input.llmGenerationMs);
    const ttsSynthesisMs = positiveOrUndefined(input.ttsSynthesisMs);
    const userSpeechMs = positiveOrUndefined(input.userSpeechMs);
    // Token counts, not latencies — 0 is meaningful (e.g. a genuine
    // cache miss), so it must survive alongside `undefined` ("not
    // reported"), not collapse into it. `positiveOrUndefined` already
    // preserves 0 and only rejects undefined/NaN/negative.
    const promptTokens = positiveOrUndefined(input.promptTokens);
    const cachedPromptTokens = positiveOrUndefined(input.cachedPromptTokens);
    const reasoningTokens = positiveOrUndefined(input.reasoningTokens);
    // PHASE 3 BATCH 1 — same rule as every span above: a negative or
    // non-finite value means the two clocks disagreed (a stale
    // snapshot, a reordered event), and the honest report for that is
    // "not measured", never a clamped 0 that would be averaged in as a
    // real zero-length wait.
    const endpointToReleaseMs = positiveOrUndefined(input.endpointToReleaseMs);
    const speechEndToReleaseMs = positiveOrUndefined(input.speechEndToReleaseMs);
    const playbackStartupMs = positiveOrUndefined(input.playbackStartupMs);
    // PHASE 3 BATCH 3 — absolute epoch-ms stamps, not spans. The same
    // `positiveOrUndefined` guard applies (it rejects undefined, NaN
    // and negatives), and it cannot collapse a real stamp: `Date.now()`
    // is never 0 or negative, so "absent" stays absent rather than
    // becoming a 1970 timestamp.
    const lastInboundAudioAtMs = positiveOrUndefined(input.lastInboundAudioAtMs);
    const lastInterimTranscriptAtMs = positiveOrUndefined(input.lastInterimTranscriptAtMs);
    const lastFinalTranscriptAtMs = positiveOrUndefined(input.lastFinalTranscriptAtMs);
    const endpointEvidenceAtMs = positiveOrUndefined(input.endpointEvidenceAtMs);
    // A closed string union, so it is validated the same way
    // `llmRetryReasons` is rather than through a numeric guard. An
    // unrecognised value is dropped rather than stored, so the field
    // can only ever hold a claim the pipeline actually made.
    const endpointEvidenceKind =
      input.endpointEvidenceKind === "speech_final" || input.endpointEvidenceKind === "utterance_end"
        ? input.endpointEvidenceKind
        : undefined;
    // PHASE 3 BATCH 4 — same guard, and here `positiveOrUndefined`
    // PRESERVING 0 is the correct semantic rather than an accident:
    // this is a counter, and "no audio ingested yet" is a real reading,
    // unlike the epoch stamps above where 0 would mean 1970.
    const inboundStreamMsAtFinalTranscript = positiveOrUndefined(
      input.inboundStreamMsAtFinalTranscript,
    );
    // PHASE 3 BATCH 6 — same guard, same reasoning as the counter
    // above: both are POSITIONS on the stream clock, so 0 is a real
    // reading ("no word timings in this result" for the word end, "no
    // re-base has happened" for the offset) and must survive. Only
    // undefined/NaN/negative are rejected.
    const lastFinalWordEndStreamMs = positiveOrUndefined(input.lastFinalWordEndStreamMs);
    const sttClockOffsetMs = positiveOrUndefined(input.sttClockOffsetMs);
    // PHASE 3 BATCH 5 — validated against the closed union the same way
    // `endpointEvidenceKind` is, so the field can only ever hold an
    // outcome the detector actually produced.
    const endpointMarkerOutcome = ENDPOINT_MARKER_OUTCOMES.has(
      input.endpointMarkerOutcome as string,
    )
      ? input.endpointMarkerOutcome
      : undefined;
    // Counts, not latencies: 0 retries is a REAL and important
    // observation (it is the answer "retries did not cause this"),
    // so it must survive alongside `undefined` ("not observed").
    // `positiveOrUndefined` already preserves 0.
    const llmAttempts = positiveOrUndefined(input.llmAttempts);
    const llmRetries = positiveOrUndefined(input.llmRetries);
    const llmRetryOverheadMs = positiveOrUndefined(input.llmRetryOverheadMs);
    const llmRetryReasons =
      typeof input.llmRetryReasons === "string" && input.llmRetryReasons.length > 0
        ? input.llmRetryReasons
        : undefined;
    // A count of 0 means the turn released with no non-empty final at
    // all. `positiveOrUndefined` preserves 0, which is correct: that is
    // a real and diagnostic observation, not a missing measurement.
    const finalTranscriptCount = positiveOrUndefined(input.finalTranscriptCount);
    // Each gap is sanitised individually, so one disagreeing pair of
    // stamps cannot poison the rest of the array. An empty result is
    // stored as ABSENT — "one final, therefore no gaps" is already
    // expressed by `finalTranscriptCount`, and an empty array would add
    // a second, weaker way of saying it.
    const gaps = Array.isArray(input.interFinalGapsMs)
      ? input.interFinalGapsMs.filter((g) => Number.isFinite(g) && g >= 0)
      : [];
    const interFinalGapsMs = gaps.length > 0 ? gaps : undefined;
    // PHASE A — validated against the closed union exactly the way
    // `endpointMarkerOutcome` above is, so the field can only ever hold
    // a disposition the pipeline actually claimed.
    const turnOutcome = TURN_OUTCOMES.has(input.turnOutcome as string) ? input.turnOutcome : undefined;
    // Counts, not latencies: 0 is a REAL reading for both (an empty
    // generation, a turn that never reached TTS), and
    // `positiveOrUndefined` preserves it.
    const charsGenerated = positiveOrUndefined(input.charsGenerated);
    const ttsChunkCount = positiveOrUndefined(input.ttsChunkCount);
    // A boolean, so neither guard above applies: stored only when the
    // pipeline actually classified a superseding utterance.
    const supersederTakesFloor =
      typeof input.supersederTakesFloor === "boolean" ? input.supersederTakesFloor : undefined;
    // TURN-RELEASE TRACE — the two closed unions are validated exactly
    // the way `endpointMarkerOutcome` and `turnOutcome` above are, so
    // each field can only ever hold a label the detector or the
    // barge-in controller actually produced.
    const releaseReason = RELEASE_REASONS.has(input.releaseReason as string)
      ? input.releaseReason
      : undefined;
    const bargeInPhase = BARGE_IN_PHASES.has(input.bargeInPhase as string)
      ? input.bargeInPhase
      : undefined;
    // DIAGNOSTIC ONLY — see `BargeInTriggerTelemetry`. Copied field by
    // field with the same validation posture as the enums above: an
    // unknown source drops the whole record, a non-finite number or a
    // non-boolean drops that field.
    const bargeInTrigger = sanitizeBargeInTrigger(input.bargeInTrigger);
    // DIAGNOSTIC ONLY — see `CutSentenceTelemetry`. Same posture.
    const cutSentence = sanitizeCutSentence(input.cutSentence);
    const heldTextReadsUnfinished =
      typeof input.heldTextReadsUnfinished === "boolean"
        ? input.heldTextReadsUnfinished
        : undefined;
    // A count, so `positiveOrUndefined` preserving 0 is correct: "this
    // turn spent no grace" is a real and diagnostic reading.
    const continuationGracesAtRelease = positiveOrUndefined(input.continuationGracesAtRelease);
    // Sanitised per element, like `interFinalGapsMs`, so one bad entry
    // cannot poison the rest. Empty is stored as ABSENT — an ordinary
    // turn holds nothing here, and an empty array would be a second,
    // weaker way of saying the same thing.
    const graceTrace = Array.isArray(input.continuationGraceTrace)
      ? input.continuationGraceTrace.filter((g) => Number.isFinite(g) && g > 0)
      : [];
    const continuationGraceTrace = graceTrace.length > 0 ? graceTrace : undefined;
    const graceResets = Array.isArray(input.continuationGraceResets)
      ? input.continuationGraceResets.filter(
          (r) =>
            Number.isFinite(r?.gracesDiscarded) &&
            r.gracesDiscarded > 0 &&
            GRACE_RESET_SOURCES.has(r?.source as string),
        )
      : [];
    const continuationGraceResets = graceResets.length > 0 ? graceResets : undefined;

    this.turnLatencies.push({
      turnIndex: input.turnIndex,
      ...(stt !== undefined ? { stt } : {}),
      ...(llm !== undefined ? { llm } : {}),
      ...(tts !== undefined ? { tts } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(llmGenerationMs !== undefined ? { llmGenerationMs } : {}),
      ...(ttsSynthesisMs !== undefined ? { ttsSynthesisMs } : {}),
      ...(userSpeechMs !== undefined ? { userSpeechMs } : {}),
      ...(endpointToReleaseMs !== undefined ? { endpointToReleaseMs } : {}),
      ...(speechEndToReleaseMs !== undefined ? { speechEndToReleaseMs } : {}),
      ...(playbackStartupMs !== undefined ? { playbackStartupMs } : {}),
      ...(lastInboundAudioAtMs !== undefined ? { lastInboundAudioAtMs } : {}),
      ...(lastInterimTranscriptAtMs !== undefined ? { lastInterimTranscriptAtMs } : {}),
      ...(lastFinalTranscriptAtMs !== undefined ? { lastFinalTranscriptAtMs } : {}),
      ...(endpointEvidenceAtMs !== undefined ? { endpointEvidenceAtMs } : {}),
      ...(endpointEvidenceKind !== undefined ? { endpointEvidenceKind } : {}),
      ...(inboundStreamMsAtFinalTranscript !== undefined
        ? { inboundStreamMsAtFinalTranscript }
        : {}),
      ...(lastFinalWordEndStreamMs !== undefined ? { lastFinalWordEndStreamMs } : {}),
      ...(sttClockOffsetMs !== undefined ? { sttClockOffsetMs } : {}),
      ...(endpointMarkerOutcome !== undefined ? { endpointMarkerOutcome } : {}),
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      ...(llmAttempts !== undefined ? { llmAttempts } : {}),
      ...(llmRetries !== undefined ? { llmRetries } : {}),
      ...(llmRetryOverheadMs !== undefined ? { llmRetryOverheadMs } : {}),
      ...(llmRetryReasons !== undefined ? { llmRetryReasons } : {}),
      ...(finalTranscriptCount !== undefined ? { finalTranscriptCount } : {}),
      ...(interFinalGapsMs !== undefined ? { interFinalGapsMs } : {}),
      ...(turnOutcome !== undefined ? { turnOutcome } : {}),
      ...(charsGenerated !== undefined ? { charsGenerated } : {}),
      ...(ttsChunkCount !== undefined ? { ttsChunkCount } : {}),
      ...(supersederTakesFloor !== undefined ? { supersederTakesFloor } : {}),
      ...(releaseReason !== undefined ? { releaseReason } : {}),
      ...(heldTextReadsUnfinished !== undefined ? { heldTextReadsUnfinished } : {}),
      ...(continuationGracesAtRelease !== undefined ? { continuationGracesAtRelease } : {}),
      ...(continuationGraceTrace !== undefined ? { continuationGraceTrace } : {}),
      ...(continuationGraceResets !== undefined ? { continuationGraceResets } : {}),
      ...(bargeInPhase !== undefined ? { bargeInPhase } : {}),
      ...(bargeInTrigger !== undefined ? { bargeInTrigger } : {}),
      ...(cutSentence !== undefined ? { cutSentence } : {}),
    });

    this.costTotals.speechToText += input.sttCostUsd;
    this.costTotals.languageModel += input.llmCostUsd;
    this.costTotals.textToSpeech += input.ttsCostUsd;
  }

  recordAuxiliaryCost(input: AuxiliaryCostInput): void {
    this.costTotals.speechToText += input.speechToText ?? 0;
    this.costTotals.languageModel += input.languageModel ?? 0;
    this.costTotals.textToSpeech += input.textToSpeech ?? 0;
  }

  /**
   * The telephony provider has confirmed the callee actually picked
   * up. Idempotent: a duplicate/retried webhook or media-stream
   * `start` must not restart the clock.
   */
  markCallAnswered(): void {
    this.answeredAt ??= new Date();
  }

  /**
   * PHASE 3 PHASE 0. Records the speech-to-text MODEL this call
   * resolved to, reported once by the session manager at the moment it
   * resolves the provider stack.
   *
   * Idempotent for the same reason `markCallAnswered` is: it is called
   * from a path a retried webhook can re-enter, and the first
   * resolution is the one that describes the call. A blank string is
   * ignored rather than stored, so a provider with no version reports
   * absence instead of an empty field.
   */
  noteSttModel(model: string | undefined): void {
    if (this.sttModel !== undefined) return;
    if (typeof model !== "string" || model.trim().length === 0) return;
    this.sttModel = model;
  }

  /**
   * PHASE 3 — CONTROLLED ENDPOINTING A/B. Records which arm this call
   * was assigned and the `endpointing` value its STT socket was
   * actually opened with, reported by the session manager at the
   * moment it assigns, before the socket exists.
   *
   * Idempotent for the same reason `noteSttModel` is, and for one
   * stronger one: two different arms recorded against one call would
   * make that call uninterpretable, which is worse than not having
   * measured it.
   *
   * ONLY AN ASSIGNABLE VALUE IS STORED. An assignment whose
   * `endpointingMs` is outside the closed set is dropped rather than
   * written, because a record is only worth having if the number in it
   * is one the socket could actually have been opened with. Nothing
   * here reads the assignment to make a decision — the value on the
   * wire comes from `resolveEndpointingMs`, not from this collector.
   */
  noteEndpointingAssignment(assignment: EndpointingAssignment | undefined): void {
    if (this.sttEndpointing !== undefined) return;
    if (assignment === undefined) return;
    if (assignment.arm !== "control" && assignment.arm !== "treatment") return;
    if (!ALLOWED_ENDPOINTING_MS.includes(assignment.endpointingMs)) return;
    this.sttEndpointing = assignment;
  }

  /**
   * PHASE 3 BATCH 1. The media bridge has handed the FIRST outbound
   * audio frame of this call to the transport.
   *
   * Idempotent for exactly the reason `markCallAnswered` is: the pump
   * calls this on every frame it sends (~50/s), and only the first one
   * is the answer to "when did the caller start hearing us". `??=`
   * makes every later call a single no-op comparison rather than
   * requiring the bridge to carry a flag of its own — which would
   * put the definition of "first" in two places.
   */
  markFirstOutboundAudio(): void {
    this.firstOutboundAudioAt ??= new Date();
  }

  markCallEnded(): void {
    this.endedAt ??= new Date();
  }

  build(): BenchmarkMetrics {
    // While the call is live there is no `endedAt` yet, so duration
    // is measured against now — the same live-ticking behaviour the
    // dashboard already relied on, just anchored correctly.
    const endReference = this.endedAt ?? new Date();
    const connectedSeconds =
      this.answeredAt !== undefined
        ? Math.max(0, (endReference.getTime() - this.answeredAt.getTime()) / 1000)
        : undefined;

    const callDuration: CallDurationMetric = {
      ...(connectedSeconds !== undefined ? { seconds: connectedSeconds } : {}),
      createdAt: this.createdAt,
      ...(this.answeredAt !== undefined ? { answeredAt: this.answeredAt } : {}),
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      ...(this.firstOutboundAudioAt !== undefined
        ? { firstOutboundAudioAt: this.firstOutboundAudioAt }
        : {}),
    };

    // Telephony bills the connected span, so it is derived here
    // rather than accumulated per turn. An unanswered call is billed
    // nothing, which is exactly what `connectedSeconds === undefined`
    // should produce.
    const telephony =
      connectedSeconds !== undefined
        ? estimateTelephonyCost(this.providerStack.telephony.id, connectedSeconds)
        : 0;

    const breakdown = { telephony, ...this.costTotals };
    const estimatedCost: EstimatedCostMetric = {
      amount:
        breakdown.telephony +
        breakdown.speechToText +
        breakdown.languageModel +
        breakdown.textToSpeech,
      currency: "USD",
      isEstimate: true,
      breakdown,
    };

    return {
      sessionId: this.sessionId,
      providerStack: this.providerStack,
      timestamp: new Date(),
      callDuration,
      ...(this.sttModel !== undefined ? { sttModel: this.sttModel } : {}),
      ...(this.sttEndpointing !== undefined ? { sttEndpointing: this.sttEndpointing } : {}),
      estimatedCost,
      turnLatencies: [...this.turnLatencies],
    };
  }
}
