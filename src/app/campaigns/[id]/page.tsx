import { CampaignCalls } from "@/components/campaign/campaign-calls";
import { CampaignControls } from "@/components/campaign/campaign-controls";
import { CampaignImport } from "@/components/campaign/campaign-import";
import { CampaignResults } from "@/components/campaign/campaign-results";

export const dynamic = "force-dynamic";

/**
 * One campaign, in the order an operator works through it: what it is
 * doing right now, what it has produced, which calls produced it, and
 * — last, because it is the setup step — the contact import.
 *
 * The voice-agent dashboard at "/" is untouched and unaware of this
 * page.
 */
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] font-semibold tracking-tight">Campaign</h1>
        <p className="text-[13px] text-muted-foreground">
          Run controls, results, and the calls behind them. Starting a run places calls only when
          CAMPAIGN_DIALING_ENABLED is true.
        </p>
      </header>

      <CampaignControls campaignId={id} />
      <CampaignResults campaignId={id} />
      <CampaignCalls campaignId={id} />

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-[16px] font-semibold tracking-tight">Import contacts</h2>
          <p className="text-[13px] text-muted-foreground">
            Upload a CSV, confirm the column mapping, review what will be imported, then commit.
          </p>
        </div>
        <CampaignImport campaignId={id} />
      </section>
    </main>
  );
}
