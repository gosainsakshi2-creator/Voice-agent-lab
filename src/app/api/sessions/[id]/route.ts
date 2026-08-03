import { NextResponse } from "next/server";

import { getRuntime } from "../../../../server/runtime";
import type { SessionId } from "../../../../types/session.types";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { manager } = getRuntime();
  const { id } = await params;

  try {
    const snapshot = await manager.getSnapshot(id as SessionId);
    const transcript = manager.getTranscript(id as SessionId);
    const metrics = await manager.getBenchmarkMetrics(id as SessionId);
    return NextResponse.json({ session: snapshot, transcript, metrics });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { manager } = getRuntime();
  const { id } = await params;

  try {
    const snapshot = await manager.end(id as SessionId);
    return NextResponse.json({ session: snapshot });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
