import { NextResponse } from "next/server";

import { getCampaign } from "@/campaign/db/repositories/campaign.repo";
import { getControl, setControl, setPilotStage } from "@/campaign/db/repositories/control.repo";
import { getDispatchConfig } from "@/campaign/config/dispatch.config";
import { describeCallCeiling, isPilotStage, MAX_PILOT_STAGE, PILOT_LADDER } from "@/campaign/domain/pilot-stage";

export const dynamic = "force-dynamic";

/**
 * The pilot ladder, and the per-campaign call ceiling.
 *
 * Changing either one affects the NEXT run. A run already in progress
 * keeps the ceiling it started with — a limit that could be raised
 * underneath a running campaign is not a limit.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const campaign = await getCampaign(id);
    if (!campaign) return NextResponse.json({ error: "Campaign not found." }, { status: 404 });
    const control = await getControl(id);
    const config = getDispatchConfig();

    return NextResponse.json({
      ladder: PILOT_LADDER,
      pilotStage: campaign.pilotStage,
      ceiling: describeCallCeiling({
        environmentMax: config.stageMaxCalls,
        pilotStage: campaign.pilotStage,
        campaignControlMax: control.maxCallsThisRun,
      }),
      control,
    });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: { stage?: number; maxCallsThisRun?: number | null };
  try {
    body = (await request.json()) as { stage?: number; maxCallsThisRun?: number | null };
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const campaign = await getCampaign(id);
    if (!campaign) return NextResponse.json({ error: "Campaign not found." }, { status: 404 });

    // Refused rather than clamped: a typo that silently became the top
    // of the ladder is the exact mistake the ladder exists to prevent.
    if (body.stage !== undefined && !isPilotStage(body.stage)) {
      return NextResponse.json(
        { error: `Pilot stage must be an integer from 0 to ${MAX_PILOT_STAGE}.` },
        { status: 400 },
      );
    }
    if (
      body.maxCallsThisRun !== undefined &&
      body.maxCallsThisRun !== null &&
      (!Number.isInteger(body.maxCallsThisRun) || body.maxCallsThisRun < 1)
    ) {
      return NextResponse.json(
        { error: "maxCallsThisRun must be a positive integer, or null to clear it." },
        { status: 400 },
      );
    }

    const pilotStage =
      body.stage !== undefined ? await setPilotStage(id, body.stage, "api:stage") : campaign.pilotStage;

    // Setting a ceiling does not change what the campaign is doing, so
    // the desired state is carried forward rather than reset.
    const existing = await getControl(id);
    const control =
      body.maxCallsThisRun !== undefined
        ? await setControl({
            campaignId: id,
            desiredState: existing.desiredState,
            requestedBy: "api:stage",
            reason: `Per-campaign call ceiling set to ${body.maxCallsThisRun ?? "none"}`,
            maxCallsThisRun: body.maxCallsThisRun,
          })
        : existing;

    const config = getDispatchConfig();
    const ceiling = describeCallCeiling({
      environmentMax: config.stageMaxCalls,
      pilotStage,
      campaignControlMax: control.maxCallsThisRun,
    });

    return NextResponse.json({
      pilotStage,
      control,
      ceiling,
      note:
        ceiling.boundBy === "environment" && ceiling.pilotStageMax !== null && ceiling.pilotStageMax > ceiling.effective
          ? `Stage ${pilotStage} allows ${ceiling.pilotStageMax} calls, but CAMPAIGN_STAGE_MAX_CALLS=${ceiling.environmentMax} is lower and binds. Raise the environment ceiling to use the full stage.`
          : `The next run may place at most ${ceiling.effective} call(s), bound by the ${ceiling.boundBy} limit.`,
    });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 400 });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
