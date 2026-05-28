/* tslint:disable */
/* eslint-disable */

/**
 * Canonical string key for an action. Matches JS `actionKey` exactly.
 */
export function action_key(action_json: string): string;

/**
 * Returns true if the state has lost a required GA. Matches JS `breaksRequiredGA`.
 */
export function breaks_required_ga(state_json: string, env_handle: number): boolean;

/**
 * Build the translation environment from the affix catalog, GA config, and
 * target. Returns an opaque handle; pass it to the other functions.
 *
 * Mirrors the relevant subset of JS `buildEnv` (d4cubeoptimv3-worker.js:364):
 * affix token IDs, gear-slot IDs, class IDs, gaRequiredCounts, targetCounts.
 */
export function build_env(data_json: string, ga_config_json: string, target_json: string): number;

/**
 * Returns the version string. Used by the JS loader to confirm WASM loaded.
 */
export function d4optimizer_version(): string;

/**
 * Release a previously built environment handle.
 */
export function free_env(handle: number): void;

/**
 * Returns JSON `{terminal: bool, success: bool}`. Matches JS `isTerminal`.
 */
export function is_terminal(state_json: string, target_json: string, env_handle: number): string;

/**
 * Canonical string key for a state. Matches JS `stateKey` exactly, including
 * the `"any"` (lowercase) default for gearSlot.
 */
export function state_key(state_json: string): string;

/**
 * Packed 57-bit state key as a u64. Uses the translation env to map affix
 * string IDs to compact token integers. Intended for Phase 3 LAO* graph.
 */
export function state_key_u64(state_json: string, env_handle: number): bigint;
