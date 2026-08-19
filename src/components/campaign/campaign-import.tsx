"use client";

/**
 * campaign-import.tsx
 *
 * The import wizard: upload → map columns → review validation →
 * commit → preflight.
 *
 * The review step exists because the mapping is a guess until a human
 * confirms it. Nothing is written until "Import contacts" is pressed,
 * and even then nothing dials.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileUp, Loader2, ShieldAlert, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NoCallsBanner } from "@/components/campaign/no-calls-banner";

const NONE = "__none__";

interface Suggestion {
  headers: string[];
  phone?: string;
  name?: string;
  callType?: string;
  metadataColumns: string[];
}

interface RejectedRow {
  rowNumber: number;
  reason: string;
  message: string;
  maskedPhone: string | null;
}

interface ImportReport {
  dryRun: boolean;
  headers: string[];
  mapping: { phone: string; name?: string; callType?: string };
  metadataColumns: string[];
  region: string;
  truncated: boolean;
  validation: {
    summary: {
      totalRows: number;
      validRows: number;
      invalidRows: number;
      duplicateRowsInFile: number;
      emptyPhoneRows: number;
      malformedPhoneRows: number;
      missingNameRows: number;
      emptyRows: number;
    };
    rejected: RejectedRow[];
  };
  plannedAllocation: Record<string, number>;
  persisted?: {
    inserted: number;
    skippedAlreadyInCampaign: number;
    totalContactsInCampaign: number;
    allocationInCampaign: Record<string, number>;
  };
}

interface PreflightReport {
  campaign: { id: string; name: string; type: string; status: string; language: string; telephonyProvider: string };
  script: { id: string; version: string; hash: string; isPlaceholder: boolean };
  agentsByProvider: Record<string, string>;
  contactPreview: Array<{
    customerName: string | null;
    maskedPhone: string;
    provider: string;
    agentName: string | null;
    campaignType: string;
    script: string;
  }>;
  contacts: { total: number; pending: number };
  providers: Array<{
    provider: string;
    configuredPercent: number;
    targetContacts: number;
    assignedContacts: number;
    matchesTarget: boolean;
  }>;
  lastImport: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRowsInFile: number;
    inserted: number;
    skippedExisting: number;
  } | null;
  blockers: string[];
  readyToDial: boolean;
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "bad" | "warn" }) {
  const color = tone === "bad" ? "text-destructive" : tone === "warn" ? "text-amber-600" : "";
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[11px] uppercase tracking-[0.04em] text-muted-foreground">{label}</p>
      <p className={`font-mono text-[20px] tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

export function CampaignImport({ campaignId }: { campaignId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [phoneColumn, setPhoneColumn] = useState("");
  const [nameColumn, setNameColumn] = useState(NONE);
  const [callTypeColumn, setCallTypeColumn] = useState(NONE);

  const [report, setReport] = useState<ImportReport | null>(null);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const loadPreflight = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${campaignId}/preflight`);
    const json = await res.json();
    if (res.ok) setPreflight(json.preflight);
  }, [campaignId]);

  useEffect(() => {
    void loadPreflight();
  }, [loadPreflight]);

  const inspect = useCallback(
    async (selected: File) => {
      setBusy(true);
      setError(undefined);
      setReport(null);
      try {
        const body = new FormData();
        body.append("file", selected);
        const res = await fetch(`/api/campaigns/${campaignId}/import?inspect=1`, {
          method: "POST",
          body,
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not read the file.");
        setSuggestion(json.suggestion);
        setPhoneColumn(json.suggestion.phone ?? "");
        setNameColumn(json.suggestion.name ?? NONE);
        setCallTypeColumn(json.suggestion.callType ?? NONE);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSuggestion(null);
      } finally {
        setBusy(false);
      }
    },
    [campaignId],
  );

  const submit = useCallback(
    async (dryRun: boolean) => {
      if (!file) return;
      setBusy(true);
      setError(undefined);
      try {
        const body = new FormData();
        body.append("file", file);
        body.append("dryRun", String(dryRun));
        body.append("phoneColumn", phoneColumn);
        if (nameColumn !== NONE) body.append("nameColumn", nameColumn);
        if (callTypeColumn !== NONE) body.append("callTypeColumn", callTypeColumn);

        const res = await fetch(`/api/campaigns/${campaignId}/import`, { method: "POST", body });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Import failed.");
        setReport(json.report);
        if (!dryRun) await loadPreflight();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [callTypeColumn, campaignId, file, loadPreflight, nameColumn, phoneColumn],
  );

  const summary = report?.validation.summary;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <Button asChild variant="ghost" size="sm">
          <Link href="/campaigns">
            <ArrowLeft /> All campaigns
          </Link>
        </Button>
        {preflight ? <Badge variant="outline">{preflight.campaign.status}</Badge> : null}
      </div>

      {preflight?.readyToDial === false ? (
        <NoCallsBanner
          detail={
            preflight.blockers[0] ??
            "Import writes contacts to the database only. Nothing on this step dials a number."
          }
        />
      ) : (
        <NoCallsBanner detail="Import writes contacts to the database only. Dialing happens from the run controls above, and only when it is explicitly enabled." />
      )}

      {/* ── Step 1: upload ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>1 · Upload CSV</CardTitle>
          <CardDescription>
            UTF-8 CSV with a header row. Quoted fields and commas inside quotes are handled.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-4 py-6 hover:bg-accent/40">
            <UploadCloud className="size-5 text-muted-foreground" aria-hidden />
            <div className="flex flex-col">
              <span className="text-[13px] font-medium">
                {file ? file.name : "Choose a CSV file"}
              </span>
              <span className="text-[12px] text-muted-foreground">
                {file ? `${(file.size / 1024).toFixed(1)} KB` : "Nothing is uploaded until you pick a file"}
              </span>
            </div>
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const selected = e.target.files?.[0] ?? null;
                setFile(selected);
                setReport(null);
                if (selected) void inspect(selected);
              }}
            />
          </label>
          {error ? (
            <p className="text-[12px] text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Step 2: mapping ────────────────────────────────────── */}
      {suggestion ? (
        <Card>
          <CardHeader>
            <CardTitle>2 · Map columns</CardTitle>
            <CardDescription>
              Detected {suggestion.headers.length} column(s). The suggestion is a guess — confirm it.
              Unmapped columns are preserved as contact metadata, never discarded.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label>Phone column (required)</Label>
                <Select value={phoneColumn} onValueChange={setPhoneColumn}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {suggestion.headers.map((header) => (
                      <SelectItem key={header} value={header}>
                        {header}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Name column</Label>
                <Select value={nameColumn} onValueChange={setNameColumn}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>— none —</SelectItem>
                    {suggestion.headers.map((header) => (
                      <SelectItem key={header} value={header}>
                        {header}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Call type column</Label>
                <Select value={callTypeColumn} onValueChange={setCallTypeColumn}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>— none —</SelectItem>
                    {suggestion.headers.map((header) => (
                      <SelectItem key={header} value={header}>
                        {header}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {suggestion.headers
                .filter((h) => h !== phoneColumn && h !== nameColumn && h !== callTypeColumn)
                .map((header) => (
                  <Badge key={header} variant="outline" className="font-mono text-[11px]">
                    {header} → metadata
                  </Badge>
                ))}
            </div>

            <Button
              onClick={() => void submit(true)}
              disabled={busy || phoneColumn.length === 0}
              className="sm:w-fit"
            >
              {busy ? <Loader2 className="animate-spin" /> : <FileUp />}
              Validate without importing
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Step 3: validation review ──────────────────────────── */}
      {report && summary ? (
        <Card>
          <CardHeader>
            <CardTitle>3 · Review</CardTitle>
            <CardDescription>
              {report.dryRun
                ? "Nothing has been written. Check the numbers, then import."
                : "Import committed."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Total rows" value={summary.totalRows} />
              <Stat label="Valid" value={summary.validRows} />
              <Stat
                label="Invalid"
                value={summary.invalidRows}
                {...(summary.invalidRows > 0 ? { tone: "bad" as const } : {})}
              />
              <Stat
                label="Duplicates in file"
                value={summary.duplicateRowsInFile}
                {...(summary.duplicateRowsInFile > 0 ? { tone: "warn" as const } : {})}
              />
            </div>

            <Separator />

            <div>
              <p className="mb-2 text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
                {report.persisted ? "Provider split in database" : "Planned provider split"}
              </p>
              <div className="grid grid-cols-3 gap-4">
                {Object.entries(report.persisted?.allocationInCampaign ?? report.plannedAllocation).map(
                  ([provider, count]) => (
                    <Stat key={provider} label={provider} value={count} />
                  ),
                )}
              </div>
            </div>

            {report.validation.rejected.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
                  Rejected rows ({report.validation.rejected.length})
                </p>
                <ScrollArea className="h-[220px] rounded-md border">
                  <ul className="divide-y">
                    {report.validation.rejected.map((row) => (
                      <li key={`${row.rowNumber}-${row.reason}`} className="flex gap-3 px-3 py-2">
                        <span className="font-mono text-[11px] text-muted-foreground">
                          row {row.rowNumber}
                        </span>
                        <span className="font-mono text-[11px]">{row.maskedPhone ?? "—"}</span>
                        <span className="text-[12px] text-muted-foreground">{row.message}</span>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
                <p className="text-[11px] text-muted-foreground">
                  Phone numbers are masked here and in the server logs.
                </p>
              </div>
            ) : null}

            {report.dryRun ? (
              <Button
                onClick={() => void submit(false)}
                disabled={busy || summary.validRows === 0}
                className="sm:w-fit"
              >
                {busy ? <Loader2 className="animate-spin" /> : <FileUp />}
                Import {summary.validRows} contact(s)
              </Button>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                Inserted {report.persisted?.inserted ?? 0}; {report.persisted?.skippedAlreadyInCampaign ?? 0}{" "}
                already existed and kept their original provider.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* ── Step 4: preflight ──────────────────────────────────── */}
      {preflight ? (
        <Card>
          <CardHeader>
            <CardTitle>4 · Preflight</CardTitle>
            <CardDescription>
              {preflight.campaign.name} · {preflight.campaign.type} · script {preflight.script.id}{" "}
              {preflight.script.version}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Stat label="Contacts" value={preflight.contacts.total} />
              <Stat label="Pending" value={preflight.contacts.pending} />
              <Stat label="Agents" value={[...new Set(Object.values(preflight.agentsByProvider))].join(" / ") || "—"} />
              <Stat label="Calls placed" value={0} />
              <Stat label="Status" value={preflight.campaign.status} />
            </div>

            {preflight.contactPreview.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
                  Who would be called (preview only — nothing dials)
                </p>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Customer</th>
                        <th className="px-3 py-2 font-medium">Phone</th>
                        <th className="px-3 py-2 font-medium">Agent</th>
                        <th className="px-3 py-2 font-medium">Campaign</th>
                        <th className="px-3 py-2 font-medium">Script</th>
                        <th className="px-3 py-2 font-medium">Voice</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preflight.contactPreview.map((row) => (
                        <tr key={row.maskedPhone} className="border-b last:border-0">
                          <td className="px-3 py-2">{row.customerName ?? "—"}</td>
                          <td className="px-3 py-2 font-mono">{row.maskedPhone}</td>
                          <td className="px-3 py-2">{row.agentName ?? "—"}</td>
                          <td className="px-3 py-2">{row.campaignType}</td>
                          <td className="px-3 py-2 font-mono text-[11px]">{row.script}</td>
                          <td className="px-3 py-2 font-mono text-[11px]">{row.provider}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b text-left text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Provider</th>
                    <th className="py-2 pr-3 text-right font-medium">Configured</th>
                    <th className="py-2 pr-3 text-right font-medium">Target</th>
                    <th className="py-2 pr-3 text-right font-medium">Assigned</th>
                  </tr>
                </thead>
                <tbody>
                  {preflight.providers.map((line) => (
                    <tr key={line.provider} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-mono">{line.provider}</td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums">
                        {line.configuredPercent}%
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums">{line.targetContacts}</td>
                      <td
                        className={`py-2 pr-3 text-right font-mono tabular-nums ${line.matchesTarget ? "" : "text-destructive"}`}
                      >
                        {line.assignedContacts}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="size-4 text-amber-600" aria-hidden />
                <p className="text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
                  Blocking dialing ({preflight.blockers.length})
                </p>
              </div>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-[12px] text-muted-foreground">
                {preflight.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
