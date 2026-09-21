/**
 * call-analytics-csv.ts
 *
 * The filtered call records as one CSV.
 *
 * ONE export, parameterised by the same filter object the screen uses.
 * "Export the YES calls" is this function with `response: "YES"`; there
 * is no second file per category and nothing is written to disk. The
 * rows come from `exportCallRecords`, which is the table's own query
 * with the transcript column added, so a row in the file and a row on
 * screen cannot disagree.
 *
 * Two bounds, both deliberate:
 *
 *   - `MAX_EXPORT_ROWS` caps the file. The screen says so when the cap
 *     is hit, and the way past it is a narrower filter, not a bigger
 *     download.
 *   - A transcript cell is cut at `MAX_TRANSCRIPT_CHARS` with a visible
 *     marker. The stored transcript is already bounded (200 turns of
 *     2,000 characters), but 400 KB in one spreadsheet cell helps
 *     nobody; the full text is one click away in the UI.
 *
 * Every cell goes through a formula guard. A contact named `=cmd|...`
 * is a spreadsheet exploit, not a name — the same rule the existing
 * campaign export applies.
 *
 * Phone numbers and emails are exported IN FULL, unlike the per-campaign
 * results export, because this file is the contact-level worksheet the
 * team asked for. Treat the download accordingly.
 */

import { exportCallRecords, type SqlRunner } from "./call-analytics.repo";
import { fromStoredTranscript } from "../outcome/transcript";
import { DURATION_BUCKET_LABELS, type CallAnalyticsFilters, type CallAnalyticsRecord } from "./call-analytics-types";

export const MAX_EXPORT_ROWS = 20_000;
export const MAX_TRANSCRIPT_CHARS = 30_000;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  const defused = /^[=+\-@\t\r]/.test(text);
  if (defused) text = `'${text}`;
  if (defused || /[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [headers.join(","), ...rows.map((row) => row.map(cell).join(","))].join("\r\n") + "\r\n";
}

export const CSV_HEADERS = [
  "call_started_at",
  "call_ended_at",
  "name",
  "email",
  "phone",
  "call_id",
  "campaign_id",
  "campaign_name",
  "contact_id",
  "call_status",
  "status_source",
  "answered",
  "duration_seconds",
  "duration_bucket",
  "customer_response",
  "call_outcome",
  "primary_reason",
  "contact_disposition",
  "registration_sheet_state",
  "attempt_number",
  "user_call_index",
  "user_call_count",
  "first_call_at",
  "previous_call_at",
  "previous_call_status",
  "previous_duration_seconds",
  "previous_duration_bucket",
  "progression",
  "tts_provider",
  "llm_provider",
  "stt_provider",
  "telephony_provider",
  "transcript_available",
  "transcript",
] as const;

/** `[HH:MM:SS] role: text` per line — readable in a cell, greppable in a file. */
export function flattenTranscript(stored: unknown): string {
  const turns = fromStoredTranscript(stored);
  if (turns.length === 0) return "";
  const lines = turns.map((turn) => {
    const stamp = turn.at ? `[${turn.at.slice(11, 19)}] ` : "";
    return `${stamp}${turn.role === "user" ? "caller" : "agent"}: ${turn.text}`;
  });
  const joined = lines.join("\n");
  return joined.length > MAX_TRANSCRIPT_CHARS
    ? `${joined.slice(0, MAX_TRANSCRIPT_CHARS)}\n[truncated for export — open the call in the UI for the full transcript]`
    : joined;
}

export function recordToCsvRow(record: CallAnalyticsRecord, transcript: unknown): readonly unknown[] {
  return [
    record.callStartedAt,
    record.callEndedAt,
    record.name,
    record.email,
    record.phone,
    record.callId,
    record.campaignId,
    record.campaignName,
    record.contactId,
    record.callStatus,
    record.statusSource,
    record.answered,
    record.durationSeconds,
    record.durationBucket ? DURATION_BUCKET_LABELS[record.durationBucket] : "",
    record.customerResponse,
    record.callOutcome ?? "unclassified",
    record.primaryReason,
    record.contactDisposition,
    record.registrationSheetState,
    record.attemptNumber,
    record.userCallIndex,
    record.userCallCount,
    record.firstCallAt,
    record.previousCallAt,
    record.previousStatusCategory,
    record.previousDurationSeconds,
    record.previousDurationBucket ? DURATION_BUCKET_LABELS[record.previousDurationBucket] : "",
    record.progression
      ? `${DURATION_BUCKET_LABELS[record.progression.from]} → ${DURATION_BUCKET_LABELS[record.progression.to]} (${record.progression.direction})`
      : "",
    record.ttsProvider,
    record.llmProvider,
    record.sttProvider,
    record.telephonyProvider,
    record.transcriptAvailable,
    flattenTranscript(transcript),
  ];
}

export interface CsvExport {
  readonly csv: string;
  readonly rows: number;
  /** True when the row cap was hit and the filter should be narrowed. */
  readonly capped: boolean;
}

export async function exportCallAnalyticsCsv(
  filters: CallAnalyticsFilters,
  runner?: SqlRunner,
): Promise<CsvExport> {
  const rows = await exportCallRecords(filters, MAX_EXPORT_ROWS, runner);
  return {
    csv: toCsv(CSV_HEADERS, rows.map(({ record, transcript }) => recordToCsvRow(record, transcript))),
    rows: rows.length,
    capped: rows.length >= MAX_EXPORT_ROWS,
  };
}

/** A filename that says what is in the file, so an exported "YES" sheet cannot be mistaken for everything. */
export function exportFilename(filters: CallAnalyticsFilters): string {
  const parts = ["call-analytics"];
  if (filters.from || filters.to) parts.push(`${filters.from ?? "start"}_to_${filters.to ?? "now"}`);
  if (filters.status) parts.push(filters.status.toLowerCase());
  if (filters.response) parts.push(`response-${filters.response.toLowerCase()}`);
  if (filters.bucket) parts.push(`bucket-${filters.bucket.toLowerCase()}`);
  if (filters.outcome) parts.push(`outcome-${filters.outcome}`);
  if (filters.campaignId) parts.push(`campaign-${filters.campaignId.slice(0, 8)}`);
  return `${parts.join("_")}.csv`;
}
