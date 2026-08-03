/**
 * in-memory-provider-registry.ts
 *
 * Concrete implementation of the `ProviderRegistry` interface
 * (see `interfaces/provider-registry.interface.ts`). Holds resolved
 * provider instances in memory, keyed by category + id, exactly as
 * the interface's doc comments describe: "the single source of
 * truth for resolving a `ProviderIdentifier` to a concrete provider
 * implementation."
 *
 * This class contains NO vendor-specific logic and NO business
 * logic beyond bookkeeping — it only stores and retrieves whatever
 * provider instances are registered with it. Wiring concrete
 * vendors into an instance is the job of `bootstrap.ts`, not this
 * class.
 */

import { ProviderAlreadyRegisteredError, ProviderNotFoundError } from "../../core/errors";
import type { ProviderCategory } from "../../types/enums";
import type { ProviderDescriptor, ProviderHealthStatus, ProviderIdentifier } from "../../types/provider.types";
import type {
  AnyProvider,
  ProviderCategoryMap,
  ProviderRegistry,
} from "../../interfaces/provider-registry.interface";

/** Builds the internal lookup key for a category + id pair. */
function toKey(category: ProviderCategory, id: string): string {
  return `${category}::${id}`;
}

export class InMemoryProviderRegistry implements ProviderRegistry {
  private readonly providers = new Map<string, AnyProvider>();

  register<C extends ProviderCategory>(category: C, provider: ProviderCategoryMap[C]): void {
    const identifier: ProviderIdentifier = { category, id: provider.descriptor.id };
    const key = toKey(category, provider.descriptor.id);

    if (this.providers.has(key)) {
      throw new ProviderAlreadyRegisteredError(identifier);
    }

    this.providers.set(key, provider);
  }

  resolve<C extends ProviderCategory>(category: C, id: ProviderIdentifier["id"]): ProviderCategoryMap[C] {
    const key = toKey(category, id);
    const provider = this.providers.get(key);

    if (!provider) {
      throw new ProviderNotFoundError({ category, id });
    }

    return provider as ProviderCategoryMap[C];
  }

  listByCategory(category: ProviderCategory): readonly ProviderDescriptor[] {
    const descriptors: ProviderDescriptor[] = [];
    for (const provider of this.providers.values()) {
      if (provider.descriptor.category === category) {
        descriptors.push(provider.descriptor);
      }
    }
    return descriptors;
  }

  async checkAllHealth(category?: ProviderCategory): Promise<readonly ProviderHealthStatus[]> {
    const targets = Array.from(this.providers.values()).filter(
      (provider) => !category || provider.descriptor.category === category,
    );

    return Promise.all(targets.map((provider) => provider.checkHealth()));
  }
}
