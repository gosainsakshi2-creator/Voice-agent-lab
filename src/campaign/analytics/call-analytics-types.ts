/**
 * call-analytics-types.ts
 *
 * The shape of the CALL ANALYTICS read model.
 *
 * There is no analytics table. Every figure here is a projection over
 * the rows the campaign layer already writes at the end of every call:
 * `call_attempts` (the mechanical record: timing, status, duration),
 * `call_outcomes` (what the call meant, plus the stored transcript),
 * `contacts` (who was called) and `sheet_sync` (whether a confirmed
 * registration reached the sheet). Yes / No / No Answer / the four
 * duration buckets are FILTERS over that one dataset, never separate
 * datasets, so a number on the summary tiles, in the table and in the
 * CSV is always the same query with the same predicate.
 *
 * Three definitions that the UI must state and this file pins:
 *
 *   1. A duration bucket exists ONLY for an answered call. A No Answer
 *      attempt has no `duration_seconds` (the repo never sets one
 *      without `answered_at`) and therefore no bucket — it is a status
 *      category, never a short call.
 *
 *   2. `customerResponse` is read from the stored classification, never
 *      inferred from duration or from "sounded positive". YES requires
 *      the same conjunction the registrations sheet requires
 *      (`confirmed_at_gate` AND `succeeded`), NO is an explicit decline
 *      or opt-out, and everything else a connected caller said is
 *      UNCLEAR. A call in which the person never spoke is
 *      NOT_APPLICABLE, not a guess either way.
 *
 *   3. The repeated-user identity is `contacts.normalized_phone`. It is
 *      the identifier the project already treats as the person — the
 *      registrations sheet is keyed on it and a campaign cannot hold it
 *      twice — and it is the only one that survives the same list being
 *      imported into a second campaign, which is where most repeat
 *      calls actually come from. `contactId` and the campaign-local
 *      `attemptNumber` are carried alongside, not replaced.
 */

export const DURATION_BUCKETS = ["LE10", "S11_20", "S21_30", "GT30"] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

/**
 * Boundaries are on the raw stored seconds: `LE10` is `duration <= 10`,
 * `S11_20` is `10 < duration <= 20`, and so on. A 10.4-second call is
 * therefore 11–20s, exactly as a person rounding up would file it.
 */
export const DURATION_BUCKET_LABELS: Readonly<Record<DurationBucket, string>> = {
  LE10: "≤10s",
  S11_20: "11–20s",
  S21_30: "21–30s",
  GT30: ">30s",
};

export const CUSTOMER_RESPONSES = ["YES", "NO", "UNCLEAR", "NOT_APPLICABLE"] as const;
export type CustomerResponse = (typeof CUSTOMER_RESPONSES)[number];

/**
 * ANSWERED       `answered_at` is set — somebody (or something) picked up.
 * NO_ANSWER      the attempt's status is NO_ANSWER.
 * NOT_CONNECTED  ended without an answer for another reason: busy,
 *                failed, cancelled (dialing disabled).
 * OPEN           no `ended_at` yet — live right now, or an orphan a
 *                crash left behind. Never counted as answered or not.
 */
export const CALL_STATUS_CATEGORIES = ["ANSWERED", "NO_ANSWER", "NOT_CONNECTED", "OPEN"] as const;
export type CallStatusCategory = (typeof CALL_STATUS_CATEGORIES)[number];

export const PROGRESSION_DIRECTIONS = ["UP", "DOWN", "SAME"] as const;
export type ProgressionDirection = (typeof PROGRESSION_DIRECTIONS)[number];

/** Movement between two duration buckets. Longer is UP; it is not "better". */
export interface BucketProgression {
  readonly from: DurationBucket;
  readonly to: DurationBucket;
  readonly direction: ProgressionDirection;
}

export function isDurationBucket(value: string): value is DurationBucket {
  return (DURATION_BUCKETS as readonly string[]).includes(value);
}

export function isCustomerResponse(value: string): value is CustomerResponse {
  return (CUSTOMER_RESPONSES as readonly string[]).includes(value);
}

export function isCallStatusCategory(value: string): value is CallStatusCategory {
  return (CALL_STATUS_CATEGORIES as readonly string[]).includes(value);
}

/** Rank so a move can be called UP or DOWN without a lookup table per pair. */
export function bucketRank(bucket: DurationBucket): number {
  return DURATION_BUCKETS.indexOf(bucket);
}

export function progressionBetween(
  from: DurationBucket | null,
  to: DurationBucket | null,
): BucketProgression | null {
  if (from === null || to === null) return null;
  const delta = bucketRank(to) - bucketRank(from);
  return { from, to, direction: delta > 0 ? "UP" : delta < 0 ? "DOWN" : "SAME" };
}

// ── Filters ───────────────────────────────────────────────────────
// Every view — summary, table, daily, export — takes the same object,
// which is what makes "Response = YES" one predicate everywhere.

export interface CallAnalyticsFilters {
  /** Inclusive calendar day, `YYYY-MM-DD`, interpreted in `timeZone`. */
  readonly from?: string;
  readonly to?: string;
  /** IANA zone the calendar days are read in. Defaults to UTC upstream. */
  readonly timeZone: string;
  readonly campaignId?: string;
  /** A stored `outcome_type`, or `"unclassified"` for attempts without an outcome row. */
  readonly outcome?: string;
  readonly response?: CustomerResponse;
  readonly status?: CallStatusCategory;
  readonly bucket?: DurationBucket;
  /** Substring match over name, phone and email. */
  readonly search?: string;
}

// ── One call ──────────────────────────────────────────────────────

export interface CallAnalyticsRecord {
  /** `call_attempts.id` — the idempotency key of everything the call wrote. */
  readonly callId: string;
  readonly sessionId: string | null;
  readonly providerCallId: string | null;

  readonly campaignId: string;
  readonly campaignName: string;
  readonly campaignType: string;

  /** `contacts.id`: the lead inside this campaign. */
  readonly contactId: string;
  /** E.164 — the cross-campaign identity of the person. */
  readonly phone: string;
  readonly name: string | null;
  /** Resolved from the imported CSV's email column, if the file had one. */
  readonly email: string | null;

  readonly callStartedAt: Date;
  readonly answeredAt: Date | null;
  readonly callEndedAt: Date | null;
  /** Raw stored seconds, always present when answered. Never rounded here. */
  readonly durationSeconds: number | null;

  /** The attempt's own status, verbatim (`COMPLETED`, `NO_ANSWER`, …). */
  readonly callStatus: string;
  /** `observed` or `inferred` — a NO_ANSWER is this system's deduction, not the carrier's word. */
  readonly statusSource: string;
  readonly statusCategory: CallStatusCategory;
  readonly answered: boolean;
  readonly durationBucket: DurationBucket | null;

  readonly customerResponse: CustomerResponse;
  /** The stored `outcome_type`, or null when the call was never classified. */
  readonly callOutcome: string | null;
  readonly primaryReason: string | null;
  readonly succeeded: boolean | null;
  readonly confidence: string | null;

  /** Contact-level verdict as it stands NOW: FINAL_YES, FINAL_NO, RETRYABLE, UNRESOLVED, TECHNICAL_FAILURE, or null. */
  readonly contactDisposition: string | null;
  /** Whether the confirmed registration reached the sheet: SYNCED, PENDING, FAILED, or null when no row was ever owed. */
  readonly registrationSheetState: string | null;

  readonly transcriptAvailable: boolean;
  readonly transcriptTurns: number | null;

  // ── History, keyed on `phone` ─────────────────────────────────
  /** The campaign's own counter for this contact. */
  readonly attemptNumber: number;
  /** 1 for the first call ever placed to this phone, across campaigns. */
  readonly userCallIndex: number;
  readonly userCallCount: number;
  readonly firstCallAt: Date;
  readonly previousCallAt: Date | null;
  readonly previousStatusCategory: CallStatusCategory | null;
  /** The previous ANSWERED call to this phone. Null when this is the first answered one. */
  readonly previousDurationSeconds: number | null;
  readonly previousDurationBucket: DurationBucket | null;
  readonly progression: BucketProgression | null;

  readonly ttsProvider: string;
  readonly llmProvider: string | null;
  readonly sttProvider: string | null;
  readonly telephonyProvider: string;
}

// ── Aggregates ────────────────────────────────────────────────────

export interface CallAnalyticsSummary {
  readonly total: number;
  readonly answered: number;
  readonly noAnswer: number;
  readonly notConnected: number;
  readonly open: number;
  readonly byBucket: Readonly<Record<DurationBucket, number>>;
  readonly byResponse: Readonly<Record<CustomerResponse, number>>;
  readonly byOutcome: Readonly<Record<string, number>>;
  readonly withTranscript: number;
}

export interface DailyAnalyticsRow {
  /** `YYYY-MM-DD` in the requested zone. */
  readonly day: string;
  readonly total: number;
  readonly answered: number;
  readonly noAnswer: number;
  readonly notConnected: number;
  readonly open: number;
  /** noAnswer / total. */
  readonly noAnswerRate: number | null;
  readonly byBucket: Readonly<Record<DurationBucket, number>>;
  /** bucket / answered. */
  readonly bucketPct: Readonly<Record<DurationBucket, number | null>>;
  readonly yes: number;
  readonly no: number;
  readonly unclear: number;
  /** yes / answered, no / answered. */
  readonly yesPct: number | null;
  readonly noPct: number | null;
}

/**
 * The denominators, as prose the UI shows next to the numbers. Kept in
 * the module rather than the component so the API and the screen cannot
 * disagree about what a percentage is over.
 */
export const DENOMINATOR_NOTE = {
  noAnswerRate: "No-answer rate = No Answer attempts ÷ all attempts that day.",
  durationPct: "Duration-bucket percentages = calls in the bucket ÷ ANSWERED calls (No Answer is excluded).",
  responsePct: "YES % and NO % = responses ÷ ANSWERED calls. UNCLEAR and NOT_APPLICABLE make up the rest.",
} as const;

export interface BucketTransition {
  readonly from: DurationBucket;
  readonly to: DurationBucket;
  readonly users: number;
}

export interface ProgressionReport {
  /** Phones with two or more answered calls — the denominator of every figure below. */
  readonly usersWithRepeatAnswers: number;
  readonly usersAnsweredOnce: number;
  /** First answered call's bucket → latest answered call's bucket, one row per pair seen. */
  readonly transitions: readonly BucketTransition[];
  readonly movedUp: number;
  readonly movedDown: number;
  readonly stayed: number;
  readonly firstVsLatest: {
    readonly latestLonger: number;
    readonly latestShorter: number;
    readonly equal: number;
    readonly medianFirstSeconds: number | null;
    readonly medianLatestSeconds: number | null;
  };
  /** Actual registrations among those repeat users, from the stored verdicts — shown apart from duration on purpose. */
  readonly registrations: {
    readonly repeatUsersWithFinalYes: number;
    readonly repeatUsersWithFinalNo: number;
  };
  readonly note: string;
}

export interface TranscriptView {
  readonly callId: string;
  readonly available: boolean;
  readonly turns: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string; readonly at: string | null }>;
  readonly turnCount: number;
  readonly truncated: boolean;
  readonly capturedAt: string | null;
}
