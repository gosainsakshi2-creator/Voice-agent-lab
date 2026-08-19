/**
 * provider-allocator.ts
 *
 * Turns a percentage allocation into an exact, reproducible,
 * well-interleaved provider assignment for any number of contacts.
 *
 * Three properties matter, and each is a deliberate design choice:
 *
 *   EXACT — largest-remainder (Hare-Niemeyer) apportionment, so the
 *   per-provider counts always sum to exactly N. Rounding each share
 *   independently does not: 33.33% of 10,000 rounded three times is
 *   9,999, and the missing contact would never be called.
 *
 *   REPRODUCIBLE — contacts are ordered by a SHA-256 of their
 *   normalized number, never by `Math.random()`. The same list and the
 *   same percentages always produce the same assignment, so a re-import
 *   after a crash lands every number on the provider it had before.
 *
 *   INTERLEAVED — assignment walks the list handing each contact to
 *   whichever provider is furthest from its target. Filling Cartesia's
 *   share first and Smallest AI's last would make one lane run in the
 *   morning and another in the evening, and the comparison would then
 *   measure time-of-day answer rates while appearing to measure the
 *   vendors.
 */

import { createHash } from "node:crypto";

import {
  CAMPAIGN_TTS_PROVIDERS,
  isCampaignTtsProvider,
  type CampaignTtsProvider,
  type ProviderAllocation,
} from "../domain/campaign-types";

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationError";
  }
}

/** Percentages must be non-negative, sum to 100, and not all be zero. */
export function validateAllocation(allocation: ProviderAllocation): ReadonlyArray<[CampaignTtsProvider, number]> {
  const entries: Array<[CampaignTtsProvider, number]> = [];

  for (const [provider, percent] of Object.entries(allocation)) {
    if (!isCampaignTtsProvider(provider)) {
      throw new AllocationError(
        `"${provider}" is not one of the campaign providers (${CAMPAIGN_TTS_PROVIDERS.join(", ")}).`,
      );
    }
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      throw new AllocationError(`Allocation for "${provider}" must be a number.`);
    }
    if (percent < 0) {
      throw new AllocationError(`Allocation for "${provider}" cannot be negative.`);
    }
    entries.push([provider, percent]);
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
 * Largest-remainder apportionment. Returns integer targets summing to
 * exactly `total`, for any `total` and any valid percentage split.
 */
export function allocateCounts(
  total: number,
  allocation: ProviderAllocation,
): ReadonlyMap<CampaignTtsProvider, number> {
  if (!Number.isInteger(total) || total < 0) {
    throw new AllocationError(`Contact total must be a non-negative integer, received ${total}.`);
  }

  const entries = validateAllocation(allocation);
  const counts = new Map<CampaignTtsProvider, number>(entries.map(([provider]) => [provider, 0]));
  if (total === 0) return counts;

  const quotas = entries.map(([provider, percent]) => {
    const exact = (total * percent) / 100;
    const floor = Math.floor(exact);
    return { provider, floor, remainder: exact - floor };
  });

  let assigned = 0;
  for (const quota of quotas) {
    counts.set(quota.provider, quota.floor);
    assigned += quota.floor;
  }

  // Hand the leftover seats to the largest fractional remainders.
  // Ties break on provider id so the result never depends on input order.
  const leftover = total - assigned;
  const byRemainder = [...quotas].sort(
    (a, b) => b.remainder - a.remainder || a.provider.localeCompare(b.provider),
  );
  for (let i = 0; i < leftover; i += 1) {
    const quota = byRemainder[i % byRemainder.length];
    if (!quota) break;
    counts.set(quota.provider, (counts.get(quota.provider) ?? 0) + 1);
  }

  return counts;
}

/** Deterministic ordering key. Same phone, same key, forever. */
export function orderingKey(normalizedPhone: string): string {
  return createHash("sha256").update(normalizedPhone, "utf8").digest("hex");
}

export interface AssignableContact {
  readonly normalizedPhone: string;
}

/**
 * Assigns each contact exactly one provider.
 *
 * `alreadyAssigned` lets a second import into the same campaign pull
 * the totals back toward the configured split rather than re-applying
 * the percentages to the new rows in isolation. Existing contacts are
 * never touched — the database forbids it — so this only steers where
 * the *new* rows go.
 */
export function assignProviders<T extends AssignableContact>(
  contacts: readonly T[],
  allocation: ProviderAllocation,
  alreadyAssigned: ReadonlyMap<CampaignTtsProvider, number> = new Map(),
): ReadonlyMap<string, CampaignTtsProvider> {
  const entries = validateAllocation(allocation);
  const providers = entries.map(([provider]) => provider);

  const existingTotal = [...alreadyAssigned.values()].reduce((sum, n) => sum + n, 0);
  const targets = allocateCounts(existingTotal + contacts.length, allocation);

  // How many of each provider these new rows still owe.
  const remaining = new Map<CampaignTtsProvider, number>();
  for (const provider of providers) {
    const deficit = (targets.get(provider) ?? 0) - (alreadyAssigned.get(provider) ?? 0);
    remaining.set(provider, Math.max(0, deficit));
  }
  rebalanceToTotal(remaining, providers, contacts.length, allocation);

  // Deterministic order, decoupled from CSV order so an
  // alphabetically-sorted list does not correlate with provider.
  const ordered = [...contacts].sort((a, b) => {
    const keyA = orderingKey(a.normalizedPhone);
    const keyB = orderingKey(b.normalizedPhone);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : a.normalizedPhone.localeCompare(b.normalizedPhone);
  });

  const assignedCount = new Map<CampaignTtsProvider, number>(providers.map((p) => [p, 0]));
  const result = new Map<string, CampaignTtsProvider>();

  for (const contact of ordered) {
    // Whoever still owes the most goes next. Because every candidate
    // shares the same number of remaining positions at this step,
    // "largest remaining share" reduces to "largest remaining count" —
    // integer comparison only, so no floating-point tie-breaking.
    let chosen: CampaignTtsProvider | undefined;
    let chosenRemaining = -1;
    let chosenAssigned = Number.POSITIVE_INFINITY;

    for (const provider of providers) {
      const providerRemaining = remaining.get(provider) ?? 0;
      if (providerRemaining <= 0) continue;
      const providerAssigned = assignedCount.get(provider) ?? 0;
      const better =
        providerRemaining > chosenRemaining ||
        // Tie on debt: prefer whoever has been handed the fewest so
        // far, which is what keeps the lanes visibly interleaved
        // rather than emitting runs of the same provider.
        (providerRemaining === chosenRemaining &&
          (providerAssigned < chosenAssigned ||
            (providerAssigned === chosenAssigned && chosen !== undefined && provider < chosen)));
      if (better) {
        chosen = provider;
        chosenRemaining = providerRemaining;
        chosenAssigned = providerAssigned;
      }
    }

    if (!chosen) {
      // Unreachable while remaining sums to contacts.length, which
      // rebalanceToTotal guarantees. Fail loudly rather than silently
      // leaving a contact unassigned and therefore never called.
      throw new AllocationError(
        `Ran out of provider capacity while assigning contact ${result.size + 1} of ${contacts.length}.`,
      );
    }

    result.set(contact.normalizedPhone, chosen);
    remaining.set(chosen, chosenRemaining - 1);
    assignedCount.set(chosen, (assignedCount.get(chosen) ?? 0) + 1);
  }

  return result;
}

/**
 * Forces `remaining` to sum to exactly `total`.
 *
 * Clamping negative deficits at zero (a provider already over its
 * target from an earlier import) can leave the sum too high or too
 * low. Corrections follow the configured percentages so the campaign
 * still converges on the requested split.
 */
function rebalanceToTotal(
  remaining: Map<CampaignTtsProvider, number>,
  providers: readonly CampaignTtsProvider[],
  total: number,
  allocation: ProviderAllocation,
): void {
  const eligible = providers.filter((p) => (allocation[p] ?? 0) > 0);
  const pool = eligible.length > 0 ? eligible : providers;

  let sum = [...remaining.values()].reduce((acc, n) => acc + n, 0);

  // Too few: hand out the shortfall largest-share first.
  while (sum < total) {
    const share = allocateCounts(total - sum, allocation);
    let progressed = false;
    for (const provider of pool) {
      const extra = share.get(provider) ?? 0;
      if (extra > 0) {
        remaining.set(provider, (remaining.get(provider) ?? 0) + extra);
        sum += extra;
        progressed = true;
      }
    }
    if (!progressed) {
      const fallback = pool[0];
      if (!fallback) break;
      remaining.set(fallback, (remaining.get(fallback) ?? 0) + (total - sum));
      sum = total;
    }
  }

  // Too many: take back from whoever currently holds the most.
  while (sum > total) {
    const ranked = [...remaining.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = ranked[0];
    if (!top) break;
    remaining.set(top[0], top[1] - 1);
    sum -= 1;
  }
}
