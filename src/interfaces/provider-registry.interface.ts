/**
 * provider-registry.interface.ts
 *
 * The Provider Registry is the single source of truth for resolving
 * a `ProviderIdentifier` to a concrete provider implementation.
 *
 * This is what makes providers swappable: the VoiceSessionManager
 * never imports a vendor SDK or a concrete provider class directly.
 * It asks the registry for "the TELEPHONY provider identified by
 * `plivo`" and receives back something conforming to
 * `TelephonyProvider`. Swapping Plivo for another vendor is a
 * registration-time change, not an application-logic change.
 */

import type { ProviderCategory } from "../types/enums";
import type { ProviderDescriptor, ProviderHealthStatus, ProviderIdentifier } from "../types/provider.types";
import type {
  LanguageModelProvider,
  SpeechToTextProvider,
  TelephonyProvider,
  TextToSpeechProvider,
} from "./providers";

/**
 * Maps each ProviderCategory to the interface type the registry
 * must return for that category. Used to keep `resolve` fully
 * type-safe per category via generics/overloads rather than
 * returning a loosely-typed union.
 */
export interface ProviderCategoryMap {
  readonly [ProviderCategory.TELEPHONY]: TelephonyProvider;
  readonly [ProviderCategory.SPEECH_TO_TEXT]: SpeechToTextProvider;
  readonly [ProviderCategory.LANGUAGE_MODEL]: LanguageModelProvider;
  readonly [ProviderCategory.TEXT_TO_SPEECH]: TextToSpeechProvider;
}

/**
 * Union type of every concrete provider interface the registry can
 * hold, used internally for heterogeneous storage.
 */
export type AnyProvider = ProviderCategoryMap[ProviderCategory];

export interface ProviderRegistry {
  /**
   * Register a provider implementation under its own descriptor.
   * Throws if a provider with the same category+id is already
   * registered.
   */
  register<C extends ProviderCategory>(
    category: C,
    provider: ProviderCategoryMap[C],
  ): void;

  /**
   * Resolve a previously registered provider by its identifier.
   * Throws a `ProviderNotFoundError` (see core/errors) if no
   * matching provider is registered.
   */
  resolve<C extends ProviderCategory>(
    category: C,
    id: ProviderIdentifier["id"],
  ): ProviderCategoryMap[C];

  /**
   * List descriptors for every provider registered under a given
   * category. Used by the Dashboard (indirectly, through the
   * VoiceSessionManager) to present available options without ever
   * touching a concrete provider instance.
   */
  listByCategory(category: ProviderCategory): readonly ProviderDescriptor[];

  /**
   * Run health checks against every registered provider in a given
   * category (or all categories if omitted).
   */
  checkAllHealth(category?: ProviderCategory): Promise<readonly ProviderHealthStatus[]>;
}
