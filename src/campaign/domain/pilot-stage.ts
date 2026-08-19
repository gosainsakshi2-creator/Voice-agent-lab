/**
 * pilot-stage.ts
 *
 * The pilot ladder: 10 calls, then 50, then 100, then 500, then the
 * full list. `campaigns.pilot_stage` has held this number since Phase
 * 1 and nothing has ever read it; this is what reads it.
 *
 * The ladder is a CEILING, never a target. Three limits can apply to a
 * single run — the deployment-wide `CAMPAIGN_STAGE_MAX_CALLS`, this
 * ladder, and an operator's per-campaign ceiling — and the smallest
 * one wins. That direction is deliberate: every control in this file
 * can only ever reduce the number of calls placed, so no combination
 * of settings, and no mistake in reading them, can dial more people
 * than the environment already permits.
 *
 * A consequence worth stating plainly rather than hiding: advancing a
 * campaign to stage 2 does NOT raise it above `CAMPAIGN_STAGE_MAX_CALLS`.
 * If the environment says 10, the run places 10 whatever the stage
 * says, and `describeCallCeiling` reports which limit actually bound
 * so the operator is told why rather than left to guess.
 */

/** Ceiling for each rung. `null` on the last rung means "the whole list". */
export const PILOT_LADDER: readonly (number | null)[] = [10, 50, 100, 500, null];

export const MAX_PILOT_STAGE = PILOT_LADDER.length - 1;

export function isPilotStage(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_PILOT_STAGE;
}

export function pilotStageCeiling(stage: number): number | null {
  if (!isPilotStage(stage)) return PILOT_LADDER[0] ?? 10;
  return PILOT_LADDER[stage] ?? null;
}

export function describePilotStage(stage: number): string {
  const ceiling = pilotStageCeiling(stage);
  return ceiling === null ? `stage ${stage} (full list)` : `stage ${stage} (${ceiling} calls)`;
}

export interface CallCeiling {
  /** The number the dispatcher will actually be given. */
  readonly effective: number;
  /** Which limit produced it, named so the UI can explain itself. */
  readonly boundBy: "environment" | "pilot-stage" | "campaign-control";
  readonly environmentMax: number;
  readonly pilotStage: number;
  readonly pilotStageMax: number | null;
  readonly campaignControlMax: number | null;
}

/**
 * Resolves the three ceilings into the one the run gets.
 *
 * Ties resolve towards `environment`, then `pilot-stage`: when two
 * limits are equal it does not matter which is reported as binding,
 * but it does matter that the answer is stable rather than depending
 * on comparison order.
 */
export function describeCallCeiling(input: {
  readonly environmentMax: number;
  readonly pilotStage: number;
  readonly campaignControlMax: number | null;
}): CallCeiling {
  const pilotStageMax = pilotStageCeiling(input.pilotStage);
  const candidates: ReadonlyArray<{ value: number; source: CallCeiling["boundBy"] }> = [
    { value: input.environmentMax, source: "environment" },
    ...(pilotStageMax !== null ? [{ value: pilotStageMax, source: "pilot-stage" as const }] : []),
    ...(input.campaignControlMax !== null
      ? [{ value: input.campaignControlMax, source: "campaign-control" as const }]
      : []),
  ];

  let winner = candidates[0] ?? { value: input.environmentMax, source: "environment" as const };
  for (const candidate of candidates) {
    if (candidate.value < winner.value) winner = candidate;
  }

  return {
    effective: winner.value,
    boundBy: winner.source,
    environmentMax: input.environmentMax,
    pilotStage: input.pilotStage,
    pilotStageMax,
    campaignControlMax: input.campaignControlMax,
  };
}
