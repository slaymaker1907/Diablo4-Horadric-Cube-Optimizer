mod actions;
mod closed_form;
mod decomposition;
mod env;
mod feasibility;
mod intern;
mod keys;
mod mc;
mod optimizer;
mod residual;
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

// ── Phase 3–5: Residual solver + optimizer + MC ──────────────────────────────

/// Runs the full LAO* residual solver for a given payload.
/// `payload_json` must be a serialized `OptimizePayload`.
/// Returns JSON result with `{action, expectedSteps, diagnostics, ...}`.
/// `solve_ilp_json` is called with plan-input JSON; return null/"" to skip ILP.
#[wasm_bindgen]
pub fn optimize_payload(payload_json: &str, solve_ilp_fn: &js_sys::Function) -> String {
    let payload: types::OptimizePayload =
        match serde_json::from_str(payload_json) {
            Ok(p) => p,
            Err(e) => return format!("{{\"error\":\"optimize_payload: invalid JSON: {}\"}}", e),
        };
    let env = env::build_env(
        payload.data.clone(),
        payload.ga_config.clone(),
        payload.target.clone(),
    );
    let solve_fn = make_js_ilp_callback(solve_ilp_fn.clone());
    let result = optimizer::optimize_payload_v3(&payload, &env, &solve_fn, 2, 6);
    serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string())
}

/// Runs MC verification after the initial optimize.
/// `intermediate_json` is the result from `optimize_payload`.
/// `solve_ilp_fn` and optional `on_progress_fn` are JS callbacks.
#[wasm_bindgen]
pub fn run_mc_verification(
    payload_json: &str,
    intermediate_json: &str,
    solve_ilp_fn: &js_sys::Function,
    on_progress_fn: Option<js_sys::Function>,
) -> String {
    let payload: types::OptimizePayload =
        match serde_json::from_str(payload_json) {
            Ok(p) => p,
            Err(e) => return format!("{{\"error\":\"run_mc_verification: invalid payload JSON: {}\"}}", e),
        };
    let intermediate: serde_json::Value =
        serde_json::from_str(intermediate_json).unwrap_or(serde_json::json!(null));

    let env = env::build_env(
        payload.data.clone(),
        payload.ga_config.clone(),
        payload.target.clone(),
    );
    let solve_fn = make_js_ilp_callback(solve_ilp_fn.clone());
    let progress_fn: Option<js_sys::Function> = on_progress_fn;
    let on_progress_cb: Option<&dyn Fn(serde_json::Value)> = if let Some(ref f) = progress_fn {
        let f_ref = f;
        Some(&move |v: serde_json::Value| {
            let _ = f_ref.call1(
                &wasm_bindgen::JsValue::NULL,
                &wasm_bindgen::JsValue::from_str(
                    &serde_json::to_string(&v).unwrap_or_default(),
                ),
            );
        })
    } else {
        None
    };

    let result = mc::run_mc_verification_v3(
        &payload,
        &env,
        intermediate,
        &solve_fn,
        on_progress_cb,
    );
    serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string())
}

fn make_js_ilp_callback(
    f: js_sys::Function,
) -> impl Fn(&str) -> Option<serde_json::Value> {
    move |plan_input_json: &str| -> Option<serde_json::Value> {
        let arg = wasm_bindgen::JsValue::from_str(plan_input_json);
        let result = f.call1(&wasm_bindgen::JsValue::NULL, &arg).ok()?;
        let json_str = result.as_string()?;
        if json_str.is_empty() || json_str == "null" {
            return None;
        }
        serde_json::from_str(&json_str).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_nonempty() {
        assert!(!d4optimizer_version().is_empty());
    }
}
