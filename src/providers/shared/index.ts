/**
 * Barrel export for shared, cross-vendor provider-layer helpers.
 * Nothing here is vendor-specific; every file under
 * `providers/shared` exists to keep the individual adapters small
 * and free of duplicated plumbing.
 */
export * from "./env";
export * from "./health";
export * from "./audio";
export * from "./http";
