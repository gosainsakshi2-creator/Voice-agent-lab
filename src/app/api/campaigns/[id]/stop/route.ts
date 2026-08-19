import { NextResponse } from "next/server";

import { getDispatcher } from "@/campaign/dispatch/dispatcher";
import { applyControl } from "@/campaign/dispatch/control-watcher";
import { setControl } from "@/campaign/db/repositories/control.repo";

export const dynamic = "force-dynamic";

/**
 * Stop: no new calls are claimed, and the campaign is left STOPPED
 * rather than merely paused. Calls already connected are allowed to
 * finish — hanging up on someone mid-sentence is not a safety feature.
 *
 * Written to the database first, exactly as pause is, and for the same
 * reason: "stop the calls" is the one instruction that must not depend
 * on which process happened to receive the request. It is stored, and
 * it stays in force until someone explicitly starts the campaign
 * again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let reason: string | undefined;
  try {
    const body = (await request.json()) as { reason?: string };
    reason = body?.reason?.trim() || undefined;
  } catch {
    // A body is optional.
  }

  try {
    const control = await setControl({
      campaignId: id,
      desiredState: "STOP",
      requestedBy: "api:stop",
      reason: reason ?? "Stopped by operator",
    });

    const dispatcher = getDispatcher(id);
    const applied = dispatcher ? applyControl(dispatcher, "STOP") : "none";

    return NextResponse.json({
      stopped: true,
      control,
      appliedToRunningDispatcher: applied === "stopped",
      status: dispatcher ? dispatcher.getStatus() : null,
      note:
        applied === "stopped"
          ? "The running dispatcher has stopped claiming new contacts. Calls already in flight will finish."
          : "No dispatcher is running in this process. The stop is stored and stays in force until the campaign is explicitly started again.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
