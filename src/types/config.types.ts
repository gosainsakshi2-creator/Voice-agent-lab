/**
 * config.types.ts
 *
 * Types describing platform and provider configuration. These types
 * describe the SHAPE of configuration only. Loading, validating, and
 * populating configuration is out of scope for this architecture
 * pass (no implementations).
 */

import type { ProviderCategory, RuntimeEnvironment } from "./enums";

/**
 * Top-level application configuration shape consumed at bootstrap.
 */
export interface AppConfig {
  readonly environment: RuntimeEnvironment;
  readonly serviceName: string;
  readonly providers: ProviderRegistryConfig;
}

/**
 * Configuration for a single provider entry as registered in the
 * ProviderRegistry. `settings` is intentionally an opaque bag —
 * each provider implementation defines and validates its own
 * settings shape at the implementation layer, not here.
 */
export interface ProviderConfigEntry {
  readonly category: ProviderCategory;
  readonly id: string;
  readonly enabled: boolean;
  readonly settings: Readonly<Record<string, unknown>>;
}

/**
 * Full set of provider configuration entries the registry may load
 * at startup.
 */
export interface ProviderRegistryConfig {
  readonly entries: readonly ProviderConfigEntry[];
  readonly defaultStackId?: string;
}

/**
 * A named, reusable provider stack preset (e.g. "Baseline",
 * "Low-Latency Hindi") that the Dashboard can offer as a quick
 * selection. Purely configuration data — resolved into a
 * ProviderStackSelection by the VoiceSessionManager at session
 * creation time.
 */
export interface ProviderStackPreset {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly telephonyId: string;
  readonly speechToTextId: string;
  readonly languageModelId: string;
  readonly textToSpeechId: string;
}
