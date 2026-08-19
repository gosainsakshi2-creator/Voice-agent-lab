import { Readable } from "node:stream";
import { NextResponse } from "next/server";

import { getCampaign } from "@/campaign/db/repositories/campaign.repo";
import { runImport, ImportError } from "@/campaign/import/importer";
import { CsvImportError, assertUploadAcceptable, parseCsvFile } from "@/campaign/import/csv-parser";
import { MappingError, suggestMapping, type ColumnMapping } from "@/campaign/import/column-mapper";
import { AllocationError } from "@/campaign/import/provider-allocator";
import { findScript } from "@/campaign/script/script-registry";

export const dynamic = "force-dynamic";

/**
 * CSV import.
 *
 *   POST ?inspect=1   -> headers + a suggested mapping, nothing else
 *   POST dryRun=true  -> full validation and provider split, no writes
 *   POST dryRun=false -> the same work, committed in one transaction
 *
 * NO CALL IS PLACED BY THIS ROUTE. It imports rows into PostgreSQL and
 * touches no telephony, TTS, STT or LLM provider.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Send the CSV as multipart/form-data with a 'file' field." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No CSV file was attached." }, { status: 400 });
  }

  try {
    // Header inspection: cheap, read-only, and the step the mapping UI
    // is built on. Guarded by the same size and type checks.
    if (new URL(request.url).searchParams.get("inspect") === "1") {
      assertUploadAcceptable({ name: file.name, size: file.size, type: file.type });
      const parsed = await parseCsvFile(file);
      return NextResponse.json({
        headers: parsed.headers,
        suggestion: suggestMapping(parsed.headers),
        sampleRowCount: parsed.rows.length,
        truncated: parsed.truncated,
        // A handful of rows so the operator can see they mapped the
        // right column. Values are shown as-is only for non-phone
        // columns; the phone column is masked by the validator later.
        sampleRows: parsed.rows.slice(0, 5),
        callsPlaced: 0,
      });
    }

    const campaign = await getCampaign(id);
    if (!campaign) {
      return NextResponse.json({ error: "Campaign not found." }, { status: 404 });
    }

    const script = findScript(campaign.scriptId, campaign.scriptVersion);
    const dryRun = String(form.get("dryRun") ?? "true") !== "false";

    assertUploadAcceptable({ name: file.name, size: file.size, type: file.type });

    const report = await runImport({
      campaign,
      csv: Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]),
      mapping: buildMapping(form),
      requireName: script?.requiresName ?? false,
      dryRun,
      ...(stringOrUndefined(form.get("region")) !== undefined
        ? { region: String(form.get("region")) }
        : {}),
    });

    return NextResponse.json({ report, callsPlaced: 0 });
  } catch (error) {
    if (error instanceof CsvImportError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    if (error instanceof MappingError || error instanceof AllocationError || error instanceof ImportError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // eslint-disable-next-line no-console
    console.error(`[campaign-import] campaign=${id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present
 * and undefined", so an omitted column has to be left off the object
 * rather than set to undefined.
 */
function buildMapping(form: FormData): Partial<ColumnMapping> {
  const phone = stringOrUndefined(form.get("phoneColumn"));
  const name = stringOrUndefined(form.get("nameColumn"));
  const callType = stringOrUndefined(form.get("callTypeColumn"));
  return {
    ...(phone !== undefined ? { phone } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(callType !== undefined ? { callType } : {}),
  };
}

function stringOrUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
