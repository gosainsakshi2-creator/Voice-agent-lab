"use client";

/**
 * campaign-header.tsx
 *
 * The identity band: which campaign this is, what state it is in, and
 * the six facts an operator needs before reading anything else.
 *
 * Read-only. It calls the same GET the campaigns list already calls and
 * changes nothing — its whole job is that the name and the status are
 * the first two things on the page instead of the word "Campaign".
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";

import { MetaChip, StatusPill, type Tone } from "@/components/campaign/ui";

interface CampaignPayload {
  campaign: {
    id: string;
    name: string;
    campaignType: string;
    status: string;
    scriptId: string;
    scriptVersion: string;
    providerAllocation: Record<string, number>;
    telephonyProvider: string;
    language: string;
    agentGender: string | null;
    totalContacts: number;
    pilotStage: number;
    createdAt: string;
  };
  allocationInDatabase: Record<string, number>;
  callsPlaced: number;
}

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: "neutral",
  IMPORTING: "info",
  READY: "success",
  RUNNING: "info",
  PAUSED: "warning",
  STOPPED: "danger",
  COMPLETED: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  IMPORTING: "Importing",
  READY: "Ready",
  RUNNING: "Running",
  PAUSED: "Paused",
  STOPPED: "Stopped",
  COMPLETED: "Completed",
};

export function CampaignHeader({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<CampaignPayload | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`);
      const json = (await res.json()) as CampaignPayload & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not load this campaign.");
      setData(json);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const campaign = data?.campaign;
  const status = campaign?.status ?? "";
  const providers = Object.entries(campaign?.providerAllocation ?? {})
    .filter(([, percent]) => percent > 0)
    .map(([provider, percent]) => `${provider} ${percent}%`);

  return (
    <header className="rounded-xl border border-border bg-surface shadow-xs">
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-col gap-2">
            <Link
              href="/campaigns"
              className="inline-flex w-fit items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              All campaigns
            </Link>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="min-w-0 text-[21px] font-semibold leading-tight tracking-tight text-foreground sm:text-[24px]">
                {campaign?.name ?? (error ? "Campaign unavailable" : "Loading campaign…")}
              </h1>
              {campaign ? (
                <StatusPill tone={STATUS_TONE[status] ?? "neutral"} pulse={status === "RUNNING"}>
                  {STATUS_LABEL[status] ?? status}
                </StatusPill>
              ) : error ? (
                <StatusPill tone="danger">Error</StatusPill>
              ) : (
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
              )}
            </div>
            <p className="font-mono text-[11px] text-subtle-foreground">
              {error ?? campaign?.id ?? campaignId}
            </p>
          </div>

          {campaign ? (
            <div className="flex shrink-0 gap-2">
              <div className="rounded-lg border border-border bg-surface-hover/40 px-3.5 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle-foreground">
                  Contacts
                </p>
                <p className="font-mono text-[18px] font-semibold leading-tight tabular-nums text-foreground">
                  {campaign.totalContacts}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-surface-hover/40 px-3.5 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle-foreground">
                  Calls placed
                </p>
                <p className="font-mono text-[18px] font-semibold leading-tight tabular-nums text-foreground">
                  {data?.callsPlaced ?? 0}
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {campaign ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-6">
            <MetaChip label="Campaign type" value={campaign.campaignType} />
            <MetaChip label="Script" value={`${campaign.scriptId} ${campaign.scriptVersion}`} mono />
            <MetaChip label="Language" value={campaign.language} />
            <MetaChip label="Telephony" value={campaign.telephonyProvider} />
            <MetaChip
              label="Voice providers"
              value={providers.length > 0 ? providers.join(" · ") : "—"}
            />
            <MetaChip
              label="Pilot stage"
              value={`Stage ${campaign.pilotStage}`}
            />
          </div>
        ) : null}
      </div>
    </header>
  );
}
