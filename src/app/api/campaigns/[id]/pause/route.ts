import { NextResponse } from "next/server";

import { getDispatcher } from "@/campaign/dispatch/dispatcher";
import { applyControl } from "@/campaign/dispatch/control-watcher";
import { setControl } from "@/campaign/db/repositories/control.repo";

export const dynamic = "force-dynamic";

/**
 * Pause: no new calls are claimed; calls already in flight are allowed
 * to finish rather than being cut off mid-sentence.
 *
 * The instruction is written to the database FIRST and applied to the
 * local dispatcher second. That order is the whole point: a pause must
 * survive the process that received it. If this replica is not the one
 * running the campaign, or the dispatcher restarts a second later, the
 * stored instruction is still in force and the control watcher applies
 * it wherever the run actually is.
 *
 * So "no dispatcher here" is a 200, not a 404 — the pause was
 * recorded, which is what was asked for.
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
      desiredState: "PAUSE",
      requestedBy: "api:pause",
      reason: reason ?? "Paused by operator",
    });

    const dispatcher = getDispatcher(id);
    const applied = dispatcher ? applyControl(dispatcher, "PAUSE") : "none";

    return NextResponse.json({
      paused: true,
      control,
      appliedToRunningDispatcher: applied === "paused",
      status: dispatcher ? dispatcher.getStatus() : null,
      note:
        applied === "paused"
          ? "The running dispatcher has stopped claiming new contacts. Calls already in flight will finish."
          : "No dispatcher is running in this process. The pause is stored and will be applied to any run that starts or is found elsewhere.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
