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
 * What actually became of one turn's generated reply.
 *
 * PHASE A — TELEMETRY ONLY. Nothing reads this to make a decision; it
 * exists because the 2026-09-17 Gemma audit could only establish WHERE
 * a reply was lost by elimination and by correlating stored transcripts
 * against `tts`/`ttsSynthesisMs`. The outcome is now stated by the code
 * that took the branch, so the same question is a query.
 *
 *   `spoken`              — at least one real audio chunk was produced
 *                           for this turn. The caller heard a reply.
 *   `superseded_buffered` — discarded before any audio because the turn
 *                           detector was already HOLDING a completed
 *                           newer caller turn.
 *   `superseded_pending`  — discarded before any audio because the
 *                           caller had RESUMED speaking (finals held,
 *                           not yet endpointed).
 *   `contaminated`        — the model echoed its own instructions; the
 *                           remainder was suppressed and the fixed
 *                           fallback spoken instead.
 *   `stream_error`        — the provider stream failed and nothing was
 *                           spoken.
 *   `empty_response`      — the stream ended normally with no content
 *                           and nothing was spoken.
 *   `aborted`             — the turn ended with nothing spoken for any
 *                           other reason (session ending, a signal
 *                           already aborted on entry).
 *
 * Exactly one value per recorded turn. `spoken` outranks
 * `stream_error`/`empty_response`: a mid-stream failure whose partial
 * text still reached the caller is not a silent turn, and
 * `charsGenerated` plus the provider's own error log still describe it.
 */
export type TurnOutcome =
  | "spoken"
  | "superseded_buffered"
  | "superseded_pending"
  | "contaminated"
  | "stream_error"
  | "empty_response"
  | "aborted";

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
  /**
   * PHASE 3 BATCH 4 — MEASUREMENT VALIDATION, not a latency.
   *
   * The value of the pipeline's `inboundStreamMs` counter at the exact
   * instant the final transcript arrived — the SAME event, in the same
   * handler pass, that `lastFinalTranscriptAtMs` stamps on the wall
   * clock. The pair is the whole point: one reading of the AUDIO-BYTES
   * clock and one of the WALL clock, taken together.
   *
   * WHY. `stt` is computed as `inboundStreamMs - segment.endedAtMs`,
   * entirely on the audio-bytes clock, and is then subtracted from a
   * wall-clock stamp to reconstruct speech end. That is only valid
   * while the audio clock advances 1:1 with real time. Production
   * showed the last INTERIM transcript arriving up to 1468ms AFTER the
   * reconstructed speech end on 10 of 12 turns, with the offset
   * tracking `stt` almost monotonically — an inconsistency that this
   * field is the minimum needed to resolve. Two turns of the same call
   * give an audio-clock elapsed and a wall-clock elapsed that can be
   * compared directly.
   *
   * DELIBERATELY UNFILTERED. `stt` is discarded when it fails its
   * plausibility bound; this counter is recorded regardless, because a
   * turn whose lag was rejected is exactly the turn worth inspecting.
   *
   * `0` is a legitimate value (a counter, not an epoch stamp): it means
   * no audio had been ingested yet, which is a real observation.
   *
   * Nothing derives a latency from this, nothing reads it to make a
   * decision, and it does not reinterpret or replace `stt`.
   */
  readonly inboundStreamMsAtFinalTranscript?: number;

  // --- PHASE 3 BATCH 6: the rest of the STT-lag subtraction.
  // Telemetry only, read by nothing that makes a decision, and neither
  // field reinterprets or replaces `stt`. ---

  /**
   * The RE-BASED end of the last recognised word of this turn's final,
   * in stream ms — i.e. `sttStreamMsOf(segment)`, the exact value the
   * pipeline subtracted to compute `stt`.
   *
   * WHY IT EXISTS. Batch 4 persisted the minuend
   * (`inboundStreamMsAtFinalTranscript`) but not the subtrahend, so a
   * turn whose `stt` was rejected left no way to see which of the three
   * rejection causes applied. With both,
   *
   *     inboundStreamMsAtFinalTranscript - lastFinalWordEndStreamMs
   *
   * reproduces exactly the lag the plausibility guard evaluated, at
   * analysis time, with no filter discarding it.
   *
   * DELIBERATELY UNFILTERED, for the same reason its Batch 4 twin is:
   * the turns worth inspecting are precisely the ones the guard threw
   * away.
   *
   * `0` is a legitimate value and is itself diagnostic — it is what
   * `sttStreamMsOf` returns for "this result carried no word timings",
   * which is one of the rejection causes.
   */
  readonly lastFinalWordEndStreamMs?: number;
  /**
   * The STT stream-clock offset in force when the reading above was
   * taken, i.e. how far a reconnect had shifted the word-end position
   * onto the call timeline.
   *
   * `0` means no re-base had occurred on this call yet, so the word-end
   * position is Deepgram's own raw reported time. A NON-ZERO value
   * means it has been shifted, and the shift is known to land a
   * recognition-lag too far forward — which is what makes a subsequent
   * lag negative and therefore discarded. Recorded so such a turn can
   * be identified and excluded rather than silently distorting a
   * measurement.
   */
  readonly sttClockOffsetMs?: number;
  /**
   * PHASE 3 BATCH 5 — WHICH GUARD the endpoint marker met inside
   * `AdaptiveTurnDetector.noteEndOfSpeech`. Diagnostic only.
   *
   * Production showed two `utterance_end` turns spending ~1817ms and
   * ~1940ms between the evidence arriving and the turn releasing, while
   * every other turn spent 150-301ms. `endpointToReleaseMs` records
   * THAT the wait happened; this records WHY. Absent on a turn that
   * received no marker at all, which is most of them — a `speech_final`
   * riding on the words never reaches `noteEndOfSpeech`.
   *
   * Only `chunk_boundary_grace_collapsed` and `evidenced_confirmation`
   * are short paths. The other six mean the marker was received and the
   * turn kept waiting.
   *
   * Declared as a literal union here rather than imported from
   * `turn-detection.ts`, matching how `endpointEvidenceKind` is
   * declared, so this types file keeps importing nothing from `core`.
   */
  readonly endpointMarkerOutcome?:
    | "no_pending_turn"
    | "stage_not_silence"
    | "chunk_boundary_grace_collapsed"
    | "pending_interim"
    | "not_releasable_filler"
    | "not_releasable_hold_phrase"
    | "not_releasable_incomplete"
    | "evidenced_confirmation";

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

  // --- PHASE 3 PHASE 0: SPEECH FRAGMENTATION. Telemetry only; read by
  // nothing that makes a decision. Exists to measure the failure mode
  // `endpointing: 300` was rejected for on 2026-08-09 — one natural
  // utterance arriving as several finals — which at the time could
  // only be observed by eye. ---

  /**
   * Non-empty FINAL transcripts the STT provider delivered for this
   * caller turn. `1` is unfragmented; `> 1` means the utterance
   * arrived in pieces.
   *
   * Counted at the same event `stt` is measured from, over the same
   * turn window — the existing authoritative boundary, not a new one.
   */
  readonly finalTranscriptCount?: number;
  /**
   * Wall-clock gaps between consecutive finals within this turn, in
   * arrival order. Length is always `finalTranscriptCount - 1`, so a
   * single final yields no array at all rather than a misleading `[0]`.
   */
  readonly interFinalGapsMs?: readonly number[];

  // --- PHASE A: TURN DISPOSITION. Telemetry only; read by nothing that
  // makes a decision, and derived entirely from branches the pipeline
  // had already taken. Optional for the same backward-compatibility
  // reason every batch above is: records written before this field
  // existed simply omit it. ---

  /** What became of this turn's reply. See `TurnOutcome`. */
  readonly turnOutcome?: TurnOutcome;
  /**
   * Characters of RAW model output this turn produced, before
   * `toSpokenText` and before any sentence was selected for synthesis.
   * `0` is meaningful — it is what an `empty_response` looks like — so
   * it is stored rather than collapsed into absence.
   *
   * A COUNT, never the text. No transcript, no reply content and no
   * prompt ever reaches this record.
   */
  readonly charsGenerated?: number;
  /** Sentence-level TTS invocations this turn made. `0` means TTS was never reached. */
  readonly ttsChunkCount?: number;
  /**
   * Whether the newer caller utterance observed at the THINKING-side
   * supersession check would be judged to TAKE THE FLOOR by
   * `bufferedTurnTakesTheFloor` — the same classification the playback
   * drain applies to a turn waiting behind a reply that is playing.
   *
   * A BOOLEAN, never the utterance. Absent when nothing newer was
   * waiting when the reply was ready.
   *
   * ── THE CONTRACT, AND HOW TO READ THE TWO FIELDS TOGETHER ─────────
   *
   * `turnOutcome` identifies WHAT ACTUALLY HAPPENED to the reply. This
   * field only describes whether the newer utterance TOOK THE FLOOR.
   * They answer different questions and must be read as a pair.
   *
   * NEVER INFER SUPERSESSION FROM THIS FIELD — neither from its
   * presence nor from its value. It is recorded on superseded turns AND
   * on turns that were kept, and `false` appears under both. The only
   * discriminator is `turnOutcome`.
   *
   * The four combinations that occur:
   *
   *   `spoken` + absent
   *     Nothing newer was waiting when the reply was ready. The
   *     ordinary case.
   *
   *   `spoken` + `false`
   *     Something WAS waiting, it did not take the floor, and the reply
   *     was therefore kept and spoken. THIS PAIR IS THE PRODUCTION
   *     SIGNATURE OF THE PHASE B FIX FIRING — before Phase B that reply
   *     was discarded and the caller heard silence. Counting it is what
   *     separates a fix that rarely needs to fire from one that has
   *     silently stopped working.
   *
   *   `superseded_buffered` / `superseded_pending` + `true`
   *     The newer utterance took the floor and won. Unchanged by
   *     Phase B, and the intended behaviour.
   *
   *   `superseded_pending` + `false`
   *     LEGITIMATE, AND NOT THE DEFECT PHASE B CLOSED. The pending
   *     branch of `newerUserTurnWaiting` has its own, older policy: it
   *     excludes a bare greeting and a bare acknowledgement, and it
   *     deliberately does NOT exclude an attention check. So a caller
   *     who resumes mid-utterance with "are you there" or "can you hear
   *     me" supersedes through that branch while
   *     `bufferedTurnTakesTheFloor` — which treats an attention check as
   *     taking no floor — reports `false`. Phase B changed only the
   *     BUFFERED branch; this pending case is untouched and is working
   *     as designed. Do not read it as a reply wrongly discarded.
   *
   * (`superseded_*` + absent, and `spoken` + `true`, are unreachable.)
   */
  readonly supersederTakesFloor?: boolean;
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
  /**
   * PHASE 3 PHASE 0 — the speech-to-text MODEL this call actually ran,
   * e.g. `"nova-3"`.
   *
   * `providerStack.speechToText` carries only the vendor id
   * (`"deepgram"`), so until now a model change between two groups of
   * calls was invisible and would silently confound any comparison
   * that grouped by provider. Sourced from the resolved provider's
   * own descriptor at the moment the conversation begins, so it
   * reports what the socket will actually be opened with.
   *
   * Optional: absent on every record written before this field
   * existed, and absent for any provider whose descriptor reports no
   * model. Never a credential — the descriptor carries the model name
   * and nothing else.
   */
  readonly sttModel?: string;
  /**
   * PHASE 3 — CONTROLLED ENDPOINTING A/B. Which arm this call was
   * assigned, and the `endpointing` value its STT socket was ACTUALLY
   * opened with.
   *
   * Both are stored because only one of them can be wrong: an analysis
   * that re-derives the parameter from the arm label cannot notice a
   * call labelled `treatment` that nevertheless ran at 400, which is
   * exactly the failure that would quietly invalidate the experiment.
   *
   * `sessionId` above and the `call_attempt_id` this record is written
   * under together give every experimental call an unambiguous
   * identity, so no additional id is carried here.
   *
   * Optional: absent on every record written before this field
   * existed, and absent for any session that was never assigned — for
   * which the production default of 400 applied, unchanged.
   */
  readonly sttEndpointing?: EndpointingAssignmentRecord;
  readonly estimatedCost: EstimatedCostMetric;
  readonly turnLatencies: readonly TurnLatencyBreakdown[];
}

/**
 * The persisted form of one call's endpointing assignment. Structural
 * rather than an import of the runtime type, so this types module
 * keeps depending on nothing.
 */
export interface EndpointingAssignmentRecord {
  /** `"control"` (400) or `"treatment"` (300). */
  readonly arm: "control" | "treatment";
  /** The value the Deepgram socket was opened with. */
  readonly endpointingMs: number;
  /** Whether this attempt was actually in the experiment. */
  readonly experimentEnabled: boolean;
  /**
   * The exact hashed key — `stt-endpointing:<call_attempts.id>` — so
   * the arm can be re-derived and checked from the record alone.
   * Absent when the attempt was not assigned by hash, which is the
   * only case in which there is no key to report.
   */
  readonly assignmentKey?: string;
  /** The treatment share in force. Absent when this attempt was not in the experiment. */
  readonly treatmentPercent?: number;
  /**
   * Why this attempt was NOT in the experiment. Present exactly when
   * `experimentEnabled` is false. Recorded rather than inferred so an
   * analysis knows which calls were excluded and on what grounds:
   * `"experiment-disabled"` is every call today, `"no-attempt-id"` is
   * a non-campaign session, and `"key-not-uuid"` would mean something
   * handed the assignment a key it refused to hash.
   */
  readonly ineligibleReason?: "experiment-disabled" | "no-attempt-id" | "key-not-uuid";
}
