/**
 * voice-agent.error.ts
 *
 * Structured error hierarchy for the platform. Every error thrown by
 * an interface implementation (VoiceSessionManager, ProviderRegistry,
 * or any Provider) should extend `VoiceAgentError` so that callers
 * can discriminate failures uniformly regardless of which provider
 * or subsystem raised them.
 *
 * NOTE: This file defines error TYPES/CLASSES ONLY — no retry logic,
 * no logging, no handling behavior. Those belong to an application
 * layer that is out of scope for this architecture pass.
 */

import type { ProviderIdentifier } from "../../types/provider.types";
import { ErrorSeverity } from "../../types/enums";

export abstract class VoiceAgentError extends Error {
  abstract readonly code: string;
  readonly severity: ErrorSeverity;
  readonly occurredAt: Date;

  protected constructor(message: string, severity: ErrorSeverity) {
    super(message);
    this.name = new.target.name;
    this.severity = severity;
    this.occurredAt = new Date();
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Raised by the ProviderRegistry when `resolve` is called with an
 * identifier that has no registered implementation.
 */
export class ProviderNotFoundError extends VoiceAgentError {
  readonly code = "PROVIDER_NOT_FOUND";

  constructor(readonly identifier: ProviderIdentifier) {
    super(
      `No provider registered for category "${identifier.category}" with id "${identifier.id}".`,
      ErrorSeverity.FATAL,
    );
  }
}

/**
 * Raised by the ProviderRegistry when `register` is called twice
 * for the same category+id.
 */
export class ProviderAlreadyRegisteredError extends VoiceAgentError {
  readonly code = "PROVIDER_ALREADY_REGISTERED";

  constructor(readonly identifier: ProviderIdentifier) {
    super(
      `A provider is already registered for category "${identifier.category}" with id "${identifier.id}".`,
      ErrorSeverity.WARNING,
    );
  }
}

/**
 * Raised when a provider fails its health check and the caller
 * requires a healthy provider to proceed.
 */
export class ProviderUnhealthyError extends VoiceAgentError {
  readonly code = "PROVIDER_UNHEALTHY";

  constructor(readonly identifier: ProviderIdentifier, reason?: string) {
    super(
      `Provider "${identifier.id}" (${identifier.category}) is unhealthy${reason ? `: ${reason}` : "."}`,
      ErrorSeverity.RECOVERABLE,
    );
  }
}

/**
 * Raised by the VoiceSessionManager when an operation requests a
 * SessionState transition that is not permitted by
 * SESSION_STATE_TRANSITIONS.
 */
export class InvalidSessionStateTransitionError extends VoiceAgentError {
  readonly code = "INVALID_SESSION_STATE_TRANSITION";

  constructor(readonly from: string, readonly to: string) {
    super(`Cannot transition session from "${from}" to "${to}".`, ErrorSeverity.RECOVERABLE);
  }
}

/**
 * Raised when a lookup for a session id finds no matching session.
 */
export class SessionNotFoundError extends VoiceAgentError {
  readonly code = "SESSION_NOT_FOUND";

  constructor(readonly sessionId: string) {
    super(`No session found with id "${sessionId}".`, ErrorSeverity.FATAL);
  }
}

/**
 * Raised when required configuration (environment variables,
 * provider settings) is missing or malformed at startup.
 */
export class ConfigurationError extends VoiceAgentError {
  readonly code = "CONFIGURATION_ERROR";

  constructor(message: string) {
    super(message, ErrorSeverity.FATAL);
  }
}
