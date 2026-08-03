/**
 * error-recovery.ts
 *
 * Every provider call in the pipeline funnels its failures through
 * `withGracefulRetry`, so "STT disconnects / TTS fails / LLM errors
 * / temporary provider failures occur" degrade the current turn
 * instead of crashing the session outright. Genuinely fatal errors
 * (per `VoiceAgentError.severity`, or anything not recognized as
 * transient) still propagate so the caller can move the session to
 * `SessionState.ERROR`.
 */

import { ErrorSeverity } from "../../types/enums";
import { VoiceAgentError } from "../../core/errors";
import type { SessionErrorInfo } from "../../types/session.types";

export class RecoverableTurnError extends Error {
  constructor(readonly sourceCategory: string, message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "RecoverableTurnError";
  }
}

function isRecoverable(error: unknown): boolean {
  if (error instanceof VoiceAgentError) {
    return error.severity !== ErrorSeverity.FATAL;
  }
  // Unrecognized errors (network hiccups, vendor SDK throws that
  // aren't wrapped in VoiceAgentError, etc.) are treated as
  // transient by default — a single retry is cheap, and an
  // over-eager FATAL classification would end a call for a blip
  // that a second attempt would have sailed through.
  return true;
}

/**
 * Runs `operation` once; on failure, if the error looks transient,
 * retries exactly once after `retryDelayMs`. If both attempts fail,
 * throws a `RecoverableTurnError` wrapping the last failure so the
 * pipeline can skip the current turn without ending the session,
 * unless the underlying error was itself FATAL, in which case it is
 * rethrown as-is for the caller to end the session.
 */
export async function withGracefulRetry<T>(
  sourceCategory: string,
  operation: () => Promise<T>,
  retryDelayMs = 250,
): Promise<T> {
  try {
    return await operation();
  } catch (firstError) {
    if (firstError instanceof VoiceAgentError && firstError.severity === ErrorSeverity.FATAL) {
      throw firstError;
    }
    if (!isRecoverable(firstError)) {
      throw firstError;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));

    try {
      return await operation();
    } catch (secondError) {
      if (secondError instanceof VoiceAgentError && secondError.severity === ErrorSeverity.FATAL) {
        throw secondError;
      }
      throw new RecoverableTurnError(
        sourceCategory,
        `${sourceCategory} failed twice for this turn: ${
          secondError instanceof Error ? secondError.message : String(secondError)
        }`,
        secondError,
      );
    }
  }
}

export function toSessionErrorInfo(error: unknown, sourceCategory?: string): SessionErrorInfo {
  if (error instanceof VoiceAgentError) {
    return {
      code: error.code,
      message: error.message,
      occurredAt: error.occurredAt,
      ...(sourceCategory !== undefined ? { sourceCategory } : {}),
    };
  }
  return {
    code: "UNKNOWN_ERROR",
    message: error instanceof Error ? error.message : String(error),
    occurredAt: new Date(),
    ...(sourceCategory !== undefined ? { sourceCategory } : {}),
  };
}
