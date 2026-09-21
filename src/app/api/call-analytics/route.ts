import { NextResponse } from "next/server";

import {
  AnalyticsFilterError,
  DENOMINATOR_NOTE,
  MAX_PAGE_SIZE,
  countCallRecords,
  listCallRecords,
  parseFilters,
  summarizeCallRecords,
} from "@/campaign/analytics";

export const dynamic = "force-dynamic";

/**
 * The call-analytics table and its summary tiles, from ONE filter.
 *
 * Query string: from, to (YYYY-MM-DD), tz, campaignId, status, response,
 * bucket, outcome, q, limit, offset. Summary and page are computed with
 * the same predicate, so the tiles always describe the rows below them.
 * Read-only; touches nothing the voice agent uses.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 25) || 25, MAX_PAGE_SIZE);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);

  try {
    const filters = parseFilters(url.searchParams);
    const [records, total, summary] = await Promise.all([
      listCallRecords(filters, limit, offset),
      countCallRecords(filters),
      summarizeCallRecords(filters),
    ]);
    return NextResponse.json({ filters, records, total, limit, offset, summary, denominators: DENOMINATOR_NOTE });
  } catch (error) {
    const status = error instanceof AnalyticsFilterError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
