/**
 * campaign-context.ts
 *
 * Builds the campaign context a session is created with.
 *
 * This is the boundary object: everything the voice agent needs to run
 * a campaign call, and nothing else. Database ids, CSV metadata,
 * allocation bookkeeping and contact status all stay on this side of
 * it — the session receives an agent, a customer name, and two pieces
 * of finished text.
 *
 * Interpolation happens HERE, once, before the session exists. By the
 * time the pipeline sees the strings there are no placeholders left to
 * resolve and no way for an unresolved `{{customer_name}}` to be
 * spoken aloud.
 */

import type { CampaignSessionContext } from "../../types/session.types";
import { resolveAgentForProvider } from "../script/agent-identity";
import { hashScript, type CampaignScript } from "../script/script-registry";
import { interpolate, ScriptVariableError } from "../script/variables";

export interface BuildCampaignContextInput {
  readonly campaignId: string;
  readonly campaignType: string;
  readonly script: CampaignScript;
  /**
   * The contact's assigned TTS provider. The agent's identity is
   * derived from it, so the voice the caller hears and the name it
   * gives always agree.
   */
  readonly provider: string;
  /** From `contacts.name`, which the CSV importer populated. */
  readonly customerName: string | null;
  /** The hash stored on the campaign when it was created. */
  readonly expectedScriptHash?: string;
}

export class CampaignContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignContextError";
  }
}

/**
 * Produces the finished, fully-interpolated context, or throws.
 *
 * Throwing is the point. A campaign call with no customer name would
 * otherwise open with "Hi , this is Ishita" — a real call, to a real
 * person, that announces itself as broken in the first three words.
 * Refusing to build the context means the call is never placed.
 */
export function buildCampaignContext(input: BuildCampaignContextInput): CampaignSessionContext {
  const { script, campaignId, campaignType } = input;

  const agent = resolveAgentForProvider(input.provider);

  const customerName = (input.customerName ?? "").trim();
  if (script.requiresName && customerName.length === 0) {
    throw new CampaignContextError(
      `Script "${script.id} ${script.version}" needs the contact's name, and this contact has none. ` +
        `Re-import with a name column mapped, or use a script that does not require one.`,
    );
  }

  // The stored hash is the campaign's record of which words it agreed
  // to run. If the script file has been edited since, the campaign
  // must not quietly start speaking the new text.
  const currentHash = hashScript(script);
  if (input.expectedScriptHash !== undefined && input.expectedScriptHash !== currentHash) {
    throw new CampaignContextError(
      `Script "${script.id} ${script.version}" has changed since this campaign was created ` +
        `(recorded ${input.expectedScriptHash.slice(0, 12)}…, now ${currentHash.slice(0, 12)}…). ` +
        `Create a new script version rather than editing one a campaign is pinned to.`,
    );
  }

  const variables = { customer_name: customerName, agent_name: agent.name };

  try {
    return {
      campaignId,
      campaignType,
      scriptId: script.id,
      scriptVersion: script.version,
      scriptHash: currentHash,
      agent: { gender: agent.gender, name: agent.name },
      customer: { name: customerName },
      systemPromptAppendix: interpolate(script.systemPromptAppendix, variables),
      openingLine: interpolate(script.openingLineTemplate, variables),
    };
  } catch (error) {
    if (error instanceof ScriptVariableError) {
      throw new CampaignContextError(
        `Cannot prepare script "${script.id} ${script.version}": ${error.message}`,
      );
    }
    throw error;
  }
}
