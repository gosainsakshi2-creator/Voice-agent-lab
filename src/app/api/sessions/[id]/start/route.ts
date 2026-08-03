import { NextResponse } from "next/server";

import { getRuntime } from "../../../../../server/runtime";
import { registerPendingCall } from "../../../../../server/pending-call";
import type { SessionId } from "../../../../../types/session.types";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { manager } = getRuntime();
  const { id } = await params;
  const sessionId = id as SessionId;

  // Registered *before* calling start() so the Answer-URL webhook
  // (which Plivo fires asynchronously once the callee picks up) can
  // always find a pending session waiting to be claimed — see
  // `pending-call.ts` for why this correlation is needed at all.
  registerPendingCall(sessionId);

  try {
    const snapshot = await manager.start(sessionId);
    return NextResponse.json({ session: snapshot });
  } catch (error) {
     console.error("START SESSION ERROR:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
