use std::collections::HashMap;

use crate::env::TranslationEnv;
use crate::types::{JsState, JsTarget, TerminalResult};

// ── isTerminal ────────────────────────────────────────────────────────────────
//
// Mirrors JS `isTerminal` (d4cubeoptimv3-worker.js:711).
// Returns (terminal, success).

pub fn is_terminal(state: &JsState, target: &JsTarget, env: &TranslationEnv) -> TerminalResult {
    if breaks_required_ga(state, env) {
        return TerminalResult { terminal: true, success: false };
    }

    let mut state_counts: HashMap<&str, u32> = HashMap::new();
    for entry in &state.affixes {
        *state_counts.entry(entry.affix_id.as_str()).or_insert(0) += 1;
    }

    for req in &target.affixes {
        if state_counts.get(req.affix_id.as_str()).copied().unwrap_or(0) == 0 {
            return TerminalResult { terminal: false, success: false };
        }
    }

    TerminalResult { terminal: true, success: true }
}

// ── breaksRequiredGA ──────────────────────────────────────────────────────────
//
// Mirrors JS `breaksRequiredGA` (d4cubeoptimv3-worker.js:745).
// Returns true if the state is missing a GA that was required.

pub fn breaks_required_ga(state: &JsState, env: &TranslationEnv) -> bool {
    if env.ga_required_counts.is_empty() {
        return false;
    }

    let mut ga_counts: HashMap<&str, u32> = HashMap::new();
    for entry in &state.affixes {
        if entry.is_ga {
            *ga_counts.entry(entry.affix_id.as_str()).or_insert(0) += 1;
        }
    }

    for (affix_id, &required) in &env.ga_required_counts {
        if ga_counts.get(affix_id.as_str()).copied().unwrap_or(0) < required {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::build_env;
    use crate::types::{AffixData, AffixEntry, JsEnvData, JsGaConfig, JsState, JsTarget, TargetAffixEntry};
    use std::collections::HashMap;

    fn minimal_env(ga_required: &[(&str, u32)], target_affixes: &[&str]) -> TranslationEnv {
        let affixes: Vec<AffixData> = target_affixes
            .iter()
            .map(|id| AffixData {
                id: id.to_string(),
                categories: vec![],
                family: None,
                roll_weight: 1.0,
                family_roll_weight: 0.0,
                class: None,
                gear_slots: None,
            })
            .collect();

        let current_ga_affixes: Vec<Option<String>> = ga_required
            .iter()
            .map(|(id, _)| Some(id.to_string()))
            .collect();

        let target = JsTarget {
            affixes: target_affixes
                .iter()
                .map(|id| TargetAffixEntry { affix_id: id.to_string() })
                .collect(),
        };

        let data = JsEnvData {
            affixes,
            categories: HashMap::new(),
            gear_slots: None,
            classes: None,
        };

        let ga_config = JsGaConfig { current_ga_affixes };

        build_env(data, ga_config, target)
    }

    fn make_state(affixes: &[(&str, bool, bool)]) -> JsState {
        JsState {
            is_legendary: false,
            gear_slot: Some("Any".to_string()),
            class: Some("Any".to_string()),
            affixes: affixes
                .iter()
                .map(|(id, ga, enc)| AffixEntry {
                    affix_id: id.to_string(),
                    is_ga: *ga,
                    is_enchanted: *enc,
                })
                .collect(),
            unsatisfactory_affix_ids: vec![],
        }
    }

    #[test]
    fn no_ga_required_never_breaks() {
        let env = minimal_env(&[], &["max-life"]);
        let state = make_state(&[("max-life", false, false)]);
        assert!(!breaks_required_ga(&state, &env));
    }

    #[test]
    fn ga_present_does_not_break() {
        let env = minimal_env(&[("max-life", 1)], &["max-life"]);
        let state = make_state(&[("max-life", true, false)]);
        assert!(!breaks_required_ga(&state, &env));
    }

    #[test]
    fn ga_missing_breaks() {
        let env = minimal_env(&[("max-life", 1)], &["max-life"]);
        // max-life is present but not as GA
        let state = make_state(&[("max-life", false, false)]);
        assert!(breaks_required_ga(&state, &env));
    }

    #[test]
    fn is_terminal_success() {
        let env = minimal_env(&[], &["max-life", "attack-speed"]);
        let state = make_state(&[("max-life", false, false), ("attack-speed", false, false)]);
        let target = JsTarget {
            affixes: vec![
                TargetAffixEntry { affix_id: "max-life".to_string() },
                TargetAffixEntry { affix_id: "attack-speed".to_string() },
            ],
        };
        let r = is_terminal(&state, &target, &env);
        assert!(r.terminal && r.success);
    }

    #[test]
    fn is_terminal_missing_affix() {
        let env = minimal_env(&[], &["max-life", "attack-speed"]);
        let state = make_state(&[("max-life", false, false)]);
        let target = JsTarget {
            affixes: vec![
                TargetAffixEntry { affix_id: "max-life".to_string() },
                TargetAffixEntry { affix_id: "attack-speed".to_string() },
            ],
        };
        let r = is_terminal(&state, &target, &env);
        assert!(!r.terminal && !r.success);
    }

    #[test]
    fn is_terminal_broken_ga() {
        let env = minimal_env(&[("max-life", 1)], &["max-life"]);
        // max-life is not GA — required GA is broken
        let state = make_state(&[("max-life", false, false)]);
        let target = JsTarget {
            affixes: vec![TargetAffixEntry { affix_id: "max-life".to_string() }],
        };
        let r = is_terminal(&state, &target, &env);
        assert!(r.terminal && !r.success);
    }
}
