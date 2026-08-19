"use client";

/**
 * campaign-results.tsx
 *
 * The results: what the campaign did, what it meant, and what the
 * numbers are not entitled to claim.
 *
 * Three presentation rules, each of which exists because the opposite
 * would mislead:
 *
 *   - A figure with no measurement renders as N/A. Never 0, never a
 *     dash that could be read as a zero.
 *   - Every rate is shown with its counts, so "100%" cannot be read
 *     without seeing that it was two calls out of two.
 *   - Voice latencies and orchestration timings are in SEPARATE cards
 *     with their sources named. They are never placed in one table,
 *     because a reader who can put them side by side in a single row
 *     will eventually add them together.
 *
 * A fourth rule is about attention rather than truth: the qualifying
 * prose that used to sit under every table is folded into a "how to
 * read this" disclosure. Every word of it is still on the page — it
 * just no longer outweighs the figure it qualifies.
 */

import { useCallback, useEffect, useState } from "react";
import { BarChart3, Download, Loader2, RefreshCw, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Callout,
  DataTable,
  EmptyState,
  GroupLabel,
  Note,
  ProviderCell,
  StatCard,
  StatGrid,
  type Column,
  type Tone,
} from "@/components/campaign/ui";

interface Percentiles {
  p50: number | null;
  p90: number | null;
  samples: number;
}

interface Rate {
  value: number | null;
  numerator: number;
  denominator: number;
}

interface ProviderAttemptRow {
  provider: string;
  attempts: number;
  rehearsedNotDialled: number;
  dialled: number;
  connected: number;
  completed: number;
  noAnswer: number;
  busy: number;
  failed: number;
  connectRate: Rate;
  connectedSeconds: Percentiles;
  inferredTerminal: number;
}

interface ProviderOutcomeRow {
  provider: string;
  classified: number;
  successes: number;
  failures: number;
  undetermined: number;
  successRateOfConnected: Rate;
  byOutcomeType: Record<string, number>;
}

interface ProviderVoiceRow {
  provider: string;
  calls: number;
  sttMs: Percentiles;
  llmMs: Percentiles;
  ttsMs: Percentiles;
  totalMs: Percentiles;
  firstTurnTotalMs: Percentiles;
  conversationSeconds: Percentiles;
  costUsd: { total: number | null; perCall: number | null };
}

interface ProviderDispatchRow {
  provider: string;
  calls: number;
  queueWaitMs: Percentiles;
  claimToDialMs: Percentiles;
  dialRequestMs: Percentiles;
  ringToAnswerMs: Percentiles;
  persistMs: Percentiles;
  classifyMs: Percentiles;
}

interface ContactDispositionCounts {
  FINAL_YES: number;
  FINAL_NO: number;
  RETRYABLE: number;
  UNRESOLVED: number;
  TECHNICAL_FAILURE: number;
  UNCLASSIFIED: number;
}

interface ProviderContactRow {
  provider: string;
  contacts: number;
  byDisposition: ContactDispositionCounts;
  stillOpen: number;
  conversionRate: Rate;
}

interface ContactOutcomes {
  total: number;
  byDisposition: ContactDispositionCounts;
  callbackRequested: number;
  stillEligible: number;
  permanentlyClosed: number;
  neverAttempted: number;
  attemptsPerContact: Record<string, number>;
  totalAttempts: number;
  conversionRate: Rate;
  finalYesRate: Rate;
  finalNoRate: Rate;
  perProvider: ProviderContactRow[];
  note: string;
}

/** Conversational events, in attempts. Never a conversion figure. */
interface ConversationAnalytics {
  attemptsRead: number;
  attemptsWithQuestions: number;
  customerQuestions: number;
  attemptsWithObjections: number;
  objections: number;
  interruptedOnQuestion: number;
  callbackRequests: number;
  adherence: {
    attemptsChecked: number;
    scriptRestarts: number;
    offScriptQuestionAttempts: number;
    unsupportedFigureAttempts: number;
  };
  registrationNote: string;
}

interface Results {
  campaign: { id: string; name: string; type: string; status: string; script: string; pilotStage: number };
  dialing: { enabled: boolean; callsPlaced: number; note: string };
  contacts: { total: number; byStatus: Record<string, number> };
  funnel: {
    attempts: number;
    dialled: number;
    connected: number;
    completed: number;
    classified: number;
    successes: number;
    connectRate: Rate;
    successRateOfConnected: Rate;
  };
  providers: ProviderAttemptRow[];
  outcomes: { perProvider: ProviderOutcomeRow[]; byType: Record<string, number>; classifiers: Record<string, number> };
  contactOutcomes: ContactOutcomes;
  conversation: ConversationAnalytics;
  voice: { perProvider: ProviderVoiceRow[]; note: string };
  orchestration: { perProvider: ProviderDispatchRow[]; note: string };
  dataHealth: {
    attemptsMissingVoiceMetrics: number;
    attemptsMissingOutcome: number;
    inferredTerminalStatuses: number;
    suspectedVoicemailAttempts: number;
    warnings: string[];
  };
  generatedAt: string;
}

const NA = "N/A";

function ms(value: number | null): string {
  if (value === null) return NA;
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function seconds(value: number | null): string {
  return value === null ? NA : `${value.toFixed(1)}s`;
}

function usd(value: number | null): string {
  return value === null ? NA : `$${value.toFixed(4)}`;
}

function percent(rate: Rate): string {
  if (rate.value === null) return NA;
  return `${(rate.value * 100).toFixed(1)}%`;
}

/** A rate is never shown without the counts behind it. */
function RateCell({ rate }: { rate: Rate }) {
  return (
    <span className="whitespace-nowrap">
      {percent(rate)}
      <span className="ml-1 text-muted-foreground">
        ({rate.numerator}/{rate.denominator})
      </span>
    </span>
  );
}

function Metric({ value, samples }: { value: number | null; samples: number }) {
  return (
    <span className="whitespace-nowrap">
      {ms(value)}
      {samples > 0 ? <span className="ml-1 text-subtle-foreground">n={samples}</span> : null}
    </span>
  );
}

/**
 * One contact disposition, in operator language: what it means on the
 * left, how many people are in it on the right.
 */
function DispositionRow({
  label,
  meaning,
  count,
  tone = "neutral",
}: {
  label: string;
  meaning: string;
  count: number;
  tone?: Tone;
}) {
  const dot: Record<Tone, string> = {
    neutral: "bg-subtle-foreground",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    info: "bg-accent",
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-hover/30 px-3.5 py-2.5">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${dot[tone]}`} aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span className="text-[12.5px] font-medium text-foreground">{label}</span>
          <span className="truncate text-[11px] text-muted-foreground">{meaning}</span>
        </div>
      </div>
      <span className="font-mono text-[16px] font-semibold tabular-nums text-foreground">{count}</span>
    </div>
  );
}

const NO_DATA = (
  <EmptyState
    icon={BarChart3}
    title="No call data yet"
    hint="Run the campaign to start collecting results."
  />
);

const CONTACT_COLUMNS: readonly Column[] = [
  { key: "provider", header: "Provider" },
  { key: "contacts", header: "Contacts", align: "right" },
  { key: "yes", header: "Final yes", align: "right" },
  { key: "no", header: "Final no", align: "right" },
  { key: "retryable", header: "Retryable", align: "right" },
  { key: "unresolved", header: "Unresolved", align: "right" },
  { key: "technical", header: "Technical", align: "right" },
  { key: "noverdict", header: "No verdict", align: "right" },
  { key: "open", header: "Still open", align: "right" },
  { key: "conversion", header: "Conversion", align: "right" },
];

const PROVIDER_COLUMNS: readonly Column[] = [
  { key: "provider", header: "Provider" },
  { key: "attempts", header: "Attempts", align: "right" },
  { key: "rehearsed", header: "Rehearsed", align: "right", hint: "Rehearsed, not dialled" },
  { key: "dialled", header: "Dialled", align: "right" },
  { key: "connected", header: "Connected", align: "right" },
  { key: "connectRate", header: "Connect rate", align: "right" },
  { key: "median", header: "Median call", align: "right" },
  { key: "successes", header: "Successes", align: "right" },
  { key: "successRate", header: "Success / connected", align: "right" },
  { key: "undetermined", header: "Undetermined", align: "right" },
];

const VOICE_COLUMNS: readonly Column[] = [
  { key: "provider", header: "Provider" },
  { key: "calls", header: "Calls", align: "right" },
  { key: "stt", header: "Speech-to-text", align: "right", hint: "Median per call" },
  { key: "llm", header: "Model", align: "right", hint: "Median per call" },
  { key: "tts", header: "Speech synthesis", align: "right", hint: "Median per call" },
  { key: "e2e50", header: "Reply time p50", align: "right" },
  { key: "e2e90", header: "Reply time p90", align: "right" },
  { key: "first", header: "First reply p50", align: "right" },
  { key: "length", header: "Median length", align: "right" },
  { key: "cost", header: "Cost", align: "right" },
  { key: "costPer", header: "Cost / call", align: "right" },
];

const EXECUTION_COLUMNS: readonly Column[] = [
  { key: "provider", header: "Provider" },
  { key: "calls", header: "Calls", align: "right" },
  { key: "queue", header: "Queue wait", align: "right" },
  { key: "claim", header: "Claim → dial", align: "right" },
  { key: "dial", header: "Dial request", align: "right" },
  { key: "ring", header: "Ring → answer", align: "right" },
  { key: "persist", header: "Save result", align: "right" },
  { key: "classify", header: "Classify", align: "right" },
];

export function CampaignResults({ campaignId }: { campaignId: string }) {
  const [results, setResults] = useState<Results | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/results`);
      const json = (await res.json()) as { results?: Results; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not load the results.");
      setResults(json.results);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading results…
        </CardContent>
      </Card>
    );
  }

  if (error || !results) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-[13px] text-destructive" role="alert">
            {error ?? "No results."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const { funnel, dataHealth, contactOutcomes, conversation } = results;

  return (
    <div className="flex flex-col gap-5">
      {/* ── Headline numbers ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex flex-col gap-0.5">
              <CardTitle className="text-[13.5px]">Campaign performance</CardTitle>
              <CardDescription>
                Attempt-level reach and contact-level outcome, kept separate.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCw className="size-4" aria-hidden />
                Refresh
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={`/api/campaigns/${campaignId}/export?kind=providers`}>
                  <Download className="size-4" aria-hidden />
                  Providers CSV
                </a>
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={`/api/campaigns/${campaignId}/export?kind=attempts`}>
                  <Download className="size-4" aria-hidden />
                  Calls CSV
                </a>
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          {dataHealth.warnings.length > 0 ? (
            <Callout tone="warning" title="Read these numbers with care">
              <ul className="flex flex-col gap-1">
                {dataHealth.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Callout>
          ) : null}

          <div className="flex flex-col gap-2.5">
            <GroupLabel>People — contacts</GroupLabel>
            <StatGrid>
              <StatCard
                label="Contacts"
                value={contactOutcomes.total}
                hint={`${contactOutcomes.totalAttempts} attempt(s)`}
              />
              <StatCard
                label="Conversion"
                value={percent(contactOutcomes.conversionRate)}
                hint={`${contactOutcomes.conversionRate.numerator}/${contactOutcomes.conversionRate.denominator} contacts`}
                tone={contactOutcomes.conversionRate.numerator > 0 ? "success" : "neutral"}
              />
              <StatCard
                label="Final yes"
                value={contactOutcomes.byDisposition.FINAL_YES}
                hint="closed, registered"
                tone={contactOutcomes.byDisposition.FINAL_YES > 0 ? "success" : "neutral"}
              />
              <StatCard label="Final no" value={contactOutcomes.byDisposition.FINAL_NO} hint="closed, declined" />
              <StatCard
                label="Still eligible"
                value={contactOutcomes.stillEligible}
                hint="can be claimed again"
              />
              <StatCard
                label="Permanently closed"
                value={contactOutcomes.permanentlyClosed}
                hint="no further attempt"
              />
            </StatGrid>
          </div>

          <div className="flex flex-col gap-2.5">
            <GroupLabel>Reach — call attempts</GroupLabel>
            <StatGrid>
              <StatCard label="Attempts" value={funnel.attempts} hint={`${funnel.dialled} dialled`} />
              <StatCard label="Connected" value={funnel.connected} hint={`${funnel.completed} completed`} />
              <StatCard
                label="Connect rate"
                value={percent(funnel.connectRate)}
                hint={`${funnel.connectRate.numerator}/${funnel.connectRate.denominator}`}
              />
              <StatCard label="Successes" value={funnel.successes} hint={`${funnel.classified} classified`} />
              <StatCard
                label="Success / connected"
                value={percent(funnel.successRateOfConnected)}
                hint={`${funnel.successRateOfConnected.numerator}/${funnel.successRateOfConnected.denominator}`}
              />
              <StatCard
                label="Calls placed"
                value={results.dialing.callsPlaced}
                hint={results.dialing.enabled ? "dialing enabled" : "dialing disabled"}
                tone={results.dialing.enabled ? "neutral" : "warning"}
              />
            </StatGrid>
          </div>

          <Note summary="How to read these numbers">
            <p>{results.dialing.note}</p>
            <p>
              Conversion is measured over unique contacts, never over attempts — one person with three attempts is
              one contact. Every rate is shown with the counts behind it, and a figure with no measurement reads as
              N/A rather than as zero.
            </p>
          </Note>
        </CardContent>
      </Card>

      {/* ── Contact-level outcome ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[13.5px]">Contact outcomes</CardTitle>
          <CardDescription>
            Where every person on the list currently stands. One contact, one row of the total — never double
            counted.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {contactOutcomes.total === 0 ? (
            <EmptyState
              icon={Users}
              title="No contacts yet"
              hint="Import a CSV below to build the call list. Outcomes appear here once the campaign runs."
            />
          ) : (
            <>
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                <DispositionRow
                  label="Final yes"
                  meaning="Agreed — closed, will not be called again"
                  count={contactOutcomes.byDisposition.FINAL_YES}
                  tone="success"
                />
                <DispositionRow
                  label="Final no"
                  meaning="Declined — closed, will not be called again"
                  count={contactOutcomes.byDisposition.FINAL_NO}
                />
                <DispositionRow
                  label="Retryable"
                  meaning="No answer or cut short — still to be called"
                  count={contactOutcomes.byDisposition.RETRYABLE}
                  tone="info"
                />
                <DispositionRow
                  label="Unresolved"
                  meaning="Spoke, but nothing was decided"
                  count={contactOutcomes.byDisposition.UNRESOLVED}
                  tone="warning"
                />
                <DispositionRow
                  label="Technical failure"
                  meaning="The call itself failed — not the person's answer"
                  count={contactOutcomes.byDisposition.TECHNICAL_FAILURE}
                  tone="danger"
                />
                <DispositionRow
                  label="No verdict yet"
                  meaning="Awaiting classification"
                  count={contactOutcomes.byDisposition.UNCLASSIFIED}
                />
                <DispositionRow
                  label="Callback requested"
                  meaning="Asked to be called back — not a refusal"
                  count={contactOutcomes.callbackRequested}
                  tone="info"
                />
              </div>

              <div className="flex flex-col gap-2">
                <GroupLabel>Attempts per contact</GroupLabel>
                {Object.keys(contactOutcomes.attemptsPerContact).length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">
                    No attempts recorded yet — every contact is still on its first call.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(contactOutcomes.attemptsPerContact).map(([attempts, count]) => (
                      <span
                        key={attempts}
                        className="inline-flex items-baseline gap-1.5 rounded-md border border-border bg-surface-hover/40 px-2.5 py-1 text-[11px] text-muted-foreground"
                      >
                        <span className="font-mono font-semibold tabular-nums text-foreground">{count}</span>
                        contact{count === 1 ? "" : "s"} · {attempts} attempt{attempts === "1" ? "" : "s"}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <GroupLabel>By provider</GroupLabel>
                <DataTable
                  columns={CONTACT_COLUMNS}
                  empty={NO_DATA}
                  rows={contactOutcomes.perProvider.map((row) => [
                    <ProviderCell key="p" provider={row.provider} />,
                    row.contacts,
                    row.byDisposition.FINAL_YES,
                    row.byDisposition.FINAL_NO,
                    row.byDisposition.RETRYABLE,
                    row.byDisposition.UNRESOLVED,
                    row.byDisposition.TECHNICAL_FAILURE,
                    row.byDisposition.UNCLASSIFIED,
                    row.stillOpen,
                    <RateCell key="conv" rate={row.conversionRate} />,
                  ])}
                />
              </div>

              <Note>
                <p>{contactOutcomes.note}</p>
              </Note>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── What happened inside the calls ───────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[13.5px]">Conversation quality</CardTitle>
          <CardDescription>
            What happened inside the calls, counted in attempts. None of these is a yes or a no.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <StatCard
              label="Calls with questions"
              value={conversation.attemptsWithQuestions}
              hint={`${conversation.customerQuestions} question(s) asked`}
            />
            <StatCard
              label="Calls with objections"
              value={conversation.attemptsWithObjections}
              hint={`${conversation.objections} objection(s) raised`}
            />
            <StatCard
              label="Ended mid-question"
              value={conversation.interruptedOnQuestion}
              hint="interrupted, still retryable"
              tone={conversation.interruptedOnQuestion > 0 ? "warning" : "neutral"}
            />
            <StatCard
              label="Callback requested"
              value={conversation.callbackRequests}
              hint="attempts, not refusals"
            />
          </div>

          <div className="flex flex-col gap-2">
            <GroupLabel>Script adherence</GroupLabel>
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <StatCard label="Checked" value={conversation.adherence.attemptsChecked} hint="attempts reviewed" />
              <StatCard
                label="Restarted script"
                value={conversation.adherence.scriptRestarts}
                tone={conversation.adherence.scriptRestarts > 0 ? "warning" : "neutral"}
              />
              <StatCard
                label="Off-script questions"
                value={conversation.adherence.offScriptQuestionAttempts}
                tone={conversation.adherence.offScriptQuestionAttempts > 0 ? "warning" : "neutral"}
              />
              <StatCard
                label="Unsupported figures"
                value={conversation.adherence.unsupportedFigureAttempts}
                tone={conversation.adherence.unsupportedFigureAttempts > 0 ? "danger" : "neutral"}
              />
            </div>
          </div>

          <Note>
            <p>{conversation.registrationNote}</p>
          </Note>
        </CardContent>
      </Card>

      {/* ── Provider comparison ──────────────────────────────────── */}
      <Card>
        <CardHeader className="gap-2">
          <CardTitle className="text-[13.5px]">Provider comparison</CardTitle>
          <CardDescription>
            The provider is the only variable — script, telephony and model are held constant across every row.
          </CardDescription>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {[
              `Script ${results.campaign.script}`,
              `Type ${results.campaign.type}`,
              `Stage ${results.campaign.pilotStage}`,
            ].map((held) => (
              <span
                key={held}
                className="rounded-md border border-border bg-surface-hover/40 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground"
              >
                held constant · {held}
              </span>
            ))}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DataTable
            columns={PROVIDER_COLUMNS}
            empty={NO_DATA}
            rows={results.providers.map((row) => {
              const outcome = results.outcomes.perProvider.find((o) => o.provider === row.provider);
              return [
                <ProviderCell key="p" provider={row.provider} />,
                row.attempts,
                row.rehearsedNotDialled,
                row.dialled,
                row.connected,
                <RateCell key="c" rate={row.connectRate} />,
                seconds(row.connectedSeconds.p50),
                outcome?.successes ?? 0,
                outcome ? <RateCell key="s" rate={outcome.successRateOfConnected} /> : NA,
                outcome?.undetermined ?? 0,
              ];
            })}
          />

          <div className="flex flex-col gap-2">
            <GroupLabel>Outcomes recorded</GroupLabel>
            {Object.entries(results.outcomes.byType).length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                Nothing classified yet — outcomes appear once calls complete.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {Object.entries(results.outcomes.byType).map(([type, count]) => (
                  <span
                    key={type}
                    className="inline-flex items-baseline gap-1.5 rounded-md border border-border bg-surface-hover/40 px-2.5 py-1 text-[11px] text-muted-foreground"
                  >
                    <span className="font-mono font-semibold tabular-nums text-foreground">{count}</span>
                    {type.replace(/_/g, " ").toLowerCase()}
                  </span>
                ))}
              </div>
            )}
          </div>

          <Note summary="How outcomes are decided">
            <p>
              Classified by {Object.keys(results.outcomes.classifiers).join(", ") || "nothing yet"}. An outcome the
              rules could not read is stored as undetermined rather than counted as a failure, and every label
              keeps the phrases it was derived from so a disputed one can be checked.
            </p>
          </Note>
        </CardContent>
      </Card>

      {/* ── Voice conversation performance ───────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[13.5px]">Voice conversation performance</CardTitle>
          <CardDescription>
            How quickly each provider held the conversation — listening, thinking and speaking — with estimated
            cost.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DataTable
            columns={VOICE_COLUMNS}
            empty={
              <EmptyState
                icon={BarChart3}
                title="No voice metrics yet"
                hint="Latency and cost appear once calls connect and a conversation is recorded."
              />
            }
            rows={results.voice.perProvider.map((row) => [
              <ProviderCell key="p" provider={row.provider} />,
              row.calls,
              <Metric key="stt" value={row.sttMs.p50} samples={row.sttMs.samples} />,
              <Metric key="llm" value={row.llmMs.p50} samples={row.llmMs.samples} />,
              <Metric key="tts" value={row.ttsMs.p50} samples={row.ttsMs.samples} />,
              ms(row.totalMs.p50),
              ms(row.totalMs.p90),
              ms(row.firstTurnTotalMs.p50),
              seconds(row.conversationSeconds.p50),
              usd(row.costUsd.total),
              usd(row.costUsd.perCall),
            ])}
          />
          <Note summary="What these timings measure">
            <p>{results.voice.note}</p>
            <p>
              Each sample is one call&apos;s own median for that stage, so these are medians of medians — the right
              figure for &ldquo;which provider is typically faster&rdquo;, and the wrong one for &ldquo;the worst
              turn we saw&rdquo;. Costs are estimates from published list prices, never invoiced spend.
            </p>
          </Note>
        </CardContent>
      </Card>

      {/* ── Campaign execution performance ───────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[13.5px]">Campaign execution performance</CardTitle>
          <CardDescription>
            The platform&apos;s own timings — queueing, dialing and saving results. Deliberately kept apart from
            the voice figures above, so a slow database write can never look like a slow voice provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DataTable
            columns={EXECUTION_COLUMNS}
            empty={
              <EmptyState
                icon={BarChart3}
                title="No execution metrics yet"
                hint="These timings are recorded while the dispatcher places calls."
              />
            }
            rows={results.orchestration.perProvider.map((row) => [
              <ProviderCell key="p" provider={row.provider} />,
              row.calls,
              <Metric key="q" value={row.queueWaitMs.p50} samples={row.queueWaitMs.samples} />,
              ms(row.claimToDialMs.p50),
              ms(row.dialRequestMs.p50),
              ms(row.ringToAnswerMs.p50),
              ms(row.persistMs.p50),
              ms(row.classifyMs.p50),
            ])}
          />
          <Note summary="Why these are separate">
            <p>{results.orchestration.note}</p>
            <p>
              These figures are never added to, averaged with, or compared against the voice latencies above.
            </p>
          </Note>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-subtle-foreground">
        <span>Generated {new Date(results.generatedAt).toLocaleString()}</span>
        <span aria-hidden>·</span>
        <span>{dataHealth.attemptsMissingVoiceMetrics} connected call(s) without voice metrics</span>
        <span aria-hidden>·</span>
        <span>{dataHealth.attemptsMissingOutcome} finished call(s) without an outcome</span>
        <span aria-hidden>·</span>
        <span>{dataHealth.inferredTerminalStatuses} deduced terminal status(es)</span>
      </div>
    </div>
  );
}
