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
    readonly warnings: readonly string[];
  };
  readonly generatedAt: Date;
}
