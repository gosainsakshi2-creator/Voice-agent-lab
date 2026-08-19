import { NextResponse } from "next/server";

import { countAttempts, listAttempts } from "@/campaign/results/results.repo";

export const dynamic = "force-dynamic";

const MAX_PAGE_SIZE = 200;

/** Per-attempt listing with its outcome. Phone numbers are masked in SQL. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, MAX_PAGE_SIZE);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);

  try {
    const [attempts, total] = await Promise.all([listAttempts(id, limit, offset), countAttempts(id)]);
    return NextResponse.json({ attempts, total, limit, offset });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
