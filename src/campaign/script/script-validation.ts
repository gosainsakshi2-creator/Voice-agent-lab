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
import type { CampaignScript } from "./script-types";
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
  /**
   * ADDITIVE, OPTIONAL. The moment to judge the script's declared event
   * date against. Defaults to now, so every existing caller is
   * unchanged; passed explicitly only by the tests, which must be able
   * to assert both sides of the boundary without waiting for a date to
   * pass.
   */
  readonly now?: Date;
}

export interface ScriptValidationResult {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  /** Provider -> agent name, derived from each provider's configured voice. */
  readonly agentsByProvider: Readonly<Record<string, string>>;
  readonly scriptIsPlaceholder: boolean;
}

/**
 * An ISO 8601 instant that carries its own offset — the only spelling
 * `eventAt` accepts. See `eventDateBlocker` for why the format is
 * checked rather than merely parsed.
 */
const ISO_INSTANT_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Has the event this script invites people to already happened?
 *
 * Returns the operator-readable blocker, or `undefined` when there is
 * nothing wrong — the same shape every other check in this file
 * produces, lifted out for one reason: `validateCampaignScript`
 * resolves its script from the registry by id and version, so a script
 * carrying a malformed date cannot be handed to it, and the branch that
 * catches one could not otherwise be tested at all. A defensive branch
 * no test can reach is decoration.
 *
 * Exported for that test and read by nothing else in production.
 *
 * WHY THIS CHECK EXISTS. A script states its date in prose, inside text
 * that is immutable and pinned by content hash, so nothing here could
 * ever read it. `registration v5` went on inviting people to "this
 * Sunday, 6th September" after 6 September had passed — and answered
 * their "when is it?" with the same wrong date from its own FAQ list.
 * Every other blocker in this file protects a campaign from a mistake
 * made at setup; this one protects it from the passage of time, which
 * is the only failure that arrives on its own.
 *
 * ONLY A SCRIPT THAT DECLARES A DATE IS HELD TO ONE. `eventAt` is
 * optional (see `CampaignScript`), so every script written before it
 * validates exactly as it did. That is the narrow, additive choice, and
 * its cost is worth stating plainly: a campaign pinned to an older
 * version with a stale date in its prose is still not caught. The fix
 * for that is to declare `eventAt` on the version in question — the
 * field is outside the content hash, so doing so invalidates nothing —
 * and that is a deliberate follow-up rather than something to do
 * silently here.
 *
 * AN UNREADABLE DATE IS ALSO A BLOCKER. A declared date the campaign
 * layer cannot parse is worse than none: it reads as protection and
 * provides none.
 */
export function eventDateBlocker(script: CampaignScript, now: Date): string | undefined {
  if (script.eventAt === undefined) return undefined;
  const eventAt = new Date(script.eventAt);
  // THE SHAPE IS CHECKED, NOT JUST THE PARSE, and the reason is that
  // `new Date` succeeds on things nobody meant. "04/10/2026" is a
  // perfectly valid Date — 10 APRIL, read as month-first — so a script
  // meaning 4 October would sail past a parseability check carrying a
  // date six months wrong, which is worse than the stale date this
  // function exists to catch. An offset is required too: without one an
  // ISO string is read as UTC, and an 11 AM IST event would be checked
  // five and a half hours late.
  if (!ISO_INSTANT_WITH_OFFSET.test(script.eventAt) || Number.isNaN(eventAt.getTime())) {
    return (
      `Script "${script.id} ${script.version}" declares an event date the campaign layer cannot read ` +
      `("${script.eventAt}"). Use an ISO 8601 instant with an offset, e.g. "2026-10-04T11:00:00+05:30".`
    );
  }
  if (eventAt.getTime() > now.getTime()) return undefined;
  return (
    `Script "${script.id} ${script.version}" invites people to an event that has already happened ` +
    `(${eventAt.toISOString()}). Publish a new version with the correct date — every call on this ` +
    `script states that date as a fact and answers "when is it?" with it.`
  );
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

    // ── The event has already happened ────────────────────────────
    //
    // A script states its date in prose, inside text that is immutable
    // and pinned by content hash, so nothing here could ever read it.
    // `registration v5` therefore went on inviting people to "this
    // Sunday, 6th September" after 6 September had passed — and
    // answered their "when is it?" with the same wrong date from its
    // own FAQ list. Every other blocker in this function protects the
    // campaign from a mistake made at setup; this one protects it from
    // the passage of time, which is the only failure that arrives on
    // its own.
    //
    // ONLY A SCRIPT THAT DECLARES A DATE IS HELD TO ONE. `eventAt` is
    // optional (see `CampaignScript`), so every script written before
    // it validates exactly as it did. That is the narrow, additive
    // choice, and its cost is worth stating plainly: a campaign pinned
    // to an older version with a stale date in its prose is still not
    // caught. The fix for that is to declare `eventAt` on the version
    // in question — it is outside the content hash, so doing so
    // invalidates nothing — and that is a deliberate follow-up rather
    // than something to do silently here.
    //
    // An UNREADABLE declared date is a blocker too. A date the campaign
    // layer cannot parse is worse than none: it reads as protection and
    // provides none.
    const staleEvent = eventDateBlocker(script, input.now ?? new Date());
    if (staleEvent) blockers.push(staleEvent);
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
