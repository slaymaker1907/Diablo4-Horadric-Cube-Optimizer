use std::collections::{HashMap, HashSet};

use crate::actions::{
    action_cost, canonicalize_affix_id_for_state, get_affix_family,
    get_category_affixes_for_state, get_category_pool_weights_for_state,
    get_eligible_by_category, get_valid_actions_v2, violates_family_uniqueness,
};
use crate::env::TranslationEnv;
use crate::intern::{intern_state, intern_action, iresidual_key_v3, istate_key_v1, istate_key_v2, action_sort_key};
use crate::types::{AffixData, AffixEntry, FeasibilityResult, JsAction, JsGaConfig, JsState, JsTarget};

// ── Constants ─────────────────────────────────────────────────────────────────

pub const RESIDUAL_EPSILON: f64 = 1e-9;
pub const RESIDUAL_PHASE2_EPSILON: f64 = 1e-6;
pub const RESIDUAL_ACTION_EPSILON: f64 = 1e-8;
pub const RESIDUAL_STATE_LIMIT: usize = 500;
pub const RESIDUAL_MAX_ITERATIONS: usize = 4096;

// ── Outcome type ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Outcome {
    pub probability: f64,
    pub state: JsState,
}

// ── Graph types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Transition {
    pub probability: f64,
    pub child_index: usize,
}

#[derive(Debug, Clone)]
pub struct ActionEntry {
    pub action: JsAction,
    pub cube_cost: f64,
    pub transitions: Vec<Transition>,
    /// Pre-computed sort key; replaces per-call `action_key()` string allocation.
    pub sort_key: u64,
}

#[derive(Debug)]
pub struct GraphNode {
    pub key: u128,
    pub state: JsState,
    pub success: bool,
    pub dead_reason: String,
    pub action_entries: Vec<ActionEntry>,
}

pub struct ResidualGraph {
    pub ok: bool,
    pub root_key: u128,
    pub root_index: usize,
    pub nodes: Vec<GraphNode>,
    pub dead_states: usize,
    pub reason: String,
    pub limit: usize,
}

// ── Solver phase results ──────────────────────────────────────────────────────

pub struct Phase1Result {
    pub values: Vec<f64>,
    pub iterations: usize,
    pub converged: bool,
    pub residual: f64,
}

#[derive(Clone)]
pub struct Phase2Result {
    pub costs: Vec<f64>,
    pub iterations: usize,
    pub converged: bool,
    pub residual: f64,
}

pub enum SolverStatus {
    Optimal,
    IterationLimit,
}

pub struct ResidualSolution {
    pub status: SolverStatus,
    pub phase1: Option<Phase1Result>,
    pub phase2: Option<Phase2Result>,
}

// ── State utilities ───────────────────────────────────────────────────────────

/// Clone a JsState (v1 clone: no unsatisfactory list).
pub fn clone_state_v1(state: &JsState) -> JsState {
    JsState {
        is_legendary: state.is_legendary,
        gear_slot: Some(
            state
                .gear_slot
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("Any")
                .to_string(),
        ),
        class: Some(
            state
                .class
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("Any")
                .to_string(),
        ),
        affixes: state
            .affixes
            .iter()
            .map(|e| AffixEntry {
                affix_id: e.affix_id.clone(),
                is_ga: e.is_ga,
                is_enchanted: e.is_enchanted,
            })
            .collect(),
        unsatisfactory_affix_ids: vec![],
        max_affix_slots: None,
    }
}

/// Clone a JsState (v2 clone: includes unsatisfactory list).
pub fn clone_state_v2(state: &JsState) -> JsState {
    let mut next = clone_state_v1(state);
    next.unsatisfactory_affix_ids = state.unsatisfactory_affix_ids.clone();
    next
}

/// Get unsatisfactory counts from a state.
pub fn get_unsatisfactory_counts(state: &JsState) -> HashMap<String, u32> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for id in &state.unsatisfactory_affix_ids {
        *counts.entry(id.clone()).or_insert(0) += 1;
    }
    counts
}

/// True if state has duplicate affix IDs.
pub fn has_duplicate_affix_ids_v2(state: &JsState) -> bool {
    let mut seen: HashSet<&str> = HashSet::new();
    for entry in &state.affixes {
        if !seen.insert(entry.affix_id.as_str()) {
            return true;
        }
    }
    false
}

/// Mirrors JS `normalizeUnsatisfactoryAffixIds`.
fn normalize_unsatisfactory_affix_ids(ga_config: &JsGaConfig) -> Vec<String> {
    let mut ids: Vec<String> = ga_config
        .unsatisfactory_affix_ids
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect();
    ids.sort();
    ids
}

/// Canonicalize a state's unsatisfactory IDs against its actual affixes.
/// Mirrors JS `canonicalizeUnsatisfactoryIds`.
pub fn canonicalize_unsatisfactory_ids(state: JsState) -> JsState {
    let mut next = clone_state_v2(&state);

    let mut present_counts: HashMap<&str, u32> = HashMap::new();
    for entry in &next.affixes {
        *present_counts.entry(entry.affix_id.as_str()).or_insert(0) += 1;
    }

    let mut unsat_counts: HashMap<String, u32> = HashMap::new();
    for affix_id in &state.unsatisfactory_affix_ids {
        if affix_id.is_empty() {
            continue;
        }
        let used = unsat_counts.get(affix_id.as_str()).copied().unwrap_or(0);
        if used >= present_counts.get(affix_id.as_str()).copied().unwrap_or(0) {
            continue;
        }
        *unsat_counts.entry(affix_id.clone()).or_insert(0) += 1;
    }

    let mut ids: Vec<String> = unsat_counts
        .into_iter()
        .flat_map(|(id, cnt)| std::iter::repeat(id).take(cnt as usize))
        .collect();
    ids.sort();
    next.unsatisfactory_affix_ids = ids;

    // Also sort affixes
    next.affixes.sort_by(|a, b| {
        a.affix_id.cmp(&b.affix_id)
            .then_with(|| (a.is_ga as u8).cmp(&(b.is_ga as u8)))
            .then_with(|| (a.is_enchanted as u8).cmp(&(b.is_enchanted as u8)))
    });

    next
}

/// Mirrors JS `normalizeOutcomeStateV2` = `canonicalizeUnsatisfactoryIds`.
pub fn normalize_outcome_state_v2(state: JsState) -> JsState {
    canonicalize_unsatisfactory_ids(state)
}

/// Mirrors JS `attachUnsatisfactoryToState`.
pub fn attach_unsatisfactory_to_state(state: &JsState, ga_config: &JsGaConfig) -> JsState {
    let mut next = clone_state_v2(state);
    next.unsatisfactory_affix_ids = normalize_unsatisfactory_affix_ids(ga_config);
    next
}

/// Mirrors JS `markUnsatisfactoryTransition`.
fn mark_unsatisfactory_transition(
    prev_state: &JsState,
    next_state: JsState,
    action: &JsAction,
    _env: &TranslationEnv,
) -> JsState {
    let mut next = clone_state_v2(&next_state);
    let prior_counts = get_unsatisfactory_counts(prev_state);

    if prior_counts.is_empty() {
        return normalize_outcome_state_v2(next);
    }

    let next_affix_counts: HashMap<&str, u32> = {
        let mut m = HashMap::new();
        for entry in &next.affixes {
            *m.entry(entry.affix_id.as_str()).or_insert(0) += 1;
        }
        m
    };

    let mut remaining: Vec<String> = Vec::new();
    for (affix_id, count) in &prior_counts {
        let mut keep_count = (*count).min(
            next_affix_counts
                .get(affix_id.as_str())
                .copied()
                .unwrap_or(0),
        );

        if action.action_type == "enchant"
            && action.target_affix_id.as_deref() == Some(affix_id.as_str())
        {
            keep_count = 0;
        }

        if action.action_type != "enchant" && is_cube_action_type(&action.action_type) && keep_count > 0 {
            let next_matching: Vec<&AffixEntry> = next
                .affixes
                .iter()
                .filter(|e| e.affix_id.as_str() == affix_id.as_str())
                .collect();
            let unlocked = next_matching.iter().filter(|e| !e.is_enchanted).count() as u32;
            keep_count = keep_count.min(unlocked);
        }

        for _ in 0..keep_count {
            remaining.push(affix_id.clone());
        }
    }

    next.unsatisfactory_affix_ids = {
        let mut v = remaining;
        v.sort();
        v
    };
    normalize_outcome_state_v2(next)
}

fn is_cube_action_type(t: &str) -> bool {
    matches!(t, "add" | "remove" | "chaotic" | "focused")
}

// ── Action outcomes ───────────────────────────────────────────────────────────

/// Roll weight for an affix.
pub fn get_affix_roll_weight(affix: &AffixData) -> f64 {
    let w = affix.roll_weight;
    if w.is_finite() && w > 0.0 { w } else { 1.0 }
}

/// Family counts in a pool.
pub fn build_family_counts_for_pool(pool: &[&AffixData]) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for affix in pool {
        if let Some(ref fam) = affix.family {
            if !fam.is_empty() {
                *counts.entry(fam.clone()).or_insert(0) += 1;
            }
        }
    }
    counts
}

/// Effective roll weight for an affix within a pool (family-normalized).
pub fn get_effective_affix_roll_weight(affix: &AffixData, family_counts: &HashMap<String, usize>) -> f64 {
    let frw = affix.family_roll_weight;
    if frw.is_finite() && frw > 0.0 {
        if let Some(ref fam) = affix.family {
            if !fam.is_empty() {
                let count = family_counts.get(fam).copied().unwrap_or(0);
                if count > 0 {
                    return frw / count as f64;
                }
            }
        }
    }
    get_affix_roll_weight(affix)
}

/// Sum effective weights of a pool.
pub fn sum_effective_weights(pool: &[&AffixData]) -> f64 {
    let family_counts = build_family_counts_for_pool(pool);
    pool.iter()
        .map(|a| get_effective_affix_roll_weight(a, &family_counts))
        .sum()
}

/// Merge outcomes by integer state key (summing probabilities), then renormalize.
pub fn merge_outcomes(outcomes: Vec<Outcome>, env: &TranslationEnv) -> Vec<Outcome> {
    let mut merged: HashMap<u64, Outcome> = HashMap::new();
    let mut total = 0.0;

    for outcome in outcomes {
        if !outcome.probability.is_finite() || outcome.probability <= 0.0 {
            continue;
        }
        let key = istate_key_v1(&intern_state(&outcome.state, env));
        total += outcome.probability;
        if let Some(existing) = merged.get_mut(&key) {
            existing.probability += outcome.probability;
        } else {
            merged.insert(key, outcome);
        }
    }

    if total <= 0.0 {
        return vec![];
    }

    merged
        .into_values()
        .map(|mut o| {
            o.probability /= total;
            o
        })
        .collect()
}

/// Mirrors JS `getActionOutcomes` (v1).
pub fn get_action_outcomes(state: &JsState, action: &JsAction, env: &TranslationEnv) -> Vec<Outcome> {
    match action.action_type.as_str() {
        "add" => {
            let prism = match action.prism.as_deref() {
                Some(p) => p,
                None => return vec![],
            };
            let list = get_category_affixes_for_state(state, env, prism, "add");
            if list.is_empty() || state.affixes.len() >= 4 {
                return vec![];
            }
            let weights = get_category_pool_weights_for_state(state, env, prism, "add");
            let family_counts = &weights.0;
            let total_weight = weights.1;
            if total_weight <= 0.0 {
                return vec![];
            }
            let mut outcomes: Vec<Outcome> = Vec::new();
            for affix in &list {
                let p = get_effective_affix_roll_weight(affix, family_counts) / total_weight;
                let canonical_id = canonicalize_affix_id_for_state(&affix.id, env);
                let mut next = clone_state_v1(state);
                next.affixes.push(AffixEntry {
                    affix_id: canonical_id,
                    is_ga: false,
                    is_enchanted: false,
                });
                if violates_family_uniqueness(&next, env) {
                    continue;
                }
                outcomes.push(Outcome { probability: p, state: next });
            }
            merge_outcomes(outcomes, env)
        }

        "remove" => {
            if state.is_legendary {
                return vec![];
            }
            let prism = match action.prism.as_deref() {
                Some(p) => p,
                None => return vec![],
            };
            let eligible = get_eligible_by_category(state, env, prism, "remove");
            if eligible.is_empty() {
                return vec![];
            }
            let p = 1.0 / eligible.len() as f64;
            let mut outcomes: Vec<Outcome> = Vec::new();
            for (idx, _) in &eligible {
                let mut next = clone_state_v1(state);
                next.affixes.remove(*idx);
                outcomes.push(Outcome { probability: p, state: next });
            }
            merge_outcomes(outcomes, env)
        }

        "focused" => {
            let prism = match action.prism.as_deref() {
                Some(p) => p,
                None => return vec![],
            };
            let eligible = get_eligible_by_category(state, env, prism, "focused");
            if eligible.is_empty() {
                return vec![];
            }
            let list = get_category_affixes_for_state(state, env, prism, "focused");
            if list.is_empty() {
                return vec![];
            }
            let weights = get_category_pool_weights_for_state(state, env, prism, "focused");
            let family_counts = &weights.0;
            let total_weight = weights.1;
            if total_weight <= 0.0 {
                return vec![];
            }
            let source_p = 1.0 / eligible.len() as f64;
            let mut outcomes: Vec<Outcome> = Vec::new();
            for (idx, _) in &eligible {
                for affix in &list {
                    let affix_p = get_effective_affix_roll_weight(affix, family_counts) / total_weight;
                    let canonical_id = canonicalize_affix_id_for_state(&affix.id, env);
                    let mut next = clone_state_v1(state);
                    next.affixes[*idx] = AffixEntry {
                        affix_id: canonical_id,
                        is_ga: false,
                        is_enchanted: false,
                    };
                    if violates_family_uniqueness(&next, env) {
                        continue;
                    }
                    outcomes.push(Outcome { probability: source_p * affix_p, state: next });
                }
            }
            merge_outcomes(outcomes, env)
        }

        "chaotic" => {
            let prism = match action.prism.as_deref() {
                Some(p) => p,
                None => return vec![],
            };
            let eligible = get_eligible_by_category(state, env, prism, "chaotic");
            if eligible.is_empty() {
                return vec![];
            }
            let source_p = 1.0 / eligible.len() as f64;
            let n_cats = env.category_names.len();
            if n_cats == 0 {
                return vec![];
            }
            let category_p = 1.0 / n_cats as f64;
            let mut outcomes: Vec<Outcome> = Vec::new();
            for (idx, _) in &eligible {
                for cat in &env.category_names {
                    let list = get_category_affixes_for_state(state, env, cat, "chaotic");
                    if list.is_empty() {
                        continue;
                    }
                    let weights = get_category_pool_weights_for_state(state, env, cat, "chaotic");
                    let family_counts = &weights.0;
                    let total_weight = weights.1;
                    if total_weight <= 0.0 {
                        continue;
                    }
                    for affix in &list {
                        let affix_p = get_effective_affix_roll_weight(affix, family_counts) / total_weight;
                        let canonical_id = canonicalize_affix_id_for_state(&affix.id, env);
                        let mut next = clone_state_v1(state);
                        next.affixes[*idx] = AffixEntry {
                            affix_id: canonical_id,
                            is_ga: false,
                            is_enchanted: false,
                        };
                        if violates_family_uniqueness(&next, env) {
                            continue;
                        }
                        outcomes.push(Outcome {
                            probability: source_p * category_p * affix_p,
                            state: next,
                        });
                    }
                }
            }
            merge_outcomes(outcomes, env)
        }

        "enchant" => {
            let src_idx = match action.source_index {
                Some(i) if i >= 0 => i as usize,
                _ => return vec![],
            };
            if src_idx >= state.affixes.len() {
                return vec![];
            }
            let target_affix_id = match action.target_affix_id.as_deref() {
                Some(t) if !t.is_empty() => t,
                _ => return vec![],
            };
            if env.affix_map.get(target_affix_id).is_none() {
                return vec![];
            }

            let source = &state.affixes[src_idx];
            if source.affix_id.is_empty() {
                return vec![];
            }

            // Sticky enchant slot check.
            let enchanted_index = state.affixes.iter().position(|e| e.is_enchanted);
            if let Some(enc_idx) = enchanted_index {
                if enc_idx != src_idx {
                    return vec![];
                }
            }
            if source.is_enchanted && source.is_ga {
                return vec![];
            }

            // No-duplicate constraint (only when affix changes).
            if target_affix_id != source.affix_id {
                let dupe = state.affixes.iter().enumerate().any(|(i, e)| {
                    i != src_idx && e.affix_id == target_affix_id
                });
                if dupe {
                    return vec![];
                }
            }

            let canonical_id = canonicalize_affix_id_for_state(target_affix_id, env);
            let mut next = clone_state_v1(state);
            next.affixes[src_idx] = AffixEntry {
                affix_id: canonical_id,
                is_ga: if target_affix_id == source.affix_id {
                    source.is_ga
                } else {
                    false
                },
                is_enchanted: true,
            };

            if violates_family_uniqueness(&next, env) {
                return vec![];
            }

            vec![Outcome { probability: 1.0, state: next }]
        }

        _ => vec![],
    }
}

/// Mirrors JS `getActionOutcomesV2`.
/// Merges outcomes by v2 integer state key, handles unsatisfactory transitions.
pub fn get_action_outcomes_v2(
    state: &JsState,
    action: &JsAction,
    env: &TranslationEnv,
) -> Vec<Outcome> {
    let base_outcomes = get_action_outcomes(state, action, env);
    let mut merged: HashMap<u128, Outcome> = HashMap::new();
    let mut total_prob = 0.0;

    for outcome in base_outcomes {
        let next = mark_unsatisfactory_transition(state, outcome.state, action, env);
        if has_duplicate_affix_ids_v2(&next) {
            continue;
        }
        let key = istate_key_v2(&intern_state(&next, env), env);
        total_prob += outcome.probability;
        if let Some(existing) = merged.get_mut(&key) {
            existing.probability += outcome.probability;
        } else {
            merged.insert(key, Outcome { probability: outcome.probability, state: next });
        }
    }

    if total_prob <= RESIDUAL_EPSILON {
        return vec![];
    }

    merged
        .into_values()
        .map(|mut o| {
            o.probability /= total_prob;
            o
        })
        .collect()
}

/// True if the affixes of `state` (optionally excluding one slot) contain two
/// members of the same non-empty family.
fn kept_has_family_collision(state: &JsState, env: &TranslationEnv, exclude_idx: Option<usize>) -> bool {
    let mut seen: HashSet<&str> = HashSet::new();
    for (j, e) in state.affixes.iter().enumerate() {
        if Some(j) == exclude_idx {
            continue;
        }
        let fam = get_affix_family(&e.affix_id, env);
        if fam.is_empty() {
            continue;
        }
        if !seen.insert(fam) {
            return true;
        }
    }
    false
}

/// True if the affixes of `state` (optionally excluding one slot) contain a
/// duplicate affix id.
fn kept_has_duplicate(state: &JsState, exclude_idx: Option<usize>) -> bool {
    let mut seen: HashSet<&str> = HashSet::new();
    for (j, e) in state.affixes.iter().enumerate() {
        if Some(j) == exclude_idx {
            continue;
        }
        if !seen.insert(e.affix_id.as_str()) {
            return true;
        }
    }
    false
}

enum Placement {
    Append,
    Replace(usize),
}

/// Residual-token-grouped outcome enumeration for `add`/`focused`/`chaotic`.
///
/// Within a fixed placement context (append for `add`, a specific replaced slot
/// for `focused`/`chaotic`) the residual child key is uniquely determined by the
/// placed affix's residual token (the rest of the state is fixed and the
/// unsatisfactory marking depends only on the resulting concrete affix multiset,
/// which is identical for any two affixes sharing a residual token). So we group
/// the pool by `(context, placed residual token)`, sum effective weights of the
/// affixes that survive the family-uniqueness and no-duplicate filters, and clone
/// /normalize/key exactly one representative child per group. This yields the
/// identical merged residual transition set as `get_action_outcomes_v2` followed
/// by the BFS residual merge, but with O(distinct residual tokens) heavy work
/// instead of O(pool size).
fn grouped_residual_outcomes(
    state: &JsState,
    action: &JsAction,
    context: &ResidualContext,
    env: &TranslationEnv,
) -> HashMap<u128, (f64, JsState)> {
    let mut merged: HashMap<u128, (f64, JsState)> = HashMap::new();

    let prism = match action.prism.as_deref() {
        Some(p) => p,
        None => return merged,
    };

    // Build the list of placement contexts (each gets its own representative
    // children, since the replaced/kept affixes differ per slot).
    let placements: Vec<Placement> = match action.action_type.as_str() {
        "add" => {
            if state.affixes.len() >= 4 {
                return merged;
            }
            vec![Placement::Append]
        }
        "focused" | "chaotic" => {
            let eligible = get_eligible_by_category(state, env, prism, action.action_type.as_str());
            if eligible.is_empty() {
                return merged;
            }
            eligible.iter().map(|(idx, _)| Placement::Replace(*idx)).collect()
        }
        _ => return merged,
    };

    // Pool categories: chaotic re-rolls across every category; add/focused use the
    // action's prism category.
    let categories: Vec<String> = match action.action_type.as_str() {
        "chaotic" => env.category_names.clone(),
        _ => vec![prism.to_string()],
    };

    // (context index, placed residual token) -> residual child key, so repeated
    // affixes in the same group only sum weight instead of rebuilding the child.
    let mut token_key: HashMap<(usize, u16), u128> = HashMap::new();
    let mut total: f64 = 0.0;

    for (ctx_id, placement) in placements.iter().enumerate() {
        let exclude_idx = match placement {
            Placement::Append => None,
            Placement::Replace(idx) => Some(*idx),
        };
        // If the affixes we keep already collide (family or duplicate), every
        // candidate child is invalid — matching the v2 path returning nothing for
        // this context.
        if kept_has_family_collision(state, env, exclude_idx)
            || kept_has_duplicate(state, exclude_idx)
        {
            continue;
        }

        for cat in &categories {
            let list = get_category_affixes_for_state(state, env, cat, action.action_type.as_str());
            if list.is_empty() {
                continue;
            }
            let weights = get_category_pool_weights_for_state(state, env, cat, action.action_type.as_str());
            let family_counts = &weights.0;
            let total_weight = weights.1;
            if total_weight <= 0.0 {
                continue;
            }

            for affix in &list {
                let w = get_effective_affix_roll_weight(affix, family_counts) / total_weight;
                if !(w.is_finite() && w > 0.0) {
                    continue;
                }
                let canonical_id = canonicalize_affix_id_for_state(&affix.id, env);

                // Cheap per-affix filters on the resulting concrete affix multiset.
                let placed_fam = get_affix_family(&canonical_id, env);
                let fam_violation = !placed_fam.is_empty()
                    && state.affixes.iter().enumerate().any(|(j, e)| {
                        Some(j) != exclude_idx && get_affix_family(&e.affix_id, env) == placed_fam
                    });
                if fam_violation {
                    continue;
                }
                let dup = state.affixes.iter().enumerate().any(|(j, e)| {
                    Some(j) != exclude_idx && e.affix_id == canonical_id
                });
                if dup {
                    continue;
                }

                let placed_entry = AffixEntry {
                    affix_id: canonical_id,
                    is_ga: false,
                    is_enchanted: false,
                };
                let token = get_residual_affix_token_v3(&placed_entry, context, env);
                let tk = (ctx_id, token);

                total += w;
                if let Some(&rk) = token_key.get(&tk) {
                    if let Some((p, _)) = merged.get_mut(&rk) {
                        *p += w;
                    }
                    continue;
                }

                // First surviving affix for this (context, token): build the
                // representative child once.
                let mut next = clone_state_v1(state);
                match placement {
                    Placement::Append => next.affixes.push(placed_entry),
                    Placement::Replace(idx) => next.affixes[*idx] = placed_entry,
                }
                let marked = mark_unsatisfactory_transition(state, next, action, env);
                let rk = residual_state_key_v3_u128(&marked, context, env);
                merged
                    .entry(rk)
                    .and_modify(|(p, _)| *p += w)
                    .or_insert((w, marked));
                token_key.insert(tk, rk);
            }
        }
    }

    if total <= RESIDUAL_EPSILON {
        return HashMap::new();
    }
    for (_, (p, _)) in merged.iter_mut() {
        *p /= total;
    }
    merged
}

/// Residual-abstraction-aware outcome enumeration for the BFS graph builder.
///
/// Returns `residual_key -> (probability, representative child state)`, with
/// probabilities normalized to sum to 1 over surviving outcomes — identical to
/// running `get_action_outcomes_v2` then merging by `residual_state_key_v3`, but
/// `add`/`focused`/`chaotic` use residual-token grouping to avoid cloning one
/// child per pool affix. `remove`/`enchant` (whose pools are just eligible slots)
/// delegate to the v2 path and merge.
pub fn get_residual_action_outcomes_v3(
    state: &JsState,
    action: &JsAction,
    context: &ResidualContext,
    env: &TranslationEnv,
) -> HashMap<u128, (f64, JsState)> {
    match action.action_type.as_str() {
        "add" | "focused" | "chaotic" => grouped_residual_outcomes(state, action, context, env),
        _ => {
            let raw_outcomes = get_action_outcomes_v2(state, action, env);
            let mut merged: HashMap<u128, (f64, JsState)> = HashMap::new();
            for outcome in raw_outcomes {
                let child = normalize_outcome_state_v2(outcome.state);
                let child_key = residual_state_key_v3_u128(&child, context, env);
                if let Some((prob, _)) = merged.get_mut(&child_key) {
                    *prob += outcome.probability;
                } else {
                    merged.insert(child_key, (outcome.probability, child));
                }
            }
            merged
        }
    }
}

/// Mirrors JS `stateKeyV2`: includes unsatisfactory IDs and trash tokens.
pub fn state_key_v2(state: &JsState, env: &TranslationEnv) -> String {
    let mut entries: Vec<&AffixEntry> = state.affixes.iter().collect();
    entries.sort_by(|a, b| {
        let at = format!("{}|{}|{}", get_affix_token_for_state_key(a, state, env), if a.is_ga { 1 } else { 0 }, if a.is_enchanted { 1 } else { 0 });
        let bt = format!("{}|{}|{}", get_affix_token_for_state_key(b, state, env), if b.is_ga { 1 } else { 0 }, if b.is_enchanted { 1 } else { 0 });
        at.cmp(&bt)
    });
    let tokens: Vec<String> = entries
        .iter()
        .map(|e| format!("{}|{}|{}", get_affix_token_for_state_key(e, state, env), if e.is_ga { 1 } else { 0 }, if e.is_enchanted { 1 } else { 0 }))
        .collect();

    let unsatisfactory: Vec<String> = {
        let mut ids = state.unsatisfactory_affix_ids.clone();
        ids.sort();
        ids
    };

    format!(
        "L{}#S{}#C{}#A{}#U{}",
        if state.is_legendary { 1 } else { 0 },
        state.gear_slot.as_deref().unwrap_or("Any"),
        state.class.as_deref().unwrap_or("Any"),
        tokens.join(","),
        unsatisfactory.join(","),
    )
}

fn is_symmetric_trash_entry(entry: &AffixEntry, state: &JsState, env: &TranslationEnv) -> bool {
    if entry.is_ga || entry.is_enchanted {
        return false;
    }
    if env.target_counts.get(&entry.affix_id).copied().unwrap_or(0) > 0 {
        return false;
    }
    let unsat_counts = get_unsatisfactory_counts(state);
    unsat_counts.get(&entry.affix_id).copied().unwrap_or(0) == 0
}

fn get_affix_token_for_state_key(entry: &AffixEntry, state: &JsState, env: &TranslationEnv) -> String {
    if is_symmetric_trash_entry(entry, state, env) {
        let sig = get_category_signature_for_affix(&entry.affix_id, env);
        format!("trash<{}>", sig)
    } else {
        entry.affix_id.clone()
    }
}

fn get_category_signature_for_affix(affix_id: &str, env: &TranslationEnv) -> String {
    let affix = env.affix_map.get(affix_id);
    let mut categories: Vec<String> = affix
        .map(|a| a.categories.clone())
        .unwrap_or_default();
    categories.sort();
    let cat_str = categories.join("&");
    let family = get_affix_family(affix_id, env);
    if !family.is_empty() {
        format!("{}::{}", cat_str, family)
    } else {
        cat_str
    }
}

// ── v2 state classification ───────────────────────────────────────────────────

/// Mirrors JS `isSuccessStateV2`.
pub fn is_success_state_v2(state: &JsState, target: &JsTarget, _env: &TranslationEnv) -> bool {
    if !state.unsatisfactory_affix_ids.is_empty() {
        return false;
    }
    let mut state_counts: HashMap<&str, u32> = HashMap::new();
    for entry in &state.affixes {
        *state_counts.entry(entry.affix_id.as_str()).or_insert(0) += 1;
    }
    for req in &target.affixes {
        if req.affix_id.is_empty() {
            continue;
        }
        if state_counts.get(req.affix_id.as_str()).copied().unwrap_or(0) < 1 {
            return false;
        }
    }
    true
}

/// Mirrors JS `classifyDeadReason`.
pub fn classify_dead_reason(state: &JsState, target: &JsTarget, env: &TranslationEnv) -> String {
    if !env.impossible_target_ga_reason.is_empty() {
        return env.impossible_target_ga_reason.clone();
    }

    if has_duplicate_affix_ids_v2(state) {
        return "Duplicate affixes are not allowed on an item.".to_string();
    }

    // Check unsatisfactory locked slots.
    if !state.unsatisfactory_affix_ids.is_empty() {
        let unsat_counts = get_unsatisfactory_counts(state);
        for (affix_id, count) in &unsat_counts {
            let has_target = target.affixes.iter().any(|e| e.affix_id == *affix_id);
            if !has_target {
                continue;
            }
            let matching: Vec<&AffixEntry> = state.affixes.iter().filter(|e| e.affix_id == *affix_id).collect();
            let locked = matching.iter().filter(|e| e.is_enchanted && e.is_ga).count() as u32;
            if locked >= *count {
                return format!("{} still needs improvement but the slot is locked.", affix_id);
            }
        }
    }

    String::new()
}

// ── Residual abstraction context ──────────────────────────────────────────────

pub struct ResidualContext {
    pub relevant_tokens: HashSet<u16>,
}

/// Get the affix signature for the residual abstraction (categories + family).
fn get_residual_affix_signature_v3(affix_id: &str, env: &TranslationEnv) -> String {
    let affix = env.affix_map.get(affix_id);
    let mut cats: Vec<String> = affix.map(|a| a.categories.clone()).unwrap_or_default();
    cats.sort();
    let cat_str = cats.join("&");
    let family = get_affix_family(affix_id, env);
    if !family.is_empty() {
        format!("{}::{}", cat_str, family)
    } else {
        cat_str
    }
}

/// Get the residual integer token for an affix entry (0 = empty/unknown).
pub fn get_residual_affix_token_v3(entry: &AffixEntry, context: &ResidualContext, env: &TranslationEnv) -> u16 {
    if entry.affix_id.is_empty() {
        return 0;
    }
    let token = env.affix_id_to_token.get(&entry.affix_id).copied().unwrap_or(0);
    crate::intern::effective_residual_token(token, &context.relevant_tokens, env)
}

/// Returns a u128 residual state key via the integer hot-path.
/// Kept for internal use; prefer `iresidual_key_v3` directly.
#[allow(dead_code)]
pub fn residual_state_key_v3_u128(state: &JsState, context: &ResidualContext, env: &TranslationEnv) -> u128 {
    iresidual_key_v3(&intern_state(state, env), &context.relevant_tokens, env)
}

/// Get the set of relevant (non-trash) affix IDs for the residual abstraction.
pub fn get_residual_relevant_affix_ids_v3(
    target: &JsTarget,
    ga_config: &JsGaConfig,
    feasibility: Option<&FeasibilityResult>,
) -> HashSet<String> {
    let mut ids: Vec<String> = Vec::new();

    for e in &target.affixes {
        if !e.affix_id.is_empty() {
            ids.push(e.affix_id.clone());
        }
    }

    if let Some(feas) = feasibility {
        if let Some(obj) = feas.details.as_object() {
            for key in &["protectedAffixIds", "forbiddenAffixIds", "improveAffixIds"] {
                if let Some(arr) = obj.get(*key).and_then(|v| v.as_array()) {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            ids.push(s.to_string());
                        }
                    }
                }
            }
        }
    }

    for id in &ga_config.protected_affix_ids {
        if !id.is_empty() {
            ids.push(id.clone());
        }
    }
    for id in &ga_config.forbidden_affix_ids {
        if !id.is_empty() {
            ids.push(id.clone());
        }
    }
    for id in &ga_config.unsatisfactory_affix_ids {
        if !id.is_empty() {
            ids.push(id.clone());
        }
    }

    ids.into_iter().filter(|s| !s.is_empty()).collect()
}

/// Token-based version of `get_residual_relevant_affix_ids_v3` for the integer hot-path.
pub fn get_residual_relevant_tokens_v3(
    target: &JsTarget,
    ga_config: &JsGaConfig,
    feasibility: Option<&FeasibilityResult>,
    env: &TranslationEnv,
) -> HashSet<u16> {
    get_residual_relevant_affix_ids_v3(target, ga_config, feasibility)
        .iter()
        .filter_map(|id| env.affix_id_to_token.get(id).copied())
        .filter(|&tok| tok != 0)
        .collect()
}

// ── Graph node creation ───────────────────────────────────────────────────────

fn create_residual_graph_node_v3(
    state: JsState,
    key: u128,
    target: &JsTarget,
    env: &TranslationEnv,
) -> GraphNode {
    let success = is_success_state_v2(&state, target, env);
    let dead_reason = if success {
        String::new()
    } else {
        classify_dead_reason(&state, target, env)
    };
    GraphNode {
        key,
        state,
        success,
        dead_reason,
        action_entries: vec![],
    }
}

// ── BFS graph builder ─────────────────────────────────────────────────────────

pub struct BuildGraphOptions<'a> {
    pub state_limit: Option<usize>,
    pub feasibility: Option<&'a FeasibilityResult>,
    pub root_already_attached: bool,
}

/// Mirrors JS `buildResidualReachableGraphV3`.
pub fn build_residual_reachable_graph_v3(
    root_state: &JsState,
    target: &JsTarget,
    ga_config: &JsGaConfig,
    env: &TranslationEnv,
    options: BuildGraphOptions,
) -> ResidualGraph {
    let limit = options.state_limit.unwrap_or(RESIDUAL_STATE_LIMIT);

    let context = ResidualContext {
        relevant_tokens: get_residual_relevant_tokens_v3(target, ga_config, options.feasibility, env),
    };

    let attached_root = if options.root_already_attached {
        root_state.clone()
    } else {
        attach_unsatisfactory_to_state(root_state, ga_config)
    };
    let root = normalize_outcome_state_v2(attached_root);
    let root_key = iresidual_key_v3(&intern_state(&root, env), &context.relevant_tokens, env);

    let mut key_to_index: HashMap<u128, usize> = HashMap::new();
    key_to_index.insert(root_key, 0);

    let root_success = is_success_state_v2(&root, target, env);
    let root_dead = if root_success { String::new() } else { classify_dead_reason(&root, target, env) };

    let root_node = GraphNode {
        key: root_key,
        state: root,
        success: root_success,
        dead_reason: root_dead.clone(),
        action_entries: vec![],
    };

    let mut nodes: Vec<GraphNode> = vec![root_node];
    let mut dead_states = if !root_dead.is_empty() { 1 } else { 0 };

    let mut queue_index = 0;
    while queue_index < nodes.len() {
        {
            let node = &nodes[queue_index];
            if node.success || !node.dead_reason.is_empty() {
                queue_index += 1;
                continue;
            }
        }

        let actions = get_valid_actions_v2(&nodes[queue_index].state.clone(), target, env);
        let mut action_entries: Vec<ActionEntry> = Vec::new();

        for action in &actions {
            let merged = get_residual_action_outcomes_v3(&nodes[queue_index].state.clone(), action, &context, env);

            let mut transitions: Vec<Transition> = Vec::new();
            for (child_key, (probability, child_state)) in merged {
                let child_index = if let Some(&idx) = key_to_index.get(&child_key) {
                    idx
                } else {
                    if nodes.len() >= limit {
                        return ResidualGraph {
                            ok: false,
                            root_key,
                            root_index: 0,
                            nodes,
                            dead_states,
                            reason: format!("Residual abstract graph exceeded limit ({} states).", limit),
                            limit,
                        };
                    }
                    let idx = nodes.len();
                    key_to_index.insert(child_key, idx);
                    let child_success = is_success_state_v2(&child_state, target, env);
                    let child_dead = if child_success {
                        String::new()
                    } else {
                        classify_dead_reason(&child_state, target, env)
                    };
                    if !child_dead.is_empty() {
                        dead_states += 1;
                    }
                    nodes.push(GraphNode {
                        key: child_key,
                        state: child_state,
                        success: child_success,
                        dead_reason: child_dead,
                        action_entries: vec![],
                    });
                    idx
                };
                transitions.push(Transition { probability, child_index });
            }

            action_entries.push(ActionEntry {
                sort_key: action_sort_key(&intern_action(action, env), env),
                action: action.clone(),
                cube_cost: action_cost(action, &nodes[queue_index].state.clone()),
                transitions,
            });
        }

        nodes[queue_index].action_entries = action_entries;
        queue_index += 1;
    }

    ResidualGraph {
        ok: true,
        root_key,
        root_index: 0,
        nodes,
        dead_states,
        reason: String::new(),
        limit,
    }
}

// ── LAO* solver ───────────────────────────────────────────────────────────────

/// Mirrors JS `getResolvedActionSuccessV3`.
pub fn get_resolved_action_success_v3(
    entry: &ActionEntry,
    state_index: usize,
    values: &[f64],
) -> f64 {
    let mut self_prob = 0.0;
    let mut leave_success = 0.0;

    for t in &entry.transitions {
        if t.child_index == state_index {
            self_prob += t.probability;
        } else {
            leave_success += t.probability * values[t.child_index];
        }
    }

    let leave_prob = 1.0 - self_prob;
    if leave_prob <= RESIDUAL_EPSILON {
        return 0.0;
    }

    let candidate = leave_success / leave_prob;
    candidate.max(0.0).min(1.0)
}

/// Mirrors JS `getResolvedActionWeightedCostV3`.
pub fn get_resolved_action_weighted_cost_v3(
    entry: &ActionEntry,
    state_index: usize,
    optimal_success: f64,
    costs: &[f64],
) -> f64 {
    let mut self_prob = 0.0;
    let mut leave_weighted_cost = 0.0;

    for t in &entry.transitions {
        if t.child_index == state_index {
            self_prob += t.probability;
        } else {
            leave_weighted_cost += t.probability * costs[t.child_index];
        }
    }

    let leave_prob = 1.0 - self_prob;
    if leave_prob <= RESIDUAL_EPSILON {
        return f64::INFINITY;
    }

    (entry.cube_cost * optimal_success + leave_weighted_cost) / leave_prob
}

/// Select best action index for phase 1 (highest success prob, tie-break by sort_key).
fn select_best_phase1_action_index_v3(
    node: &GraphNode,
    state_index: usize,
    values: &[f64],
) -> i32 {
    let mut best_index: i32 = -1;
    let mut best_value = -1.0f64;
    let mut best_sort_key: u64 = u64::MAX;

    for (i, entry) in node.action_entries.iter().enumerate() {
        let candidate = get_resolved_action_success_v3(entry, state_index, values);
        if candidate > best_value + RESIDUAL_ACTION_EPSILON
            || (f64::abs(candidate - best_value) <= RESIDUAL_ACTION_EPSILON
                && (best_index < 0 || entry.sort_key < best_sort_key))
        {
            best_index = i as i32;
            best_value = candidate;
            best_sort_key = entry.sort_key;
        }
    }

    best_index
}

/// Mirrors JS `buildResidualPhase2EligibleActionsV3`.
pub fn build_phase2_eligible_actions_v3(
    graph: &ResidualGraph,
    phase1_values: &[f64],
    epsilon: f64,
) -> Vec<Option<Vec<usize>>> {
    let mut eligible: Vec<Option<Vec<usize>>> = vec![None; graph.nodes.len()];

    for state_index in 0..graph.nodes.len() {
        let node = &graph.nodes[state_index];
        if node.success || !node.dead_reason.is_empty() {
            continue;
        }
        let optimal_success = phase1_values[state_index];
        if optimal_success <= epsilon {
            continue;
        }
        let indices: Vec<usize> = node
            .action_entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| {
                let s = get_resolved_action_success_v3(entry, state_index, phase1_values);
                f64::abs(s - optimal_success) <= RESIDUAL_ACTION_EPSILON
            })
            .map(|(i, _)| i)
            .collect();
        eligible[state_index] = Some(indices);
    }

    eligible
}

/// Mirrors JS `solveResidualLAOPhase1V3`.
pub fn solve_residual_lao_phase1_v3(
    graph: &ResidualGraph,
    max_iterations: usize,
    epsilon: f64,
) -> Phase1Result {
    let n = graph.nodes.len();
    let mut values: Vec<f64> = graph
        .nodes
        .iter()
        .map(|node| if node.success { 1.0 } else { 0.0 })
        .collect();

    let mut converged = false;
    let mut iterations = 0;
    let mut residual = f64::INFINITY;

    while iterations < max_iterations {
        let mut max_delta = 0.0f64;
        for index in 0..n {
            let node = &graph.nodes[index];
            if node.success {
                values[index] = 1.0;
                continue;
            }
            if !node.dead_reason.is_empty() {
                values[index] = 0.0;
                continue;
            }
            let mut next_value = 0.0f64;
            for entry in &node.action_entries {
                let candidate = get_resolved_action_success_v3(entry, index, &values);
                if candidate > next_value {
                    next_value = candidate;
                }
            }
            let delta = (next_value - values[index]).abs();
            if delta > max_delta {
                max_delta = delta;
            }
            values[index] = next_value;
        }
        residual = max_delta;
        iterations += 1;
        if max_delta < epsilon {
            converged = true;
            break;
        }
    }

    Phase1Result {
        values,
        iterations,
        converged,
        residual,
    }
}

/// Mirrors JS `solveResidualLAOPhase2V3`.
pub fn solve_residual_lao_phase2_v3(
    graph: &ResidualGraph,
    phase1: &Phase1Result,
    max_iterations: usize,
    abs_epsilon: f64,
    rel_epsilon: f64,
) -> Phase2Result {
    let n = graph.nodes.len();
    let mut costs: Vec<f64> = vec![0.0; n];

    let eligible = build_phase2_eligible_actions_v3(graph, &phase1.values, abs_epsilon);

    let mut converged = false;
    let mut iterations = 0;
    let mut residual = f64::INFINITY;

    while iterations < max_iterations {
        let mut max_delta = 0.0f64;
        let mut max_abs_value = 0.0f64;

        for index in 0..n {
            let node = &graph.nodes[index];
            if node.success || !node.dead_reason.is_empty() {
                costs[index] = 0.0;
                continue;
            }
            let optimal_success = phase1.values[index];
            if optimal_success <= abs_epsilon {
                costs[index] = 0.0;
                continue;
            }

            let best_cost = match &eligible[index] {
                Some(indices) => {
                    let mut best = f64::INFINITY;
                    let mut best_sort_key: u64 = u64::MAX;
                    let mut best_idx: i32 = -1;
                    for &action_idx in indices {
                        let entry = &node.action_entries[action_idx];
                        let candidate = get_resolved_action_weighted_cost_v3(
                            entry,
                            index,
                            optimal_success,
                            &costs,
                        );
                        if candidate < best - RESIDUAL_ACTION_EPSILON
                            || (f64::abs(candidate - best) <= RESIDUAL_ACTION_EPSILON
                                && (best_idx < 0 || entry.sort_key < best_sort_key))
                        {
                            best = candidate;
                            best_sort_key = entry.sort_key;
                            best_idx = action_idx as i32;
                        }
                    }
                    best
                }
                None => f64::INFINITY,
            };

            let next_value = if best_cost.is_finite() { best_cost } else { 0.0 };
            let delta = (next_value - costs[index]).abs();
            if delta > max_delta {
                max_delta = delta;
            }
            let abs_next = next_value.abs();
            if abs_next > max_abs_value {
                max_abs_value = abs_next;
            }
            costs[index] = next_value;
        }

        residual = max_delta;
        iterations += 1;
        let scale = if max_abs_value > 1.0 { max_abs_value } else { 1.0 };
        if max_delta / scale < rel_epsilon {
            converged = true;
            break;
        }
    }

    Phase2Result {
        costs,
        iterations,
        converged,
        residual,
    }
}

/// Mirrors JS `solveResidualLAOStarV3`.
pub fn solve_residual_lao_star_v3(graph: &ResidualGraph) -> ResidualSolution {
    let phase1 = solve_residual_lao_phase1_v3(graph, RESIDUAL_MAX_ITERATIONS, RESIDUAL_EPSILON);
    if !phase1.converged {
        return ResidualSolution {
            status: SolverStatus::IterationLimit,
            phase1: Some(phase1),
            phase2: None,
        };
    }

    let phase2 = solve_residual_lao_phase2_v3(
        graph,
        &phase1,
        RESIDUAL_MAX_ITERATIONS,
        RESIDUAL_EPSILON,
        RESIDUAL_PHASE2_EPSILON,
    );
    if !phase2.converged {
        return ResidualSolution {
            status: SolverStatus::IterationLimit,
            phase1: Some(phase1),
            phase2: Some(phase2),
        };
    }

    ResidualSolution {
        status: SolverStatus::Optimal,
        phase1: Some(phase1),
        phase2: Some(phase2),
    }
}

// ── Policy extraction (for MC fast-path) ──────────────────────────────────────

/// For each non-terminal node, return the index into `node.action_entries`
/// that the LAO* solver selected (matches the same tie-break rule used by
/// `solve_residual_lao_phase2_v3` and `build_residual_result_from_solution`).
///
/// Returns `None` for terminal nodes, dead nodes, and nodes with no feasible
/// action. This is used to build a state→action policy table that MC rollouts
/// can consult in O(1) instead of recomputing the optimizer from scratch.
pub fn extract_residual_policy_indices(
    graph: &ResidualGraph,
    phase1: &Phase1Result,
    phase2: &Phase2Result,
) -> Vec<Option<usize>> {
    let n = graph.nodes.len();
    let mut policy: Vec<Option<usize>> = vec![None; n];
    let eligible = build_phase2_eligible_actions_v3(graph, &phase1.values, RESIDUAL_EPSILON);

    for index in 0..n {
        let node = &graph.nodes[index];
        if node.success || !node.dead_reason.is_empty() {
            continue;
        }
        let optimal_success = phase1.values[index];
        if optimal_success <= RESIDUAL_EPSILON {
            continue;
        }

        let indices = match &eligible[index] {
            Some(v) if !v.is_empty() => v,
            _ => continue,
        };

        let mut best_cost = f64::INFINITY;
        let mut best_sort_key: u64 = u64::MAX;
        let mut best_idx: Option<usize> = None;
        for &action_idx in indices {
            let entry = &node.action_entries[action_idx];
            let candidate = get_resolved_action_weighted_cost_v3(
                entry,
                index,
                optimal_success,
                &phase2.costs,
            );
            if candidate < best_cost - RESIDUAL_ACTION_EPSILON
                || (f64::abs(candidate - best_cost) <= RESIDUAL_ACTION_EPSILON
                    && (best_idx.is_none() || entry.sort_key < best_sort_key))
            {
                best_cost = candidate;
                best_sort_key = entry.sort_key;
                best_idx = Some(action_idx);
            }
        }
        policy[index] = best_idx;
    }
    policy
}

// ── Result builder ────────────────────────────────────────────────────────────

/// Build the optimize result from the residual solution, mirrors JS `summarizeRootV2`
/// (adapted for the residual v3 graph).
pub fn build_residual_result_from_solution(
    graph: &ResidualGraph,
    phase1: &Phase1Result,
    phase2: &Phase2Result,
    target: &JsTarget,
    env: &TranslationEnv,
    note: Option<&str>,
) -> serde_json::Value {
    use serde_json::json;

    let root_index = graph.root_index;
    let root = &graph.nodes[root_index];

    if root.success {
        return json!({
            "action": null,
            "successProb": 1.0,
            "expectedSteps": 0.0,
            "variance": null,
            "stdDev": null,
            "oneStepRisk": [],
            "diagnostics": {
                "reason": "Current state already satisfies the target.",
                "rootVisits": 0,
                "strategy": "v3-residual-lao-star",
                "expandedStates": graph.nodes.len(),
                "deadStates": graph.dead_states,
                "candidateActions": [],
            }
        });
    }

    if !root.dead_reason.is_empty() {
        return json!({
            "action": null,
            "successProb": 0.0,
            "expectedSteps": null,
            "variance": null,
            "stdDev": null,
            "oneStepRisk": [],
            "diagnostics": {
                "reason": root.dead_reason,
                "rootVisits": 0,
                "strategy": "v3-residual-lao-star",
                "expandedStates": graph.nodes.len(),
                "deadStates": graph.dead_states,
                "candidateActions": [],
            }
        });
    }

    let epsilon = RESIDUAL_EPSILON;
    let root_success = phase1.values[root_index];
    let step_estimates_reliable = phase1.converged && phase2.converged;

    // Build candidate actions.
    let mut candidates: Vec<serde_json::Value> = root
        .action_entries
        .iter()
        .map(|entry| {
            let success_prob = get_resolved_action_success_v3(entry, root_index, &phase1.values);
            let expected_steps = if step_estimates_reliable && success_prob > epsilon {
                let weighted = get_resolved_action_weighted_cost_v3(
                    entry,
                    root_index,
                    success_prob,
                    &phase2.costs,
                );
                if weighted.is_finite() {
                    Some(weighted / success_prob)
                } else {
                    None
                }
            } else {
                None
            };
            let action_val = action_to_json(&entry.action);
            json!({
                "action": action_val,
                "visits": 0,
                "successProb": success_prob,
                "expectedSteps": expected_steps,
                "rank": success_prob,
            })
        })
        .collect();

    // Sort: highest success first, then lowest expectedSteps, then action key.
    candidates.sort_by(|a, b| {
        let sa = a["successProb"].as_f64().unwrap_or(-1.0);
        let sb = b["successProb"].as_f64().unwrap_or(-1.0);
        if (sa - sb).abs() > RESIDUAL_ACTION_EPSILON {
            return sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal);
        }
        let ea = a["expectedSteps"].as_f64().unwrap_or(f64::INFINITY);
        let eb = b["expectedSteps"].as_f64().unwrap_or(f64::INFINITY);
        if (ea - eb).abs() > RESIDUAL_ACTION_EPSILON {
            return ea.partial_cmp(&eb).unwrap_or(std::cmp::Ordering::Equal);
        }
        let ka = a["action"]["type"].as_str().unwrap_or("").to_string();
        let kb = b["action"]["type"].as_str().unwrap_or("").to_string();
        ka.cmp(&kb)
    });

    let best = candidates.first().cloned();
    let best_action = best.as_ref().and_then(|c| {
        if c["action"].is_null() {
            None
        } else {
            Some(c["action"].clone())
        }
    });

    let expected_steps = if step_estimates_reliable && root_success > epsilon {
        Some(phase2.costs[root_index] / root_success)
    } else {
        None
    };

    let mut diag = json!({
        "reason": null,
        "rootVisits": 0,
        "strategy": "v3-residual-lao-star",
        "expandedStates": graph.nodes.len(),
        "deadStates": graph.dead_states,
        "phase1Iterations": phase1.iterations,
        "phase2Iterations": phase2.iterations,
        "phase1Converged": phase1.converged,
        "phase2Converged": phase2.converged,
        "stepEstimatesReliable": step_estimates_reliable,
        "candidateActions": candidates[..candidates.len().min(6)].to_vec(),
    });

    if let Some(n) = note {
        diag["note"] = json!(n);
    }

    json!({
        "action": best_action,
        "successProb": root_success,
        "expectedSteps": expected_steps,
        "variance": null,
        "stdDev": null,
        "oneStepRisk": [],
        "diagnostics": diag,
    })
}

/// Convert a JsAction to a serde_json::Value.
pub fn action_to_json(action: &JsAction) -> serde_json::Value {
    use serde_json::json;
    let mut obj = json!({ "type": action.action_type });
    if let Some(ref p) = action.prism {
        obj["prism"] = json!(p);
    }
    if let Some(src) = action.source_index {
        obj["sourceIndex"] = json!(src);
    }
    if let Some(ref t) = action.target_affix_id {
        obj["targetAffixId"] = json!(t);
    }
    obj
}
