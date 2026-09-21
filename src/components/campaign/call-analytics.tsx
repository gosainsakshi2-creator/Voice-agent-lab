"use client";

/**
 * call-analytics.tsx
 *
 * ONE screen, ONE dataset, several views of it.
 *
 * The filter bar builds a single query string. The summary tiles, the
 * call table, the daily table, the progression report and the CSV link
 * all receive that same string, so choosing "Response = YES" narrows
 * every one of them together and the export button downloads exactly
 * what is on screen. There is no per-category page and no per-category
 * dataset anywhere in this file.
 *
 * Presentation only: every classification (bucket, response, category,
 * progression) arrives already computed by the SQL that also filters on
 * it. This component never re-derives a bucket from a duration.
 *
 * Reuses the campaign screens' own primitives (StatCard, DataTable,
 * StatusPill, Note) so the page reads as part of the same application.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FileText, Loader2, PhoneOff, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  DataTable,
  EmptyState,
  GroupLabel,
  Note,
  StatCard,
  StatGrid,
  StatusPill,
  type Column,
  type Tone,
} from "@/components/campaign/ui";
import {
  CALL_STATUS_CATEGORIES,
  CUSTOMER_RESPONSES,
  DENOMINATOR_NOTE,
  DURATION_BUCKETS,
  DURATION_BUCKET_LABELS,
  type CallStatusCategory,
  type CustomerResponse,
  type DurationBucket,
} from "@/campaign/analytics/call-analytics-types";
import { OUTCOME_TYPES } from "@/campaign/outcome/outcome-types";

// ── Wire shapes (Dates arrive as ISO strings) ─────────────────────

interface RecordDto {
  callId: string;
  campaignId: string;
  campaignName: string;
  contactId: string;
  phone: string;
  name: string | null;
  email: string | null;
  callStartedAt: string;
  callEndedAt: string | null;
  durationSeconds: number | null;
  callStatus: string;
  statusSource: string;
  statusCategory: CallStatusCategory;
  answered: boolean;
  durationBucket: DurationBucket | null;
  customerResponse: CustomerResponse;
  callOutcome: string | null;
  primaryReason: string | null;
  contactDisposition: string | null;
  registrationSheetState: string | null;
  transcriptAvailable: boolean;
  transcriptTurns: number | null;
  attemptNumber: number;
  userCallIndex: number;
  userCallCount: number;
  previousDurationBucket: DurationBucket | null;
  progression: { from: DurationBucket; to: DurationBucket; direction: "UP" | "DOWN" | "SAME" } | null;
}

interface SummaryDto {
  total: number;
  answered: number;
  noAnswer: number;
  notConnected: number;
  open: number;
  byBucket: Record<DurationBucket, number>;
  byResponse: Record<CustomerResponse, number>;
  byOutcome: Record<string, number>;
  withTranscript: number;
}

interface DailyDto {
  day: string;
  total: number;
  answered: number;
  noAnswer: number;
  notConnected: number;
  open: number;
  noAnswerRate: number | null;
  byBucket: Record<DurationBucket, number>;
  bucketPct: Record<DurationBucket, number | null>;
  yes: number;
  no: number;
  unclear: number;
  yesPct: number | null;
  noPct: number | null;
}

interface ProgressionDto {
  usersWithRepeatAnswers: number;
  usersAnsweredOnce: number;
  transitions: { from: DurationBucket; to: DurationBucket; users: number }[];
  movedUp: number;
  movedDown: number;
  stayed: number;
  firstVsLatest: {
    latestLonger: number;
    latestShorter: number;
    equal: number;
    medianFirstSeconds: number | null;
    medianLatestSeconds: number | null;
  };
  registrations: { repeatUsersWithFinalYes: number; repeatUsersWithFinalNo: number };
  note: string;
}

interface TranscriptDto {
  callId: string;
  available: boolean;
  turns: { role: "user" | "assistant"; text: string; at: string | null }[];
  turnCount: number;
  truncated: boolean;
}

interface CampaignOption {
  id: string;
  name: string;
}

// ── Filter state ──────────────────────────────────────────────────

interface Filters {
  from: string;
  to: string;
  campaignId: string;
  status: "" | CallStatusCategory;
  response: "" | CustomerResponse;
  bucket: "" | DurationBucket;
  outcome: string;
  q: string;
}

const EMPTY_FILTERS: Filters = { from: "", to: "", campaignId: "", status: "", response: "", bucket: "", outcome: "", q: "" };

const PAGE_SIZE = 25;

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The one query string. Everything that fetches or exports uses it. */
function toQueryString(filters: Filters, timeZone: string): string {
  const params = new URLSearchParams();
  params.set("tz", timeZone);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.campaignId) params.set("campaignId", filters.campaignId);
  if (filters.status) params.set("status", filters.status);
  if (filters.response) params.set("response", filters.response);
  if (filters.bucket) params.set("bucket", filters.bucket);
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  return params.toString();
}

// ── Labels ────────────────────────────────────────────────────────

const STATUS_LABEL: Record<CallStatusCategory, string> = {
  ANSWERED: "Answered",
  NO_ANSWER: "No Answer",
  NOT_CONNECTED: "Not connected (busy / failed / cancelled)",
  OPEN: "Still open",
};

const STATUS_TONE: Record<CallStatusCategory, Tone> = {
  ANSWERED: "success",
  NO_ANSWER: "warning",
  NOT_CONNECTED: "neutral",
  OPEN: "info",
};

const RESPONSE_LABEL: Record<CustomerResponse, string> = {
  YES: "Yes",
  NO: "No",
  UNCLEAR: "Unclear",
  NOT_APPLICABLE: "N/A",
};

const RESPONSE_TONE: Record<CustomerResponse, Tone> = {
  YES: "success",
  NO: "neutral",
  UNCLEAR: "warning",
  NOT_APPLICABLE: "neutral",
};

function humanise(value: string): string {
  return value.replace(/_/g, " ").toLowerCase();
}

function seconds(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}s`;
}

function pctText(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function pctOf(numerator: number, denominator: number): string {
  return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}% of answered` : "no answered calls";
}

// ── Small controls ────────────────────────────────────────────────

function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  anyLabel = "Any",
}: {
  label: string;
  value: T | "";
  onChange: (value: T | "") => void;
  options: readonly { value: T; label: string }[];
  anyLabel?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <GroupLabel>{label}</GroupLabel>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T | "")}
        className="h-8 min-w-0 rounded-md border border-border bg-surface px-2 text-[12px] text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterInput({
  label,
  type = "text",
  value,
  onChange,
  placeholder,
}: {
  label: string;
  type?: "text" | "date";
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <GroupLabel>{label}</GroupLabel>
      <Input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 text-[12px]"
      />
    </label>
  );
}

// ── Main component ────────────────────────────────────────────────

type View = "calls" | "daily" | "progression";

export function CallAnalytics() {
  const [timeZone] = useState(browserTimeZone);
  const [filters, setFilters] = useState<Filters>(() => {
    // A campaign page can deep-link here with ?campaignId=…
    if (typeof window === "undefined") return EMPTY_FILTERS;
    const initial = new URLSearchParams(window.location.search).get("campaignId");
    return initial ? { ...EMPTY_FILTERS, campaignId: initial } : EMPTY_FILTERS;
  });
  const [debouncedQ, setDebouncedQ] = useState(filters.q);
  const [view, setView] = useState<View>("calls");
  const [offset, setOffset] = useState(0);

  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [records, setRecords] = useState<RecordDto[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [daily, setDaily] = useState<DailyDto[] | null>(null);
  const [progression, setProgression] = useState<ProgressionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [transcriptFor, setTranscriptFor] = useState<RecordDto | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQ(filters.q), 300);
    return () => clearTimeout(handle);
  }, [filters.q]);

  const queryString = useMemo(
    () => toQueryString({ ...filters, q: debouncedQ }, timeZone),
    [filters, debouncedQ, timeZone],
  );

  // Any filter change goes back to page one; a filter that leaves the
  // current offset past the end would otherwise show an empty page.
  useEffect(() => {
    setOffset(0);
  }, [queryString]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/campaigns");
        const json = (await res.json()) as { campaigns?: { id: string; name: string }[] };
        if (!cancelled && res.ok) {
          setCampaigns((json.campaigns ?? []).map((c) => ({ id: c.id, name: c.name })));
        }
      } catch {
        // The campaign dropdown is a convenience; the page works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/call-analytics?${queryString}&limit=${PAGE_SIZE}&offset=${offset}`);
      const json = (await res.json()) as {
        records?: RecordDto[];
        total?: number;
        summary?: SummaryDto;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Could not load the call records.");
      setRecords(json.records ?? []);
      setTotal(json.total ?? 0);
      setSummary(json.summary ?? null);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [queryString, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (view !== "daily") return;
    let cancelled = false;
    setDaily(null);
    void (async () => {
      try {
        const res = await fetch(`/api/call-analytics/daily?${queryString}`);
        const json = (await res.json()) as { days?: DailyDto[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? "Could not load the daily view.");
        if (!cancelled) setDaily(json.days ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, queryString]);

  useEffect(() => {
    if (view !== "progression") return;
    let cancelled = false;
    setProgression(null);
    void (async () => {
      try {
        const res = await fetch(`/api/call-analytics/progression?${queryString}`);
        const json = (await res.json()) as { report?: ProgressionDto; error?: string };
        if (!res.ok) throw new Error(json.error ?? "Could not load the progression view.");
        if (!cancelled) setProgression(json.report ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, queryString]);

  const set = <K extends keyof Filters>(key: K) => (value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const hasFilters = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-6">
      {/* ── Filters ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex flex-col gap-0.5">
              <CardTitle className="text-[13.5px]">Filters</CardTitle>
              <CardDescription>One set of filters drives the tiles, the table, the daily view and the export.</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCw className="size-4" aria-hidden />
                Refresh
              </Button>
              <Button size="sm" variant="outline" disabled={!hasFilters} onClick={() => setFilters(EMPTY_FILTERS)}>
                <X className="size-4" aria-hidden />
                Clear
              </Button>
              <Button size="sm" variant="default" asChild>
                <a href={`/api/call-analytics/export?${queryString}`}>
                  <Download className="size-4" aria-hidden />
                  Export CSV{hasFilters ? " (filtered)" : ""}
                </a>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
            <FilterInput label="From" type="date" value={filters.from} onChange={set("from")} />
            <FilterInput label="To" type="date" value={filters.to} onChange={set("to")} />
            <FilterSelect
              label="Campaign"
              value={filters.campaignId}
              onChange={set("campaignId")}
              anyLabel="All campaigns"
              options={campaigns.map((c) => ({ value: c.id, label: c.name }))}
            />
            <FilterSelect
              label="Answered / No Answer"
              value={filters.status}
              onChange={set("status")}
              options={CALL_STATUS_CATEGORIES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
            />
            <FilterSelect
              label="Response"
              value={filters.response}
              onChange={set("response")}
              options={CUSTOMER_RESPONSES.map((r) => ({ value: r, label: RESPONSE_LABEL[r] }))}
            />
            <FilterSelect
              label="Duration"
              value={filters.bucket}
              onChange={set("bucket")}
              options={DURATION_BUCKETS.map((b) => ({ value: b, label: DURATION_BUCKET_LABELS[b] }))}
            />
            <FilterSelect
              label="Outcome"
              value={filters.outcome}
              onChange={set("outcome")}
              options={[
                ...OUTCOME_TYPES.map((o) => ({ value: o as string, label: humanise(o) })),
                { value: "unclassified", label: "not classified" },
              ]}
            />
            <FilterInput label="Search" value={filters.q} onChange={set("q")} placeholder="name, phone, email" />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Dates are calendar days in your browser&apos;s time zone ({timeZone}). A duration filter implies answered
            calls: No Answer has no duration and never appears in a bucket.
          </p>
        </CardContent>
      </Card>

      {error ? (
        <p className="text-[12px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {/* ── Summary ─────────────────────────────────────────────── */}
      {summary ? (
        <div className="flex flex-col gap-3">
          <StatGrid>
            <StatCard label="Total calls" value={summary.total} hint="every attempt matching the filters" />
            <StatCard label="Answered" value={summary.answered} tone="success" hint="picked up (answered_at set)" />
            <StatCard label="No Answer" value={summary.noAnswer} tone="warning" hint="status NO_ANSWER — no duration" />
            <StatCard
              label="Not connected"
              value={summary.notConnected}
              hint={`busy / failed / cancelled${summary.open > 0 ? ` · ${summary.open} still open` : ""}`}
            />
            <StatCard label="Yes" value={summary.byResponse.YES} tone="success" hint={pctOf(summary.byResponse.YES, summary.answered)} />
            <StatCard label="No" value={summary.byResponse.NO} hint={pctOf(summary.byResponse.NO, summary.answered)} />
          </StatGrid>
          <StatGrid className="xl:grid-cols-6">
            {DURATION_BUCKETS.map((bucket) => (
              <StatCard
                key={bucket}
                label={DURATION_BUCKET_LABELS[bucket]}
                value={summary.byBucket[bucket]}
                hint={pctOf(summary.byBucket[bucket], summary.answered)}
              />
            ))}
            <StatCard label="Unclear" value={summary.byResponse.UNCLEAR} tone="warning" hint={pctOf(summary.byResponse.UNCLEAR, summary.answered)} />
            <StatCard label="With transcript" value={summary.withTranscript} hint="calls whose transcript is stored" />
          </StatGrid>
          <Note summary="How these numbers are defined">
            <p>
              <strong>Answered</strong> means the attempt has an answer time. <strong>No Answer</strong> is the
              attempt&apos;s own NO_ANSWER status; until a carrier callback exists it is this system&apos;s deduction.
              Busy, failed and cancelled attempts are <strong>Not connected</strong>, kept apart so No Answer is never
              inflated.
            </p>
            <p>
              <strong>Duration buckets</strong> apply to answered calls only, on the raw stored seconds: ≤10s is
              duration ≤ 10.000s, 11–20s is 10 &lt; duration ≤ 20, and so on. {DENOMINATOR_NOTE.durationPct}
            </p>
            <p>
              <strong>Yes</strong> is a registration confirmed at the commitment question in the stored classification
              (the same test the registrations sheet uses). <strong>No</strong> is an explicit decline or opt-out.
              Anything else a connected person said is <strong>Unclear</strong>; a call where nobody spoke is N/A. Duration
              is never read as a response. {DENOMINATOR_NOTE.responsePct}
            </p>
          </Note>
        </div>
      ) : null}

      {/* ── View switch ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Analytics view">
        {(
          [
            ["calls", "Calls"],
            ["daily", "Daily"],
            ["progression", "Progression"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            role="tab"
            aria-selected={view === key}
            size="sm"
            variant={view === key ? "secondary" : "ghost"}
            onClick={() => setView(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {view === "calls" ? (
        <CallsTable
          records={records}
          total={total}
          offset={offset}
          loading={loading}
          onPage={setOffset}
          onTranscript={setTranscriptFor}
        />
      ) : view === "daily" ? (
        <DailyTable days={daily} />
      ) : (
        <ProgressionView report={progression} />
      )}

      {transcriptFor ? <TranscriptPanel record={transcriptFor} onClose={() => setTranscriptFor(null)} /> : null}
    </div>
  );
}

// ── Calls table ───────────────────────────────────────────────────

const CALL_COLUMNS: readonly Column[] = [
  { key: "who", header: "Name / phone / email" },
  { key: "when", header: "Date / time" },
  { key: "campaign", header: "Campaign" },
  { key: "status", header: "Answered" },
  { key: "duration", header: "Duration", align: "right" },
  { key: "bucket", header: "Bucket" },
  { key: "response", header: "Response" },
  { key: "outcome", header: "Outcome" },
  { key: "registration", header: "Registration" },
  { key: "history", header: "Call #", hint: "nth call to this phone across campaigns / total" },
  { key: "progress", header: "vs previous answered" },
  { key: "transcript", header: "Transcript" },
];

function CallsTable({
  records,
  total,
  offset,
  loading,
  onPage,
  onTranscript,
}: {
  records: RecordDto[];
  total: number;
  offset: number;
  loading: boolean;
  onPage: (offset: number) => void;
  onTranscript: (record: RecordDto) => void;
}) {
  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-[13.5px]">Calls</CardTitle>
            <span className="font-mono text-[11px] tabular-nums text-subtle-foreground">{total}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-[11px] tabular-nums text-muted-foreground">
              {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`} of {total}
            </span>
            <Button size="sm" variant="outline" disabled={offset === 0 || loading} onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => onPage(offset + PAGE_SIZE)}>
              Next
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading && records.length === 0 ? (
          <p className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading calls…
          </p>
        ) : (
          <DataTable
            columns={CALL_COLUMNS}
            rows={records.map((r) => [
              <span key="who" className="flex flex-col gap-0.5 text-left">
                <span className="font-medium text-foreground">{r.name ?? "Unnamed contact"}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{r.phone}</span>
                {r.email ? <span className="text-[11px] text-muted-foreground">{r.email}</span> : null}
              </span>,
              <span key="when" className="flex flex-col gap-0.5 text-muted-foreground">
                <span>{new Date(r.callStartedAt).toLocaleString()}</span>
                <span className="text-[10px] uppercase tracking-[0.08em] text-subtle-foreground">{humanise(r.callStatus)}</span>
              </span>,
              <span key="campaign" className="max-w-[14rem] truncate text-muted-foreground" title={r.campaignName}>
                {r.campaignName}
              </span>,
              <span key="status" className="flex flex-col items-start gap-0.5">
                <StatusPill tone={STATUS_TONE[r.statusCategory]}>{STATUS_LABEL[r.statusCategory].split(" (")[0]}</StatusPill>
                {r.statusCategory === "NO_ANSWER" && r.statusSource === "inferred" ? (
                  <span className="pl-1 text-[10px] uppercase tracking-[0.08em] text-subtle-foreground">deduced</span>
                ) : null}
              </span>,
              <span key="duration" className="font-mono text-muted-foreground">
                {seconds(r.durationSeconds)}
              </span>,
              r.durationBucket ? (
                <StatusPill key="bucket" tone="info">
                  {DURATION_BUCKET_LABELS[r.durationBucket]}
                </StatusPill>
              ) : (
                <span key="bucket" className="text-muted-foreground">
                  —
                </span>
              ),
              <StatusPill key="response" tone={RESPONSE_TONE[r.customerResponse]}>
                {RESPONSE_LABEL[r.customerResponse]}
              </StatusPill>,
              <span key="outcome" className="flex flex-col gap-0.5">
                <span className="text-foreground">{r.callOutcome ? humanise(r.callOutcome) : "not classified"}</span>
                {r.primaryReason ? <span className="text-[10px] text-subtle-foreground">{humanise(r.primaryReason)}</span> : null}
              </span>,
              <span key="registration" className="flex flex-col gap-0.5 text-muted-foreground">
                <span>{r.contactDisposition ? humanise(r.contactDisposition) : "—"}</span>
                {r.registrationSheetState ? (
                  <span className="text-[10px] uppercase tracking-[0.08em] text-subtle-foreground">sheet {r.registrationSheetState.toLowerCase()}</span>
                ) : null}
              </span>,
              <span key="history" className="font-mono text-muted-foreground">
                {r.userCallIndex}/{r.userCallCount}
                <span className="text-subtle-foreground"> · attempt {r.attemptNumber}</span>
              </span>,
              r.progression ? (
                <span key="progress" className="font-mono text-[11px] text-muted-foreground">
                  {DURATION_BUCKET_LABELS[r.progression.from]} → {DURATION_BUCKET_LABELS[r.progression.to]}
                  <span className="text-subtle-foreground"> {r.progression.direction.toLowerCase()}</span>
                </span>
              ) : (
                <span key="progress" className="text-muted-foreground">
                  {r.durationBucket ? "first answered" : "—"}
                </span>
              ),
              r.transcriptAvailable ? (
                <Button key="transcript" size="sm" variant="outline" onClick={() => onTranscript(r)}>
                  <FileText className="size-3.5" aria-hidden />
                  View{r.transcriptTurns !== null ? ` (${r.transcriptTurns})` : ""}
                </Button>
              ) : (
                <span key="transcript" className="text-muted-foreground">
                  unavailable
                </span>
              ),
            ])}
            empty={
              <EmptyState
                icon={PhoneOff}
                title="No calls match"
                hint="Widen the filters, or run a campaign. Every attempt appears here once, with its outcome."
              />
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

// ── Daily table ───────────────────────────────────────────────────

const DAILY_COLUMNS: readonly Column[] = [
  { key: "day", header: "Day" },
  { key: "total", header: "Total", align: "right" },
  { key: "answered", header: "Answered", align: "right" },
  { key: "noanswer", header: "No Answer", align: "right", hint: DENOMINATOR_NOTE.noAnswerRate },
  { key: "le10", header: "≤10s", align: "right", hint: DENOMINATOR_NOTE.durationPct },
  { key: "s11", header: "11–20s", align: "right", hint: DENOMINATOR_NOTE.durationPct },
  { key: "s21", header: "21–30s", align: "right", hint: DENOMINATOR_NOTE.durationPct },
  { key: "gt30", header: ">30s", align: "right", hint: DENOMINATOR_NOTE.durationPct },
  { key: "yes", header: "Yes", align: "right", hint: DENOMINATOR_NOTE.responsePct },
  { key: "no", header: "No", align: "right", hint: DENOMINATOR_NOTE.responsePct },
];

function CountPct({ count, pct }: { count: number; pct: number | null }) {
  return (
    <span className="flex flex-col items-end gap-0.5 font-mono">
      <span className="text-foreground">{count}</span>
      <span className="text-[10px] text-subtle-foreground">{pctText(pct)}</span>
    </span>
  );
}

function DailyTable({ days }: { days: DailyDto[] | null }) {
  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle className="text-[13.5px]">Daily</CardTitle>
        <CardDescription>
          One row per calendar day with at least one attempt. Percentages under each count use the denominator named
          in the column header&apos;s tooltip.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {days === null ? (
          <p className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading days…
          </p>
        ) : (
          <>
            <DataTable
              columns={DAILY_COLUMNS}
              rows={days.map((d) => [
                <span key="day" className="font-mono text-foreground">
                  {d.day}
                </span>,
                <span key="total" className="font-mono text-foreground">
                  {d.total}
                </span>,
                <span key="answered" className="font-mono text-foreground">
                  {d.answered}
                </span>,
                <CountPct key="noanswer" count={d.noAnswer} pct={d.noAnswerRate} />,
                <CountPct key="le10" count={d.byBucket.LE10} pct={d.bucketPct.LE10} />,
                <CountPct key="s11" count={d.byBucket.S11_20} pct={d.bucketPct.S11_20} />,
                <CountPct key="s21" count={d.byBucket.S21_30} pct={d.bucketPct.S21_30} />,
                <CountPct key="gt30" count={d.byBucket.GT30} pct={d.bucketPct.GT30} />,
                <CountPct key="yes" count={d.yes} pct={d.yesPct} />,
                <CountPct key="no" count={d.no} pct={d.noPct} />,
              ])}
              empty={<EmptyState title="No days match" hint="No attempt fell inside the current filters." />}
            />
            <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              <p>{DENOMINATOR_NOTE.noAnswerRate}</p>
              <p>{DENOMINATOR_NOTE.durationPct}</p>
              <p>{DENOMINATOR_NOTE.responsePct}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Progression ───────────────────────────────────────────────────

function ProgressionView({ report }: { report: ProgressionDto | null }) {
  const matrix = useMemo(() => {
    const cells = new Map<string, number>();
    for (const t of report?.transitions ?? []) cells.set(`${t.from}>${t.to}`, t.users);
    return cells;
  }, [report]);

  if (report === null) {
    return (
      <Card>
        <CardContent>
          <p className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading progression…
          </p>
        </CardContent>
      </Card>
    );
  }

  const repeat = report.usersWithRepeatAnswers;
  const share = (n: number) => (repeat > 0 ? `${((n / repeat) * 100).toFixed(1)}% of repeat users` : "—");

  return (
    <div className="flex flex-col gap-4">
      <StatGrid>
        <StatCard label="Repeat users" value={repeat} hint="phones answered ≥ 2 times — the denominator" />
        <StatCard label="Answered once" value={report.usersAnsweredOnce} hint="no second answered call yet" />
        <StatCard label="Moved up" value={report.movedUp} tone="info" hint={share(report.movedUp)} />
        <StatCard label="Moved down" value={report.movedDown} tone="warning" hint={share(report.movedDown)} />
        <StatCard label="Same bucket" value={report.stayed} hint={share(report.stayed)} />
        <StatCard
          label="Median first → latest"
          value={`${report.firstVsLatest.medianFirstSeconds === null ? "—" : report.firstVsLatest.medianFirstSeconds.toFixed(0)}s → ${report.firstVsLatest.medianLatestSeconds === null ? "—" : report.firstVsLatest.medianLatestSeconds.toFixed(0)}s`}
          hint={`${report.firstVsLatest.latestLonger} longer · ${report.firstVsLatest.latestShorter} shorter · ${report.firstVsLatest.equal} equal`}
        />
      </StatGrid>

      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="text-[13.5px]">First answered call → latest answered call</CardTitle>
          <CardDescription>
            Rows are the first call&apos;s bucket, columns the latest call&apos;s. A cell is the number of phone numbers
            that made that move. Longer is not better; it is longer.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {repeat === 0 ? (
            <EmptyState title="No repeat users in this scope" hint="Progression needs a phone number with at least two answered calls." />
          ) : (
            <DataTable
              columns={[
                { key: "from", header: "First ↓ / Latest →" },
                ...DURATION_BUCKETS.map((b) => ({ key: b, header: DURATION_BUCKET_LABELS[b], align: "right" as const })),
                { key: "sum", header: "Users", align: "right" },
              ]}
              rows={DURATION_BUCKETS.map((from) => {
                const counts = DURATION_BUCKETS.map((to) => matrix.get(`${from}>${to}`) ?? 0);
                const rowTotal = counts.reduce((a, b) => a + b, 0);
                return [
                  <span key="from" className="font-medium text-foreground">
                    {DURATION_BUCKET_LABELS[from]}
                  </span>,
                  ...DURATION_BUCKETS.map((to, i) => {
                    const n = counts[i] ?? 0;
                    const dir = DURATION_BUCKETS.indexOf(to) - DURATION_BUCKETS.indexOf(from);
                    return (
                      <span
                        key={to}
                        className={
                          n === 0
                            ? "font-mono text-subtle-foreground"
                            : dir > 0
                              ? "font-mono font-semibold text-accent"
                              : dir < 0
                                ? "font-mono font-semibold text-warning"
                                : "font-mono text-foreground"
                        }
                      >
                        {n}
                      </span>
                    );
                  }),
                  <span key="sum" className="font-mono text-muted-foreground">
                    {rowTotal}
                  </span>,
                ];
              })}
            />
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <StatCard
              label="Repeat users registered (FINAL_YES)"
              value={report.registrations.repeatUsersWithFinalYes}
              tone="success"
              hint="from the stored contact verdicts, not from duration"
            />
            <StatCard label="Repeat users declined (FINAL_NO)" value={report.registrations.repeatUsersWithFinalNo} hint="stored verdict" />
          </div>
          <Note summary="How to read this">
            <p>{report.note}</p>
          </Note>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Transcript panel ──────────────────────────────────────────────

function TranscriptPanel({ record, onClose }: { record: RecordDto; onClose: () => void }) {
  const [transcript, setTranscript] = useState<TranscriptDto | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/call-analytics/transcript/${record.callId}`);
        const json = (await res.json()) as TranscriptDto & { error?: string };
        if (!res.ok) throw new Error(json.error ?? "Could not load the transcript.");
        if (!cancelled) setTranscript(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [record.callId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose} role="presentation">
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Transcript for ${record.name ?? record.phone}`}
        className="flex h-full w-full max-w-xl flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-[15px] font-semibold text-foreground">{record.name ?? "Unnamed contact"}</h2>
            <p className="font-mono text-[11px] text-muted-foreground">
              {record.phone} · {new Date(record.callStartedAt).toLocaleString()} · {seconds(record.durationSeconds)}
            </p>
            <p className="font-mono text-[10px] text-subtle-foreground">call {record.callId}</p>
          </div>
          <Button size="icon" variant="ghost" className="size-8" aria-label="Close transcript" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StatusPill tone={RESPONSE_TONE[record.customerResponse]}>response {RESPONSE_LABEL[record.customerResponse]}</StatusPill>
          {record.callOutcome ? <StatusPill tone="neutral">{humanise(record.callOutcome)}</StatusPill> : null}
          {record.durationBucket ? <StatusPill tone="info">{DURATION_BUCKET_LABELS[record.durationBucket]}</StatusPill> : null}
        </div>

        {error ? (
          <p className="text-[12px] text-destructive" role="alert">
            {error}
          </p>
        ) : transcript === null ? (
          <p className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading transcript…
          </p>
        ) : !transcript.available ? (
          <EmptyState title="Transcript unavailable" hint="No transcript was stored for this call. Nothing is reconstructed here." />
        ) : (
          <ol className="flex flex-col gap-2">
            {transcript.turns.map((turn, index) => (
              <li
                key={index}
                className={
                  turn.role === "user"
                    ? "ml-6 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-[12.5px] text-foreground"
                    : "mr-6 rounded-lg border border-border bg-surface-hover/50 px-3 py-2 text-[12.5px] text-foreground"
                }
              >
                <span className="mb-0.5 block text-[10px] uppercase tracking-[0.08em] text-subtle-foreground">
                  {turn.role === "user" ? "caller" : "agent"}
                  {turn.at ? ` · ${new Date(turn.at).toLocaleTimeString()}` : ""}
                </span>
                {turn.text}
              </li>
            ))}
            {transcript.truncated ? (
              <li className="text-[11px] text-muted-foreground">
                Stored transcript was truncated at capture ({transcript.turnCount} turns in the call).
              </li>
            ) : null}
          </ol>
        )}
      </aside>
    </div>
  );
}
