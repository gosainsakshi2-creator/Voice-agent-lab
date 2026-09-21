import { AnalyticsFilterError, exportCallAnalyticsCsv, exportFilename, parseFilters } from "@/campaign/analytics";

export const dynamic = "force-dynamic";

/**
 * ONE CSV export, shaped by the same query string as the table. No
 * filters → every call record; `response=YES` → only the YES rows;
 * `status=NO_ANSWER` → only the No Answer rows; and so on. Nothing is
 * written to disk. Two response headers say how many rows came back and
 * whether the row cap cut the file short.
 */
export async function GET(request: Request) {
  try {
    const filters = parseFilters(new URL(request.url).searchParams);
    const { csv, rows, capped } = await exportCallAnalyticsCsv(filters);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(filters)}"`,
        "Cache-Control": "no-store",
        "X-Export-Rows": String(rows),
        "X-Export-Capped": capped ? "true" : "false",
      },
    });
  } catch (error) {
    const status = error instanceof AnalyticsFilterError ? 400 : 500;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
