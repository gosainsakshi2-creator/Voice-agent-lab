/**
 * Barrel export for the VoiceSessionManager implementation and its
 * supporting orchestration pieces. Consumers that only need the
 * public contract should import the `VoiceSessionManager` type from
 * the package root; consumers wiring up the application (or a
 * future API-routes layer) import `DefaultVoiceSessionManager` /
 * `createVoiceSessionManager` from here.
 */
export * from "./voice-session-manager.impl";
export * from "./conversation-pipeline";
export * from "./conversation-memory";
export * from "./language-detector";
export * from "./turn-detection";
export * from "./barge-in-controller";
export * from "./metrics-collector";
export * from "./cost-estimator";
export * from "./session-record";
