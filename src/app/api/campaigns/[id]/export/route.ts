import { exportAttemptsCsv, exportProvidersCsv } from "@/campaign/results/export-csv";

export const dynamic = "force-dynamic";

/**
 * CSV export: `?kind=attempts` (one row per call) or `?kind=providers`
 * (one row per provider — the comparison).
 *
 * Voice and orchestration columns are prefixed and are read from their
 * own tables by their own queries, so no cell in either file mixes a
 * conversation measurement with a dispatcher one.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const kind = new URL(request.url).searchParams.get("kind") ?? "attempts";

  if (kind !== "attempts" && kind !== "providers") {
    return Response.json({ error: `Unknown export kind "${kind}".` }, { status: 400 });
  }

  try {
    const csv = kind === "providers" ? await exportProvidersCsv(id) : await exportAttemptsCsv(id);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="campaign-${id}-${kind}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
