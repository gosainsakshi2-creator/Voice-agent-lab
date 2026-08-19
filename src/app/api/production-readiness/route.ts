import { NextResponse } from "next/server";

import { buildProductionReadiness } from "@/campaign/production-readiness";

export const dynamic = "force-dynamic";

/**
 * The deployment-wide production-readiness report: database, public URL,
 * HTTPS, the six vendor configurations, the load limits, the calling
 * window and the database guarantees. The four campaign-scoped checks
 * come back as SKIPPED, so `overall` is INCOMPLETE rather than PASS —
 * which is the honest answer to "is this environment ready" asked
 * without naming a campaign.
 *
 * Pass `?campaignId=` to include the campaign checks, or use
 * `/api/campaigns/{id}/production-readiness`.
 *
 * Read-only. Places no calls. Never enables dialing.
 */
export async function GET(request: Request) {
  const campaignId = new URL(request.url).searchParams.get("campaignId")?.trim();
  try {
    const readiness = await buildProductionReadiness(campaignId ? { campaignId } : {});
    return NextResponse.json({ readiness });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
