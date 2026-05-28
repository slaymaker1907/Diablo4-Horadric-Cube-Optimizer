use std::collections::{HashMap, HashSet};

use crate::env::TranslationEnv;
use crate::types::{FeasibilityResult, JsGaConfig, JsState, JsTarget};

// ── Helpers mirroring JS worker helpers ──────────────────────────────────────

/// True if the affix is legal for the given state (slot + class constraints).
/// Mirrors JS `isAffixLegalForStateV3`.
pub fn is_affix_legal_for_state(affix_id: &str, state: &JsState, env: &TranslationEnv) -> bool {
    let affix = match env.affix_map.get(affix_id) {
        Some(a) => a,
        None => return false,
    };

    let class_name = state.class.as_deref().unwrap_or("Any");
    if !crate::env::affix_supports_class(affix, class_name) {
        return false;
    }

    let gear_slot = state.gear_slot.as_deref().unwrap_or("Any");
    crate::env::affix_supports_gear_slot(affix, gear_slot)
}

/// Returns the family of an affix (checks affix_map first, then ID-prefix rules).
/// Mirrors JS `getAffixFamilyV3`.
pub fn get_affix_family<'a>(affix_id: &str, env: &'a TranslationEnv) -> &'a str {
    if let Some(affix) = env.affix_map.get(affix_id) {
        if let Some(ref fam) = affix.family {
            if !fam.is_empty() {
                return fam.as_str();
            }
        }
    }
    if affix_id == "elemental-damage-other" || affix_id.starts_with("elemental-damage-") {
        return "elemental-damage";
    }
    if affix_id == "specific-resistance-other" || affix_id.starts_with("specific-resistance-") {
        return "specific-resistance";
    }
    ""
}

/// Collect target entries from a target spec.
pub fn get_target_entries(target: &JsTarget) -> Vec<&crate::types::TargetAffixEntry> {
    target
        .affixes
        .iter()
        .filter(|e| !e.affix_id.is_empty())
        .collect()
}

/// Affix IDs that should be improved (have GA).
/// Mirrors JS `getImproveAffixIdsV3`.
pub fn get_improve_affix_ids(target: &JsTarget, ga_config: &JsGaConfig) -> HashSet<String> {
    let from_target = target
        .affixes
        .iter()
        .filter(|e| e.needs_improvement)
        .map(|e| e.affix_id.clone());
    let from_config = ga_config.unsatisfactory_affix_ids.iter().cloned();
    normalize_id_set(from_target.chain(from_config))
}

/// Affix IDs that are explicitly forbidden.
/// Mirrors JS `getForbiddenAffixIdsV3`.
pub fn get_forbidden_affix_ids(target: &JsTarget, ga_config: &JsGaConfig) -> HashSet<String> {
    let combined = target
        .forbidden_affix_ids
        .iter()
        .chain(ga_config.forbidden_affix_ids.iter())
        .cloned();
    normalize_id_set(combined)
}

/// Affix IDs that are explicitly protected (must not be removed).
/// Mirrors JS `getProtectedAffixIdsV3`.
pub fn get_protected_affix_ids(target: &JsTarget, ga_config: &JsGaConfig) -> HashSet<String> {
    let combined = target
        .protected_affix_ids
        .iter()
        .chain(ga_config.protected_affix_ids.iter())
        .cloned();
    normalize_id_set(combined)
}

fn normalize_id_set(iter: impl Iterator<Item = String>) -> HashSet<String> {
    iter.filter(|s| !s.is_empty()).collect()
}

// ── analyzeFeasibilityV3 ──────────────────────────────────────────────────────

/// Mirrors JS `analyzeFeasibilityV3`.
/// Runs F4–F7 feasibility checks and returns the first failure or success.
pub fn analyze_feasibility(
    state: &JsState,
    target: &JsTarget,
    ga_config: &JsGaConfig,
    env: &TranslationEnv,
) -> FeasibilityResult {
    let target_entries = get_target_entries(target);
    let max_affix_slots = crate::env::get_max_affix_slots(state, env);

    let improve_affix_ids = get_improve_affix_ids(target, ga_config);
    let forbidden_affix_ids = get_forbidden_affix_ids(target, ga_config);
    let protected_affix_ids = get_protected_affix_ids(target, ga_config);
    let target_id_set: HashSet<&str> =
        target_entries.iter().map(|e| e.affix_id.as_str()).collect();

    let distinct_required = target_entries.len();
    let additional_protected = protected_affix_ids
        .iter()
        .filter(|id| !target_id_set.contains(id.as_str()))
        .count();
    let protected_union_count = distinct_required + additional_protected;

    // F4: required + protected exceeds slot capacity
    if protected_union_count > max_affix_slots {
        return FeasibilityResult {
            ok: false,
            check: Some("F4".to_string()),
            message: format!(
                "Required and protected affixes exceed slot capacity: need {}, but only {} slots are available.",
                protected_union_count, max_affix_slots
            ),
            details: serde_json::json!({
                "maxAffixSlots": max_affix_slots,
                "protectedUnionCount": protected_union_count,
                "protectedAffixIds": Vec::from_iter(protected_affix_ids.iter().cloned()),
            }),
        };
    }

    // F5: target affix not legal for slot/class
    for entry in &target_entries {
        if !is_affix_legal_for_state(&entry.affix_id, state, env) {
            return FeasibilityResult {
                ok: false,
                check: Some("F5".to_string()),
                message: format!(
                    "Target affix {} is not legal for the current item slot, class, or affix pool.",
                    entry.affix_id
                ),
                details: serde_json::json!({
                    "illegalAffixId": entry.affix_id,
                    "gearSlot": state.gear_slot.as_deref().unwrap_or("Any"),
                    "class": state.class.as_deref().unwrap_or("Any"),
                }),
            };
        }
    }

    // F6: duplicate required affix OR same-family conflict
    let mut required_counts: HashMap<&str, u32> = HashMap::new();
    let mut family_counts: HashMap<String, u32> = HashMap::new();
    for entry in &target_entries {
        *required_counts.entry(entry.affix_id.as_str()).or_insert(0) += 1;
        let fam = get_affix_family(&entry.affix_id, env);
        if !fam.is_empty() {
            *family_counts.entry(fam.to_string()).or_insert(0) += 1;
        }
    }

    if let Some((&dup_id, &count)) = required_counts.iter().find(|(_, &c)| c > 1) {
        return FeasibilityResult {
            ok: false,
            check: Some("F6".to_string()),
            message: format!(
                "Target affix {} is required more than once, which exceeds item uniqueness constraints.",
                dup_id
            ),
            details: serde_json::json!({
                "duplicateAffixId": dup_id,
                "duplicateCount": count,
            }),
        };
    }

    if let Some((fam, &count)) = family_counts.iter().find(|(_, &c)| c > 1) {
        return FeasibilityResult {
            ok: false,
            check: Some("F6".to_string()),
            message: format!(
                "Target contains mutually exclusive affixes from the {} family.",
                fam
            ),
            details: serde_json::json!({
                "conflictingFamily": fam,
                "familyCount": count,
            }),
        };
    }

    // F7: target affix also forbidden
    if let Some(conflict) = target_entries
        .iter()
        .find(|e| forbidden_affix_ids.contains(&e.affix_id))
    {
        return FeasibilityResult {
            ok: false,
            check: Some("F7".to_string()),
            message: format!(
                "Target affix {} is both required and forbidden.",
                conflict.affix_id
            ),
            details: serde_json::json!({
                "conflictingAffixId": conflict.affix_id,
            }),
        };
    }

    // Sort the output sets for determinism (JS sorts via normalizeIdList)
    let mut protected_sorted: Vec<String> = protected_affix_ids.into_iter().collect();
    protected_sorted.sort();
    let mut forbidden_sorted: Vec<String> = forbidden_affix_ids.into_iter().collect();
    forbidden_sorted.sort();
    let mut improve_sorted: Vec<String> = improve_affix_ids.into_iter().collect();
    improve_sorted.sort();

    FeasibilityResult {
        ok: true,
        check: None,
        message: String::new(),
        details: serde_json::json!({
            "maxAffixSlots": max_affix_slots,
            "protectedAffixIds": protected_sorted,
            "forbiddenAffixIds": forbidden_sorted,
            "improveAffixIds": improve_sorted,
        }),
    }
}
