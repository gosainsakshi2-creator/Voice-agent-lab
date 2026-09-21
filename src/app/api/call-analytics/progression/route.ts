import { NextResponse } from "next/server";

import { AnalyticsFilterError, parseFilters, progressionReport } from "@/campaign/analytics";

export const dynamic = "force-dynamic";

/**
 * First-vs-latest duration-bucket movement per phone number, over the
 * scope filters (date, campaign, search). Registrations among the same
 * people are returned separately and never inferred from the movement.
 */
export async function GET(request: Request) {
  try {
    const filters = parseFilters(new URL(request.url).searchParams);
    const report = await progressionReport(filters);
    return NextResponse.json({ filters, report });
  } catch (error) {
    const status = error instanceof AnalyticsFilterError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
