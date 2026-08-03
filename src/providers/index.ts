/**
 * Barrel export for the Provider Layer — every concrete adapter
 * satisfying the architecture's provider interfaces, plus the
 * concrete `ProviderRegistry` implementation and its env-driven
 * bootstrap. Consumers (a future VoiceSessionManager implementation,
 * or an application entry point) should import from here rather
 * than reaching into individual adapter files, mirroring how
 * `src/index.ts` barrels the core architecture.
 */
export * from "./telephony";
export * from "./speech-to-text";
export * from "./language-model";
export * from "./text-to-speech";
export * from "./registry";
