/**
 * allocation.ts
 *
 * The percentage-allocation primitives shared by the campaign's three
 * INDEPENDENT provider dimensions: TTS, language model and telephony.
 *
 * WHY THIS FILE EXISTS. The TTS split already had a validator, and
 * copying it twice more — once for the LLM dimension, once for
 * telephony — would have left three near-identical tables of rules
 * that drift apart the first time one of them is corrected. What is
 * genuinely shared is only the RULES ("non-negative, sums to 100, not
 * all zero, ids must be known"), so only the rules live here.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. The contact-level apportionment in
 * `import/provider-allocator.ts` — largest-remainder counts, the
 * SHA-256 contact ordering, the interleaving walk — is untouched and
 * stays where it is. That code is load-bearing for a live campaign's
 * TTS lanes and for the database's provider-immutability guarantees,
 * and this change does not reach into it beyond having it call
 * `validatePercentageAllocation` for the rules it was already
 * applying. Its behaviour, its error messages and its output for any
 * given input are unchanged.
 *
 * TWO DIFFERENT QUESTIONS, TWO DIFFERENT FUNCTIONS:
 *
 *   TTS is apportioned ACROSS A KNOWN LIST of contacts at import time
 *   and then locked per contact by a database trigger, so it needs
 *   exact counts — `allocateCounts` in provider-allocator.ts.
 *
 *   LLM and telephony are chosen PER CALL, campaign-wide, with no
 *   import-time list to apportion over and nothing locked. That needs
 *   a stateless, reproducible pick — `pickByAllocation` below.
 */

/**
 * Raised for any malformed allocation, in any dimension.
 *
 * Deliberately declared here rather than in `provider-allocator.ts`,
 * which now re-exports it: that keeps every existing
 * `import { AllocationError } from ".../provider-allocator"` working
 * byte-for-byte while giving the two newer dimensions the same error
 * type, so an API route's `instanceof` check covers all three without
 * knowing there are three.
 */
export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationError";
  }
}

/** A percentage split over some set of provider ids. */
export type PercentageAllocation<P extends string> = Readonly<Partial<Record<P, number>>>;

/**
 * Validates a percentage split and returns its entries in a stable
 * order.
 *
 * The rules, and the wording of every message, are carried over
 * verbatim from the TTS validator this replaces, so the existing
 * allocation tests continue to assert exactly what they asserted
 * before. `allowedIds` and `dimensionLabel` are what make it reusable:
 * they are the only things that differed between the three copies this
 * would otherwise have become.
 */
export function validatePercentageAllocation<P extends string>(
  allocation: PercentageAllocation<P>,
  allowedIds: readonly P[],
  dimensionLabel: string,
): ReadonlyArray<[P, number]> {
  const entries: Array<[P, number]> = [];

  for (const [provider, percent] of Object.entries(allocation)) {
    if (!(allowedIds as readonly string[]).includes(provider)) {
      throw new AllocationError(
        `"${provider}" is not one of the ${dimensionLabel} (${allowedIds.join(", ")}).`,
      );
    }
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      throw new AllocationError(`Allocation for "${provider}" must be a number.`);
    }
    if (percent < 0) {
      throw new AllocationError(`Allocation for "${provider}" cannot be negative.`);
    }
    entries.push([provider as P, percent]);
  }

  if (entries.length === 0) {
    throw new AllocationError("At least one provider must be allocated.");
  }

  const total = entries.reduce((sum, [, percent]) => sum + percent, 0);
  // Percentages like 33.33 x3 cannot sum to exactly 100 in binary
  // floating point, so compare against a tolerance rather than ===.
  if (Math.abs(total - 100) > 1e-6) {
    throw new AllocationError(`Allocation must total 100%. It currently totals ${total.toFixed(4)}%.`);
  }

  if (!entries.some(([, percent]) => percent > 0)) {
    throw new AllocationError("At least one provider must have an allocation above 0%.");
  }

  // Stable order so every downstream tie-break is deterministic.
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * A stable 32-bit hash of `key`, as a fraction in [0, 1).
 *
 * FNV-1a rather than SHA-256 deliberately: this runs once per call
 * placement on the dispatcher's hot path, the input is a UUID that is
 * already uniformly distributed, and nothing here is a security
 * boundary — the only property required is that the same key always
 * produces the same fraction, in this process and in every future one.
 */
function stableFraction(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in uint32 range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

/**
 * Picks ONE provider for ONE call, according to the configured split.
 *
 * Reproducible: the same `key` and the same percentages always return
 * the same provider, in this process and after a restart. That is what
 * makes a retry of a given contact land on the provider its earlier
 * attempts used, so a contact's attempts stay comparable to each other
 * and an operator reading two rows for one number is not looking at two
 * different stacks without being told.
 *
 * Proportional: keys are uniformly distributed, so over a campaign the
 * share each provider receives converges on its configured percentage.
 * This is NOT exact apportionment and is not meant to be — a 50/50
 * split over 10 calls may land 6/4. Where exactness matters (the TTS
 * lanes, which must be comparable vendor-to-vendor) the contact-level
 * `allocateCounts` path is used instead and is unchanged.
 *
 * A provider allocated 0% occupies a zero-width band and can therefore
 * never be returned — "0%" means "never", with no special case needed.
 */
export function pickByAllocation<P extends string>(
  key: string,
  entries: ReadonlyArray<[P, number]>,
): P {
  const total = entries.reduce((sum, [, percent]) => sum + percent, 0);
  if (total <= 0) {
    // Unreachable via `validatePercentageAllocation`, which rejects an
    // all-zero split. Thrown rather than defaulted because a silent
    // fallback here would attribute a call to a provider the campaign
    // never selected, which is the one thing attribution must not do.
    throw new AllocationError("Cannot pick a provider from an allocation that totals 0%.");
  }

  const target = stableFraction(key) * total;
  let cumulative = 0;
  for (const [provider, percent] of entries) {
    cumulative += percent;
    if (target < cumulative) return provider;
  }

  // Floating-point tail: `target` can land a hair above the final
  // cumulative sum. The last entry with a positive share owns it.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry && entry[1] > 0) return entry[0];
  }
  throw new AllocationError("Cannot pick a provider from an allocation that totals 0%.");
}
