use crate::closed_form::{
    affix_has_category, get_affix_categories_for_op, get_closed_form_plan_candidates,
    get_host_entry, is_empty_host_slot,
};
use crate::env::TranslationEnv;
use crate::feasibility::{analyze_feasibility, get_protected_affix_ids};
use crate::types::{
    ClosedFormOptions, DecompositionOption, DecompositionPlanInput, FeasibilityResult,
    JsGaConfig, JsState, JsTarget, ResidualSlotInfo, ResidualTargetInfo, TargetRow,
};
use std::collections::HashSet;

const KEEP_PLAN_CASE_ID: &str = "KEEP";

// ── keep option ───────────────────────────────────────────────────────────────

fn create_keep_plan_option(
    target_index: usize,
    target_affix_id: &str,
    slot_index: usize,
) -> DecompositionOption {
    DecompositionOption {
        id: format!("t{}-s{}-keep", target_index, slot_index),
        key: format!("t{}|s{}|{}", target_index, slot_index, KEEP_PLAN_CASE_ID),
        target_index,
        target_affix_id: target_affix_id.to_string(),
        slot_index,
        case_id: KEEP_PLAN_CASE_ID.to_string(),
        prism: String::new(),
        remove_prism: String::new(),
        prism_delta: 0,
        uses_enchant: false,
        cost_kind: "constant".to_string(),
        constant_cost: 0.0,
        base_denominator: None,
        requires_stage: false,
        source_index: slot_index,
        use_enchant_follow_up: false,
        loose_estimate: false,
        action: None,
    }
}

// ── isTargetSatisfiedAtSlotV3 ─────────────────────────────────────────────────

fn is_target_satisfied_at_slot(
    state: &JsState,
    target_affix_id: &str,
    needs_improvement: bool,
    slot_index: usize,
) -> bool {
    let host = match get_host_entry(state, slot_index) {
        Some(h) => h,
        None => return false,
    };
    if host.affix_id != target_affix_id {
        return false;
    }
    !needs_improvement
}

// ── createDecompositionOptionV3 ───────────────────────────────────────────────

fn build_decomposition_action(option: &DecompositionOption) -> Option<serde_json::Value> {
    use crate::closed_form::{CASE_A, CASE_B, CASE_C, CASE_E, CASE_F, CASE_G, CASE_REENCHANT};
    if option.case_id == KEEP_PLAN_CASE_ID {
        return None;
    }
    if option.case_id == CASE_A {
        return Some(serde_json::json!({
            "type": "add",
            "prism": option.prism,
        }));
    }
    if option.case_id == CASE_B
        || option.case_id == CASE_F
        || option.case_id == CASE_G
    {
        return Some(serde_json::json!({
            "type": "focused",
            "prism": option.prism,
        }));
    }
    if option.case_id == CASE_C {
        return Some(serde_json::json!({
            "type": "remove",
            "prism": option.remove_prism,
        }));
    }
    if option.case_id == CASE_E || option.case_id == CASE_REENCHANT {
        return Some(serde_json::json!({
            "type": "enchant",
            "sourceIndex": option.source_index,
            "targetAffixId": option.target_affix_id,
        }));
    }
    None
}

fn create_decomposition_option(
    target_index: usize,
    target_affix_id: &str,
    slot_index: usize,
    candidate: &crate::types::ClosedFormCandidate,
    state: &JsState,
    env: &TranslationEnv,
) -> Option<DecompositionOption> {
    use crate::closed_form::{CASE_A, CASE_E, CASE_F, CASE_REENCHANT};

    let case_uses_add = candidate.case_id == CASE_A;
    let target_cats = if case_uses_add {
        get_affix_categories_for_op(target_affix_id, Some("add"), env)
    } else {
        get_affix_categories_for_op(target_affix_id, Some("focused"), env)
    };

    let requires_concrete_prism = matches!(
        candidate.case_id.as_str(),
        "A" | "B" | "C" | "F" | "G"
    );

    let prism = if let Some(ref p) = candidate.prism {
        p.clone()
    } else if target_cats.len() == 1 {
        target_cats[0].clone()
    } else {
        String::new()
    };

    if requires_concrete_prism && prism.is_empty() {
        return None;
    }

    let prism_op_type = if case_uses_add { "add" } else { "focused" };
    let prism_delta = if !prism.is_empty() {
        let host = get_host_entry(state, slot_index);
        if let Some(h) = host {
            if affix_has_category(&h.affix_id, &prism, env, Some(prism_op_type)) {
                0
            } else {
                1
            }
        } else {
            1
        }
    } else {
        0
    };

    // constant-cost cases: D, E, REENCHANT, and Case F where expectedSteps ≈ 1
    let constant_case = candidate.case_id == CASE_E
        || candidate.case_id == CASE_REENCHANT
        || (candidate.case_id == CASE_F
            && candidate.expected_steps.is_finite()
            && (candidate.expected_steps - 1.0).abs() <= 1e-9);

    let cost_kind = if constant_case { "constant" } else { "stage" };
    let constant_cost = if constant_case { candidate.expected_steps } else { 0.0 };

    let uses_enchant =
        candidate.case_id == CASE_E || candidate.case_id == CASE_REENCHANT;

    let source_index = candidate
        .source_index
        .unwrap_or(slot_index);

    let requires_stage = !prism.is_empty() && (prism_delta > 0 || !constant_case);

    let mut option = DecompositionOption {
        id: format!(
            "t{}-s{}-{}-{}-{}",
            target_index,
            slot_index,
            candidate.case_id,
            candidate.prism.as_deref().unwrap_or("none"),
            candidate.remove_prism.as_deref().unwrap_or("none")
        ),
        key: format!(
            "t{}|s{}|{}|{}|{}",
            target_index,
            slot_index,
            candidate.case_id,
            candidate.prism.as_deref().unwrap_or(""),
            candidate.remove_prism.as_deref().unwrap_or("")
        ),
        target_index,
        target_affix_id: target_affix_id.to_string(),
        slot_index,
        case_id: candidate.case_id.clone(),
        prism,
        remove_prism: candidate.remove_prism.clone().unwrap_or_default(),
        prism_delta,
        uses_enchant,
        cost_kind: cost_kind.to_string(),
        constant_cost,
        base_denominator: candidate.denominator,
        requires_stage,
        source_index,
        use_enchant_follow_up: candidate.use_enchant_follow_up,
        loose_estimate: candidate.loose_estimate,
        action: None,
    };
    option.action = build_decomposition_action(&option);
    Some(option)
}

// ── residual reason ───────────────────────────────────────────────────────────

fn get_closed_form_residual_reason(
    state: &JsState,
    target_affix_id: &str,
    slot_index: usize,
    env: &TranslationEnv,
    max_affix_slots: usize,
) -> String {
    if slot_index >= max_affix_slots {
        return "Slot index is outside the available host range.".to_string();
    }
    let host = get_host_entry(state, slot_index);
    if host.is_none() && !is_empty_host_slot(state, slot_index, max_affix_slots) {
        return "Host slot is not addressable in the current item shape.".to_string();
    }
    if let Some(h) = host {
        if h.is_enchanted {
            return "Host slot is already enchanted, so closed-form cube-touch cases do not apply."
                .to_string();
        }
    }

    let target_cats_add = get_affix_categories_for_op(target_affix_id, Some("add"), env);
    let target_cats_focused = get_affix_categories_for_op(target_affix_id, Some("focused"), env);
    if target_cats_add.is_empty() && target_cats_focused.is_empty() {
        return "Target affix has no legal category source in the current catalog.".to_string();
    }

    if host.is_none() {
        return "No closed-form empty-slot plan has positive remaining pool size.".to_string();
    }
    let host = host.unwrap();

    let shared: Vec<&str> = target_cats_focused
        .iter()
        .filter(|cat| affix_has_category(&host.affix_id, cat, env, Some("focused")))
        .map(|s| s.as_str())
        .collect();

    if !shared.is_empty() {
        return "Host slot shares a category with the target, but the closed-form assumptions for Cases B, F, or G are not satisfied.".to_string();
    }

    if state.is_legendary {
        return "Remove Affix is unavailable on Legendary items, so Case C is not applicable."
            .to_string();
    }

    let removable = get_affix_categories_for_op(&host.affix_id, Some("remove"), env);
    let unique_removable: Vec<String> = removable
        .into_iter()
        .filter(|cat| {
            crate::closed_form::is_unique_unlocked_category_host(
                state,
                slot_index,
                cat,
                env,
                Some("remove"),
            )
        })
        .collect();

    if unique_removable.is_empty() {
        return "Remove would not be deterministic because the host is not the unique unlocked slot in any current category.".to_string();
    }

    "No closed-form case applies; escalate this target-slot pair to the residual solver."
        .to_string()
}

// ── compareDecompositionOptionsV3 ────────────────────────────────────────────

fn compute_option_expected_steps(option: &DecompositionOption) -> f64 {
    if option.case_id == KEEP_PLAN_CASE_ID {
        return 0.0;
    }
    if option.cost_kind == "constant" {
        return option.constant_cost;
    }
    // For "stage" cost kind, at stage 0 (before any prism work) use base denominator
    if let Some(denom) = option.base_denominator {
        if denom > 0.0 {
            use crate::closed_form::{CASE_A, CASE_B, CASE_C, CASE_F, CASE_G};
            if option.case_id == CASE_A {
                let steps = if option.use_enchant_follow_up {
                    2.0 - 1.0 / denom
                } else {
                    denom - 1.0 + 1.0 / denom
                };
                return steps;
            }
            if option.case_id == CASE_B
                || option.case_id == CASE_F
                || option.case_id == CASE_G
            {
                return denom;
            }
            if option.case_id == CASE_C {
                return 1.0 + denom - 1.0 + 1.0 / denom;
            }
        }
    }
    f64::INFINITY
}

fn compare_decomposition_options(a: &DecompositionOption, b: &DecompositionOption) -> std::cmp::Ordering {
    if a.slot_index != b.slot_index {
        return a.slot_index.cmp(&b.slot_index);
    }
    let a_cost = compute_option_expected_steps(a);
    let b_cost = compute_option_expected_steps(b);
    if (a_cost - b_cost).abs() > 1e-9 {
        return a_cost.partial_cmp(&b_cost).unwrap_or(std::cmp::Ordering::Equal);
    }
    a.key.cmp(&b.key)
}

// ── Main: buildDecompositionPlanInputV3 ───────────────────────────────────────

pub fn build_decomposition_plan_input(
    state: &JsState,
    target: &JsTarget,
    ga_config: &JsGaConfig,
    env: &TranslationEnv,
    feasibility: Option<FeasibilityResult>,
) -> DecompositionPlanInput {
    let feasibility = feasibility.unwrap_or_else(|| {
        analyze_feasibility(state, target, ga_config, env)
    });
    let max_affix_slots = crate::env::get_max_affix_slots(state, env);

    let protected_affix_ids_vec: Vec<String> = if let serde_json::Value::Array(arr) =
        feasibility.details.get("protectedAffixIds").unwrap_or(&serde_json::Value::Null)
    {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect()
    } else {
        let ids = get_protected_affix_ids(target, ga_config);
        let mut v: Vec<String> = ids.into_iter().collect();
        v.sort();
        v
    };
    let protected_set: HashSet<String> = protected_affix_ids_vec.iter().cloned().collect();

    let mut targets: Vec<TargetRow> = Vec::new();
    let mut all_options: Vec<DecompositionOption> = Vec::new();
    let mut residual_targets: Vec<ResidualTargetInfo> = Vec::new();

    let target_entries: Vec<&crate::types::TargetAffixEntry> = target
        .affixes
        .iter()
        .filter(|e| !e.affix_id.is_empty())
        .collect();

    for (target_index, target_entry) in target_entries.iter().enumerate() {
        let mut row = TargetRow {
            target_index,
            target_affix_id: target_entry.affix_id.clone(),
            options: Vec::new(),
            residual_slots: Vec::new(),
        };
        let mut seen_keys: HashSet<String> = HashSet::new();

        let cf_options = ClosedFormOptions {
            max_affix_slots: Some(max_affix_slots as u32),
            allow_discretionary_enchant: true,
            touch_only_improvement: false,
            protected_affix_ids: protected_affix_ids_vec.clone(),
            target: Some(target.clone()),
            ga_config: Some(ga_config.clone()),
        };

        for slot_index in 0..max_affix_slots {
            // Check if target is already satisfied at this slot
            if is_target_satisfied_at_slot(
                state,
                &target_entry.affix_id,
                target_entry.needs_improvement,
                slot_index,
            ) {
                let keep = create_keep_plan_option(target_index, &target_entry.affix_id, slot_index);
                if !seen_keys.contains(&keep.key) {
                    seen_keys.insert(keep.key.clone());
                    all_options.push(keep.clone());
                    row.options.push(keep);
                }
            }

            // Skip protected slots
            let host = get_host_entry(state, slot_index);
            if let Some(h) = host {
                if protected_set.contains(&h.affix_id) {
                    row.residual_slots.push(ResidualSlotInfo {
                        slot_index,
                        reason: "Slot is explicitly protected and excluded from host pools."
                            .to_string(),
                    });
                    continue;
                }
            }

            let candidates = get_closed_form_plan_candidates(
                state,
                target_entry,
                slot_index,
                env,
                &cf_options,
                Some(target),
            );

            if candidates.is_empty() {
                let reason = get_closed_form_residual_reason(
                    state,
                    &target_entry.affix_id,
                    slot_index,
                    env,
                    max_affix_slots,
                );
                row.residual_slots.push(ResidualSlotInfo { slot_index, reason });
                continue;
            }

            for candidate in &candidates {
                let option = match create_decomposition_option(
                    target_index,
                    &target_entry.affix_id,
                    slot_index,
                    candidate,
                    state,
                    env,
                ) {
                    Some(o) => o,
                    None => continue,
                };
                if seen_keys.contains(&option.key) {
                    continue;
                }
                seen_keys.insert(option.key.clone());
                all_options.push(option.clone());
                row.options.push(option);
            }
        }

        row.options.sort_by(compare_decomposition_options);

        if row.options.is_empty() {
            let reason = row
                .residual_slots
                .first()
                .map(|s| s.reason.clone())
                .unwrap_or_else(|| {
                    "No decomposition-safe host option exists for this target.".to_string()
                });
            residual_targets.push(ResidualTargetInfo {
                target_index,
                target_affix_id: target_entry.affix_id.clone(),
                reason,
            });
        }

        targets.push(row);
    }

    let ok = residual_targets.is_empty();
    let reason = if ok {
        String::new()
    } else {
        "At least one target lacks a decomposition-safe host assignment and must be escalated to the residual solver.".to_string()
    };

    DecompositionPlanInput {
        ok,
        reason,
        _env_handle: 0,
        feasibility,
        max_affix_slots,
        targets,
        options: all_options,
        residual_targets,
    }
}
