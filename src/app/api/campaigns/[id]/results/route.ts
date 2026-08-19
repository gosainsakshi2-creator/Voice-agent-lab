import { NextResponse } from "next/server";

import { buildCampaignResults } from "@/campaign/results/campaign-results";
import { getControl, recentEvents } from "@/campaign/db/repositories/control.repo";
import { getDispatcher } from "@/campaign/dispatch/dispatcher";

export const dynamic = "force-dynamic";

/**
 * The campaign's results: funnel, per-provider comparison, outcomes,
 * and the two metric families kept apart.
 *
 * Strictly read-only. Building a report cannot start, stop or affect a
 * campaign, and places no calls.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const results = await buildCampaignResults(id);
    if (!results) return NextResponse.json({ error: "Campaign not found." }, { status: 404 });

    const [control, events] = await Promise.all([getControl(id), recentEvents(id, 20)]);
    const dispatcher = getDispatcher(id);

    return NextResponse.json({
      results,
      control,
      events,
      dispatcher: dispatcher ? dispatcher.getStatus() : null,
      running: dispatcher !== undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
