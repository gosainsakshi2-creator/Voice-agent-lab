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
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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

function outcomeTone(succeeded: boolean | null): string {
  if (succeeded === true) return "border-emerald-600/30 text-emerald-700 dark:text-emerald-400";
  if (succeeded === null) return "border-amber-600/30 text-amber-700 dark:text-amber-400";
  return "text-muted-foreground";
}

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
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-[15px]">Calls</CardTitle>
            <CardDescription className="text-[12px]">
              {total} attempt(s). Phone numbers are masked before they leave the database.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <span className="text-[12px] text-muted-foreground">
              {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`} of {total}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + PAGE_SIZE >= total || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {error ? (
          <p className="text-[12px] text-destructive" role="alert">
            {error}
          </p>
        ) : loading ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading…
          </p>
        ) : attempts.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No call has been attempted yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  {["Contact", "Provider", "#", "Status", "Length", "Outcome", "Why", "Ended"].map((header) => (
                    <th key={header} className="px-2 py-1.5 font-medium whitespace-nowrap">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {attempts.map((attempt) => (
                  <tr key={attempt.attemptId} className="border-b last:border-0">
                    <td className="px-2 py-1.5">
                      <span className="font-medium">{attempt.customerName ?? "—"}</span>
                      <span className="ml-2 font-mono text-muted-foreground">{attempt.maskedPhone}</span>
                    </td>
                    <td className="px-2 py-1.5">{attempt.provider}</td>
                    <td className="px-2 py-1.5 tabular-nums">{attempt.attemptNumber}</td>
                    <td className="px-2 py-1.5">
                      {attempt.status}
                      <span className="ml-1 text-muted-foreground">
                        ({attempt.statusSource === "inferred" ? "deduced" : attempt.statusSource})
                      </span>
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {attempt.durationSeconds === null ? "N/A" : `${attempt.durationSeconds.toFixed(1)}s`}
                    </td>
                    <td className="px-2 py-1.5">
                      {attempt.outcomeType ? (
                        <Badge variant="outline" className={`text-[11px] ${outcomeTone(attempt.succeeded)}`}>
                          {attempt.outcomeType.replace(/_/g, " ")}
                          {attempt.confidence ? ` · ${attempt.confidence}` : ""}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">not classified</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {attempt.primaryReason?.replace(/_/g, " ") ?? attempt.failureClass ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">
                      {attempt.endedAt ? new Date(attempt.endedAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
