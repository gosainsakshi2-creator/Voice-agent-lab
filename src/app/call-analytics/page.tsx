import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { CallAnalytics } from "@/components/campaign/call-analytics";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Call analytics — Voice Agent Lab",
};

/**
 * Every campaign call, as one filterable dataset.
 *
 * A read-only projection over the call records the campaign layer
 * already stores. Yes / No / No Answer / the duration buckets are
 * filters on this screen, not pages of their own, and the CSV button
 * exports whatever the filters currently show.
 *
 * The voice-agent dashboard at "/" and the campaign pages are untouched
 * and unaware of this page.
 */
export default function CallAnalyticsPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[1280px] flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-2">
        <Link
          href="/campaigns"
          className="inline-flex w-fit items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          All campaigns
        </Link>
        <h1 className="text-[22px] font-semibold tracking-tight">Call analytics</h1>
        <p className="max-w-2xl text-[13px] text-muted-foreground">
          Every call attempt across every campaign, with its duration, the customer&apos;s response, the stored
          outcome and the transcript. Filter the one table; the summary, the daily view and the CSV export follow
          the same filters.
        </p>
      </header>
      <CallAnalytics />
    </main>
  );
}
