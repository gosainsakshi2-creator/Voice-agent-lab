/**
 * benchmark.types.ts
 *
 * Shared, provider-agnostic types describing the metrics captured
 * for a single benchmark session. These are DATA shapes only — how
 * they are measured, aggregated, or persisted is an implementation
 * concern out of scope for this architecture pass.
 */

import type { ProviderStackSelection, SessionId } from "./session.types";

/**
 * A generic millisecond latency measurement, reused across every
 * per-stage latency type below so they share a single shape.
 */
export interface LatencyMeasurementMs {
  readonly milliseconds: number;
  /** When this measurement was recorded. */
  readonly measuredAt: Date;
}

/**
 * STT RECOGNITION latency for a single turn: how long after the
 * caller's audio ended the corresponding final transcript actually
 * arrived. Measured as `inboundStreamMs - segment.endedAtMs` — both
 * are positions on the SAME audio stream clock, so the difference is
 * the provider's recognition lag.
 *
 * NOT the duration the caller spoke (see
 * `TurnLatencyBreakdown.userSpeechMs` for that).
 */
export interface SttLatencyMetric extends LatencyMeasurementMs {}

/**
 * LLM latency for a single turn: request sent -> FIRST token
 * received (time-to-first-token).
 *
 * TTFT is deliberately the headline number rather than
 * time-to-last-token: the pipeline starts synthesizing on the first
 * complete sentence, so TTFT is what actually sits on the critical
 * path. It is also the only LLM figure that cannot be contaminated
 * by TTS — see `TurnLatencyBreakdown.llmGenerationMs`.
 */
export interface LlmLatencyMetric extends LatencyMeasurementMs {}

/**
 * TTS latency for a single turn: synthesis request sent -> FIRST
 * audio chunk received. Excludes playback entirely.
 */
export interface TtsLatencyMetric extends LatencyMeasurementMs {}

/**
 * TRUE end-to-end conversational response latency for a single turn:
 *
 *     caller stopped speaking  ->  first AI audio frame handed to
 *                                  the telephony transport
 *
 * This is a single measured wall-clock span, NOT a sum of the
 * component metrics above. It therefore includes everything the
 * caller actually experiences as dead air — recognition lag,
 * endpointing wait, LLM time-to-first-token, TTS time-to-first-chunk
 * and all pipeline overhead in between — and excludes the duration
 * of the reply itself (synthesis of later sentences, queue drain,
 * playback), none of which the caller waits on.
 */
export interface TotalLatencyMetric extends LatencyMeasurementMs {}

/**
 * Wall-clock duration of the CONNECTED call: from the moment the
 * telephony provider confirmed the callee answered to the moment the
 * call ended. Session creation, provider warm-up, dialling and
 * ringing are all excluded by construction.
 */
export interface CallDurationMetric {
  /**
   * Measured connected seconds. `undefined` until the call is
   * answered — an unanswered call has no duration to report, and
   * must render as N/A rather than as 0 or as time-since-dial.
   */
  readonly seconds?: number;
  /** Session object creation. Diagnostic only — never the timer origin. */
  readonly createdAt: Date;
  /** Telephony-confirmed answer. This is the timer origin. */
  readonly answeredAt?: Date;
  readonly endedAt?: Date;
  /**
   * The instant the FIRST outbound audio frame of the whole call was
   * handed to the telephony transport — i.e. the moment the caller
   * begins to hear the agent's opening line.
   *
   * Reported by the media bridge's own outbound pump, not by the
   * pipeline: the pipeline only knows when audio was QUEUED, and the
   * bridge's pre-roll and frame pacing sit between the two. Absent on
   * a call that never produced audio (unanswered, voicemail,
   * immediately abandoned), which must render as N/A rather than 0.
   */
  readonly firstOutboundAudioAt?: Date;
}

/**
 * ESTIMATED monetary cost of a session, broken down by the provider
 * category that incurred it. `currency` follows ISO 4217 (e.g. "USD").
 *
 * These are heuristics derived from published list prices and
 * approximate token/character/second counts — never actual provider
 * billing. `isEstimate` is a literal `true` so no consumer can
 * accidentally present this as invoiced spend.
 */
export interface EstimatedCostMetric {
  readonly amount: number;
  readonly currency: string;
  readonly isEstimate: true;
  readonly breakdown?: Readonly<{
    readonly telephony?: number;
    readonly speechToText?: number;
    readonly languageModel?: number;
    readonly textToSpeech?: number;
  }>;
}

/**
 * A single latency sample tied to the turn it was measured in,
 * allowing per-turn benchmarking rather than only session-level
 * averages.
 *
 * Every latency field is OPTIONAL: a turn that was barged into
 * before any audio was produced, or served by a provider that does
 * not expose the necessary timestamps, genuinely has no measurement
 * to report. Consumers must render those as N/A — never substitute a
 * zero or a derived value.
 */
export interface TurnLatencyBreakdown {
  readonly turnIndex: number;
  readonly stt?: SttLatencyMetric;
  readonly llm?: LlmLatencyMetric;
  readonly tts?: TtsLatencyMetric;
  readonly total?: TotalLatencyMetric;

  // --- Secondary throughput figures. NOT latency; never summed into
  // `total`, and not shown as headline numbers. ---

  /**
   * Full LLM generation span (request -> last token) with the
   * wall-clock the pipeline spent inside TTS subtracted back out.
   *
   * The subtraction is required for correctness, not polish: the
   * provider's async generator is suspended at its `yield` while the
   * pipeline synthesizes each sentence, so its own `latencyMs`
   * silently absorbs that TTS time.
   */
  readonly llmGenerationMs?: number;
  /** Total TTS synthesis wall-clock for the turn, summed across sentence chunks. */
  readonly ttsSynthesisMs?: number;
  /** How long the caller spoke. Useful context; explicitly not a latency. */
  readonly userSpeechMs?: number;

  // --- PHASE 3 BATCH 1: boundaries that were already computed for the
  // per-turn console trace and then discarded. They are SUB-SPANS of
  // `total`, never additions to it: summing them with stt/llm/tts
  // would double-count. Telemetry only — nothing reads them to make a
  // decision. ---

  /**
   * The detector's own hold: the provider's explicit end-of-speech
   * claim arriving -> the turn being released to the pipeline.
   *
   * `endpointEvidenceAtMs` is stamped only when Deepgram made that
   * claim DIRECTLY — `speech_final: true` on the words, or a
   * standalone `UtteranceEnd` marker. A turn released by inference
   * (the adaptive silence window simply expiring) has no such claim
   * and reports `undefined`, never a substituted value. So this is
   * NOT "how long endpointing took" on every turn; it is that span on
   * the turns where the boundary was actually observed.
   */
  readonly endpointToReleaseMs?: number;
  /**
   * Caller's audio actually ending -> turn released. Covers the whole
   * pre-LLM wait: the provider's recognition lag PLUS the detector's
   * silence and confirmation windows.
   *
   * Its origin, `userSpeechEndedAtMs`, is RECONSTRUCTED as
   * `lastFinalSegmentAtMs - sttLagMs` rather than directly observed
   * (the caller's microphone is not ours to timestamp), so its
   * accuracy is bounded by the accuracy of `sttLagMs`. It is the same
   * origin `total` is measured from, so the two are consistent by
   * construction.
   */
  readonly speechEndToReleaseMs?: number;
  /**
   * Playback startup: first audio frame QUEUED on the transport ->
   * first frame the bridge's pump actually SENT toward the caller.
   *
   * This is the span `total` deliberately stops short of. `total`
   * ends at `audio-queued`; the caller hears nothing until the
   * bridge has accumulated its pre-roll (5 frames / 100ms, or the
   * 120ms cap) and its 20ms-paced pump has emitted the first one.
   * Absent when the turn produced no audio, or when no bridge is
   * attached (dashboard/mock sessions).
   */
  readonly playbackStartupMs?: number;

  // --- PHASE 3 BATCH 3: ABSOLUTE WALL-CLOCK OBSERVATIONS. ------------
  //
  // Every field above is a DURATION. These five are not: they are raw
  // `Date.now()` epoch-millisecond stamps of events that were directly
  // OBSERVED, recorded so the STT boundary can later be decomposed.
  //
  // They exist because `stt` (recognition lag) is computed on the
  // AUDIO-STREAM clock — `inboundStreamMs - segment.endedAtMs` — which
  // conflates Deepgram's processing, transport delay, the configured
  // `endpointing` hold, and any divergence between the audio clock and
  // real time. Production measured that boundary at p50 1040ms / p90
  // 2350ms / max 3300ms without being able to say which of those it
  // was. Wall-clock stamps of the surrounding events are the smallest
  // thing that separates them.
  //
  // NOTHING HERE IS A LATENCY, and nothing derives one yet: this batch
  // captures raw observations only. They are never summed into `total`
  // and nothing reads them to make a decision.
  //
  // Absent means NOT OBSERVED, never zero — an epoch stamp of 0 would
  // be a 1970 timestamp, so a missing value stays `undefined`.

  /**
   * Wall clock of the most recent caller audio chunk the application
   * received, as of this turn's release.
   *
   * Rolling, not per-turn: inbound audio is continuous, so at release
   * this is simply the freshest frame. Compare against
   * `lastFinalTranscriptAtMs` to see how far behind the live audio edge the
   * transcript landed IN REAL TIME — the wall-clock counterpart of the
   * stream-clock `stt`, and the pair that reveals audio-clock drift.
   */
  readonly lastInboundAudioAtMs?: number;
  /**
   * Wall clock of the latest non-empty INTERIM transcript for this
   * turn. Cleared at each release, so it is never inherited from a
   * previous turn; absent when the turn produced no interim at all.
   */
  readonly lastInterimTranscriptAtMs?: number;
  /**
   * Wall clock at which the latest non-empty FINAL transcript arrived —
   * the same observation `stt`'s lag is measured at, kept here in
   * absolute form. This is OBSERVED. It is NOT the caller's speech end,
   * which is reconstructed (`lastFinalSegmentAtMs - sttLagMs`) and is
   * deliberately not stamped here as though it had been seen.
   */
  readonly lastFinalTranscriptAtMs?: number;
  /**
   * Wall clock at which the endpoint evidence that ended this turn
   * arrived. Absent on a turn released by INFERENCE — the adaptive
   * silence window expiring with no explicit provider claim — which is
   * a real distinction and not a gap.
   */
  readonly endpointEvidenceAtMs?: number;
  /**
   * WHICH claim it was, preserved verbatim from the pipeline rather
   * than re-derived later:
   *   `speech_final`  — Deepgram's VAD endpointer fired ON the words.
   *   `utterance_end` — the word-timing `UtteranceEnd` marker, or a
   *                     `speech_final` that arrived alone in its own
   *                     empty message, both of which reach the pipeline
   *                     as an end-of-speech marker.
   * The two have very different delivery characteristics on a noisy
   * line, and without this field a stored turn cannot say which it got.
   */
  readonly endpointEvidenceKind?: "speech_final" | "utterance_end";

  // --- OpenAI usage telemetry. TELEMETRY ONLY: informs investigation
  // of `llm` (TTFT), never itself a latency and never summed into
  // `total`. Absent whenever the provider doesn't report usage, or a
  // stream was aborted before its usage chunk arrived. ---

  /** OpenAI-reported prompt tokens for this turn's LLM request. */
  readonly promptTokens?: number;
  /** Of `promptTokens`, how many were served from the prompt-prefix cache. */
  readonly cachedPromptTokens?: number;
  /** Reasoning tokens generated before the first visible content token. */
  readonly reasoningTokens?: number;

  // --- PHASE 3 BATCH 2A: vendor RETRY ATTRIBUTION. Observed from the
  // SDK's own logging, never configured by us, and read by nothing
  // that makes a decision. Exists to answer one question with
  // evidence: how much of this turn's `llm` (TTFT) was spent on
  // failed attempts and backoff rather than on the model. ---

  /** HTTP attempts the SDK made for this turn's request. 1 means no retry occurred. */
  readonly llmAttempts?: number;
  /** Attempts beyond the first. 0 on the overwhelming majority of turns. */
  readonly llmRetries?: number;
  /** MEASURED wall clock spent on failed attempts plus the SDK's backoff sleeps. */
  readonly llmRetryOverheadMs?: number;
  /** Compact, non-sensitive reasons, e.g. `"500,500"`. Absent when no retry occurred. */
  readonly llmRetryReasons?: string;
}

/**
 * The complete set of benchmark metrics collected for one session,
 * tying every measurement back to the exact provider stack under
 * test. This is the primary artifact the platform exists to
 * produce: a like-for-like comparison across provider stacks.
 */
export interface BenchmarkMetrics {
  readonly sessionId: SessionId;
  readonly providerStack: ProviderStackSelection;
  readonly timestamp: Date;
  readonly callDuration: CallDurationMetric;
  readonly estimatedCost: EstimatedCostMetric;
  readonly turnLatencies: readonly TurnLatencyBreakdown[];
}
