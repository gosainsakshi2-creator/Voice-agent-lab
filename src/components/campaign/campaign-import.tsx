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
 *
 * The wizard's shape is unchanged; only its presentation is. The drop
 * zone accepts a dragged file as well as a click, and preflight now
 * leads with READY or BLOCKED instead of burying the verdict under the
 * evidence for it.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  FileSpreadsheet,
  FileUp,
  Loader2,
  ShieldAlert,
  UploadCloud,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Callout,
  DataTable,
  EmptyState,
  GroupLabel,
  Note,
  ProviderCell,
  StatCard,
  StatusPill,
  type Column,
  type Tone,
} from "@/components/campaign/ui";

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

/** A numbered step heading, so the wizard still reads as a sequence. */
function StepHeader({
  step,
  title,
  description,
  status,
}: {
  step: number;
  title: string;
  description: string;
  status?: { tone: Tone; label: string };
}) {
  return (
    <CardHeader className="gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2.5">
          <span
            className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-surface-hover font-mono text-[10px] font-semibold text-muted-foreground"
            aria-hidden
          >
            {step}
          </span>
          <CardTitle className="text-[13.5px]">{title}</CardTitle>
        </div>
        {status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : null}
      </div>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
  );
}

const PREVIEW_COLUMNS: readonly Column[] = [
  { key: "customer", header: "Customer" },
  { key: "phone", header: "Phone" },
  { key: "agent", header: "Agent" },
  { key: "campaign", header: "Campaign" },
  { key: "script", header: "Script" },
  { key: "voice", header: "Voice provider" },
];

const ALLOCATION_COLUMNS: readonly Column[] = [
  { key: "provider", header: "Provider" },
  { key: "configured", header: "Configured", align: "right" },
  { key: "target", header: "Target", align: "right" },
  { key: "assigned", header: "Assigned", align: "right" },
  { key: "match", header: "", align: "right" },
];

export function CampaignImport({ campaignId }: { campaignId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [phoneColumn, setPhoneColumn] = useState("");
  const [nameColumn, setNameColumn] = useState(NONE);
  const [callTypeColumn, setCallTypeColumn] = useState(NONE);
  const [dragging, setDragging] = useState(false);

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

  /** Selecting a file — from the picker or from a drop — behaves identically. */
  const accept = useCallback(
    (selected: File | null) => {
      setFile(selected);
      setReport(null);
      if (selected) void inspect(selected);
    },
    [inspect],
  );

  const summary = report?.validation.summary;

  // Display-only advisories. These are NOT blockers and are never
  // allowed to change readyToDial — they are the things worth a second
  // look once the campaign is otherwise clear to run.
  const advisories: string[] = [];
  if (preflight?.lastImport && preflight.lastImport.invalidRows > 0) {
    advisories.push(
      `${preflight.lastImport.invalidRows} row(s) in the last import were rejected and are not in the call list.`,
    );
  }
  if (preflight?.lastImport && preflight.lastImport.duplicateRowsInFile > 0) {
    advisories.push(
      `${preflight.lastImport.duplicateRowsInFile} duplicate row(s) in the last file were collapsed to one contact.`,
    );
  }
  if (preflight && preflight.contacts.total > 0 && preflight.contacts.pending === 0) {
    advisories.push("No contact is pending — every imported contact has already been worked through.");
  }

  return (
    <div className="flex flex-col gap-5">
      <Callout tone="neutral" title="Importing never dials">
        Contacts are written to the database only. Calls are placed from the run controls above, and only when
        dialing is explicitly enabled.
      </Callout>

      {/* ── Step 1: upload ─────────────────────────────────────── */}
      <Card>
        <StepHeader
          step={1}
          title="Upload CSV"
          description="UTF-8 CSV with a header row. Quoted fields and commas inside quotes are handled."
          {...(file ? { status: { tone: "success" as Tone, label: "File selected" } } : {})}
        />
        <CardContent className="flex flex-col gap-3">
          <label
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              accept(event.dataTransfer.files?.[0] ?? null);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed px-6 py-8 text-center transition-colors ${
              dragging
                ? "border-accent bg-accent/[0.06]"
                : "border-border-strong bg-surface-hover/25 hover:border-accent/50 hover:bg-surface-hover/50"
            }`}
          >
            <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-surface-hover text-muted-foreground">
              {file ? (
                <FileSpreadsheet className="size-4 text-accent" aria-hidden />
              ) : (
                <UploadCloud className="size-4" aria-hidden />
              )}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-foreground">
                {file ? file.name : "Drop a CSV here, or click to choose"}
              </span>
              <span className="text-[11.5px] text-muted-foreground">
                {file
                  ? `${(file.size / 1024).toFixed(1)} KB · re-drop a file to replace it`
                  : "Nothing is uploaded until you pick a file"}
              </span>
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => accept(e.target.files?.[0] ?? null)}
            />
          </label>
          {busy && !report ? (
            <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Reading the file…
            </p>
          ) : null}
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
          <StepHeader
            step={2}
            title="Map columns"
            description={`Detected ${suggestion.headers.length} column(s). The suggestion is a guess — confirm it. Unmapped columns are preserved as contact metadata, never discarded.`}
          />
          <CardContent className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label className="text-[11px] text-muted-foreground">Phone column (required)</Label>
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
                <Label className="text-[11px] text-muted-foreground">Name column</Label>
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
                <Label className="text-[11px] text-muted-foreground">Call type column</Label>
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

            {(() => {
              const metadata = suggestion.headers.filter(
                (h) => h !== phoneColumn && h !== nameColumn && h !== callTypeColumn,
              );
              return metadata.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <GroupLabel>Kept as metadata</GroupLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {metadata.map((header) => (
                      <span
                        key={header}
                        className="rounded-md border border-border bg-surface-hover/40 px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground"
                      >
                        {header}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null;
            })()}

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
          <StepHeader
            step={3}
            title="Review"
            description={
              report.dryRun
                ? "Nothing has been written yet. Check the numbers, then import."
                : "Import committed to the database."
            }
            status={
              report.dryRun
                ? { tone: "warning", label: "Not yet imported" }
                : { tone: "success", label: "Imported" }
            }
          />
          <CardContent className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <StatCard label="Total rows" value={summary.totalRows} />
              <StatCard label="Valid" value={summary.validRows} tone={summary.validRows > 0 ? "success" : "neutral"} />
              <StatCard
                label="Invalid"
                value={summary.invalidRows}
                tone={summary.invalidRows > 0 ? "danger" : "neutral"}
                hint={summary.invalidRows > 0 ? "not imported" : undefined}
              />
              <StatCard
                label="Duplicates in file"
                value={summary.duplicateRowsInFile}
                tone={summary.duplicateRowsInFile > 0 ? "warning" : "neutral"}
                hint={summary.duplicateRowsInFile > 0 ? "collapsed to one" : undefined}
              />
            </div>

            <div className="flex flex-col gap-2">
              <GroupLabel>
                {report.persisted ? "Provider split in database" : "Planned provider split"}
              </GroupLabel>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {Object.entries(report.persisted?.allocationInCampaign ?? report.plannedAllocation).map(
                  ([provider, count]) => (
                    <StatCard key={provider} label={provider} value={count} hint="contacts" />
                  ),
                )}
              </div>
            </div>

            {report.validation.rejected.length > 0 ? (
              <div className="flex flex-col gap-2">
                <GroupLabel>Rejected rows ({report.validation.rejected.length})</GroupLabel>
                <ScrollArea className="h-[220px] rounded-lg border border-border">
                  <ul className="divide-y divide-border">
                    {report.validation.rejected.map((row) => (
                      <li
                        key={`${row.rowNumber}-${row.reason}`}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2"
                      >
                        <span className="font-mono text-[11px] text-subtle-foreground">row {row.rowNumber}</span>
                        <span className="font-mono text-[11px] text-foreground">{row.maskedPhone ?? "—"}</span>
                        <span className="text-[12px] text-muted-foreground">{row.message}</span>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
                <p className="text-[11px] text-subtle-foreground">
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
              <Callout tone="success" title={`Inserted ${report.persisted?.inserted ?? 0} contact(s)`}>
                {report.persisted?.skippedAlreadyInCampaign ?? 0} already existed and kept their original
                provider.
              </Callout>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* ── Step 4: preflight ──────────────────────────────────── */}
      {preflight ? (
        <Card>
          <StepHeader
            step={4}
            title="Preflight"
            description="Everything that must hold before this campaign is allowed to dial."
            status={
              preflight.readyToDial
                ? { tone: "success", label: "Ready to dial" }
                : { tone: "danger", label: `Blocked · ${preflight.blockers.length}` }
            }
          />
          <CardContent className="flex flex-col gap-5">
            {preflight.readyToDial ? (
              <Callout tone="success" title="Ready to dial">
                Every preflight condition is satisfied. Starting a run from the controls above will place calls.
              </Callout>
            ) : (
              <Callout
                tone="danger"
                role="alert"
                title={`Dialing is blocked — ${preflight.blockers.length} issue${preflight.blockers.length === 1 ? "" : "s"} to clear`}
              >
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {preflight.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </Callout>
            )}

            {advisories.length > 0 ? (
              <Callout tone="warning" title="Worth a look — not blocking">
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {advisories.map((advisory) => (
                    <li key={advisory}>{advisory}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard label="Contacts" value={preflight.contacts.total} />
              <StatCard label="Pending" value={preflight.contacts.pending} hint="not yet attempted" />
              <StatCard
                label="Agents"
                value={[...new Set(Object.values(preflight.agentsByProvider))].join(" / ") || "—"}
              />
              <StatCard
                label="Script"
                value={preflight.script.version}
                hint={preflight.script.isPlaceholder ? "placeholder" : preflight.script.id}
                tone={preflight.script.isPlaceholder ? "warning" : "neutral"}
              />
              <StatCard label="Status" value={preflight.campaign.status} />
            </div>

            <div className="flex flex-col gap-2">
              <GroupLabel>Provider allocation</GroupLabel>
              <DataTable
                columns={ALLOCATION_COLUMNS}
                empty={
                  <EmptyState
                    icon={Users}
                    title="No providers allocated yet"
                    hint="Allocation appears once contacts are imported."
                  />
                }
                rows={preflight.providers.map((line) => [
                  <ProviderCell key="p" provider={line.provider} />,
                  `${line.configuredPercent}%`,
                  line.targetContacts,
                  <span
                    key="assigned"
                    className={line.matchesTarget ? "text-foreground" : "font-medium text-danger"}
                  >
                    {line.assignedContacts}
                  </span>,
                  line.matchesTarget ? (
                    <CheckCircle2 key="ok" className="ml-auto size-3.5 text-success" aria-label="Matches target" />
                  ) : (
                    <ShieldAlert
                      key="off"
                      className="ml-auto size-3.5 text-danger"
                      aria-label="Does not match target"
                    />
                  ),
                ])}
              />
            </div>

            {preflight.contactPreview.length > 0 ? (
              <div className="flex flex-col gap-2">
                <GroupLabel>Who would be called — preview only, nothing dials</GroupLabel>
                <DataTable
                  columns={PREVIEW_COLUMNS}
                  rows={preflight.contactPreview.map((row) => [
                    row.customerName ?? "—",
                    <span key="phone" className="font-mono text-muted-foreground">
                      {row.maskedPhone}
                    </span>,
                    row.agentName ?? "—",
                    row.campaignType,
                    <span key="script" className="font-mono text-[11px] text-muted-foreground">
                      {row.script}
                    </span>,
                    <ProviderCell key="voice" provider={row.provider} />,
                  ])}
                />
              </div>
            ) : null}

            <Note summary="What preflight checks, and what it cannot">
              <p>
                Preflight is read-only: it places no calls and contacts no provider. Whether the campaign may dial
                is derived from the blocker list above rather than asserted, so clearing every entry is the only
                way it becomes ready.
              </p>
              <p className="font-mono text-[10.5px] text-subtle-foreground">
                script {preflight.script.id} {preflight.script.version} · hash{" "}
                {preflight.script.hash.slice(0, 12)} · telephony {preflight.campaign.telephonyProvider} ·{" "}
                {preflight.campaign.language}
              </p>
            </Note>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
