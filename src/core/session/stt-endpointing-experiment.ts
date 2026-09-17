/**
 * stt-endpointing-experiment.ts
 *
 * PHASE 3 — CONTROLLED ENDPOINTING A/B. Assignment plumbing only.
 * This file decides, ONCE PER CALL ATTEMPT, which Deepgram
 * `endpointing` value that attempt's live socket will be opened with.
 * It runs no experiment by itself: with the flag unset — which is how
 * every environment ships — every call resolves to the production
 * value of 400 and the socket request is byte-for-byte what it is
 * today.
 *
 * WHY A PER-CALL ASSIGNMENT AND NOT A GLOBAL SETTING. `endpointing`
 * is a property of the Deepgram connection, and the connection is
 * opened once per call and lives for the whole call. A turn-level
 * choice is therefore not expressible on the wire, and a global
 * change would give us two populations separated by deploy time —
 * confounded by everything else that moved between them. Assigning
 * per call, from a hash, splits one population.
 *
 * WHY THE KEY IS THE CALL-ATTEMPT UUID, AND NOTHING ELSE.
 * `pickByAllocation` hashes with FNV-1a and documents its input as
 * "a UUID that is already uniformly distributed". The first version of
 * this file broke that precondition: it hashed the SESSION id, which
 * is `sess_<base36 Date.now()>_<base36 counter>`. Measured over ids
 * generated exactly as the manager generates them, the counter suffix
 * barely moves the hash — at a fixed millisecond, counters 1..80
 * produced 24 consecutive `control`, then 10 `treatment`, then a run
 * of 45 `treatment`. Under a realistic concurrency-3 dispatcher that
 * left consecutive calls sharing an arm ~80% of the time and the
 * hourly treatment share swinging by up to 23 points, while the
 * OVERALL split still read 49.9% — so a share check could not have
 * caught it. That is the time-ordered confound this design exists to
 * remove, arriving through the back door.
 *
 * `call_attempts.id` is `uuid PRIMARY KEY DEFAULT gen_random_uuid()`:
 * genuinely random, unique per ATTEMPT, and already the row key the
 * resulting telemetry is stored under. It is the identifier the
 * primitive was built for, so the primitive is kept unchanged.
 *
 * A NON-UUID KEY IS REFUSED RATHER THAN HASHED (see `assignEndpointing`),
 * so the defect above cannot return by someone passing a session id
 * back in.
 *
 * A RETRY IS A NEW ATTEMPT and therefore a new UUID and an
 * independently drawn arm. That is deliberate: the randomisation unit
 * is the call attempt, which is also the unit the latency is measured
 * over. It does mean two attempts on one contact are not a matched
 * pair, and analysis must not treat them as one.
 *
 * WHAT IS BEING MEASURED, AND THE GUARDRAIL. `endpointing: 300` was
 * rejected on 2026-08-09 because it fragmented one natural utterance
 * into several finals. That failure mode is now measurable —
 * `finalTranscriptCount` and `interFinalGapsMs` per turn — so the
 * treatment arm can be judged on fragmentation, not just on the
 * pre-release latency it is meant to reduce. Fragmentation is the
 * CRITICAL guardrail, and this file exists so the two arms can be
 * told apart in the telemetry beyond any doubt.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT TOUCH. `utterance_end_ms`
 * (1000) is not a dimension of this experiment and is not read here.
 * Neither are turn-release guards, silence thresholds, continuation
 * logic, prompts, the LLM, TTS, the campaign's provider allocation,
 * or any telephony behaviour.
 */

import { ConfigurationError } from "../errors";
import { pickByAllocation, validatePercentageAllocation } from "../../campaign/domain/allocation";

/**
 * The production default, unchanged. Also the value EVERY call gets
 * while the experiment is off, and the value an absent assignment
 * resolves to.
 */
export const CONTROL_ENDPOINTING_MS = 400;

/** The one value under test. Reached only by an explicitly enabled experiment. */
export const TREATMENT_ENDPOINTING_MS = 300;

/**
 * The CLOSED set of values this experiment may ever put on a
 * Deepgram socket. Nothing else is reachable, and anything else is a
 * throw rather than a fallback — see `resolveEndpointingMs`.
 */
export const ALLOWED_ENDPOINTING_MS: readonly number[] = [
  CONTROL_ENDPOINTING_MS,
  TREATMENT_ENDPOINTING_MS,
];

/** The two arms. A closed union so an unrecognised arm cannot be constructed. */
export type EndpointingArm = "control" | "treatment";

const ENDPOINTING_ARMS: readonly EndpointingArm[] = ["control", "treatment"];

/**
 * Why a call is NOT in the experiment. Recorded rather than inferred,
 * because an analysis has to know which calls were excluded and on
 * what grounds before it can claim the remaining two arms are
 * comparable.
 */
export type EndpointingIneligibility =
  | "experiment-disabled"
  | "no-attempt-id"
  | "key-not-uuid";

/**
 * Hash namespace for this dimension.
 *
 * LOAD-BEARING, not decorative — the same reason
 * `resolveCallProviderStack` namespaces `telephony:` and `llm:`.
 * `pickByAllocation` is a pure function of its key, so any two
 * dimensions handed the same bare id would be perfectly correlated
 * and whole cells of the resulting matrix would never occur. Prefixing
 * gives this dimension its own independent hash of the same id.
 */
const ASSIGNMENT_NAMESPACE = "stt-endpointing";

/**
 * Accepts a canonical RFC-4122 UUID of any real version (1-8) with a
 * valid variant nibble. Postgres' `gen_random_uuid()` emits v4, which
 * this matches; the nil UUID and the session-id shape do not match and
 * are therefore refused rather than hashed.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Env vars this experiment reads. Nothing else configures it. */
export const ENDPOINTING_EXPERIMENT_ENABLED_ENV = "STT_ENDPOINTING_EXPERIMENT_ENABLED";
export const ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV =
  "STT_ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT";

/** Used when the split is not configured at all. */
export const DEFAULT_TREATMENT_PERCENT = 50;

export interface EndpointingExperimentConfig {
  /** `false` unless the flag is exactly `"true"`. */
  readonly enabled: boolean;
  /** Share of attempts routed to `endpointing=300`, 0-100. Meaningless while `enabled` is false. */
  readonly treatmentPercent: number;
}

/**
 * What one call attempt was assigned, in the form it is logged and
 * persisted.
 *
 * `endpointingMs` is the value the socket was ACTUALLY opened with,
 * carried alongside the arm label rather than derived from it at read
 * time: an analysis that has to re-derive the parameter from the label
 * cannot detect the one failure that would invalidate it — a call
 * labelled "treatment" whose socket nevertheless ran at 400.
 */
export interface EndpointingAssignment {
  readonly arm: EndpointingArm;
  readonly endpointingMs: number;
  /** Whether this attempt was actually in the experiment. */
  readonly experimentEnabled: boolean;
  /**
   * The EXACT string that was hashed, e.g.
   * `stt-endpointing:3f2a...`. Absent when the attempt was not
   * assigned by hash at all, so "what was hashed" is never a guess.
   */
  readonly assignmentKey?: string;
  /** The split in force when this attempt was assigned. Absent when it was not in the experiment. */
  readonly treatmentPercent?: number;
  /** Present exactly when `experimentEnabled` is false. */
  readonly ineligibleReason?: EndpointingIneligibility;
}

/**
 * Parses the treatment split.
 *
 * STRICT, AND THIS IS THE BEHAVIOUR VERBATIM:
 *
 *   unset, empty, or whitespace-only  -> `DEFAULT_TREATMENT_PERCENT` (50)
 *   a plain decimal in 0..100         -> that number ("0", "50", "33.33", "100")
 *   a plain decimal outside 0..100    -> ConfigurationError ("-1", "101", "100.5")
 *   anything else                     -> ConfigurationError
 *
 * "Anything else" explicitly includes `abc`, `NaN`, `Infinity`, `1,5`,
 * `1e2` and `0x10`. Every one of those used to be accepted by
 * `Number()` and silently became a real percentage — `1e2` became a
 * 100% treatment rollout and `0x10` became 16% — which is exactly the
 * class of configuration mistake that must be loud. Exponential and
 * hex forms were never a supported way to write a percentage; they
 * were an artefact of the coercion, so refusing them takes nothing
 * away.
 *
 * Surrounding whitespace is trimmed before parsing, because an env
 * file routinely carries a trailing space and that is not a mistake
 * about the VALUE.
 */
function parseTreatmentPercent(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value.length === 0) return DEFAULT_TREATMENT_PERCENT;

  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new ConfigurationError(
      `${ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV} must be a plain decimal percentage ` +
        `between 0 and 100 (e.g. "50" or "33.33"). Received "${value}".`,
    );
  }

  const parsed = Number(value);
  // The pattern already excludes NaN and Infinity; this is belt to
  // that braces, and keeps the guarantee true if the pattern is ever
  // widened.
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new ConfigurationError(
      `${ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV} must be between 0 and 100. Received "${value}".`,
    );
  }

  return parsed;
}

/**
 * Reads the experiment's configuration from the environment.
 *
 * OFF BY DEFAULT, and off for anything that is not literally `"true"` —
 * the same convention, and the same strictness, as
 * `CAMPAIGN_DIALING_ENABLED`. An experiment that could be switched on
 * by a stray value is not disabled by default in any useful sense.
 *
 * THE SPLIT IS ONLY PARSED WHEN THE EXPERIMENT IS ON. That is
 * deliberate and is the one place this is lenient: while the
 * experiment is off the split is not used for anything, and a typo in
 * an unused variable must not be able to throw on every call in
 * production. Nothing malformed is silently USED either way — when the
 * experiment is off the value is not read at all, and the default is
 * what gets reported.
 */
export function readEndpointingExperimentConfig(): EndpointingExperimentConfig {
  const enabled = (process.env[ENDPOINTING_EXPERIMENT_ENABLED_ENV] ?? "") === "true";
  if (!enabled) return { enabled: false, treatmentPercent: DEFAULT_TREATMENT_PERCENT };

  return {
    enabled: true,
    treatmentPercent: parseTreatmentPercent(process.env[ENDPOINTING_EXPERIMENT_TREATMENT_PERCENT_ENV]),
  };
}

/** The assignment every call gets when it is not in the experiment. */
function notInExperiment(ineligibleReason: EndpointingIneligibility): EndpointingAssignment {
  return {
    arm: "control",
    endpointingMs: CONTROL_ENDPOINTING_MS,
    experimentEnabled: false,
    ineligibleReason,
  };
}

/**
 * Assigns ONE call attempt to ONE arm.
 *
 * `attemptKey` MUST be the call-attempt UUID (`call_attempts.id`).
 * Anything that is not a canonical UUID is REFUSED — the attempt is
 * recorded as ineligible and runs the production 400 — rather than
 * hashed. Refusing is the point: hashing a low-entropy key produced a
 * split that looked balanced in aggregate while being clustered in
 * time, and the only reliable way to stop that recurring is to make
 * the wrong kind of key impossible to pass.
 *
 * REPRODUCIBLE: a pure function of `attemptKey` and the configured
 * split, through the same FNV-1a `pickByAllocation` the campaign's
 * provider dimensions already use. The same attempt UUID always lands
 * in the same arm, in this process and after a restart, so an
 * assignment can be re-derived from a stored record and checked.
 *
 * RESOLVED ONCE, HERE. The returned `endpointingMs` has already been
 * through `resolveEndpointingMs`, so every consumer downstream —
 * including the audio pipeline — receives a value that is known to be
 * in the closed set and never has to validate, or throw, again.
 */
export function assignEndpointing(
  attemptKey: string | undefined,
  config: EndpointingExperimentConfig = readEndpointingExperimentConfig(),
): EndpointingAssignment {
  if (!config.enabled) return notInExperiment("experiment-disabled");

  if (attemptKey === undefined || attemptKey.trim().length === 0) {
    return notInExperiment("no-attempt-id");
  }
  if (!UUID_PATTERN.test(attemptKey.trim())) {
    return notInExperiment("key-not-uuid");
  }

  const assignmentKey = `${ASSIGNMENT_NAMESPACE}:${attemptKey.trim().toLowerCase()}`;

  const arm = pickByAllocation<EndpointingArm>(
    assignmentKey,
    validatePercentageAllocation<EndpointingArm>(
      { control: 100 - config.treatmentPercent, treatment: config.treatmentPercent },
      ENDPOINTING_ARMS,
      "endpointing experiment arms",
    ),
  );

  return {
    arm,
    // Validated HERE, once, so nothing downstream repeats it.
    endpointingMs: resolveEndpointingMs(
      arm === "treatment" ? TREATMENT_ENDPOINTING_MS : CONTROL_ENDPOINTING_MS,
    ),
    experimentEnabled: true,
    assignmentKey,
    treatmentPercent: config.treatmentPercent,
  };
}

/**
 * Validates an `endpointing` value against the closed set.
 *
 * Called ONCE PER CALL, inside `assignEndpointing`, and once more by
 * the Deepgram adapter as a last check on whatever an external caller
 * handed it. It is deliberately NOT called from the audio pipeline:
 * the pipeline's STT loop swallows exceptions by design (a broken
 * socket must degrade to "no more transcription", not crash a live
 * call), so a validation throw raised in there would have become a
 * silently deaf call. The pipeline now carries an already-resolved
 * number and has nothing left to validate.
 *
 * ABSENT means the production default, explicitly: a caller that
 * carries no assignment at all — every non-campaign path, every
 * harness, every historical call site — gets exactly the 400 it gets
 * today.
 *
 * PRESENT BUT NOT IN THE CLOSED SET is a THROW. The failure that would
 * quietly ruin the experiment is a call running some third value while
 * its telemetry says `control` or `treatment`, and a defaulting
 * resolver is precisely how that happens.
 */
export function resolveEndpointingMs(endpointingMs: number | undefined): number {
  if (endpointingMs === undefined) return CONTROL_ENDPOINTING_MS;

  if (!ALLOWED_ENDPOINTING_MS.includes(endpointingMs)) {
    throw new ConfigurationError(
      `Refusing to open an STT stream with endpointing=${String(endpointingMs)}. ` +
        `Only ${ALLOWED_ENDPOINTING_MS.join(", ")} are assignable.`,
    );
  }

  return endpointingMs;
}
