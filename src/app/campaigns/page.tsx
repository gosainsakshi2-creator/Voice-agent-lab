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
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] font-semibold tracking-tight">Outbound campaigns</h1>
        <p className="text-[13px] text-muted-foreground">
          Create a campaign, import contacts, and review the provider split before any dialing exists.
        </p>
      </header>
      <CampaignList />
    </main>
  );
}
