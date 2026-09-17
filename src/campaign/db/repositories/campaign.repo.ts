/**
 * campaign.repo.ts
 *
 * Campaign persistence. All SQL for the `campaigns` table lives here
 * so the constraint behaviour it relies on is visible in one place.
 */

import type { PoolClient } from "pg";

import { query } from "../client";
import {
  LEGACY_LLM_ALLOCATION,
  isCampaignLlmProvider,
  isCampaignTelephonyProvider,
  type CampaignRecord,
  type CampaignStatus,
  type LlmAllocation,
  type ProviderAllocation,
  type TelephonyAllocation,
} from "../../domain/campaign-types";

interface CampaignRow {
  id: string;
  name: string;
  campaign_type: string;
  status: CampaignStatus;
  script_id: string;
  script_version: string;
  script_hash: string;
  provider_allocation: ProviderAllocation;
  telephony_provider: string;
  /** NULL for campaigns created before STT became selectable. */
  stt_provider: string | null;
  language: string;
  dispatch_config: Record<string, unknown>;
  total_contacts: number;
  pilot_stage: number;
  idempotency_key: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

function toRecord(row: CampaignRow): CampaignRecord {
  return {
    id: row.id,
    name: row.name,
    campaignType: row.campaign_type,
    status: row.status,
    scriptId: row.script_id,
    scriptVersion: row.script_version,
    scriptHash: row.script_hash,
    providerAllocation: row.provider_allocation,
    telephonyProvider: row.telephony_provider,
    // Absent, never defaulted here: "no choice was made" and "chose
    // Deepgram" are different facts, and `resolveCallProviderStack` is
    // the single place that turns the first into the second.
    ...(row.stt_provider !== null ? { sttProvider: row.stt_provider } : {}),
    language: row.language,
    dispatchConfig: row.dispatch_config,
    agentGender: readAgentGender(row.dispatch_config),
    llmAllocation: readLlmAllocation(row.dispatch_config),
    telephonyAllocation: readTelephonyAllocation(row.dispatch_config, row.telephony_provider),
    totalContacts: row.total_contacts,
    pilotStage: row.pilot_stage,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * Agent identity lives in the `dispatch_config` JSONB rather than in a
 * dedicated column: Phase 1's schema is frozen, and this keeps Phase
 * 3A free of a migration. Anything unreadable resolves to null, which
 * the script validator then reports as a blocker.
 */
function readAgentGender(config: Record<string, unknown>): "male" | "female" | null {
  const agent = config?.["agent"];
  if (typeof agent !== "object" || agent === null) return null;
  const gender = (agent as Record<string, unknown>)["gender"];
  return gender === "male" || gender === "female" ? gender : null;
}

/**
 * Reads one percentage map out of `dispatch_config`, keeping only
 * entries whose id is currently known and whose share is a usable
 * number.
 *
 * Returns `undefined` — NOT an empty object — when there is nothing
 * usable, so each caller below can apply its own "what did this
 * campaign do before the field existed" answer rather than inventing a
 * split here. Unknown ids are dropped rather than throwing: a read path
 * that refuses to load a campaign because one entry is stale would take
 * the whole campaign offline, and the allocation is validated properly
 * on the way IN, at the API boundary.
 */
function readAllocation<P extends string>(
  config: Record<string, unknown>,
  key: string,
  isKnownId: (value: string) => value is P,
): Readonly<Partial<Record<P, number>>> | undefined {
  const raw = config?.[key];
  if (typeof raw !== "object" || raw === null) return undefined;

  const parsed: Partial<Record<P, number>> = {};
  let usable = 0;
  for (const [id, percent] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKnownId(id)) continue;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) continue;
    parsed[id] = percent;
    usable += percent;
  }

  return usable > 0 ? parsed : undefined;
}

/**
 * The campaign's LLM split.
 *
 * Absent for every campaign created before the dimension existed, and
 * those campaigns ran on the call runner's `"gpt-5.1"` literal — so the
 * fallback is that exact behaviour, not a new default. The 50/50 the UI
 * offers is applied when a campaign is CREATED and is stored; it is
 * never substituted in here, which is what keeps an existing campaign
 * from silently starting to route half its calls to a different model.
 */
function readLlmAllocation(config: Record<string, unknown>): LlmAllocation {
  return readAllocation(config, "llmAllocation", isCampaignLlmProvider) ?? LEGACY_LLM_ALLOCATION;
}

/**
 * The campaign's carrier split.
 *
 * Absent for every campaign created before the dimension existed, and
 * those campaigns dialled through the `telephony_provider` column —
 * so the fallback is 100% of that column's value, whatever it is.
 */
function readTelephonyAllocation(
  config: Record<string, unknown>,
  telephonyProviderColumn: string,
): TelephonyAllocation {
  const stored = readAllocation(config, "telephonyAllocation", isCampaignTelephonyProvider);
  if (stored) return stored;
  return isCampaignTelephonyProvider(telephonyProviderColumn)
    ? { [telephonyProviderColumn]: 100 }
    : {};
}

const SELECT_COLUMNS = `
  id, name, campaign_type, status, script_id, script_version, script_hash,
  provider_allocation, telephony_provider, stt_provider, language, dispatch_config,
  total_contacts, pilot_stage, idempotency_key, created_at, started_at, completed_at
`;

export interface CreateCampaignInput {
  readonly name: string;
  readonly campaignType: string;
  readonly language: string;
  readonly scriptId: string;
  readonly scriptVersion: string;
  readonly scriptHash: string;
  readonly providerAllocation: ProviderAllocation;
  readonly telephonyProvider: string;
  /** Omitted means "no explicit choice" — stored as NULL, resolved to the default at dial time. */
  readonly sttProvider?: string | undefined;
  readonly dispatchConfig: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

/**
 * Creates a campaign, or returns the existing one when the same
 * idempotency key has already been used.
 *
 * `ON CONFLICT DO NOTHING` plus a follow-up read, rather than a
 * check-then-insert: two requests arriving together — a
 * double-clicked button, a retried fetch — would both pass a prior
 * existence check and both insert. Here the unique index decides, and
 * the loser reads back the winner's row.
 */
export async function createCampaignIdempotent(
  input: CreateCampaignInput,
): Promise<{ campaign: CampaignRecord; created: boolean }> {
  const inserted = await query<CampaignRow>(
    `INSERT INTO campaigns
       (name, campaign_type, language, script_id, script_version, script_hash,
        provider_allocation, telephony_provider, stt_provider, dispatch_config,
        idempotency_key, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, 'DRAFT')
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.name,
      input.campaignType,
      input.language,
      input.scriptId,
      input.scriptVersion,
      input.scriptHash,
      JSON.stringify(input.providerAllocation),
      input.telephonyProvider,
      // NULL, not a substituted default: the column records a decision.
      input.sttProvider ?? null,
      JSON.stringify(input.dispatchConfig),
      input.idempotencyKey,
    ],
  );

  const insertedRow = inserted.rows[0];
  if (insertedRow) return { campaign: toRecord(insertedRow), created: true };

  const existing = await query<CampaignRow>(
    `SELECT ${SELECT_COLUMNS} FROM campaigns WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  const existingRow = existing.rows[0];
  if (!existingRow) {
    throw new Error("Campaign was neither created nor found — the insert conflicted with nothing.");
  }
  return { campaign: toRecord(existingRow), created: false };
}

export async function getCampaign(id: string): Promise<CampaignRecord | undefined> {
  const result = await query<CampaignRow>(`SELECT ${SELECT_COLUMNS} FROM campaigns WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toRecord(row) : undefined;
}

export async function listCampaigns(limit = 50): Promise<readonly CampaignRecord[]> {
  const result = await query<CampaignRow>(
    `SELECT ${SELECT_COLUMNS} FROM campaigns ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map(toRecord);
}

/** Status transition inside a caller-supplied transaction. */
export async function setCampaignStatus(
  client: PoolClient,
  id: string,
  status: CampaignStatus,
): Promise<void> {
  await client.query("UPDATE campaigns SET status = $2 WHERE id = $1", [id, status]);
}

export async function setTotalContacts(
  client: PoolClient,
  id: string,
  totalContacts: number,
): Promise<void> {
  await client.query("UPDATE campaigns SET total_contacts = $2 WHERE id = $1", [id, totalContacts]);
}
