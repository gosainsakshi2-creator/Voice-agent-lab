/**
 * app.config.ts
 *
 * Declares the SHAPE and DEFAULT SKELETON of application config.
 * No environment reading, no file I/O, no validation logic — this
 * is architecture, not a config loader implementation.
 */

import { RuntimeEnvironment } from "../types/enums";
import type { AppConfig } from "../types/config.types";

/**
 * A structurally valid, empty-provider-list default. Intended as a
 * documentation/reference skeleton for whoever implements the real
 * config loader — NOT wired into any runtime path.
 */
export const DEFAULT_APP_CONFIG_SKELETON: AppConfig = {
  environment: RuntimeEnvironment.DEVELOPMENT,
  serviceName: "voice-agent-lab",
  providers: {
    entries: [],
  },
};
