/**
 * agent-identity.ts
 *
 * The one place a campaign's agent gender becomes an agent name.
 *
 * Kept as a single resolver, rather than a name literal sprinkled
 * through prompts and greetings, because the names are business
 * assets that will change. Changing "Ishita" anywhere else in the
 * codebase should be impossible — there is nowhere else to change it.
 */

import { TTS_VOICE_METADATA, type VoiceGender } from "../../constants/voice.constants";

export type AgentGender = VoiceGender;

export interface AgentIdentity {
  readonly gender: AgentGender;
  readonly name: string;
}

/** The current roster. One edit here renames the agent everywhere. */
const AGENT_NAMES: Readonly<Record<AgentGender, string>> = {
  male: "Rohan",
  female: "Ishita",
};

export const AGENT_GENDERS: readonly AgentGender[] = ["female", "male"];

export class AgentIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentIdentityError";
  }
}

export function isAgentGender(value: unknown): value is AgentGender {
  return value === "male" || value === "female";
}

export function resolveAgentIdentity(gender: unknown): AgentIdentity {
  if (!isAgentGender(gender)) {
    throw new AgentIdentityError(
      `Agent gender must be "male" or "female", received ${JSON.stringify(gender)}.`,
    );
  }
  return { gender, name: AGENT_NAMES[gender] };
}

/**
 * The agent for a call, derived from the TTS provider that call is
 * assigned to.
 *
 * This is the authoritative resolver. The agent's name follows the
 * gender of the provider's ALREADY-CONFIGURED voice — read from
 * `TTS_VOICE_METADATA`, the single source of truth — rather than being
 * chosen per campaign. That is what keeps the voice and the name in
 * agreement on every call without touching a single voice id:
 *
 *   cartesia     -> male voice   -> Rohan
 *   sarvam       -> male voice   -> Rohan
 *   smallest-ai  -> female voice -> Ishita
 *
 * A campaign therefore runs Rohan on two lanes and Ishita on one, by
 * design. The benchmarked voices stay exactly as they are.
 */
export function resolveAgentForProvider(providerId: string): AgentIdentity {
  const gender = TTS_VOICE_METADATA.get(providerId);
  if (gender === undefined) {
    throw new AgentIdentityError(
      `No configured voice gender for TTS provider "${providerId}" — add it to voice.constants.ts.`,
    );
  }
  return { gender, name: AGENT_NAMES[gender] };
}

/** Provider -> agent, for preflight and the creation preview. */
export function agentsByProvider(providerIds: readonly string[]): ReadonlyMap<string, AgentIdentity> {
  const result = new Map<string, AgentIdentity>();
  for (const providerId of providerIds) {
    const gender = TTS_VOICE_METADATA.get(providerId);
    if (gender !== undefined) result.set(providerId, { gender, name: AGENT_NAMES[gender] });
  }
  return result;
}
