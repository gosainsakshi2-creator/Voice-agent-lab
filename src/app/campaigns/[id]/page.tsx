import Link from "next/link";
import { ArrowLeft } from "lucide-react";

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
 * Each block is labelled with what it is FOR rather than what it
 * contains, so a screen with four cards on it reads as a sequence
 * rather than as four unrelated panels.
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
      <header className="flex flex-col gap-3">
        <Link
          href="/campaigns"
          className="inline-flex w-fit items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          All campaigns
        </Link>
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] font-semibold tracking-tight">Campaign</h1>
          <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
            Run controls, results, and the calls behind them. Starting a run places calls only when
            CAMPAIGN_DIALING_ENABLED is true.
          </p>
        </div>
      </header>

      <Step
        number={1}
        title="Run"
        description="Start, pause or stop the campaign. Stop is durable: it holds even across a restart."
      >
        <CampaignControls campaignId={id} />
      </Step>

      <Step
        number={2}
        title="Results"
        description="Contact-level outcomes and the per-provider comparison, with what the numbers cannot support stated alongside them."
      >
        <CampaignResults campaignId={id} />
      </Step>

      <Step
        number={3}
        title="Calls"
        description="Every attempt, newest first, with the outcome the classifier read from it. Phone numbers are masked before they leave the database."
      >
        <CampaignCalls campaignId={id} />
      </Step>

      <Step
        number={4}
        title="Contacts"
        description="Upload a CSV, confirm the column mapping, review what will be imported, then commit. Nothing is dialled by importing, and each contact is locked to one provider for every attempt it ever gets."
      >
        <CampaignImport campaignId={id} />
      </Step>
    </main>
  );
}

/** One labelled stage of the campaign screen. */
function Step({
  number,
  title,
  description,
  children,
}: {
  number: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] text-muted-foreground"
          aria-hidden
        >
          {number}
        </span>
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
          <p className="max-w-3xl text-[12px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
