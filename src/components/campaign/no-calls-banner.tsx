/**
 * no-calls-banner.tsx
 *
 * The campaign UI can create campaigns and import thousands of phone
 * numbers, which looks a great deal like a system that is about to
 * ring them. It is not, and the interface has to say so plainly rather
 * than leave the operator to infer it.
 */

import { ShieldCheck } from "lucide-react";

export function NoCallsBanner({ detail }: { detail?: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-emerald-600/30 bg-emerald-500/10 px-4 py-3"
    >
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
      <div className="flex flex-col gap-0.5">
        <p className="text-[13px] font-semibold tracking-tight text-emerald-700 dark:text-emerald-400">
          NO CALLS HAVE BEEN STARTED
        </p>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {detail ??
            "Campaign setup and contact import only. No dialer exists in the project yet, so nothing here can place a call."}
        </p>
      </div>
    </div>
  );
}
