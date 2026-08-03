/**
 * Root barrel export for the Voice Agent Lab core architecture.
 *
 * Consumers (Dashboard, provider implementations, session manager
 * implementation — all out of scope for this pass) should import
 * from this package root rather than reaching into subpaths, e.g.:
 *
 *   import type { VoiceSessionManager, SessionState } from "voice-agent-lab";
 */
export * from "./types";
export * from "./interfaces";
export * from "./constants";
export * from "./config";
export * from "./core/errors";
export * from "./core/session";
