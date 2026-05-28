/* tslint:disable */
/* eslint-disable */

/**
 * Canonical string key for an action. Matches JS `actionKey` exactly.
 */
export function action_key(action_json: string): string;

/**
 * F4–F7 feasibility check. Returns JSON `{ok, check, message, details}`.
 * Mirrors JS `analyzeFeasibilityV3`.
 *
 * `env_handle` must reference an env built with `build_env` using the same
 * data/gaConfig/target combination (typically the same call).
 */
export function analyze_feasibility(state_json: string, target_json: string, ga_config_json: string, env_handle: number): string;

/**
 * Returns true if the state has lost a required GA. Matches JS `breaksRequiredGA`.
 */
export function breaks_required_ga(state_json: string, env_handle: number): boolean;

/**
 * Full decomposition plan input for a (state, target) pair.
 * Returns JSON DecompositionPlanInput (ok, reason, feasibility, maxAffixSlots,
 * targets, options, residualTargets).
 * Mirrors JS `buildDecompositionPlanInputV3`.
 */
export function build_decomposition_plan_input(state_json: string, target_json: string, ga_config_json: string, env_handle: number): string;

/**
 * Build the translation environment from the affix catalog, GA config, and
 * target. Returns an opaque handle; pass it to the other functions.
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
 * Closed-form plan candidates for one (state, targetEntry, slotIndex).
 * Returns JSON array of ClosedFormCandidate objects.
 * Mirrors JS `getClosedFormPlanCandidatesV3`.
 *
 * `options_json` fields (all optional):
 *   maxAffixSlots, allowDiscretionaryEnchant, touchOnlyImprovement,
 *   protectedAffixIds, target, gaConfig
 */
export function get_closed_form_plan_candidates(state_json: string, target_entry_json: string, slot_index: number, env_handle: number, options_json: string): string;

/**
 * Returns JSON `{terminal: bool, success: bool}`. Matches JS `isTerminal`.
 */
export function is_terminal(state_json: string, target_json: string, env_handle: number): string;

/**
 * Runs the full LAO* residual solver for a given payload.
 * `payload_json` must be a serialized `OptimizePayload`.
 * Returns JSON result with `{action, expectedSteps, diagnostics, ...}`.
 * `solve_ilp_json` is called with plan-input JSON; return null/"" to skip ILP.
 */
export function optimize_payload(payload_json: string, solve_ilp_fn: Function): string;

/**
 * Runs MC verification after the initial optimize.
 * `intermediate_json` is the result from `optimize_payload`.
 * `solve_ilp_fn` and optional `on_progress_fn` are JS callbacks.
 */
export function run_mc_verification(payload_json: string, intermediate_json: string, solve_ilp_fn: Function, on_progress_fn?: Function | null): string;

/**
 * Canonical string key for a state. Matches JS `stateKey` exactly.
 */
export function state_key(state_json: string): string;

/**
 * Packed 57-bit state key as a u64.
 */
export function state_key_u64(state_json: string, env_handle: number): bigint;
