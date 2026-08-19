"use client";

/**
 * campaign-calls.tsx
 *
 * The individual calls, newest first, each with the outcome the
 * classifier gave it.
 *
 * Phone numbers arrive already masked — the SQL that reads them masks
 * them, so an unmasked number never reaches the browser at all. The
 * status column says whether a terminal status was OBSERVED or
 * DEDUCED, because until a carrier status callback exists every
 * "no answer" is this system's inference and must not be read as the
 * carrier's word.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, PhoneOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DataTable,
  EmptyState,
  ProviderCell,
  StatusPill,
  type Column,
  type Tone,
} from "@/components/campaign/ui";

interface AttemptRow {
  attemptId: string;
  attemptNumber: number;
  provider: string;
  customerName: string | null;
  maskedPhone: string;
  status: string;
  statusSource: string;
  failureClass: string | null;
  durationSeconds: number | null;
  endedAt: string | null;
  outcomeType: string | null;
  succeeded: boolean | null;
  primaryReason: string | null;
  confidence: string | null;
}

const PAGE_SIZE = 25;

/** Yes is green, "we could not tell" is amber, no is quiet — never red. */
function outcomeTone(succeeded: boolean | null): Tone {
  if (succeeded === true) return "success";
  if (succeeded === null) return "warning";
  return "neutral";
}

const STATUS_TONE: Record<string, Tone> = {
  COMPLETED: "success",
  CONNECTED: "info",
  IN_PROGRESS: "info",
  DIALING: "info",
  RINGING: "info",
  NO_ANSWER: "warning",
  BUSY: "warning",
  CANCELLED: "neutral",
  FAILED: "danger",
};

function humanise(value: string): string {
  return value.replace(/_/g, " ").toLowerCase();
}

const COLUMNS: readonly Column[] = [
  { key: "contact", header: "Contact" },
  { key: "provider", header: "Provider" },
  { key: "attempt", header: "Attempt", align: "right" },
  { key: "status", header: "Call status" },
  { key: "length", header: "Length", align: "right" },
  { key: "outcome", header: "Outcome" },
  { key: "why", header: "Reason" },
  { key: "ended", header: "Ended" },
];

export function CampaignCalls({ campaignId }: { campaignId: string }) {
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/attempts?limit=${PAGE_SIZE}&offset=${offset}`);
      const json = (await res.json()) as { attempts?: AttemptRow[]; total?: number; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not load the calls.");
      setAttempts(json.attempts ?? []);
      setTotal(json.total ?? 0);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [campaignId, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-[13.5px]">Call attempts</CardTitle>
            <span className="font-mono text-[11px] tabular-nums text-subtle-foreground">{total}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-[11px] tabular-nums text-muted-foreground">
              {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`} of {total}
            </span>
            <Button
              size="icon"
              variant="outline"
              className="size-8"
              aria-label="Previous page"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="size-8"
              aria-label="Next page"
              disabled={offset + PAGE_SIZE >= total || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {error ? (
          <p className="text-[12px] text-destructive" role="alert">
            {error}
          </p>
        ) : loading ? (
          <p className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading calls…
          </p>
        ) : (
          <>
            <DataTable
              columns={COLUMNS}
              rows={attempts.map((attempt) => [
                <span key="contact" className="flex flex-col gap-0.5 text-left">
                  <span className="font-medium text-foreground">{attempt.customerName ?? "Unnamed contact"}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{attempt.maskedPhone}</span>
                </span>,
                <ProviderCell key="provider" provider={attempt.provider} />,
                <span key="attempt" className="font-mono text-muted-foreground">
                  #{attempt.attemptNumber}
                </span>,
                <span key="status" className="flex flex-col items-start gap-0.5">
                  <StatusPill tone={STATUS_TONE[attempt.status] ?? "neutral"}>
                    {humanise(attempt.status)}
                  </StatusPill>
                  <span className="pl-1 text-[10px] uppercase tracking-[0.08em] text-subtle-foreground">
                    {attempt.statusSource === "inferred" ? "deduced" : attempt.statusSource}
                  </span>
                </span>,
                <span key="length" className="font-mono text-muted-foreground">
                  {attempt.durationSeconds === null ? "N/A" : `${attempt.durationSeconds.toFixed(1)}s`}
                </span>,
                attempt.outcomeType ? (
                  <StatusPill key="outcome" tone={outcomeTone(attempt.succeeded)}>
                    {humanise(attempt.outcomeType)}
                    {attempt.confidence ? (
                      <span className="text-subtle-foreground">{attempt.confidence}</span>
                    ) : null}
                  </StatusPill>
                ) : (
                  <span key="outcome" className="text-muted-foreground">
                    not classified
                  </span>
                ),
                <span key="why" className="text-muted-foreground">
                  {attempt.primaryReason?.replace(/_/g, " ") ?? attempt.failureClass ?? "—"}
                </span>,
                <span key="ended" className="text-muted-foreground">
                  {attempt.endedAt ? new Date(attempt.endedAt).toLocaleString() : "—"}
                </span>,
              ])}
              empty={
                <EmptyState
                  icon={PhoneOff}
                  title="No calls yet"
                  hint="Run the campaign to start collecting attempts. Every attempt will appear here with its outcome."
                />
              }
            />
            {attempts.length > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Phone numbers are masked before they leave the database. A deduced status is this system&apos;s
                inference, not the carrier&apos;s word.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
