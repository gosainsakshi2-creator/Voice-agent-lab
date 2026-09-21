import Link from "next/link";
import { BarChart3 } from "lucide-react";

import { CampaignList } from "@/components/campaign/campaign-list";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Campaigns — Voice Agent Lab",
};

/**
 * Campaign management, on its own route. The voice-agent dashboard at
 * "/" is untouched and unaware of this page.
 */
export default function CampaignsPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] font-semibold tracking-tight">Outbound campaigns</h1>
          <p className="text-[13px] text-muted-foreground">
            Create a campaign, import contacts, and review the provider split before any dialing exists.
          </p>
        </div>
        {/* Additive: the cross-campaign call analytics screen. */}
        <Link
          href="/call-analytics"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          <BarChart3 className="size-3.5" aria-hidden />
          Call analytics
        </Link>
      </header>
      <CampaignList />
    </main>
  );
}
