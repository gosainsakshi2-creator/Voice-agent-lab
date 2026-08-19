import { NextResponse } from "next/server";

import { getRuntime } from "@/server/runtime";
import { launchCampaignRun } from "@/campaign/dispatch/run-launcher";
import { getDispatchConfig } from "@/campaign/config/dispatch.config";

export const dynamic = "force-dynamic";

/**
 * Starts the dispatcher for one campaign.
 *
 * The run is kicked off and this returns immediately — a campaign can
 * outlive any HTTP request. Progress is read from `/progress`, results
 * from `/results`.
 *
 * With `CAMPAIGN_DIALING_ENABLED` unset or false the whole pipeline
 * still runs — claiming, attempt rows, script and agent resolution —
 * but the call runner stops before a session is ever created, so no
 * telephony provider is contacted.
 *
 * The number of calls this run may place is the SMALLEST of the
 * environment ceiling, the campaign's pilot-ladder rung and any
 * per-campaign ceiling, and the response says which one bound so the
 * operator is never left wondering why a stage-3 campaign placed ten
 * calls.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = getDispatchConfig();

  try {
    const { manager } = getRuntime();
    const result = await launchCampaignRun({
      campaignId: id,
      manager: manager as never,
      requestedBy: "api:start",
      intent: "start",
      config,
    });

    if (!result.started) {
      const status = result.code === "NOT_FOUND" ? 404 : result.code === "ALREADY_RUNNING" ? 409 : 400;
      return NextResponse.json(
        { error: result.blockers[0] ?? "Campaign cannot run.", blockers: result.blockers },
        { status },
      );
    }

    return NextResponse.json({
      started: true,
      dialingEnabled: result.dialingEnabled,
      ceiling: result.ceiling,
      stageMaxCalls: result.ceiling.effective,
      status: result.status,
      note: result.dialingEnabled
        ? "Dialing is ENABLED — real calls will be placed."
        : "Dialing is disabled. The dispatcher will rehearse every step and place no calls.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
