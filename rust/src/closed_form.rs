use std::collections::HashSet;

use crate::env::TranslationEnv;
use crate::types::{AffixEntry, ClosedFormCandidate, ClosedFormOptions, JsState, JsTarget, TargetAffixEntry};

const RE_ENCHANT_TIE_BREAK_COST: f64 = 0.5;

pub const CASE_A: &str = "A";
pub const CASE_B: &str = "B";
pub const CASE_C: &str = "C";
pub const CASE_E: &str = "E";
pub const CASE_F: &str = "F";
pub const CASE_G: &str = "G";
pub const CASE_REENCHANT: &str = "REENCHANT";

// ── Category / affix helpers ──────────────────────────────────────────────────

/// Categories of `affix_id` for an operation type.
/// Mirrors JS `getAffixCategoriesForOpV3`.
pub fn get_affix_categories_for_op(
    affix_id: &str,
    op_type: Option<&str>,
    env: &TranslationEnv,
) -> Vec<String> {
    let affix = match env.affix_map.get(affix_id) {
        Some(a) => a,
        None => return vec![],
    };
    if let Some(op) = op_type {
        if let Some(op_cats) = &affix.operation_categories {
            if let Some(cats) = op_cats.get(op) {
                let mut sorted = cats.clone();
                sorted.sort_unstable();
                return sorted;
            }
        }
    }
    let mut sorted = affix.categories.clone();
    sorted.sort_unstable();
    sorted
}

/// True if `affix_id` belongs to `category` for the given op type.
/// Mirrors JS `affixHasCategoryV3`.
pub fn affix_has_category(
    affix_id: &str,
    category: &str,
    env: &TranslationEnv,
    op_type: Option<&str>,
) -> bool {
    get_affix_categories_for_op(affix_id, op_type, env)
        .iter()
        .any(|c| c == category)
}

/// Affix IDs in `category` for the state's slot+class, optionally op-type-filtered.
/// Mirrors JS `getCategoryAffixesForStateV3` (returning IDs only, not objects).
pub fn get_category_affix_ids_for_state(
    state: &JsState,
    category: &str,
    env: &TranslationEnv,
    op_type: Option<&str>,
) -> Vec<String> {
    let gear_slot = state.gear_slot.as_deref().unwrap_or("Any");
    let class_name = state.class.as_deref().unwrap_or("Any");

    // Resolve base list (IDs for this slot+class, no op-type filter yet)
    let base: Vec<String> = {
        // Try pre-computed slot+class table first
        if let Some(ids) = env
            .category_affix_ids_by_slot_by_class
            .get(gear_slot)
            .and_then(|by_cls| by_cls.get(class_name))
            .and_then(|by_cat| by_cat.get(category))
        {
            ids.clone()
        } else if gear_slot == "Any" && class_name == "Any" {
            env.category_affix_ids
                .get(category)
                .cloned()
                .unwrap_or_default()
        } else {
            // Fallback: slot list filtered by class at runtime
            let slot_ids = env
                .category_affix_ids_by_slot
                .get(gear_slot)
                .and_then(|by_cat| by_cat.get(category))
                .cloned()
                .or_else(|| env.category_affix_ids.get(category).cloned())
                .unwrap_or_default();
            slot_ids
                .into_iter()
                .filter(|id| {
                    env.affix_map
                        .get(id)
                        .map(|a| crate::env::affix_supports_class(a, class_name))
                        .unwrap_or(false)
                })
                .collect()
        }
    };

    if let Some(op) = op_type {
        base.into_iter()
            .filter(|id| affix_has_category(id, category, env, Some(op)))
            .collect()
    } else {
        base
    }
}

/// Count of affixes in the category pool (pool size for probability).
pub fn get_category_pool_size(
    state: &JsState,
    category: &str,
    env: &TranslationEnv,
    op_type: Option<&str>,
) -> usize {
    get_category_affix_ids_for_state(state, category, env, op_type).len()
}

/// Count of current affixes (excluding `ignore_index`) with the given category.
pub fn count_present_affixes_in_category(
    state: &JsState,
    category: &str,
    env: &TranslationEnv,
    ignore_index: Option<usize>,
    op_type: Option<&str>,
) -> usize {
    state
        .affixes
        .iter()
        .enumerate()
        .filter(|(idx, entry)| {
            if ignore_index == Some(*idx) || entry.affix_id.is_empty() {
                return false;
            }
            affix_has_category(&entry.affix_id, category, env, op_type)
        })
        .count()
}

/// pool_size - present_count; the denominator `n` in closed-form formulae.
pub fn get_category_success_denominator(
    state: &JsState,
    category: &str,
    env: &TranslationEnv,
    ignore_index: Option<usize>,
    op_type: Option<&str>,
) -> usize {
    let pool = get_category_pool_size(state, category, env, op_type);
    let present =
        count_present_affixes_in_category(state, category, env, ignore_index, op_type);
    pool.saturating_sub(present)
}

// ── GA / matched-target block helpers ────────────────────────────────────────

pub fn is_category_focused_blocked_by_ga(
    state: &JsState,
    prism: &str,
    env: &TranslationEnv,
) -> bool {
    if !env.strict_mode || env.ga_required_counts.is_empty() {
        return false;
    }
    state.affixes.iter().any(|entry| {
        if !entry.is_ga || entry.is_enchanted || entry.affix_id.is_empty() {
            return false;
        }
        if env.ga_required_counts.get(&entry.affix_id).copied().unwrap_or(0) == 0 {
            return false;
        }
        affix_has_category(&entry.affix_id, prism, env, Some("focused"))
    })
}

pub fn is_category_focused_blocked_by_matched_target(
    state: &JsState,
    prism: &str,
    env: &TranslationEnv,
    exclude_slot: Option<usize>,
) -> bool {
    if env.target_counts.is_empty() {
        return false;
    }
    state.affixes.iter().enumerate().any(|(idx, entry)| {
        if Some(idx) == exclude_slot || entry.is_enchanted || entry.affix_id.is_empty() {
            return false;
        }
        if env.target_counts.get(&entry.affix_id).copied().unwrap_or(0) == 0 {
            return false;
        }
        affix_has_category(&entry.affix_id, prism, env, Some("focused"))
    })
}

pub fn is_unique_unlocked_category_host(
    state: &JsState,
    slot_index: usize,
    category: &str,
    env: &TranslationEnv,
    op_type: Option<&str>,
) -> bool {
    let matches: Vec<usize> = state
        .affixes
        .iter()
        .enumerate()
        .filter_map(|(idx, entry)| {
            if entry.is_enchanted || entry.affix_id.is_empty() {
                return None;
            }
            if affix_has_category(&entry.affix_id, category, env, op_type) {
                Some(idx)
            } else {
                None
            }
        })
        .collect();
    matches.len() == 1 && matches[0] == slot_index
}

// ── Bug 1/2 helpers ───────────────────────────────────────────────────────────

pub fn can_use_enchant_follow_up_after_add(
    state: &JsState,
    env: &TranslationEnv,
    target_affix_id: &str,
) -> bool {
    if target_affix_id.is_empty() {
        return false;
    }
    if state.affixes.iter().any(|e| e.is_enchanted) {
        return false;
    }
    crate::feasibility::is_affix_legal_for_state(target_affix_id, state, env)
}

pub fn is_case_a_stuck_recovery_risk(
    state: &JsState,
    target: &JsTarget,
    env: &TranslationEnv,
    prism: &str,
) -> bool {
    if prism.is_empty() {
        return false;
    }
    if !state.affixes.iter().any(|e| e.is_enchanted) {
        return false;
    }
    let target_ids: HashSet<&str> = target
        .affixes
        .iter()
        .filter(|e| !e.affix_id.is_empty())
        .map(|e| e.affix_id.as_str())
        .collect();
    state.affixes.iter().any(|entry| {
        if entry.is_enchanted || entry.affix_id.is_empty() {
            return false;
        }
        if !target_ids.contains(entry.affix_id.as_str()) {
            return false;
        }
        affix_has_category(&entry.affix_id, prism, env, Some("focused"))
    })
}

// ── Discretionary enchant check ───────────────────────────────────────────────

pub fn is_discretionary_enchant_slot(
    state: &JsState,
    slot_index: usize,
    env: &TranslationEnv,
    protected_affix_ids: &HashSet<String>,
) -> bool {
    let host = match get_host_entry(state, slot_index) {
        Some(h) => h,
        None => return false,
    };
    if host.is_enchanted {
        return false;
    }
    if protected_affix_ids.contains(&host.affix_id) {
        return false;
    }
    env.target_counts.get(&host.affix_id).copied().unwrap_or(0) == 0
}

// ── Formula functions ─────────────────────────────────────────────────────────

pub fn compute_case_a_expected_steps(n: usize, use_enchant_follow_up: bool) -> Option<f64> {
    if n == 0 {
        return None;
    }
    let nf = n as f64;
    if use_enchant_follow_up {
        Some(2.0 - 1.0 / nf)
    } else {
        Some(nf - 1.0 + 1.0 / nf)
    }
}

pub fn compute_case_b_expected_steps(n: usize) -> Option<f64> {
    if n == 0 { None } else { Some(n as f64) }
}

pub fn compute_case_c_expected_steps(n: usize) -> Option<f64> {
    compute_case_a_expected_steps(n, false).map(|a| 1.0 + a)
}

// ── State helpers ─────────────────────────────────────────────────────────────

pub fn get_host_entry(state: &JsState, slot_index: usize) -> Option<&AffixEntry> {
    state.affixes.get(slot_index).filter(|e| !e.affix_id.is_empty())
}

pub fn is_empty_host_slot(state: &JsState, slot_index: usize, max_affix_slots: usize) -> bool {
    slot_index >= state.affixes.len() && slot_index < max_affix_slots
}

// ── Sort comparator ───────────────────────────────────────────────────────────

pub fn sort_candidates(candidates: &mut Vec<ClosedFormCandidate>) {
    candidates.sort_by(|a, b| {
        let a_steps = if a.expected_steps.is_finite() { a.expected_steps } else { f64::INFINITY };
        let b_steps = if b.expected_steps.is_finite() { b.expected_steps } else { f64::INFINITY };
        let diff = a_steps - b_steps;
        if diff.abs() > 1e-9 {
            return a_steps.partial_cmp(&b_steps).unwrap_or(std::cmp::Ordering::Equal);
        }
        let a_tok = format!(
            "{}|{}|{}",
            a.case_id,
            a.prism.as_deref().unwrap_or(""),
            a.remove_prism.as_deref().unwrap_or("")
        );
        let b_tok = format!(
            "{}|{}|{}",
            b.case_id,
            b.prism.as_deref().unwrap_or(""),
            b.remove_prism.as_deref().unwrap_or("")
        );
        a_tok.cmp(&b_tok)
    });
}

// ── Main function ─────────────────────────────────────────────────────────────

/// Mirrors JS `getClosedFormPlanCandidatesV3`.
pub fn get_closed_form_plan_candidates(
    state: &JsState,
    target_entry: &TargetAffixEntry,
    slot_index: usize,
    env: &TranslationEnv,
    options: &ClosedFormOptions,
    target_for_risk: Option<&JsTarget>,
) -> Vec<ClosedFormCandidate> {
    let mut candidates: Vec<ClosedFormCandidate> = Vec::new();

    let max_affix_slots = options
        .max_affix_slots
        .map(|v| v as usize)
        .unwrap_or_else(|| crate::env::get_max_affix_slots(state, env));

    let target_categories_add =
        get_affix_categories_for_op(&target_entry.affix_id, Some("add"), env);
    let target_categories_focused =
        get_affix_categories_for_op(&target_entry.affix_id, Some("focused"), env);

    if slot_index >= max_affix_slots
        || (target_categories_add.is_empty() && target_categories_focused.is_empty())
    {
        return candidates;
    }

    let has_enchanted_slot = state.affixes.iter().any(|e| e.is_enchanted);
    let protected_set: HashSet<String> = options.protected_affix_ids.iter().cloned().collect();

    // ── Case E: discretionary enchant ────────────────────────────────────────
    if get_host_entry(state, slot_index).is_some()
        && options.allow_discretionary_enchant
        && !has_enchanted_slot
        && is_discretionary_enchant_slot(state, slot_index, env, &protected_set)
    {
        candidates.push(ClosedFormCandidate {
            ok: true,
            case_id: CASE_E.to_string(),
            slot_index,
            target_affix_id: target_entry.affix_id.clone(),
            expected_steps: 1.0,
            prism: None,
            remove_prism: None,
            denominator: None,
            use_enchant_follow_up: false,
            loose_estimate: false,
            action_type: Some("enchant".to_string()),
            source_index: Some(slot_index),
        });
    }

    match get_host_entry(state, slot_index) {
        None => {
            // Empty slot: Case A
            if !is_empty_host_slot(state, slot_index, max_affix_slots) {
                return candidates;
            }
            for prism in &target_categories_add {
                let n = get_category_success_denominator(state, prism, env, None, Some("add"));
                let use_follow_up =
                    can_use_enchant_follow_up_after_add(state, env, &target_entry.affix_id);
                if let Some(expected_steps) = compute_case_a_expected_steps(n, use_follow_up) {
                    let loose_estimate = target_for_risk
                        .map(|t| is_case_a_stuck_recovery_risk(state, t, env, prism))
                        .unwrap_or(false);
                    candidates.push(ClosedFormCandidate {
                        ok: true,
                        case_id: CASE_A.to_string(),
                        slot_index,
                        target_affix_id: target_entry.affix_id.clone(),
                        expected_steps,
                        prism: Some(prism.clone()),
                        remove_prism: None,
                        denominator: Some(n as f64),
                        use_enchant_follow_up: use_follow_up,
                        loose_estimate,
                        action_type: None,
                        source_index: None,
                    });
                }
            }
            sort_candidates(&mut candidates);
            return candidates;
        }
        Some(host) => {
            let host = host.clone(); // avoid borrow issues

            // Enchanted slot: REENCHANT if eligible
            if host.is_enchanted {
                if !host.is_ga
                    && env.target_counts.get(&host.affix_id).copied().unwrap_or(0) == 0
                    && !state
                        .affixes
                        .iter()
                        .enumerate()
                        .any(|(idx, e)| idx != slot_index && e.affix_id == target_entry.affix_id)
                {
                    candidates.push(ClosedFormCandidate {
                        ok: true,
                        case_id: CASE_REENCHANT.to_string(),
                        slot_index,
                        target_affix_id: target_entry.affix_id.clone(),
                        expected_steps: RE_ENCHANT_TIE_BREAK_COST,
                        prism: None,
                        remove_prism: None,
                        denominator: None,
                        use_enchant_follow_up: false,
                        loose_estimate: false,
                        action_type: Some("enchant".to_string()),
                        source_index: Some(slot_index),
                    });
                }
                return candidates;
            }

            let shared_categories: Vec<String> = target_categories_focused
                .iter()
                .filter(|cat| affix_has_category(&host.affix_id, cat, env, Some("focused")))
                .cloned()
                .collect();

            // Case F: GA improvement of an already-present target
            if target_entry.needs_improvement
                && host.affix_id == target_entry.affix_id
                && !host.is_ga
            {
                for prism in &shared_categories {
                    if is_category_focused_blocked_by_ga(state, prism, env) {
                        continue;
                    }
                    if is_category_focused_blocked_by_matched_target(
                        state,
                        prism,
                        env,
                        Some(slot_index),
                    ) {
                        continue;
                    }
                    let n = get_category_success_denominator(
                        state,
                        prism,
                        env,
                        None,
                        Some("focused"),
                    );
                    let expected_steps = if options.touch_only_improvement {
                        Some(1.0)
                    } else {
                        compute_case_b_expected_steps(n)
                    };
                    if let Some(steps) = expected_steps {
                        candidates.push(ClosedFormCandidate {
                            ok: true,
                            case_id: CASE_F.to_string(),
                            slot_index,
                            target_affix_id: target_entry.affix_id.clone(),
                            expected_steps: steps,
                            prism: Some(prism.clone()),
                            remove_prism: None,
                            denominator: Some(n as f64),
                            use_enchant_follow_up: false,
                            loose_estimate: false,
                            action_type: None,
                            source_index: None,
                        });
                    }
                }
            }

            // Case B: focused reroll of a non-matching, non-GA slot
            if !shared_categories.is_empty()
                && host.affix_id != target_entry.affix_id
                && !host.is_ga
            {
                for prism in &shared_categories {
                    if is_category_focused_blocked_by_ga(state, prism, env) {
                        continue;
                    }
                    if is_category_focused_blocked_by_matched_target(
                        state,
                        prism,
                        env,
                        Some(slot_index),
                    ) {
                        continue;
                    }
                    let n = get_category_success_denominator(
                        state,
                        prism,
                        env,
                        None,
                        Some("focused"),
                    );
                    if let Some(steps) = compute_case_b_expected_steps(n) {
                        candidates.push(ClosedFormCandidate {
                            ok: true,
                            case_id: CASE_B.to_string(),
                            slot_index,
                            target_affix_id: target_entry.affix_id.clone(),
                            expected_steps: steps,
                            prism: Some(prism.clone()),
                            remove_prism: None,
                            denominator: Some(n as f64),
                            use_enchant_follow_up: false,
                            loose_estimate: false,
                            action_type: None,
                            source_index: None,
                        });
                    }
                }
            }

            // Case G: focused reroll of a GA slot
            if !shared_categories.is_empty() && host.is_ga {
                for prism in &shared_categories {
                    if is_category_focused_blocked_by_ga(state, prism, env) {
                        continue;
                    }
                    if is_category_focused_blocked_by_matched_target(
                        state,
                        prism,
                        env,
                        Some(slot_index),
                    ) {
                        continue;
                    }
                    let n = get_category_success_denominator(
                        state,
                        prism,
                        env,
                        None,
                        Some("focused"),
                    );
                    if let Some(steps) = compute_case_b_expected_steps(n) {
                        candidates.push(ClosedFormCandidate {
                            ok: true,
                            case_id: CASE_G.to_string(),
                            slot_index,
                            target_affix_id: target_entry.affix_id.clone(),
                            expected_steps: steps,
                            prism: Some(prism.clone()),
                            remove_prism: None,
                            denominator: Some(n as f64),
                            use_enchant_follow_up: false,
                            loose_estimate: false,
                            action_type: None,
                            source_index: None,
                        });
                    }
                }
            }

            // Case C: remove + focused reroll (no shared category, not legendary)
            if shared_categories.is_empty() && !state.is_legendary {
                let removable_categories: Vec<String> =
                    get_affix_categories_for_op(&host.affix_id, Some("remove"), env)
                        .into_iter()
                        .filter(|cat| {
                            is_unique_unlocked_category_host(
                                state,
                                slot_index,
                                cat,
                                env,
                                Some("remove"),
                            )
                        })
                        .collect();

                for remove_prism in &removable_categories {
                    for prism in &target_categories_focused {
                        if is_category_focused_blocked_by_ga(state, prism, env) {
                            continue;
                        }
                        if is_category_focused_blocked_by_matched_target(
                            state,
                            prism,
                            env,
                            Some(slot_index),
                        ) {
                            continue;
                        }
                        let n = get_category_success_denominator(
                            state,
                            prism,
                            env,
                            Some(slot_index),
                            Some("focused"),
                        );
                        if let Some(steps) = compute_case_c_expected_steps(n) {
                            candidates.push(ClosedFormCandidate {
                                ok: true,
                                case_id: CASE_C.to_string(),
                                slot_index,
                                target_affix_id: target_entry.affix_id.clone(),
                                expected_steps: steps,
                                prism: Some(prism.clone()),
                                remove_prism: Some(remove_prism.clone()),
                                denominator: Some(n as f64),
                                use_enchant_follow_up: false,
                                loose_estimate: false,
                                action_type: None,
                                source_index: None,
                            });
                        }
                    }
                }
            }
        }
    }

    sort_candidates(&mut candidates);
    candidates
}
