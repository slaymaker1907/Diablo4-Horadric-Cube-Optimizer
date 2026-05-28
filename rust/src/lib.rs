mod closed_form;
mod decomposition;
mod env;
mod feasibility;
mod keys;
mod terminal;
mod types;

use wasm_bindgen::prelude::*;

pub const VERSION: &str = "v4-rust-0.1.0";

/// Returns the version string. Used by the JS loader to confirm WASM loaded.
#[wasm_bindgen]
pub fn d4optimizer_version() -> String {
    VERSION.to_string()
}

// ── Environment ───────────────────────────────────────────────────────────────

/// Build the translation environment from the affix catalog, GA config, and
/// target. Returns an opaque handle; pass it to the other functions.
#[wasm_bindgen]
pub fn build_env(data_json: &str, ga_config_json: &str, target_json: &str) -> u32 {
    let data: types::JsEnvData =
        serde_json::from_str(data_json).expect("build_env: invalid data JSON");
    let ga_config: types::JsGaConfig = if ga_config_json.is_empty() || ga_config_json == "null" {
        types::JsGaConfig::default()
    } else {
        serde_json::from_str(ga_config_json).expect("build_env: invalid gaConfig JSON")
    };
    let target: types::JsTarget =
        serde_json::from_str(target_json).expect("build_env: invalid target JSON");

    let translation_env = env::build_env(data, ga_config, target);
    env::store_env(translation_env)
}

/// Release a previously built environment handle.
#[wasm_bindgen]
pub fn free_env(handle: u32) {
    env::release_env(handle);
}

// ── State / action keys ───────────────────────────────────────────────────────

/// Canonical string key for a state. Matches JS `stateKey` exactly.
#[wasm_bindgen]
pub fn state_key(state_json: &str) -> String {
    let state: types::JsState =
        serde_json::from_str(state_json).expect("state_key: invalid state JSON");
    keys::state_key(&state)
}

/// Canonical string key for an action. Matches JS `actionKey` exactly.
#[wasm_bindgen]
pub fn action_key(action_json: &str) -> String {
    let action: types::JsAction =
        serde_json::from_str(action_json).expect("action_key: invalid action JSON");
    keys::action_key(&action)
}

/// Packed 57-bit state key as a u64.
#[wasm_bindgen]
pub fn state_key_u64(state_json: &str, env_handle: u32) -> u64 {
    let state: types::JsState =
        serde_json::from_str(state_json).expect("state_key_u64: invalid state JSON");
    env::with_env(env_handle, |e| keys::state_key_u64(&state, e))
        .expect("state_key_u64: invalid env handle")
}

// ── Terminal checks ───────────────────────────────────────────────────────────

/// Returns JSON `{terminal: bool, success: bool}`. Matches JS `isTerminal`.
#[wasm_bindgen]
pub fn is_terminal(state_json: &str, target_json: &str, env_handle: u32) -> String {
    let state: types::JsState =
        serde_json::from_str(state_json).expect("is_terminal: invalid state JSON");
    let target: types::JsTarget =
        serde_json::from_str(target_json).expect("is_terminal: invalid target JSON");
    env::with_env(env_handle, |e| {
        let result = terminal::is_terminal(&state, &target, e);
        serde_json::to_string(&result).expect("is_terminal: serialization failed")
    })
    .expect("is_terminal: invalid env handle")
}

/// Returns true if the state has lost a required GA. Matches JS `breaksRequiredGA`.
#[wasm_bindgen]
pub fn breaks_required_ga(state_json: &str, env_handle: u32) -> bool {
    let state: types::JsState =
        serde_json::from_str(state_json).expect("breaks_required_ga: invalid state JSON");
    env::with_env(env_handle, |e| terminal::breaks_required_ga(&state, e))
        .expect("breaks_required_ga: invalid env handle")
}

// ── Phase 2: feasibility + closed-form ───────────────────────────────────────

/// F4–F7 feasibility check. Returns JSON `{ok, check, message, details}`.
/// Mirrors JS `analyzeFeasibilityV3`.
///
/// `env_handle` must reference an env built with `build_env` using the same
/// data/gaConfig/target combination (typically the same call).
#[wasm_bindgen]
pub fn analyze_feasibility(
    state_json: &str,
    target_json: &str,
    ga_config_json: &str,
    env_handle: u32,
) -> String {
    let state: types::JsState =
        serde_json::from_str(state_json).expect("analyze_feasibility: invalid state JSON");
    let target: types::JsTarget =
        serde_json::from_str(target_json).expect("analyze_feasibility: invalid target JSON");
    let ga_config: types::JsGaConfig =
        if ga_config_json.is_empty() || ga_config_json == "null" {
            types::JsGaConfig::default()
        } else {
            serde_json::from_str(ga_config_json)
                .expect("analyze_feasibility: invalid gaConfig JSON")
        };
    let result = env::with_env(env_handle, |e| {
        feasibility::analyze_feasibility(&state, &target, &ga_config, e)
    })
    .expect("analyze_feasibility: invalid env handle");
    serde_json::to_string(&result).expect("analyze_feasibility: serialization failed")
}

/// Closed-form plan candidates for one (state, targetEntry, slotIndex).
/// Returns JSON array of ClosedFormCandidate objects.
/// Mirrors JS `getClosedFormPlanCandidatesV3`.
///
/// `options_json` fields (all optional):
///   maxAffixSlots, allowDiscretionaryEnchant, touchOnlyImprovement,
///   protectedAffixIds, target, gaConfig
#[wasm_bindgen]
pub fn get_closed_form_plan_candidates(
    state_json: &str,
    target_entry_json: &str,
    slot_index: u32,
    env_handle: u32,
    options_json: &str,
) -> String {
    let state: types::JsState =
        serde_json::from_str(state_json)
            .expect("get_closed_form_plan_candidates: invalid state JSON");
    let target_entry: types::TargetAffixEntry =
        serde_json::from_str(target_entry_json)
            .expect("get_closed_form_plan_candidates: invalid targetEntry JSON");
    let options: types::ClosedFormOptions =
        if options_json.is_empty() || options_json == "null" || options_json == "{}" {
            types::ClosedFormOptions::default()
        } else {
            serde_json::from_str(options_json)
                .expect("get_closed_form_plan_candidates: invalid options JSON")
        };
    let target_for_risk = options.target.as_ref();
    let result = env::with_env(env_handle, |e| {
        closed_form::get_closed_form_plan_candidates(
            &state,
            &target_entry,
            slot_index as usize,
            e,
            &options,
            target_for_risk,
        )
    })
    .expect("get_closed_form_plan_candidates: invalid env handle");
    serde_json::to_string(&result)
        .expect("get_closed_form_plan_candidates: serialization failed")
}

/// Full decomposition plan input for a (state, target) pair.
/// Returns JSON DecompositionPlanInput (ok, reason, feasibility, maxAffixSlots,
/// targets, options, residualTargets).
/// Mirrors JS `buildDecompositionPlanInputV3`.
#[wasm_bindgen]
pub fn build_decomposition_plan_input(
    state_json: &str,
    target_json: &str,
    ga_config_json: &str,
    env_handle: u32,
) -> String {
    let state: types::JsState =
        serde_json::from_str(state_json)
            .expect("build_decomposition_plan_input: invalid state JSON");
    let target: types::JsTarget =
        serde_json::from_str(target_json)
            .expect("build_decomposition_plan_input: invalid target JSON");
    let ga_config: types::JsGaConfig =
        if ga_config_json.is_empty() || ga_config_json == "null" {
            types::JsGaConfig::default()
        } else {
            serde_json::from_str(ga_config_json)
                .expect("build_decomposition_plan_input: invalid gaConfig JSON")
        };
    let result = env::with_env(env_handle, |e| {
        decomposition::build_decomposition_plan_input(&state, &target, &ga_config, e, None)
    })
    .expect("build_decomposition_plan_input: invalid env handle");
    serde_json::to_string(&result)
        .expect("build_decomposition_plan_input: serialization failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_nonempty() {
        assert!(!d4optimizer_version().is_empty());
    }
}
