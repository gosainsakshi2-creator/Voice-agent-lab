/**
 * results-types.ts
 *
 * The shape of a campaign's results.
 *
 * Three conventions run through every type here, and they are the
 * reason the report can be trusted:
 *
 *   1. A figure with no data is `null`, never 0 and never omitted.
 *      "No call has completed yet" and "every call cost nothing" must
 *      not render as the same number.
 *
 *   2. Every derived figure carries the count it was derived from.
 *      A 100% success rate over two calls and one over four hundred
 *      are different claims, and a table that shows only the
 *      percentage lets the first be read as the second.
 *
 *   3. VOICE measurements and ORCHESTRATION measurements are separate
 *      structures, sourced from separate tables by separate queries.
 *      A database write or a claim delay must never be able to appear
 *      inside a provider's TTS latency — that comparison is the whole
 *      reason this campaign exists.
 */

/** A percentile pair plus the number of calls behind it. */
export interface Percentiles {
  readonly p50: number | null;
  readonly p90: number | null;
  /** Calls that contributed a value. Zero means both percentiles are null. */
  readonly samples: number;
}

/** A rate that is honest about having no denominator. */
export interface Rate {
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
}

export interface ProviderAttemptRow {
  readonly provider: string;
  readonly attempts: number;
  /** Attempts cancelled before dialling — rehearsals with the kill switch off. */
  readonly rehearsedNotDialled: number;
  readonly dialled: number;
  readonly connected: number;
  readonly completed: number;
  readonly noAnswer: number;
  readonly busy: number;
  readonly failed: number;
  readonly connectRate: Rate;
  /** Median connected seconds. Unanswered calls contribute nothing, not zero. */
  readonly connectedSeconds: Percentiles;
  /**
   * Terminal statuses this system DEDUCED rather than observed. Until
   * a carrier status callback exists, every NO_ANSWER is one of these,
   * and presenting them as carrier-reported would be a lie.
   */
  readonly inferredTerminal: number;
}

export interface ProviderOutcomeRow {
  readonly provider: string;
  readonly classified: number;
  readonly successes: number;
  readonly failures: number;
  /** Classified, but the classifier refused to call it either way. */
  readonly undetermined: number;
  /** Successes over CONNECTED calls — the only denominator that means anything. */
  readonly successRateOfConnected: Rate;
  readonly byOutcomeType: Readonly<Record<string, number>>;
}

/** VOICE CONVERSATION measurements. Sourced only from `call_metrics`. */
export interface ProviderVoiceRow {
  readonly provider: string;
  readonly calls: number;
  /**
   * Each sample is ONE CALL'S median for that stage, so these are
   * medians of medians — the right shape for "which provider is
   * typically faster", and the wrong one for "the slowest turn we saw".
   */
  readonly sttMs: Percentiles;
  readonly llmMs: Percentiles;
  readonly ttsMs: Percentiles;
  readonly totalMs: Percentiles;
  /** The first turn, which is the one the caller judges the agent on. */
  readonly firstTurnTotalMs: Percentiles;
  readonly turnsPerCall: Percentiles;
  readonly conversationSeconds: Percentiles;
  readonly costUsd: {
    readonly total: number | null;
    readonly perCall: number | null;
    readonly telephony: number | null;
    readonly stt: number | null;
    readonly llm: number | null;
    readonly tts: number | null;
  };
}

/** CAMPAIGN ORCHESTRATION measurements. Sourced only from `dispatch_metrics`. */
export interface ProviderDispatchRow {
  readonly provider: string;
  readonly calls: number;
  readonly queueWaitMs: Percentiles;
  readonly claimToDialMs: Percentiles;
  readonly dialRequestMs: Percentiles;
  readonly ringToAnswerMs: Percentiles;
  readonly persistMs: Percentiles;
  readonly classifyMs: Percentiles;
}

// ── CONTACT-level outcomes ────────────────────────────────────────
// Everything above counts attempts. Everything here counts people, and
// the two are kept as separate structures so no template can put an
// attempt count and a contact count in the same row and derive a rate
// across them.

/** Contacts per disposition. `UNCLASSIFIED` is a real state, not a zero. */
export interface ContactDispositionCounts {
  readonly FINAL_YES: number;
  readonly FINAL_NO: number;
  readonly RETRYABLE: number;
  readonly UNRESOLVED: number;
  readonly TECHNICAL_FAILURE: number;
  /** No business outcome recorded yet: never called, or never classified. */
  readonly UNCLASSIFIED: number;
}

/** One provider's lane, counted in PEOPLE rather than calls. */
export interface ProviderContactRow {
  readonly provider: string;
  readonly contacts: number;
  readonly byDisposition: ContactDispositionCounts;
  readonly stillOpen: number;
  /** FINAL_YES over this lane's contacts. Comparable across lanes; attempts are not. */
  readonly conversionRate: Rate;
}

export interface ContactOutcomes {
  /** Unique people, which is the denominator of every rate in this block. */
  readonly total: number;
  readonly byDisposition: ContactDispositionCounts;
  /** Contacts whose most recent call ended in a callback request. */
  readonly callbackRequested: number;
  /** Contacts the dispatcher can still claim — the claim query's own predicate. */
  readonly stillEligible: number;
  /** Contacts that will never be called again. */
  readonly permanentlyClosed: number;
  readonly neverAttempted: number;
  /** attempt count -> how many contacts have had exactly that many. */
  readonly attemptsPerContact: Readonly<Record<string, number>>;
  /** Sum of every contact's attempts. Equals the attempt-level total. */
  readonly totalAttempts: number;
  /**
   * THE conversion figure: FINAL_YES over unique contacts. Never over
   * attempts — one person called three times is one chance to convert,
   * not three.
   */
  readonly conversionRate: Rate;
  readonly finalYesRate: Rate;
  readonly finalNoRate: Rate;
  readonly perProvider: readonly ProviderContactRow[];
  readonly note: string;
}

/**
 * WHAT HAPPENED IN THE CONVERSATIONS, counted in attempts.
 *
 * Separate from `outcomes` and from `contactOutcomes` for the same
 * reason those two are separate from each other: these are not verdicts
 * and must never be read as any. A customer question, an objection and
 * an interrupted call are conversational events — they say how the
 * script is landing, and a campaign that cannot see them can only tell
 * that a call did not convert, never why.
 *
 * `registrationNote` is part of the structure rather than the prose
 * around it, because the one mistake this block invites is exactly the
 * one it exists to prevent: adding "interested-sounding" attempts to a
 * conversion figure.
 */
export interface ConversationAnalytics {
  /** Attempts whose stored outcome carries conversational detail. */
  readonly attemptsRead: number;
  readonly attemptsWithQuestions: number;
  readonly customerQuestions: number;
  readonly attemptsWithObjections: number;
  readonly objections: number;
  /** Attempts that ended while the person was still asking something. */
  readonly interruptedOnQuestion: number;
  /** Attempts whose outcome was a callback request. */
  readonly callbackRequests: number;
  /** SCRIPT ADHERENCE, from the same stored detail. */
  readonly adherence: {
    readonly attemptsChecked: number;
    /** Calls where the agent went back to the top of the script. */
    readonly scriptRestarts: number;
    /** Calls where the agent asked something the script does not ask. */
    readonly offScriptQuestionAttempts: number;
    /** Calls where the agent stated a figure the script never supplied. */
    readonly unsupportedFigureAttempts: number;
  };
  readonly registrationNote: string;
}

export interface CampaignResults {
  readonly campaign: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly status: string;
    readonly language: string;
    readonly telephonyProvider: string;
    readonly script: string;
    readonly scriptHash: string;
    readonly pilotStage: number;
    readonly createdAt: Date;
    readonly startedAt: Date | null;
    readonly completedAt: Date | null;
  };
  readonly dialing: {
    readonly enabled: boolean;
    /** Attempts that actually reached the telephony provider. */
    readonly callsPlaced: number;
    readonly note: string;
  };
  readonly contacts: {
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
  };
  readonly funnel: {
    readonly attempts: number;
    readonly dialled: number;
    readonly connected: number;
    readonly completed: number;
    readonly classified: number;
    readonly successes: number;
    readonly connectRate: Rate;
    readonly successRateOfConnected: Rate;
  };
  readonly providers: readonly ProviderAttemptRow[];
  readonly outcomes: {
    readonly perProvider: readonly ProviderOutcomeRow[];
    readonly byType: Readonly<Record<string, number>>;
    readonly classifiers: Readonly<Record<string, number>>;
  };
  /**
   * PEOPLE, not calls. Sits alongside `funnel` and `outcomes` rather
   * than replacing them: the attempt-level view answers "how is the
   * dialler doing", and this one answers "how many of these ten people
   * registered".
   */
  readonly contactOutcomes: ContactOutcomes;
  /**
   * Conversational events, in attempts. Sits beside the two blocks
   * above and feeds neither: no figure here is a success, a failure, or
   * a denominator for one.
   */
  readonly conversation: ConversationAnalytics;
  /** Sourced from `call_metrics` alone. */
  readonly voice: {
    readonly perProvider: readonly ProviderVoiceRow[];
    readonly note: string;
  };
  /** Sourced from `dispatch_metrics` alone. */
  readonly orchestration: {
    readonly perProvider: readonly ProviderDispatchRow[];
    readonly note: string;
  };
  /** What the report itself knows is missing. */
  readonly dataHealth: {
    readonly attemptsMissingVoiceMetrics: number;
    readonly attemptsMissingOutcome: number;
    readonly inferredTerminalStatuses: number;
    /**
     * Attempts whose TRANSCRIPT matched a voicemail greeting. A floor,
     * not a count: the platform has no answering-machine detection, so
     * every "connected" figure in this report includes an unknown
     * number of machines that said nothing recognisable.
     */
    readonly suspectedVoicemailAttempts: number;
    readonly warnings: readonly string[];
  };
  readonly generatedAt: Date;
}
