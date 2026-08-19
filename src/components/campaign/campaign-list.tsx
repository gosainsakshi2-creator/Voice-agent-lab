"use client";

/**
 * campaign-list.tsx
 *
 * Campaign list plus the create form. Built on the existing `ui/`
 * primitives — the voice-agent dashboard at "/" is not imported,
 * modified, or re-styled by anything here.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NoCallsBanner } from "@/components/campaign/no-calls-banner";
import { CAMPAIGN_TTS_PROVIDERS, type CampaignType } from "@/campaign/domain/campaign-types";
import { agentsByProvider } from "@/campaign/script/agent-identity";

interface CampaignSummary {
  id: string;
  name: string;
  campaignType: string;
  status: string;
  totalContacts: number;
  scriptId: string;
  scriptVersion: string;
  createdAt: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  cartesia: "Cartesia",
  sarvam: "Sarvam",
  "smallest-ai": "Smallest AI",
};

/** Even thirds that still total exactly 100. */
const DEFAULT_PERCENTS: Record<string, number> = {
  cartesia: 33.34,
  sarvam: 33.33,
  "smallest-ai": 33.33,
};

export function CampaignList() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const [name, setName] = useState("");
  const [campaignType, setCampaignType] = useState<CampaignType>("registration");
  const [language, setLanguage] = useState("en");
  const [percents, setPercents] = useState<Record<string, number>>(DEFAULT_PERCENTS);
  // Derived, not chosen: each provider's agent name follows the gender
  // of its already-configured voice, so the voice and the name always
  // agree. Same resolver the server uses.
  const agents = useMemo(() => agentsByProvider([...CAMPAIGN_TTS_PROVIDERS]), []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/campaigns");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load campaigns.");
      setCampaigns(json.campaigns ?? []);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const total = useMemo(
    () => Object.values(percents).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0),
    [percents],
  );
  const totalIsValid = Math.abs(total - 100) < 1e-6;

  const create = useCallback(async () => {
    setCreating(true);
    setError(undefined);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          campaignType,
          language,
          providerAllocation: percents,
          // Derived from the campaign's own identity rather than a
          // fresh random value, so a double-submit or a refreshed
          // form resolves to the same campaign instead of a second one.
          idempotencyKey: `ui:${campaignType}:${name.trim().toLowerCase()}`,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not create the campaign.");
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [campaignType, language, load, name, percents]);

  return (
    <div className="flex flex-col gap-6">
      <NoCallsBanner />

      <Card>
        <CardHeader>
          <CardTitle>Create campaign</CardTitle>
          <CardDescription>
            Sets up a campaign and its provider split. Contacts are imported in the next step.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="campaign-name">Campaign name</Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="October registration drive"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Campaign type</Label>
              <Select value={campaignType} onValueChange={(v) => setCampaignType(v as CampaignType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="registration">Registration</SelectItem>
                  <SelectItem value="reminder">Reminder</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label>Conversation language</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="hi">Hindi</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Opening language only. The agent still follows the caller into Hindi, English or
                Hinglish exactly as it does today.
              </p>
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label>Agent</Label>
              <div className="flex flex-wrap gap-2">
                {[...agents].map(([provider, agent]) => (
                  <span
                    key={provider}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-[12px]"
                  >
                    {PROVIDER_LABEL[provider] ?? provider}
                    <span aria-hidden>&rarr;</span>
                    <b className="font-semibold">{agent.name}</b>
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Each agent name follows the gender of that provider&apos;s configured voice, so the
                voice and the name always match. Script: {campaignType} v1.
              </p>
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
                Provider allocation
              </p>
              <p
                className={`font-mono text-[12px] ${totalIsValid ? "text-muted-foreground" : "text-destructive"}`}
              >
                {total.toFixed(2)}% {totalIsValid ? "" : "— must total 100%"}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {CAMPAIGN_TTS_PROVIDERS.map((provider) => (
                <div key={provider} className="flex flex-col gap-1.5">
                  <Label htmlFor={`pct-${provider}`}>{PROVIDER_LABEL[provider] ?? provider}</Label>
                  <Input
                    id={`pct-${provider}`}
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    className="font-mono"
                    value={percents[provider] ?? 0}
                    onChange={(e) =>
                      setPercents((prev) => ({ ...prev, [provider]: Number(e.target.value) }))
                    }
                  />
                </div>
              ))}
            </div>
            <p className="text-[12px] text-muted-foreground">
              Exact contact counts are computed by largest-remainder apportionment at import time, so
              they always sum to the imported total for any list size.
            </p>
          </div>

          {error ? (
            <p className="text-[12px] text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <Button
            onClick={() => void create()}
            disabled={creating || name.trim().length === 0 || !totalIsValid}
            className="sm:w-fit"
          >
            {creating ? <Loader2 className="animate-spin" /> : <Plus />}
            Create campaign
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Campaigns</CardTitle>
          <CardDescription>{campaigns.length} campaign(s)</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-[13px] text-muted-foreground">Loading…</p>
          ) : campaigns.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No campaigns yet. Create one above, then import a CSV.
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {campaigns.map((campaign) => (
                <li key={campaign.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <Link
                      href={`/campaigns/${campaign.id}`}
                      className="truncate text-[14px] font-medium hover:underline"
                    >
                      {campaign.name}
                    </Link>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {campaign.campaignType} · {campaign.scriptId} {campaign.scriptVersion} ·{" "}
                      {campaign.totalContacts} contacts
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline">{campaign.status}</Badge>
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/campaigns/${campaign.id}`}>Open</Link>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
