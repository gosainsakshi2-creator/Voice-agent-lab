/**
 * script-validation.ts
 *
 * The gate between a campaign and a dialable state.
 *
 * Every condition is checked against the campaign as stored, not
 * against what a request claimed, and each failure is returned as a
 * sentence an operator can act on rather than a boolean. Preflight
 * renders these; nothing may dial while the list is non-empty.
 */

import { findScript, hashScript, scriptVariables } from "./script-registry";
import { agentsByProvider } from "./agent-identity";
import { SUPPORTED_SCRIPT_VARIABLES } from "./variables";
import { isCampaignType, type CampaignTtsProvider } from "../domain/campaign-types";

export interface ScriptValidationInput {
  readonly campaignType: string;
  readonly scriptId: string;
  readonly scriptVersion: string;
  readonly scriptHash: string;
  /** Providers that actually have contacts assigned. */
  readonly allocatedProviders: readonly CampaignTtsProvider[];
  /** Contacts with no name, when the script needs one. */
  readonly contactsMissingName: number;
}

export interface ScriptValidationResult {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  /** Provider -> agent name, derived from each provider's configured voice. */
  readonly agentsByProvider: Readonly<Record<string, string>>;
  readonly scriptIsPlaceholder: boolean;
}

export function validateCampaignScript(input: ScriptValidationInput): ScriptValidationResult {
  const blockers: string[] = [];

  if (!isCampaignType(input.campaignType)) {
    blockers.push(`Campaign type "${input.campaignType}" is not a known campaign type.`);
  }

  const script = findScript(input.scriptId, input.scriptVersion);

  if (!script) {
    blockers.push(`Script "${input.scriptId} ${input.scriptVersion}" is not in the registry.`);
  } else {
    // A registration campaign running the reminder script would be a
    // silent, plausible-looking disaster — every call would complete
    // and every outcome would be wrong.
    if (script.campaignType !== input.campaignType) {
      blockers.push(
        `Campaign type is "${input.campaignType}" but script "${script.id} ${script.version}" is a ${script.campaignType} script.`,
      );
    }

    const currentHash = hashScript(script);
    if (currentHash !== input.scriptHash) {
      blockers.push(
        `Script content has changed since this campaign was created ` +
          `(recorded ${input.scriptHash.slice(0, 12)}…, now ${currentHash.slice(0, 12)}…). ` +
          `Publish a new version instead of editing a pinned one.`,
      );
    }

    if (script.isPlaceholder) {
      blockers.push(
        `Script "${script.id} ${script.version}" is placeholder text, not the approved campaign script. ` +
          `Install the real wording before any call is placed.`,
      );
    }

    const unknownVariables = scriptVariables(script).filter(
      (name) => !(SUPPORTED_SCRIPT_VARIABLES as readonly string[]).includes(name),
    );
    if (unknownVariables.length > 0) {
      blockers.push(
        `Script uses variable(s) the campaign layer cannot supply: ${unknownVariables.map((n) => `{{${n}}}`).join(", ")}.`,
      );
    }

    if (script.requiresName && input.contactsMissingName > 0) {
      blockers.push(
        `${input.contactsMissingName} contact(s) have no name, and this script speaks the contact's name.`,
      );
    }
  }

  // The agent's name follows each provider's already-configured voice,
  // so a campaign spanning male- and female-voiced providers is normal
  // and is NOT a blocker. The only failure here is a provider whose
  // voice gender was never declared, which would leave a call with no
  // agent name at all.
  const agents = agentsByProvider(input.allocatedProviders);
  const undeclared = input.allocatedProviders.filter((provider) => !agents.has(provider));
  if (undeclared.length > 0) {
    blockers.push(
      `No configured voice gender for ${undeclared.join(", ")} — the agent name cannot be resolved for those calls.`,
    );
  }

  return {
    ok: blockers.length === 0,
    blockers,
    agentsByProvider: Object.fromEntries([...agents].map(([p, a]) => [p, a.name])),
    scriptIsPlaceholder: script?.isPlaceholder ?? true,
  };
}
