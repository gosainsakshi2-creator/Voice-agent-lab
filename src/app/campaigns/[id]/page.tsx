import { CampaignCalls } from "@/components/campaign/campaign-calls";
import { CampaignControls } from "@/components/campaign/campaign-controls";
import { CampaignHeader } from "@/components/campaign/campaign-header";
import { CampaignImport } from "@/components/campaign/campaign-import";
import { CampaignResults } from "@/components/campaign/campaign-results";
import { Section } from "@/components/campaign/ui";

export const dynamic = "force-dynamic";

/**
 * One campaign, in the order an operator works through it: what it is,
 * what it is doing right now, what it has produced, which calls
 * produced it, and — last, because it is the setup step — the contact
 * import.
 *
 * The header carries the identity and state so nothing below has to
 * restate it, and each band is labelled with what it is FOR rather
 * than with a paragraph explaining it; the explanations now live next
 * to the numbers they qualify.
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
    <main className="mx-auto flex min-h-dvh w-full max-w-[1200px] flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <CampaignHeader campaignId={id} />

      <Section
        eyebrow="01"
        title="Run"
        description="Start, pause or stop the campaign. Stop is durable — it holds even across a restart."
      >
        <CampaignControls campaignId={id} />
      </Section>

      <Section
        eyebrow="02"
        title="Results"
        description="Contact-level outcomes and the per-provider comparison."
      >
        <CampaignResults campaignId={id} />
      </Section>

      <Section
        eyebrow="03"
        title="Calls"
        description="Every attempt, newest first, with the outcome read from it. Phone numbers are masked before they leave the database."
      >
        <CampaignCalls campaignId={id} />
      </Section>

      <Section
        eyebrow="04"
        title="Contacts & launch checks"
        description="Import a CSV, confirm the mapping, review, commit — then read the preflight before dialing."
      >
        <CampaignImport campaignId={id} />
      </Section>
    </main>
  );
}
