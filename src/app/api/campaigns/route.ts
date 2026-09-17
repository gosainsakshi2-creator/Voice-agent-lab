import { NextResponse } from "next/server";

import { createCampaignIdempotent, listCampaigns } from "@/campaign/db/repositories/campaign.repo";
import { defaultScriptFor, describeScript, findScript, hashScript, listScripts } from "@/campaign/script/script-registry";
import { validateAllocation, AllocationError } from "@/campaign/import/provider-allocator";
import { validatePercentageAllocation } from "@/campaign/domain/allocation";
import {
  CAMPAIGN_LLM_PROVIDERS,
  CAMPAIGN_TELEPHONY_PROVIDERS,
  DEFAULT_LLM_ALLOCATION,
  isCampaignTelephonyProvider,
  isCampaignType,
  type LlmAllocation,
  type ProviderAllocation,
  type TelephonyAllocation,
  CAMPAIGN_STT_PROVIDERS,
  isCampaignSttProvider,
} from "@/campaign/domain/campaign-types";

export const dynamic = "force-dynamic";

/**
 * Campaign creation and listing.
 *
 * Creating a campaign places no calls and contacts no provider — it
 * writes one row. Dialing does not exist anywhere in the project yet.
 */

interface CreateBody {
  name?: string;
  campaignType?: string;
  language?: string;
  scriptId?: string;
  scriptVersion?: string;
  providerAllocation?: ProviderAllocation;
  telephonyProvider?: string;
  /**
   * The campaign's speech-to-text provider. A SINGLE id, not an
   * allocation — STT is not split across contacts. Omitted means "no
   * explicit choice", which the dispatcher resolves to Deepgram.
   */
  sttProvider?: string;
  llmAllocation?: LlmAllocation;
  telephonyAllocation?: TelephonyAllocation;
  idempotencyKey?: string;
}

export async function GET() {
  try {
    const [campaigns, scripts] = await Promise.all([listCampaigns(), Promise.resolve(listScripts())]);
    return NextResponse.json({
      campaigns,
      scripts: scripts.map(describeScript),
    });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "A campaign name is required." }, { status: 400 });

  const campaignType = body.campaignType?.trim() ?? "";
  if (!isCampaignType(campaignType)) {
    return NextResponse.json(
      { error: `Campaign type must be "registration" or "reminder".` },
      { status: 400 },
    );
  }

  // An idempotency key is required rather than optional: without one,
  // a refreshed browser or a retried request creates a second campaign
  // and the contact list silently splits across two of them.
  const idempotencyKey = body.idempotencyKey?.trim();
  if (!idempotencyKey) {
    return NextResponse.json({ error: "An idempotencyKey is required." }, { status: 400 });
  }

  const script =
    body.scriptId && body.scriptVersion
      ? findScript(body.scriptId, body.scriptVersion)
      : defaultScriptFor(campaignType);

  if (!script) {
    return NextResponse.json(
      { error: `No script found for "${body.scriptId} ${body.scriptVersion}".` },
      { status: 400 },
    );
  }
  if (script.campaignType !== campaignType) {
    return NextResponse.json(
      { error: `Script "${script.id}" is for ${script.campaignType} campaigns, not ${campaignType}.` },
      { status: 400 },
    );
  }

  const allocation = body.providerAllocation ?? {};

  // ── The three provider dimensions, each validated the same way ────
  //
  // Independent on purpose: a campaign may split TTS four ways while
  // running one model and one carrier, or any other combination. Each
  // is checked against ITS OWN canonical id list, so a TTS id offered
  // as a carrier is rejected rather than silently stored.
  //
  // `telephonyProvider` used to be `body.telephonyProvider?.trim() ||
  // "vobiz"` — accepted verbatim, never checked. A value that was not a
  // registered provider id (a capitalised "Plivo", a typo) persisted
  // happily and then failed at `createSession` for every contact in the
  // campaign, one call at a time. It now fails closed, here, before a
  // row exists.
  // ── Speech-to-text provider ─────────────────────────────────────
  // Rejected up front, like every other provider id, so a typo is a
  // 400 at creation rather than a failed dial an hour later.
  const rawStt = body.sttProvider?.trim().toLowerCase();
  if (rawStt !== undefined && rawStt.length > 0 && !isCampaignSttProvider(rawStt)) {
    return NextResponse.json(
      {
        error: `"${rawStt}" is not a supported speech-to-text provider (${CAMPAIGN_STT_PROVIDERS.join(", ")}).`,
      },
      { status: 400 },
    );
  }
  const sttProvider = rawStt !== undefined && rawStt.length > 0 ? rawStt : undefined;

  let llmAllocation: LlmAllocation;
  let telephonyAllocation: TelephonyAllocation;
  try {
    validateAllocation(allocation);

    // NEW campaigns only. An existing campaign is never re-read through
    // this path, so nothing already stored is affected by the default.
    llmAllocation = body.llmAllocation ?? DEFAULT_LLM_ALLOCATION;
    validatePercentageAllocation(llmAllocation, CAMPAIGN_LLM_PROVIDERS, "campaign language models");

    telephonyAllocation = resolveTelephonyAllocation(body);
    validatePercentageAllocation(
      telephonyAllocation,
      CAMPAIGN_TELEPHONY_PROVIDERS,
      "campaign telephony providers",
    );
  } catch (error) {
    if (error instanceof AllocationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  try {
    const { campaign, created } = await createCampaignIdempotent({
      name,
      campaignType,
      language: body.language?.trim() || "en",
      scriptId: script.id,
      scriptVersion: script.version,
      scriptHash: hashScript(script),
      providerAllocation: allocation,
      // The single-carrier column predates the split and is still read
      // by the dispatcher's legacy path and by anything that reports one
      // carrier per campaign, so it is kept in agreement with the
      // allocation rather than left behind: it names whichever carrier
      // holds the largest share.
      telephonyProvider: dominantProvider(telephonyAllocation),
      // Validated against the supported set rather than stored as
      // typed: a campaign must never be persisted pointing at a
      // recognizer that does not exist, because the failure would not
      // surface until it tried to dial. Absent stays absent — the
      // column records a decision, and "not chosen" is a real answer.
      ...(sttProvider !== undefined ? { sttProvider } : {}),
      // Both new dimensions live in `dispatch_config`, following the
      // exact precedent `agent.gender` set — no migration, and the
      // Phase 1 schema stays frozen. `dispatch_config` is JSONB with no
      // shape constraint, nothing else reads these keys, and the values
      // are small fixed maps, so this is a safe use of it rather than a
      // workaround.
      dispatchConfig: {
        note: "Dispatch configuration is set in a later phase.",
        llmAllocation,
        telephonyAllocation,
      },
      idempotencyKey,
    });

    return NextResponse.json(
      { campaign, created, callsPlaced: 0 },
      { status: created ? 201 : 200 },
    );
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 500 });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The carrier split for a NEW campaign, in precedence order:
 *
 *   1. An explicit `telephonyAllocation` — the new, general form.
 *   2. A `telephonyProvider` — the single-carrier form the Dashboard
 *      and any existing caller may still send. Read as 100% of that
 *      carrier, and now VALIDATED: an unknown id raises rather than
 *      being stored and failing later, one call at a time.
 *   3. Vobiz at 100%.
 *
 * Vobiz is the default because it is the carrier this programme's live
 * campaigns already run on — the safest existing convention, and the
 * one the previous `|| "vobiz"` encoded. Choosing Plivo here would
 * change where every future campaign dials without anyone asking for
 * it.
 */
function resolveTelephonyAllocation(body: CreateBody): TelephonyAllocation {
  if (body.telephonyAllocation) return body.telephonyAllocation;

  const named = body.telephonyProvider?.trim();
  if (named) {
    if (!isCampaignTelephonyProvider(named)) {
      throw new AllocationError(
        `"${named}" is not one of the campaign telephony providers (${CAMPAIGN_TELEPHONY_PROVIDERS.join(", ")}).`,
      );
    }
    return { [named]: 100 };
  }

  return { vobiz: 100 };
}

/** The largest-share entry, ties broken on id so the result never depends on key order. */
function dominantProvider(allocation: TelephonyAllocation): string {
  const ranked = Object.entries(allocation)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // `validatePercentageAllocation` has already refused an all-zero
  // split, so `ranked` cannot be empty by the time this is called.
  return ranked[0]?.[0] ?? "vobiz";
}
