import { NextResponse } from "next/server";

import { buildProductionReadiness } from "@/campaign/production-readiness";

export const dynamic = "force-dynamic";

/**
 * The production-readiness report for one campaign, including the
 * deployment-wide checks it depends on.
 *
 * Strictly read-only. It places no calls, contacts no vendor, and never
 * sets CAMPAIGN_DIALING_ENABLED. Distinct from `/preflight`, which
 * answers whether this campaign's DATA is ready; this answers whether
 * the deployment around it can actually place a call.
 *
 * Returns 200 with the report whatever the verdict — a BLOCKED readiness
 * report is a successful answer to the question, not a failed request.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const readiness = await buildProductionReadiness({ campaignId: id });
    return NextResponse.json({ readiness });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
