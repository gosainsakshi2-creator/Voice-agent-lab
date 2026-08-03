/**
 * env.ts (providers/shared)
 *
 * Small, dependency-free helpers for reading provider configuration
 * from `process.env` / a provider's opaque `settings` bag. Centralized
 * here so every adapter validates and reports missing configuration
 * the same way (DRY) instead of re-implementing `if (!value) throw`
 * in eight different files.
 *
 * Nothing here talks to a vendor SDK. This is pure configuration
 * plumbing shared across the Provider Layer.
 */

import { ConfigurationError } from "../../core/errors";

/**
 * Read a required string environment variable. Throws
 * `ConfigurationError` (an existing, architecture-defined error) if
 * it is missing or empty, naming both the variable and the provider
 * that needed it so misconfiguration is obvious at startup.
 */
export function requireEnv(name: string, providerId: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new ConfigurationError(
      `Missing required environment variable "${name}" for provider "${providerId}".`,
    );
  }
  return value;
}

/**
 * Read an optional string environment variable, falling back to a
 * caller-supplied default when unset.
 */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : fallback;
}

/**
 * Read an optional numeric environment variable, falling back to a
 * caller-supplied default when unset or unparsable.
 */
export function optionalEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Read a per-language override map out of an opaque provider
 * `settings` bag (see `ProviderConfigEntry.settings`), e.g. a
 * TTS provider's default voice id per `SupportedLanguage`. Falls
 * back to `undefined` when absent so callers can apply their own
 * default.
 */
export function readSettingsString(
  settings: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = settings?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
