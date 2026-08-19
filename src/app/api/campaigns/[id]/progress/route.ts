import { NextResponse } from "next/server";

import { campaignProgress, getDispatcher } from "@/campaign/dispatch/dispatcher";

export const dynamic = "force-dynamic";

/** Live progress: database counts plus the in-process dispatcher state. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const progress = await campaignProgress(id);
    const dispatcher = getDispatcher(id);
    return NextResponse.json({
      progress,
      dispatcher: dispatcher ? dispatcher.getStatus() : null,
      running: dispatcher !== undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
