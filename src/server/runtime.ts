/**
 * runtime.ts
 *
 * The ONE place the new integration layer wires the existing
 * architecture together at process start-up:
 *
 *   bootstrapProviderRegistry()  -> ProviderRegistry (Provider Layer, untouched)
 *   new DefaultVoiceSessionManager(registry) (Session Manager, untouched)
 *
 * Every API route / websocket bridge in `src/app/api/**` and
 * `server.ts` imports `getRuntime()` from here instead of
 * constructing its own registry or manager, so the whole process
 * shares exactly one `ProviderRegistry` and one
 * `VoiceSessionManager` — mirroring how a real deployment would
 * bootstrap once at start-up.
 *
 * Stored on `globalThis` so Next.js's dev-mode module reloading
 * (fast refresh / route re-compilation) doesn't spawn a second
 * registry and orphan any in-flight session.
 */

import { bootstrapProviderRegistry, type ProviderRegistrationOutcome } from "../providers/registry/bootstrap";
import { DefaultVoiceSessionManager } from "../core/session/voice-session-manager.impl";
import type { ProviderRegistry } from "../interfaces/provider-registry.interface";

export interface VoiceAgentRuntime {
  readonly registry: ProviderRegistry;
  readonly manager: DefaultVoiceSessionManager;
  readonly bootstrapOutcomes: readonly ProviderRegistrationOutcome[];
}

declare global {
  // eslint-disable-next-line no-var
  var __voiceAgentRuntime: VoiceAgentRuntime | undefined;
}

export function getRuntime(): VoiceAgentRuntime {
  if (!globalThis.__voiceAgentRuntime) {
    const { registry, outcomes } = bootstrapProviderRegistry();
    const manager = new DefaultVoiceSessionManager(registry);

    for (const outcome of outcomes) {
      if (!outcome.registered) {
        // eslint-disable-next-line no-console
        console.warn(
          `[voice-agent-lab] provider not registered: ${outcome.identifier.category}/${outcome.identifier.id} — ${outcome.reason}`,
        );
      }
    }

    globalThis.__voiceAgentRuntime = { registry, manager, bootstrapOutcomes: outcomes };
  }
  return globalThis.__voiceAgentRuntime;
}
