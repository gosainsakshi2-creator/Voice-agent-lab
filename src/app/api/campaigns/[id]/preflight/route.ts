import { NextResponse } from "next/server";

import { buildPreflight } from "@/campaign/preflight";

export const dynamic = "force-dynamic";

/** Read-only pre-launch summary. Places no calls; contacts no provider. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const preflight = await buildPreflight(id);
    if (!preflight) return NextResponse.json({ error: "Campaign not found." }, { status: 404 });
    return NextResponse.json({ preflight });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
