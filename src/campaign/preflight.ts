/**
 * preflight.ts
 *
 * The pre-launch summary: everything an operator should have to
 * confirm before a campaign is allowed to dial, assembled from the
 * database rather than from whatever the import request claimed.
 *
 * Preflight is strictly read-only. It places no calls and contacts no
 * provider. `readyToDial` is derived from `blockers` rather than
 * asserted, and stays false while the external-limits entry stands —
 * the carrier's CPS, concurrency, DID pool, answering-machine
 * detection and status callbacks are still unconfirmed, and a campaign
 * cleared to run at size without them would be cleared on a guess.
 */

import { query } from "./db/client";
import { getCampaign } from "./db/repositories/campaign.repo";
import {
  countContactsByProvider,
  countContactsMissingName,
  previewContacts,
} from "./db/repositories/contact.repo";
import { allocateCounts } from "./import/provider-allocator";
import { findScript } from "./script/script-registry";
import { validateCampaignScript } from "./script/script-validation";
import { isDialingEnabled } from "./config/campaign.config";
import type { CampaignRecord, CampaignTtsProvider } from "./domain/campaign-types";

export interface PreflightProviderLine {
  readonly provider: string;
  readonly configuredPercent: number;
  readonly targetContacts: number;
  readonly assignedContacts: number;
  /** True when what is in the database matches what the percentages ask for. */
  readonly matchesTarget: boolean;
}

export interface PreflightReport {
  readonly campaign: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly status: string;
    readonly language: string;
    readonly telephonyProvider: string;
    readonly createdAt: Date;
  };
  readonly script: {
    readonly id: string;
    readonly version: string;
    readonly hash: string;
    readonly isPlaceholder: boolean;
    readonly requiresName: boolean;
  };
  /** Provider -> agent name, derived from each provider's configured voice. */
  readonly agentsByProvider: Readonly<Record<string, string>>;
  /** A few contacts, phone-masked, so the operator can sanity-check who will be called. */
  readonly contactPreview: ReadonlyArray<{
    readonly customerName: string | null;
    readonly maskedPhone: string;
    readonly provider: string;
    readonly agentName: string | null;
    readonly campaignType: string;
    readonly script: string;
  }>;
  readonly contacts: {
    readonly total: number;
    readonly pending: number;
  };
  readonly providers: readonly PreflightProviderLine[];
  readonly lastImport: {
    readonly totalRows: number;
    readonly validRows: number;
    readonly invalidRows: number;
    readonly duplicateRowsInFile: number;
    readonly inserted: number;
    readonly skippedExisting: number;
    readonly at: Date;
  } | null;
  /** Every reason this campaign may not dial. */
  readonly blockers: readonly string[];
  /**
   * Derived from `blockers`, not asserted. It stays false while the
   * external-limits blocker stands, which is the intended state until
   * those limits are confirmed against the carrier.
   */
  readonly readyToDial: boolean;
  /**
   * Attempts that reached the telephony provider. Rehearsals recorded
   * with the kill switch off are excluded, so this is zero until
   * dialing is genuinely enabled.
   */
  readonly callsPlaced: number;
}

interface ImportEventRow {
  data: {
    totalRows?: number;
    validRows?: number;
    invalidRows?: number;
    duplicateRowsInFile?: number;
    inserted?: number;
    skippedExisting?: number;
  } | null;
  at: Date;
}

export async function buildPreflight(campaignId: string): Promise<PreflightReport | undefined> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return undefined;

  const [assigned, missingName, preview] = await Promise.all([
    countContactsByProvider(campaign.id),
    countContactsMissingName(campaign.id),
    previewContacts(campaign.id, 5),
  ]);
  const total = [...assigned.values()].reduce((sum, n) => sum + n, 0);

  const pendingResult = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM contacts WHERE campaign_id = $1 AND status = 'PENDING'",
    [campaign.id],
  );

  const callsPlacedResult = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM call_attempts
      WHERE campaign_id = $1 AND status <> 'CANCELLED'`,
    [campaign.id],
  );

  const lastImportResult = await query<ImportEventRow>(
    `SELECT data, at FROM campaign_events
      WHERE campaign_id = $1 AND code = 'CONTACTS_IMPORTED'
      ORDER BY at DESC LIMIT 1`,
    [campaign.id],
  );

  const targets = total > 0 ? allocateCounts(total, campaign.providerAllocation) : new Map();
  const providers = buildProviderLines(campaign, targets, assigned);
  const script = findScript(campaign.scriptId, campaign.scriptVersion);

  // Script + agent validation is the Phase 3A gate: these blockers are
  // what stand between a campaign and a dialable state.
  const scriptCheck = validateCampaignScript({
    campaignType: campaign.campaignType,
    scriptId: campaign.scriptId,
    scriptVersion: campaign.scriptVersion,
    scriptHash: campaign.scriptHash,
    allocatedProviders: [...assigned.keys()],
    contactsMissingName: missingName,
  });

  const blockers = [
    ...collectBlockers(campaign, total, providers, script?.isPlaceholder ?? true),
    ...scriptCheck.blockers,
  ];

  const lastImportRow = lastImportResult.rows[0];

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      type: campaign.campaignType,
      status: campaign.status,
      language: campaign.language,
      telephonyProvider: campaign.telephonyProvider,
      createdAt: campaign.createdAt,
    },
    script: {
      id: campaign.scriptId,
      version: campaign.scriptVersion,
      hash: campaign.scriptHash,
      isPlaceholder: script?.isPlaceholder ?? true,
      requiresName: script?.requiresName ?? false,
    },
    agentsByProvider: scriptCheck.agentsByProvider,
    contactPreview: preview.map((contact) => ({
      customerName: contact.name,
      maskedPhone: contact.maskedPhone,
      provider: contact.assignedProvider,
      agentName: scriptCheck.agentsByProvider[contact.assignedProvider] ?? null,
      campaignType: campaign.campaignType,
      script: `${campaign.scriptId} ${campaign.scriptVersion}`,
    })),
    contacts: { total, pending: pendingResult.rows[0]?.n ?? 0 },
    providers,
    lastImport: lastImportRow
      ? {
          totalRows: lastImportRow.data?.totalRows ?? 0,
          validRows: lastImportRow.data?.validRows ?? 0,
          invalidRows: lastImportRow.data?.invalidRows ?? 0,
          duplicateRowsInFile: lastImportRow.data?.duplicateRowsInFile ?? 0,
          inserted: lastImportRow.data?.inserted ?? 0,
          skippedExisting: lastImportRow.data?.skippedExisting ?? 0,
          at: lastImportRow.at,
        }
      : null,
    blockers,
    readyToDial: blockers.length === 0,
    callsPlaced: callsPlacedResult.rows[0]?.n ?? 0,
  };
}

function buildProviderLines(
  campaign: CampaignRecord,
  targets: ReadonlyMap<CampaignTtsProvider, number>,
  assigned: ReadonlyMap<CampaignTtsProvider, number>,
): readonly PreflightProviderLine[] {
  const providers = new Set<string>([
    ...Object.keys(campaign.providerAllocation),
    ...[...assigned.keys()],
  ]);

  return [...providers]
    .sort((a, b) => a.localeCompare(b))
    .map((provider) => {
      const key = provider as CampaignTtsProvider;
      const targetContacts = targets.get(key) ?? 0;
      const assignedContacts = assigned.get(key) ?? 0;
      return {
        provider,
        configuredPercent: campaign.providerAllocation[key] ?? 0,
        targetContacts,
        assignedContacts,
        matchesTarget: targetContacts === assignedContacts,
      };
    });
}

/**
 * Everything standing between this campaign and a real call.
 *
 * The dispatcher now exists, so the blocker that used to say it did
 * not is gone — leaving it in place would print "no code path can
 * dial" on the same page as a working Start button. What remains
 * unconditional is the external-limits entry, which is a real gate
 * rather than a formality: until Vobiz CPS, concurrency, the DID pool,
 * answering-machine detection and status callbacks are confirmed, this
 * campaign is not cleared to run at size.
 */
function collectBlockers(
  campaign: CampaignRecord,
  totalContacts: number,
  providers: readonly PreflightProviderLine[],
  scriptIsPlaceholder: boolean,
): readonly string[] {
  const blockers: string[] = [];

  if (!isDialingEnabled()) {
    blockers.push(
      "CAMPAIGN_DIALING_ENABLED is not set to true — the dispatcher will rehearse every step and place no calls.",
    );
  }
  if (totalContacts === 0) {
    blockers.push("No contacts have been imported.");
  }
  if (campaign.status !== "READY") {
    blockers.push(`Campaign status is ${campaign.status}; it must be READY.`);
  }
  const mismatched = providers.filter((line) => !line.matchesTarget);
  if (totalContacts > 0 && mismatched.length > 0) {
    blockers.push(
      `Provider assignment does not match the configured split: ${mismatched
        .map((line) => `${line.provider} has ${line.assignedContacts}, expected ${line.targetContacts}`)
        .join("; ")}.`,
    );
  }

  blockers.push(
    "External limits are unconfirmed: Vobiz CPS, Vobiz concurrent calls, DID pool, answering-machine detection, status callbacks, and CDR/billing access.",
  );

  return blockers;
}
