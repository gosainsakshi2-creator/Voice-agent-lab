import { NextResponse } from "next/server";

import { createCampaignIdempotent, listCampaigns } from "@/campaign/db/repositories/campaign.repo";
import { defaultScriptFor, describeScript, findScript, hashScript, listScripts } from "@/campaign/script/script-registry";
import { validateAllocation, AllocationError } from "@/campaign/import/provider-allocator";
import { isCampaignType, type ProviderAllocation } from "@/campaign/domain/campaign-types";

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
  try {
    validateAllocation(allocation);
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
      // Recorded, not used. Nothing dials in this phase.
      telephonyProvider: body.telephonyProvider?.trim() || "vobiz",
      dispatchConfig: { note: "Dispatch configuration is set in a later phase." },
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
