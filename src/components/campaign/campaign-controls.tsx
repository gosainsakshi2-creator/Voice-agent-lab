"use client";

/**
 * campaign-controls.tsx
 *
 * Start, pause, resume, stop — and the two limits that decide how many
 * people a run may reach.
 *
 * The panel is built around one idea: an operator must never have to
 * guess what the system is about to do. So it shows the kill switch,
 * the resolved call ceiling AND which of the three limits produced it,
 * the stored control state (which survives a restart, unlike the
 * dispatcher), and the last few events — before any button is pressed.
 *
 * The presentation puts the plain-language state first and the
 * environment-variable-level detail one fold down; the facts are the
 * same, but "dialing is disabled" is a state, not a headline to shout.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleStop, Loader2, Pause, Play, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Callout, GroupLabel, Note, StatCard, StatusPill, type Tone } from "@/components/campaign/ui";

interface Ceiling {
  effective: number;
  boundBy: "environment" | "pilot-stage" | "campaign-control";
  environmentMax: number;
  pilotStage: number;
  pilotStageMax: number | null;
  campaignControlMax: number | null;
}

interface Control {
  desiredState: "RUN" | "PAUSE" | "STOP";
  maxCallsThisRun: number | null;
  revision: number;
  requestedBy: string;
  reason: string | null;
  requestedAt: string;
}

interface DispatcherStatus {
  state: string;
  dialingEnabled: boolean;
  callsPlacedThisRun: number;
  stageMaxCalls: number;
  lanes: Record<string, { active: number; placed: number; available: number }>;
}

interface ProgressPayload {
  progress: { byStatus: Record<string, number>; attempts: number };
  dispatcher: DispatcherStatus | null;
  running: boolean;
}

interface StagePayload {
  ladder: (number | null)[];
  pilotStage: number;
  ceiling: Ceiling;
  control: Control;
}

const BOUND_BY_LABEL: Record<Ceiling["boundBy"], string> = {
  environment: "CAMPAIGN_STAGE_MAX_CALLS",
  "pilot-stage": "the pilot stage",
  "campaign-control": "this campaign's ceiling",
};

/** The same three limits, named the way an operator would name them. */
const BOUND_BY_SHORT: Record<Ceiling["boundBy"], string> = {
  environment: "Environment",
  "pilot-stage": "Pilot stage",
  "campaign-control": "Campaign ceiling",
};

const CONTROL_TONE: Record<Control["desiredState"], Tone> = {
  RUN: "success",
  PAUSE: "warning",
  STOP: "danger",
};

const CONTROL_LABEL: Record<Control["desiredState"], string> = {
  RUN: "Run",
  PAUSE: "Paused",
  STOP: "Stopped",
};

export function CampaignControls({ campaignId }: { campaignId: string }) {
  const [stage, setStage] = useState<StagePayload | undefined>();
  const [progress, setProgress] = useState<ProgressPayload | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [ceilingDraft, setCeilingDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const [stageRes, progressRes] = await Promise.all([
        fetch(`/api/campaigns/${campaignId}/stage`),
        fetch(`/api/campaigns/${campaignId}/progress`),
      ]);
      const stageJson = (await stageRes.json()) as StagePayload & { error?: string };
      const progressJson = (await progressRes.json()) as ProgressPayload & { error?: string };
      if (!stageRes.ok) throw new Error(stageJson.error ?? "Could not read the campaign controls.");
      setStage(stageJson);
      if (progressRes.ok) setProgress(progressJson);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while a dispatcher is actually running. A finished
  // campaign does not need to be re-fetched every three seconds.
  useEffect(() => {
    if (!progress?.running) return;
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [progress?.running, load]);

  const act = useCallback(
    async (action: "start" | "pause" | "resume" | "stop") => {
      setBusy(action);
      setError(undefined);
      setNote(undefined);
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/${action}`, { method: "POST" });
        const json = (await res.json()) as { error?: string; note?: string; blockers?: string[] };
        if (!res.ok) {
          throw new Error(
            json.blockers?.length ? `${json.error}\n• ${json.blockers.join("\n• ")}` : (json.error ?? "Request failed."),
          );
        }
        setNote(json.note);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(undefined);
      }
    },
    [campaignId, load],
  );

  const saveLimits = useCallback(
    async (body: { stage?: number; maxCallsThisRun?: number | null }) => {
      setBusy("limits");
      setError(undefined);
      setNote(undefined);
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/stage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as { error?: string; note?: string };
        if (!res.ok) throw new Error(json.error ?? "Could not update the limits.");
        setNote(json.note);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(undefined);
      }
    },
    [campaignId, load],
  );

  const dialingEnabled = progress?.dispatcher?.dialingEnabled ?? false;
  const running = progress?.running ?? false;
  const control = stage?.control;
  const ceiling = stage?.ceiling;

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <CardTitle className="text-[13.5px]">Run controls</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {control ? (
              <StatusPill tone={CONTROL_TONE[control.desiredState]}>
                {CONTROL_LABEL[control.desiredState]}
                <span className="text-subtle-foreground">
                  {control.revision > 0 ? `rev ${control.revision}` : "default"}
                </span>
              </StatusPill>
            ) : null}
            <StatusPill tone={running ? "info" : "neutral"} pulse={running}>
              {running ? `Dispatcher ${progress?.dispatcher?.state ?? "RUNNING"}` : "Dispatcher idle"}
            </StatusPill>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* The kill switch, stated before any button — as a state, not a banner. */}
        {dialingEnabled ? (
          <Callout tone="danger" title="Dialing is live — starting places real calls">
            At most {ceiling?.effective ?? "?"} call(s) may be placed in the next run.
          </Callout>
        ) : (
          <Callout tone="warning" title="Dialing is currently disabled">
            Enable campaign dialing to place real calls.
          </Callout>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy !== undefined || running} onClick={() => void act("start")}>
            {busy === "start" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Start run
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => void act("pause")}>
            {busy === "pause" ? <Loader2 className="size-4 animate-spin" /> : <Pause className="size-4" />}
            Pause
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== undefined || running} onClick={() => void act("resume")}>
            {busy === "resume" ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            Resume
          </Button>
          <Button size="sm" variant="destructive" disabled={busy !== undefined} onClick={() => void act("stop")}>
            {busy === "stop" ? <Loader2 className="size-4 animate-spin" /> : <CircleStop className="size-4" />}
            Stop
          </Button>
        </div>

        {note ? <p className="text-[12px] text-muted-foreground">{note}</p> : null}
        {error ? (
          <p className="whitespace-pre-line text-[12px] text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <Note summary="How the controls behave">
          <p>
            Pause and stop are stored in the database, so they hold even if the process running the campaign is
            not the one that received the request, and they never cut off a call that is already connected — they
            stop new ones being claimed.
          </p>
          {dialingEnabled ? null : (
            <p>
              <span className="font-mono text-[11px] text-foreground">CAMPAIGN_DIALING_ENABLED</span> is not true.
              Starting rehearses every step — claiming, attempt rows, script and agent resolution — and stops
              before any session is created, so no telephony provider is contacted.
            </p>
          )}
        </Note>

        {/* The ceiling, and which limit produced it. */}
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <GroupLabel>Run limits</GroupLabel>

          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[11px] text-muted-foreground">Pilot stage</Label>
              <Select
                value={String(stage?.pilotStage ?? 0)}
                onValueChange={(value) => void saveLimits({ stage: Number(value) })}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(stage?.ladder ?? []).map((rung, index) => (
                    <SelectItem key={index} value={String(index)}>
                      {`Stage ${index} — ${rung === null ? "full list" : `${rung} calls`}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[11px] text-muted-foreground" htmlFor="campaign-ceiling">
                This campaign&apos;s ceiling
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="campaign-ceiling"
                  className="w-[120px]"
                  inputMode="numeric"
                  placeholder={control?.maxCallsThisRun === null ? "none" : String(control?.maxCallsThisRun ?? "")}
                  value={ceilingDraft}
                  onChange={(event) => setCeilingDraft(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== undefined}
                  onClick={() =>
                    void saveLimits({
                      maxCallsThisRun: ceilingDraft.trim() === "" ? null : Number(ceilingDraft.trim()),
                    })
                  }
                >
                  {ceilingDraft.trim() === "" ? "Clear" : "Set"}
                </Button>
              </div>
            </div>
          </div>

          {ceiling ? (
            <>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <StatCard
                  label="Next run ceiling"
                  value={ceiling.effective}
                  hint={`bound by ${BOUND_BY_SHORT[ceiling.boundBy].toLowerCase()}`}
                  tone="info"
                />
                <StatCard label="Environment max" value={ceiling.environmentMax} />
                <StatCard
                  label={`Stage ${ceiling.pilotStage} allows`}
                  value={ceiling.pilotStageMax === null ? "Full list" : ceiling.pilotStageMax}
                />
                <StatCard
                  label="Campaign ceiling"
                  value={ceiling.campaignControlMax ?? "None"}
                />
              </div>
              <Note summary="How the ceiling is resolved">
                <p>
                  The next run may place at most{" "}
                  <span className="font-semibold text-foreground">{ceiling.effective}</span> call(s), bound by{" "}
                  <span className="font-medium text-foreground">{BOUND_BY_LABEL[ceiling.boundBy]}</span>.
                  Environment ceiling {ceiling.environmentMax}; stage {ceiling.pilotStage} allows{" "}
                  {ceiling.pilotStageMax === null ? "the full list" : ceiling.pilotStageMax}; campaign ceiling{" "}
                  {ceiling.campaignControlMax ?? "none"}. The smallest always wins, and a limit changed now
                  applies to the next run rather than one already in progress.
                </p>
              </Note>
            </>
          ) : null}
        </div>

        {progress?.dispatcher ? (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <GroupLabel>Lanes this run</GroupLabel>
              <span className="text-[11px] text-muted-foreground">
                <span className="font-mono font-medium tabular-nums text-foreground">
                  {progress.dispatcher.callsPlacedThisRun}
                </span>{" "}
                of at most{" "}
                <span className="font-mono font-medium tabular-nums text-foreground">
                  {progress.dispatcher.stageMaxCalls}
                </span>{" "}
                call(s) started
              </span>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(progress.dispatcher.lanes).map(([provider, lane]) => (
                <div
                  key={provider}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-hover/40 px-3.5 py-2.5"
                >
                  <p className="text-[12.5px] font-medium text-foreground">{provider}</p>
                  <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {lane.active} active · {lane.placed} placed · {lane.available} free
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
