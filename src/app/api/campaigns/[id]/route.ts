import { NextResponse } from "next/server";

import { getCampaign } from "@/campaign/db/repositories/campaign.repo";
import { countContactsByProvider } from "@/campaign/db/repositories/contact.repo";
import { attemptAggregates } from "@/campaign/results/results.repo";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const campaign = await getCampaign(id);
    if (!campaign) return NextResponse.json({ error: "Campaign not found." }, { status: 404 });

    const [byProvider, attempts] = await Promise.all([
      countContactsByProvider(id),
      attemptAggregates(id),
    ]);
    return NextResponse.json({
      campaign,
      allocationInDatabase: Object.fromEntries(byProvider),
      // Counted, not asserted. Rehearsals recorded with the kill
      // switch off are excluded, so this stays zero until a call
      // genuinely reached the telephony provider.
      callsPlaced: attempts.reduce((sum, row) => sum + row.dialled, 0),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
