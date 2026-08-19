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
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

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
  voice: { perProvider: ProviderVoiceRow[]; note: string };
  orchestration: { perProvider: ProviderDispatchRow[]; note: string };
  dataHealth: {
    attemptsMissingVoiceMetrics: number;
    attemptsMissingOutcome: number;
    inferredTerminalStatuses: number;
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
      {samples > 0 ? <span className="ml-1 text-muted-foreground">(n={samples})</span> : null}
    </span>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.04em] text-muted-foreground">{label}</p>
      <p className="text-[18px] font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Table({ headers, rows }: { headers: readonly string[]; rows: readonly React.ReactNode[][] }) {
  if (rows.length === 0) {
    return <p className="text-[12px] text-muted-foreground">No data yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            {headers.map((header) => (
              <th key={header} className="px-2 py-1.5 font-medium whitespace-nowrap">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-2 py-1.5 tabular-nums">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
        <CardContent className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
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

  const { funnel, dataHealth } = results;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-[15px]">Results</CardTitle>
              <CardDescription className="text-[12px]">
                {results.campaign.name} · {results.campaign.type} · script {results.campaign.script} · status{" "}
                {results.campaign.status}
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
          <p className="text-[12px] leading-relaxed text-muted-foreground">{results.dialing.note}</p>

          {dataHealth.warnings.length > 0 ? (
            <div className="flex items-start gap-3 rounded-lg border border-amber-600/30 bg-amber-500/10 px-4 py-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              <ul className="flex flex-col gap-1">
                {dataHealth.warnings.map((warning) => (
                  <li key={warning} className="text-[12px] leading-relaxed text-muted-foreground">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Contacts" value={String(results.contacts.total)} />
            <Tile label="Attempts" value={String(funnel.attempts)} hint={`${funnel.dialled} dialled`} />
            <Tile label="Connected" value={String(funnel.connected)} />
            <Tile label="Connect rate" value={percent(funnel.connectRate)} hint={`${funnel.connectRate.numerator}/${funnel.connectRate.denominator}`} />
            <Tile label="Successes" value={String(funnel.successes)} hint={`${funnel.classified} classified`} />
            <Tile
              label="Success / connected"
              value={percent(funnel.successRateOfConnected)}
              hint={`${funnel.successRateOfConnected.numerator}/${funnel.successRateOfConnected.denominator}`}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Per provider</CardTitle>
          <CardDescription className="text-[12px]">
            Same script, same telephony, same model — the provider is the only thing that differs.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table
            headers={[
              "Provider", "Attempts", "Rehearsed", "Dialled", "Connected", "Connect rate",
              "Median call", "Successes", "Success / connected", "Undetermined",
            ]}
            rows={results.providers.map((row) => {
              const outcome = results.outcomes.perProvider.find((o) => o.provider === row.provider);
              return [
                <span key="p" className="font-medium">{row.provider}</span>,
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
          <Separator />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.04em] text-muted-foreground">Outcomes</span>
            {Object.entries(results.outcomes.byType).length === 0 ? (
              <span className="text-[12px] text-muted-foreground">Nothing classified yet.</span>
            ) : (
              Object.entries(results.outcomes.byType).map(([type, count]) => (
                <Badge key={type} variant="outline" className="text-[11px]">
                  {type.replace(/_/g, " ")} · {count}
                </Badge>
              ))
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Classified by {Object.keys(results.outcomes.classifiers).join(", ") || "nothing yet"}. An outcome the
            rules could not read is stored as undetermined rather than counted as a failure, and every label keeps
            the phrases it was derived from so a disputed one can be checked.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Voice conversation</CardTitle>
          <CardDescription className="text-[12px]">{results.voice.note}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Table
            headers={["Provider", "Calls", "STT p50", "LLM p50", "TTS p50", "End-to-end p50", "End-to-end p90", "First turn p50", "Median length", "Cost", "Cost / call"]}
            rows={results.voice.perProvider.map((row) => [
              <span key="p" className="font-medium">{row.provider}</span>,
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
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Each sample is one call&apos;s own median for that stage, so these are medians of medians — the right
            figure for &ldquo;which provider is typically faster&rdquo;, and the wrong one for &ldquo;the worst turn
            we saw&rdquo;. Costs are estimates from published list prices, never invoiced spend.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Campaign orchestration</CardTitle>
          <CardDescription className="text-[12px]">{results.orchestration.note}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Table
            headers={["Provider", "Calls", "Queue wait p50", "Claim → dial p50", "Dial request p50", "Ring → answer p50", "Persist p50", "Classify p50"]}
            rows={results.orchestration.perProvider.map((row) => [
              <span key="p" className="font-medium">{row.provider}</span>,
              row.calls,
              <Metric key="q" value={row.queueWaitMs.p50} samples={row.queueWaitMs.samples} />,
              ms(row.claimToDialMs.p50),
              ms(row.dialRequestMs.p50),
              ms(row.ringToAnswerMs.p50),
              ms(row.persistMs.p50),
              ms(row.classifyMs.p50),
            ])}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            This is the platform&apos;s own overhead. It is deliberately never added to, averaged with, or compared
            against the voice latencies above — a slow database write must not be able to look like a slow TTS
            provider.
          </p>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Generated {new Date(results.generatedAt).toLocaleString()} · {dataHealth.attemptsMissingVoiceMetrics}{" "}
        connected call(s) without voice metrics · {dataHealth.attemptsMissingOutcome} finished call(s) without an
        outcome · {dataHealth.inferredTerminalStatuses} deduced terminal status(es).
      </p>
    </div>
  );
}
