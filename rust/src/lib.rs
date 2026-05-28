mod env;
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
///
/// Mirrors the relevant subset of JS `buildEnv` (d4cubeoptimv3-worker.js:364):
/// affix token IDs, gear-slot IDs, class IDs, gaRequiredCounts, targetCounts.
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

/// Canonical string key for a state. Matches JS `stateKey` exactly, including
/// the `"any"` (lowercase) default for gearSlot.
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

/// Packed 57-bit state key as a u64. Uses the translation env to map affix
/// string IDs to compact token integers. Intended for Phase 3 LAO* graph.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_nonempty() {
        assert!(!d4optimizer_version().is_empty());
    }
}
