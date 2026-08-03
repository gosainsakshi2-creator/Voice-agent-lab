import { NextResponse } from "next/server";

import { getRuntime } from "../../../../../server/runtime";
import type { SessionId } from "../../../../../types/session.types";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { manager } = getRuntime();
  const { id } = await params;

  try {
    const snapshot = await manager.warmUpProviders(id as SessionId);
    const warmup = await manager.getWarmupResult(id as SessionId);
    return NextResponse.json({ session: snapshot, warmup });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
