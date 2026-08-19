"use client";

/**
 * campaign-list.tsx
 *
 * Campaign setup, plus the list of campaigns already set up. Built on
 * the existing `ui/` primitives — the voice-agent dashboard at "/" is
 * not imported, modified, or re-styled by anything here.
 *
 * The form is organised as the four decisions an operator actually
 * makes, in the order they make them: what this campaign IS, who says
 * it, which words are said, and how the contacts are split between the
 * providers being compared. Each one is its own labelled block with the
 * consequence of the choice stated next to it, because every field here
 * ends up in a phone call to a real person.
 *
 * Presentation only. Every field, every request body and the
 * idempotency key are exactly what they were.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Check, Loader2, Plus, Scale } from "lucide-react";

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

/** As returned by `describeScript` on the campaigns endpoint. */
interface ScriptSummary {
  id: string;
  version: string;
  campaignType: string;
  label: string;
  hash: string;
  requiresName: boolean;
  isPlaceholder: boolean;
  variables: string[];
}

const PROVIDER_LABEL: Record<string, string> = {
  cartesia: "Cartesia",
  sarvam: "Sarvam",
  "smallest-ai": "Smallest AI",
};

/** Neutral shades rather than a new palette — the bar shows proportion, not identity. */
const PROVIDER_BAR: Record<string, string> = {
  cartesia: "bg-foreground/75",
  sarvam: "bg-foreground/50",
  "smallest-ai": "bg-foreground/25",
};

/** Even thirds that still total exactly 100. */
const DEFAULT_PERCENTS: Record<string, number> = {
  cartesia: 33.34,
  sarvam: 33.33,
  "smallest-ai": 33.33,
};

const CAMPAIGN_TYPE_COPY: Record<CampaignType, { title: string; detail: string }> = {
  registration: {
    title: "Registration",
    detail: "Invites someone who has not signed up. Retried until they accept or decline.",
  },
  reminder: {
    title: "Reminder",
    detail: "Calls someone already registered so they attend. One pass, not a sales retry cycle.",
  },
};

export function CampaignList() {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<CampaignSummary | undefined>();

  const [name, setName] = useState("");
  const [campaignType, setCampaignType] = useState<CampaignType>("registration");
  const [language, setLanguage] = useState("en");
  const [scriptKey, setScriptKey] = useState<string | undefined>();
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
      setScripts(json.scripts ?? []);
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

  const scriptsForType = useMemo(
    () => scripts.filter((script) => script.campaignType === campaignType),
    [scripts, campaignType],
  );

  // The first script registered for a type is the one the server picks
  // when none is sent, so the default selection here resolves to the
  // same script rather than to a different one.
  const selectedScript = useMemo(() => {
    const match = scriptsForType.find((script) => `${script.id}:${script.version}` === scriptKey);
    return match ?? scriptsForType[0];
  }, [scriptsForType, scriptKey]);

  const total = useMemo(
    () => Object.values(percents).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0),
    [percents],
  );
  const totalIsValid = Math.abs(total - 100) < 1e-6;
  const nameIsValid = name.trim().length > 0;
  const canCreate = !creating && nameIsValid && totalIsValid;

  const create = useCallback(async () => {
    setCreating(true);
    setError(undefined);
    setCreated(undefined);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          campaignType,
          language,
          providerAllocation: percents,
          // The endpoint already accepts these and falls back to the
          // default script for the type when they are absent; sending
          // the selection explicitly makes the choice visible without
          // changing what gets created.
          ...(selectedScript ? { scriptId: selectedScript.id, scriptVersion: selectedScript.version } : {}),
          // Derived from the campaign's own identity rather than a
          // fresh random value, so a double-submit or a refreshed
          // form resolves to the same campaign instead of a second one.
          idempotencyKey: `ui:${campaignType}:${name.trim().toLowerCase()}`,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not create the campaign.");
      setCreated(json.campaign as CampaignSummary);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [campaignType, language, load, name, percents, selectedScript]);

  return (
    <div className="flex flex-col gap-6">
      <NoCallsBanner />

      <Card>
        <CardHeader>
          <CardTitle>Create campaign</CardTitle>
          <CardDescription>
            Sets up a campaign and its provider split. No contact is imported and no call is placed by
            this step — both come after it.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {/* ── 1. What this campaign is ───────────────────────────── */}
          <FormSection
            step={1}
            title="Campaign"
            hint="The name is for you; the type decides how the calls behave."
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="campaign-name">Campaign name</Label>
                <Input
                  id="campaign-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="October registration drive"
                  aria-invalid={!nameIsValid && name.length > 0}
                  aria-describedby="campaign-name-hint"
                />
                <p id="campaign-name-hint" className="text-[11px] text-muted-foreground">
                  Used as the idempotency key with the type, so re-submitting this form opens the same
                  campaign rather than creating a second one.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Campaign type</Label>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Campaign type">
                  {(["registration", "reminder"] as const).map((type) => {
                    const active = campaignType === type;
                    return (
                      <button
                        key={type}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => {
                          setCampaignType(type);
                          setScriptKey(undefined);
                        }}
                        className={`flex flex-col gap-1 rounded-lg border p-3 text-left ${
                          active
                            ? "border-foreground/40 bg-muted/60 ring-1 ring-foreground/15"
                            : "bg-background hover:bg-muted/40"
                        }`}
                      >
                        <span className="flex items-center gap-1.5 text-[13px] font-medium">
                          {active ? <Check className="size-3.5" aria-hidden /> : null}
                          {CAMPAIGN_TYPE_COPY[type].title}
                        </span>
                        <span className="text-[11px] leading-relaxed text-muted-foreground">
                          {CAMPAIGN_TYPE_COPY[type].detail}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </FormSection>

          <Separator />

          {/* ── 2. Who speaks ──────────────────────────────────────── */}
          <FormSection
            step={2}
            title="Voice and language"
            hint="The agent name is derived from each provider's configured voice and cannot be set here."
          >
            <div className="grid gap-4 lg:grid-cols-2">
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
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Opening language only. The agent still follows the caller into Hindi, English or
                  Hinglish exactly as it does today.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Agent per provider</Label>
                <div className="flex flex-col divide-y rounded-lg border">
                  {[...agents].map(([provider, agent]) => (
                    <div key={provider} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-[12px]">{PROVIDER_LABEL[provider] ?? provider}</span>
                      <span className="font-mono text-[12px] font-semibold">{agent.name}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Each name follows the gender of that provider&apos;s voice, so the voice and the name
                  always match.
                </p>
              </div>
            </div>
          </FormSection>

          <Separator />

          {/* ── 3. Which words ─────────────────────────────────────── */}
          <FormSection
            step={3}
            title="Script"
            hint="Approved wording, pinned by content hash to every campaign that runs it."
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label>Script version</Label>
                {scriptsForType.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-3 py-4">
                    <p className="text-[12px] text-muted-foreground">
                      {loading
                        ? "Loading the script registry…"
                        : `No script is registered for ${campaignType} campaigns.`}
                    </p>
                  </div>
                ) : (
                  <Select
                    {...(selectedScript
                      ? { value: `${selectedScript.id}:${selectedScript.version}` }
                      : {})}
                    onValueChange={setScriptKey}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {scriptsForType.map((script) => (
                        <SelectItem key={`${script.id}:${script.version}`} value={`${script.id}:${script.version}`}>
                          {script.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Editing a script&apos;s text changes its hash, so a new wording is published as a new
                  version rather than applied to campaigns that already ran.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Selected script</Label>
                {selectedScript ? (
                  <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium">{selectedScript.label}</span>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {selectedScript.id} {selectedScript.version}
                      </Badge>
                      {selectedScript.isPlaceholder ? (
                        <Badge variant="outline" className="text-[10px] text-amber-600">
                          placeholder — blocks READY
                        </Badge>
                      ) : null}
                    </div>
                    <p className="font-mono text-[11px] break-all text-muted-foreground">
                      hash {selectedScript.hash.slice(0, 16)}…
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedScript.variables.map((variable) => (
                        <Badge key={variable} variant="outline" className="font-mono text-[10px]">
                          {`{{${variable}}}`}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {selectedScript.requiresName
                        ? "Every contact must have a name: the script speaks it, so a nameless row is rejected at import."
                        : "This script does not speak the contact's name."}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed px-3 py-4">
                    <p className="text-[12px] text-muted-foreground">
                      Nothing selected yet — the details of the script appear here.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </FormSection>

          <Separator />

          {/* ── 4. How the contacts are split ──────────────────────── */}
          <FormSection
            step={4}
            title="Provider allocation"
            hint="Percentages, never counts. A contact is locked to its provider for every attempt it ever gets."
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`font-mono text-[12px] ${totalIsValid ? "text-muted-foreground" : "text-destructive"}`}
                  >
                    {total.toFixed(2)}%
                  </span>
                  {totalIsValid ? (
                    <Badge variant="outline" className="text-[10px]">
                      totals 100%
                    </Badge>
                  ) : (
                    <span className="text-[12px] text-destructive">must total exactly 100%</span>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setPercents(DEFAULT_PERCENTS)}
                  disabled={creating}
                >
                  <Scale className="size-4" aria-hidden />
                  Even split
                </Button>
              </div>

              {/* Proportion, at a glance. Static widths, no animation. */}
              <div
                className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={CAMPAIGN_TTS_PROVIDERS.map(
                  (provider) => `${PROVIDER_LABEL[provider] ?? provider} ${(percents[provider] ?? 0).toFixed(2)}%`,
                ).join(", ")}
              >
                {CAMPAIGN_TTS_PROVIDERS.map((provider) => {
                  const share = Math.max(0, Math.min(100, percents[provider] ?? 0));
                  return share > 0 ? (
                    <span
                      key={provider}
                      className={PROVIDER_BAR[provider] ?? "bg-foreground/40"}
                      style={{ width: `${share}%` }}
                    />
                  ) : null;
                })}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {CAMPAIGN_TTS_PROVIDERS.map((provider) => (
                  <div key={provider} className="flex flex-col gap-1.5 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <span className={`size-2 rounded-full ${PROVIDER_BAR[provider] ?? "bg-foreground/40"}`} aria-hidden />
                      <Label htmlFor={`pct-${provider}`} className="text-[12px]">
                        {PROVIDER_LABEL[provider] ?? provider}
                      </Label>
                    </div>
                    <Input
                      id={`pct-${provider}`}
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      inputMode="decimal"
                      className="font-mono"
                      value={percents[provider] ?? 0}
                      aria-invalid={!totalIsValid}
                      onChange={(e) =>
                        setPercents((prev) => ({ ...prev, [provider]: Number(e.target.value) }))
                      }
                    />
                  </div>
                ))}
              </div>

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Exact contact counts are computed by largest-remainder apportionment at import time, so
                they always sum to the imported total for any list size.
              </p>
            </div>
          </FormSection>

          {/* ── Validation, result, and the primary action ──────────── */}
          {error ? (
            <div
              className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <p className="text-[12px] leading-relaxed">{error}</p>
            </div>
          ) : null}

          {created ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="flex min-w-0 flex-col">
                  <p className="truncate text-[13px] font-medium">{created.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    Created as {created.status}. Import contacts next — no call is placed until a run is
                    started.
                  </p>
                </div>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/campaigns/${created.id}`}>
                  Open campaign
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
            </div>
          ) : null}

          <Separator />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {nameIsValid
                ? `${CAMPAIGN_TYPE_COPY[campaignType].title} · ${language === "hi" ? "Hindi" : "English"} · ${
                    selectedScript ? `${selectedScript.id} ${selectedScript.version}` : "no script"
                  } · ${CAMPAIGN_TTS_PROVIDERS.length}-provider split`
                : "Give the campaign a name to continue."}
            </p>
            <Button onClick={() => void create()} disabled={!canCreate}>
              {creating ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
              {creating ? "Creating…" : "Create campaign"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Campaigns</CardTitle>
          <CardDescription>
            {loading ? "Loading…" : `${campaigns.length} campaign(s)`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 py-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading campaigns…
            </div>
          ) : campaigns.length === 0 ? (
            <div className="flex flex-col items-start gap-1 rounded-lg border border-dashed px-4 py-6">
              <p className="text-[13px] font-medium">No campaigns yet</p>
              <p className="text-[12px] text-muted-foreground">
                Create one above, then import a CSV of contacts. Nothing dials until a run is started.
              </p>
            </div>
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

/** One numbered block of the form. Keeps the hierarchy visible on a long page. */
function FormSection({
  step,
  title,
  hint,
  children,
}: {
  step: number;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] text-muted-foreground"
          aria-hidden
        >
          {step}
        </span>
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
        </div>
      </div>
      <div className="sm:pl-8">{children}</div>
    </section>
  );
}
