/**
 * export-csv.ts
 *
 * The results, as a file someone can open.
 *
 * Two exports, deliberately: a per-attempt sheet for auditing
 * individual calls, and a per-provider sheet for the comparison. Both
 * are built from the same aggregates the API returns, so a number in
 * the spreadsheet and the same number on screen cannot drift.
 *
 * Three details that matter more than they look:
 *
 *   - Phone numbers are already masked by SQL before they reach here.
 *     A results export is the likeliest artefact to be mailed around,
 *     and it must not carry a contact list out of the system.
 *
 *   - Voice columns and orchestration columns are prefixed `voice_`
 *     and `dispatch_`, and are read from their two tables by two
 *     separate queries. A reader can always tell which clock a number
 *     came from, and no cell mixes them.
 *
 *   - Every field is passed through a formula guard. A contact named
 *     `=cmd|...` in a CSV is a spreadsheet exploit, not a name.
 */

import {
  attemptAggregates,
  dispatchAggregates,
  dispatchMetricsByAttempt,
  listAttempts,
  outcomeAggregates,
  voiceAggregates,
  voiceMetricsByAttempt,
} from "./results.repo";

/** Enough rows for a pilot; a full campaign export is a later, paged job. */
const MAX_EXPORT_ROWS = 5_000;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  // Neutralise anything a spreadsheet would evaluate as a formula, and
  // quote it as well. Quoting is not what defuses it — the leading
  // apostrophe is — but it keeps the guard visible in the raw file
  // rather than leaving a bare `'=cmd|...` that reads like a typo.
  const defused = /^[=+\-@\t\r]/.test(text);
  if (defused) text = `'${text}`;
  if (defused || /[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  return [headers.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\r\n") + "\r\n";
}

/** One row per call attempt, with its outcome and both metric families. */
export async function exportAttemptsCsv(campaignId: string): Promise<string> {
  const [attempts, voice, dispatch] = await Promise.all([
    listAttempts(campaignId, MAX_EXPORT_ROWS, 0),
    voiceMetricsByAttempt(campaignId),
    dispatchMetricsByAttempt(campaignId),
  ]);

  const headers = [
    "attempt_id", "attempt_number", "provider", "customer_name", "masked_phone",
    "status", "status_source", "failure_class", "hangup_reason",
    "dialed_at", "answered_at", "ended_at", "duration_seconds",
    "outcome_type", "succeeded", "primary_reason", "outcome_confidence",
    "voice_turn_count", "voice_conversation_seconds",
    "voice_stt_p50_ms", "voice_llm_p50_ms", "voice_tts_p50_ms", "voice_total_p50_ms",
    "voice_first_turn_total_ms", "voice_cost_total_usd",
    "dispatch_queue_wait_ms", "dispatch_claim_to_dial_ms", "dispatch_dial_request_ms",
    "dispatch_ring_to_answer_ms", "dispatch_persist_ms", "dispatch_classify_ms",
  ];

  const rows = attempts.map((attempt) => {
    const v = voice.get(attempt.attemptId) ?? {};
    const d = dispatch.get(attempt.attemptId) ?? {};
    return [
      attempt.attemptId, attempt.attemptNumber, attempt.provider, attempt.customerName, attempt.maskedPhone,
      attempt.status, attempt.statusSource, attempt.failureClass, attempt.hangupReason,
      attempt.dialedAt, attempt.answeredAt, attempt.endedAt, attempt.durationSeconds,
      attempt.outcomeType, attempt.succeeded, attempt.primaryReason, attempt.confidence,
      v["turnCount"], v["conversationSeconds"],
      v["sttP50Ms"], v["llmP50Ms"], v["ttsP50Ms"], v["totalP50Ms"],
      v["firstTurnTotalMs"], v["costTotalUsd"],
      d["queueWaitMs"], d["claimToDialMs"], d["dialRequestMs"],
      d["ringToAnswerMs"], d["persistMs"], d["classifyMs"],
    ];
  });

  return toCsv(headers, rows);
}

/** One row per provider: the comparison, in the order it should be read. */
export async function exportProvidersCsv(campaignId: string): Promise<string> {
  const [attempts, outcomes, voice, dispatch] = await Promise.all([
    attemptAggregates(campaignId),
    outcomeAggregates(campaignId),
    voiceAggregates(campaignId),
    dispatchAggregates(campaignId),
  ]);

  const voiceByProvider = new Map(voice.map((row) => [row.provider, row]));
  const dispatchByProvider = new Map(dispatch.map((row) => [row.provider, row]));

  const successByProvider = new Map<string, number>();
  const classifiedByProvider = new Map<string, number>();
  for (const row of outcomes) {
    classifiedByProvider.set(row.provider, (classifiedByProvider.get(row.provider) ?? 0) + row.count);
    if (row.succeeded === true) {
      successByProvider.set(row.provider, (successByProvider.get(row.provider) ?? 0) + row.count);
    }
  }

  const headers = [
    "provider", "attempts", "rehearsed_not_dialled", "dialled", "connected", "connect_rate",
    "completed", "no_answer", "busy", "failed", "inferred_terminal_statuses",
    "classified", "successes", "success_rate_of_connected",
    "voice_calls", "voice_stt_p50_ms", "voice_llm_p50_ms", "voice_tts_p50_ms",
    "voice_total_p50_ms", "voice_total_p90_ms", "voice_first_turn_total_p50_ms",
    "voice_conversation_seconds_p50", "voice_cost_total_usd", "voice_cost_per_call_usd",
    "dispatch_calls", "dispatch_queue_wait_p50_ms", "dispatch_dial_request_p50_ms",
    "dispatch_ring_to_answer_p50_ms", "dispatch_persist_p50_ms", "dispatch_classify_p50_ms",
  ];

  const rows = attempts.map((row) => {
    const v = voiceByProvider.get(row.provider);
    const d = dispatchByProvider.get(row.provider);
    const successes = successByProvider.get(row.provider) ?? 0;
    return [
      row.provider, row.attempts, row.rehearsedNotDialled, row.dialled, row.connected,
      ratio(row.connected, row.dialled),
      row.completed, row.noAnswer, row.busy, row.failed, row.inferredTerminal,
      classifiedByProvider.get(row.provider) ?? 0, successes, ratio(successes, row.connected),
      v?.calls ?? 0, v?.sttMs.p50 ?? null, v?.llmMs.p50 ?? null, v?.ttsMs.p50 ?? null,
      v?.totalMs.p50 ?? null, v?.totalMs.p90 ?? null, v?.firstTurnTotalMs.p50 ?? null,
      v?.conversationSeconds.p50 ?? null, v?.costTotalUsd ?? null,
      v && v.calls > 0 && v.costTotalUsd !== null ? round6(v.costTotalUsd / v.calls) : null,
      d?.calls ?? 0, d?.queueWaitMs.p50 ?? null, d?.dialRequestMs.p50 ?? null,
      d?.ringToAnswerMs.p50 ?? null, d?.persistMs.p50 ?? null, d?.classifyMs.p50 ?? null,
    ];
  });

  return toCsv(headers, rows);
}

/** Empty rather than 0 when there is no denominator — same rule as the report. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
