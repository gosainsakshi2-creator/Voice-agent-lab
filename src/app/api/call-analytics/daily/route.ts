import { NextResponse } from "next/server";

import { AnalyticsFilterError, DENOMINATOR_NOTE, dailyCallAnalytics, parseFilters } from "@/campaign/analytics";

export const dynamic = "force-dynamic";

/**
 * Per-day aggregates over the SAME filtered call records as the table.
 * Days are read in `tz`. Every percentage's denominator is returned with
 * the rows so the screen can quote it rather than imply it.
 */
export async function GET(request: Request) {
  try {
    const filters = parseFilters(new URL(request.url).searchParams);
    const days = await dailyCallAnalytics(filters);
    return NextResponse.json({ filters, days, denominators: DENOMINATOR_NOTE });
  } catch (error) {
    const status = error instanceof AnalyticsFilterError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
