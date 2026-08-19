import { NextResponse } from "next/server";

import { getRuntime } from "@/server/runtime";
import { launchCampaignRun } from "@/campaign/dispatch/run-launcher";

export const dynamic = "force-dynamic";

/**
 * Resume a paused or stopped campaign.
 *
 * A resume is a NEW run over whatever is still pending, not the old
 * run continuing: it goes through the same preflight, takes the same
 * dispatcher lock, and is bound by the same call ceiling. Contacts
 * that already completed are not re-dialled, because they are no
 * longer claimable — the claim query filters on status, and a finished
 * contact is not PENDING.
 *
 * Resuming also clears a stored PAUSE or STOP, because asking to
 * resume is an explicit instruction that supersedes the earlier one.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const { manager } = getRuntime();
    const result = await launchCampaignRun({
      campaignId: id,
      manager: manager as never,
      requestedBy: "api:resume",
      intent: "resume",
    });

    if (!result.started) {
      const status = result.code === "NOT_FOUND" ? 404 : result.code === "ALREADY_RUNNING" ? 409 : 400;
      return NextResponse.json(
        { error: result.blockers[0] ?? "Campaign cannot resume.", blockers: result.blockers },
        { status },
      );
    }

    return NextResponse.json({
      resumed: true,
      dialingEnabled: result.dialingEnabled,
      ceiling: result.ceiling,
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
