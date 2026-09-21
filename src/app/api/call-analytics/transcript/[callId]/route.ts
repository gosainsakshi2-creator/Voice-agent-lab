import { NextResponse } from "next/server";

import { transcriptForCall } from "@/campaign/analytics";

export const dynamic = "force-dynamic";

/**
 * The transcript stored with ONE call, read from `call_outcomes` by the
 * attempt id. `available: false` is an honest answer, not an error: a
 * No Answer attempt, an unclassified call, or a call whose outcome write
 * failed all have no transcript, and none of them is invented here.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params;
  try {
    const transcript = await transcriptForCall(callId);
    if (!transcript) return NextResponse.json({ error: "No call with that id." }, { status: 404 });
    return NextResponse.json(transcript);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
