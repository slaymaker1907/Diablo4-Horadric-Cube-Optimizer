use std::collections::HashSet;
use std::rc::Rc;

use crate::env::{PoolWeights, TranslationEnv, DEFAULT_CLASS, DEFAULT_GEAR_SLOT};
use crate::types::{AffixData, AffixEntry, JsAction, JsState, JsTarget};

// ── Constants ─────────────────────────────────────────────────────────────────

const ELEMENTAL_DAMAGE_FAMILY: &str = "elemental-damage";
const SPECIFIC_RESISTANCE_FAMILY: &str = "specific-resistance";
pub const RE_ENCHANT_TIE_BREAK_COST: f64 = 0.5;

// ── Family helpers ────────────────────────────────────────────────────────────

/// Infer family from affix ID prefix (for synthetic / unlisted IDs).
pub fn infer_affix_family(affix_id: &str) -> &'static str {
    if affix_id.starts_with("elemental-damage-") || affix_id == "elemental-damage-other" {
        return ELEMENTAL_DAMAGE_FAMILY;
    }
    if affix_id.starts_with("specific-resistance-") || affix_id == "specific-resistance-other" {
        return SPECIFIC_RESISTANCE_FAMILY;
    }
    ""
}

/// Get affix family, preferring catalog entry over inferred.
pub fn get_affix_family<'a>(affix_id: &str, env: &'a TranslationEnv) -> &'a str {
    if let Some(affix) = env.affix_map.get(affix_id) {
        if let Some(ref fam) = affix.family {
            if !fam.is_empty() {
                return fam.as_str();
            }
        }
    }
    infer_affix_family(affix_id)
}

/// Return canonical affix ID for a state: collapse non-wanted family members
/// to the family's "other" placeholder.
pub fn canonicalize_affix_id_for_state(affix_id: &str, env: &TranslationEnv) -> String {
    if affix_id.is_empty() {
        return affix_id.to_string();
    }
    let family = get_affix_family(affix_id, env);
    if family.is_empty() {
        return affix_id.to_string();
    }
    let wanted = env.wanted_by_family.get(family).map(|s| s.as_str()).unwrap_or("");
    if !wanted.is_empty() && affix_id == wanted {
        return affix_id.to_string();
    }
    env.family_other_id
        .get(family)
        .map(|s| s.clone())
        .unwrap_or_else(|| affix_id.to_string())
}

/// Returns true if `state` has two or more affixes from the same family.
pub fn violates_family_uniqueness(state: &JsState, env: &TranslationEnv) -> bool {
    let mut family_count: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for entry in &state.affixes {
        let fam = get_affix_family(&entry.affix_id, env);
        if fam.is_empty() {
            continue;
        }
        let cnt = family_count.entry(fam).or_insert(0);
        *cnt += 1;
        if *cnt > 1 {
            return true;
        }
    }
    false
}

/// Get operation-appropriate categories for an affix.
pub fn get_affix_categories_for_op<'a>(affix: &'a AffixData, op_type: &str) -> &'a [String] {
    if !op_type.is_empty() {
        if let Some(ref op_cats) = affix.operation_categories {
            if let Some(cats) = op_cats.get(op_type) {
                return cats;
            }
        }
    }
    &affix.categories
}

/// Returns the gear slot for a state, defaulting to DEFAULT_GEAR_SLOT.
pub fn get_state_gear_slot(state: &JsState) -> &str {
    state
        .gear_slot
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_GEAR_SLOT)
}

/// Returns the class for a state, defaulting to DEFAULT_CLASS.
pub fn get_state_class(state: &JsState) -> &str {
    state
        .class
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_CLASS)
}

/// Cache key for the per-(slot, class, category, op) affix pool and its weights.
fn pool_cache_key(gear_slot: &str, class: &str, category: &str, op_type: &str) -> String {
    format!("{}\u{1f}{}\u{1f}{}\u{1f}{}", gear_slot, class, category, op_type)
}

/// Resolved affix-id list for a (slot, class, category, op_type), memoized on the
/// env. The pool depends only on these four keys (never on state affixes), so the
/// cached result is exactly identical to recomputing it every call.
pub fn get_category_affix_ids_for_state(
    state: &JsState,
    env: &TranslationEnv,
    category: &str,
    op_type: &str,
) -> Rc<Vec<String>> {
    let gear_slot = get_state_gear_slot(state);
    let class = get_state_class(state);
    let key = pool_cache_key(gear_slot, class, category, op_type);

    {
        let cache = env.category_pool_cache.borrow();
        if let Some(rc) = cache.get(&key) {
            return Rc::clone(rc);
        }
    }

    // Select the ID list from the appropriate tier.
    let ids: &Vec<String> = {
        let by_slot_by_class = env
            .category_affix_ids_by_slot_by_class
            .get(gear_slot)
            .and_then(|by_class| by_class.get(class))
            .and_then(|by_cat| by_cat.get(category));

        if let Some(ids) = by_slot_by_class {
            ids
        } else if gear_slot == DEFAULT_GEAR_SLOT && class == DEFAULT_CLASS {
            match env.category_affix_ids.get(category) {
                Some(ids) => ids,
                None => {
                    let empty = Rc::new(Vec::new());
                    env.category_pool_cache.borrow_mut().insert(key, Rc::clone(&empty));
                    return empty;
                }
            }
        } else {
            let by_slot = env
                .category_affix_ids_by_slot
                .get(gear_slot)
                .and_then(|by_cat| by_cat.get(category));
            match by_slot {
                Some(ids) => ids,
                None => match env.category_affix_ids.get(category) {
                    Some(ids) => ids,
                    None => {
                        let empty = Rc::new(Vec::new());
                        env.category_pool_cache.borrow_mut().insert(key, Rc::clone(&empty));
                        return empty;
                    }
                },
            }
        }
    };

    let mut resolved: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(affix) = env.affix_map.get(id) else { continue };
        if !op_type.is_empty()
            && !get_affix_categories_for_op(affix, op_type).iter().any(|c| c == category)
        {
            continue;
        }
        resolved.push(id.clone());
    }

    let computed = Rc::new(resolved);
    env.category_pool_cache.borrow_mut().insert(key, Rc::clone(&computed));
    computed
}

/// Get the affix pool for a category, filtered to the state's gear slot/class.
/// Returns a Vec of &AffixData references from env.affix_map (resolved from the
/// memoized id list).
pub fn get_category_affixes_for_state<'a>(
    state: &JsState,
    env: &'a TranslationEnv,
    category: &str,
    op_type: &str,
) -> Vec<&'a AffixData> {
    let ids = get_category_affix_ids_for_state(state, env, category, op_type);
    ids.iter()
        .filter_map(|id| env.affix_map.get(id))
        .collect()
}

/// Family-normalized `(family_counts, total_effective_weight)` for a category's
/// pool, memoized on the env. Pure function of (slot, class, category, op_type).
pub fn get_category_pool_weights_for_state(
    state: &JsState,
    env: &TranslationEnv,
    category: &str,
    op_type: &str,
) -> Rc<PoolWeights> {
    let gear_slot = get_state_gear_slot(state);
    let class = get_state_class(state);
    let key = pool_cache_key(gear_slot, class, category, op_type);

    {
        let cache = env.pool_weight_cache.borrow();
        if let Some(rc) = cache.get(&key) {
            return Rc::clone(rc);
        }
    }

    let list = get_category_affixes_for_state(state, env, category, op_type);
    let family_counts = crate::residual::build_family_counts_for_pool(&list);
    let total_weight: f64 = list
        .iter()
        .map(|a| crate::residual::get_effective_affix_roll_weight(a, &family_counts))
        .sum();

    let computed = Rc::new((family_counts, total_weight));
    env.pool_weight_cache.borrow_mut().insert(key, Rc::clone(&computed));
    computed
}

/// Returns (index, &AffixEntry) pairs of affixes eligible for cube ops in a category.
pub fn get_eligible_by_category<'a>(
    state: &'a JsState,
    env: &TranslationEnv,
    category: &str,
    op_type: &str,
) -> Vec<(usize, &'a AffixEntry)> {
    state
        .affixes
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            if entry.is_enchanted {
                return false;
            }
            let affix = match env.affix_map.get(&entry.affix_id) {
                Some(a) => a,
                None => return false,
            };
            get_affix_categories_for_op(affix, op_type).iter().any(|c| c == category)
        })
        .collect()
}

/// True if the entry is a GA that is in ga_required_counts (i.e., protected).
pub fn is_protected_ga(entry: &AffixEntry, env: &TranslationEnv) -> bool {
    if !entry.is_ga {
        return false;
    }
    env.ga_required_counts.get(&entry.affix_id).copied().unwrap_or(0) > 0
}

// ── v1 action cost ────────────────────────────────────────────────────────────

pub fn is_cube_action(action: &JsAction) -> bool {
    matches!(
        action.action_type.as_str(),
        "add" | "remove" | "chaotic" | "focused"
    )
}

pub fn action_cost(action: &JsAction, state: &JsState) -> f64 {
    if is_cube_action(action) {
        return 1.0;
    }
    if action.action_type == "enchant" {
        if let Some(idx) = action.source_index {
            if let Some(entry) = state.affixes.get(idx as usize) {
                if entry.is_enchanted {
                    return RE_ENCHANT_TIE_BREAK_COST;
                }
            }
        }
    }
    0.0
}

// ── getValidActions (v1) ──────────────────────────────────────────────────────

/// Port of JS `getValidActions`. Generates all valid cube/enchant actions.
pub fn get_valid_actions(state: &JsState, target: &JsTarget, env: &TranslationEnv) -> Vec<JsAction> {
    let mut actions: Vec<JsAction> = Vec::new();

    // Category-based actions.
    for category in &env.category_names {
        // add: only when < 4 affixes
        if state.affixes.len() < 4 {
            actions.push(JsAction {
                action_type: "add".to_string(),
                prism: Some(category.clone()),
                source_index: None,
                target_affix_id: None,
            });
        }

        // remove: not allowed on legendary items
        let eligible_remove = get_eligible_by_category(state, env, category, "remove");
        if !state.is_legendary && !eligible_remove.is_empty() {
            let touches_ga = env.strict_mode
                && eligible_remove.iter().any(|(_, e)| is_protected_ga(e, env));
            if !touches_ga {
                actions.push(JsAction {
                    action_type: "remove".to_string(),
                    prism: Some(category.clone()),
                    source_index: None,
                    target_affix_id: None,
                });
            }
        }

        // chaotic
        let eligible_chaotic = get_eligible_by_category(state, env, category, "chaotic");
        if !eligible_chaotic.is_empty() {
            let touches_ga = env.strict_mode
                && eligible_chaotic.iter().any(|(_, e)| is_protected_ga(e, env));
            if !touches_ga {
                actions.push(JsAction {
                    action_type: "chaotic".to_string(),
                    prism: Some(category.clone()),
                    source_index: None,
                    target_affix_id: None,
                });
            }
        }

        // focused
        let eligible_focused = get_eligible_by_category(state, env, category, "focused");
        if !eligible_focused.is_empty() {
            let touches_ga = env.strict_mode
                && eligible_focused.iter().any(|(_, e)| is_protected_ga(e, env));
            if !touches_ga {
                actions.push(JsAction {
                    action_type: "focused".to_string(),
                    prism: Some(category.clone()),
                    source_index: None,
                    target_affix_id: None,
                });
            }
        }
    }

    // ── Enchant action generation ─────────────────────────────────────────────
    let target_ids: HashSet<&str> = target
        .affixes
        .iter()
        .map(|e| e.affix_id.as_str())
        .collect();
    let current_affix_ids: HashSet<&str> = state
        .affixes
        .iter()
        .map(|e| e.affix_id.as_str())
        .collect();
    let unsatisfactory_ids: HashSet<&str> = state
        .unsatisfactory_affix_ids
        .iter()
        .map(|s| s.as_str())
        .collect();

    let enchanted_index = state.affixes.iter().position(|e| e.is_enchanted);

    let build_enchant_candidates = |source_entry: &AffixEntry, include_same: bool| -> Vec<String> {
        let mut candidates: Vec<String> = Vec::new();
        for tid in &target_ids {
            if !current_affix_ids.contains(tid) || unsatisfactory_ids.contains(tid) {
                candidates.push(tid.to_string());
            }
        }
        if include_same && !source_entry.affix_id.is_empty() {
            if !candidates.iter().any(|c| c == source_entry.affix_id.as_str()) {
                candidates.push(source_entry.affix_id.clone());
            }
        }
        candidates
    };

    let push_enchant_for_slot =
        |actions: &mut Vec<JsAction>, source_idx: usize, source_entry: &AffixEntry, include_same: bool| {
            let other_affix_ids: HashSet<&str> = state
                .affixes
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != source_idx)
                .map(|(_, e)| e.affix_id.as_str())
                .collect();

            let source_in_target = target_ids.contains(source_entry.affix_id.as_str());
            let source_unsatisfactory = unsatisfactory_ids.contains(source_entry.affix_id.as_str());
            let allow_change = !source_in_target || source_unsatisfactory;

            let candidates = build_enchant_candidates(source_entry, include_same);
            for target_affix_id in candidates {
                if other_affix_ids.contains(target_affix_id.as_str()) {
                    continue;
                }
                if !allow_change && target_affix_id != source_entry.affix_id {
                    continue;
                }
                if env.strict_mode
                    && is_protected_ga(source_entry, env)
                    && target_affix_id != source_entry.affix_id
                {
                    continue;
                }
                actions.push(JsAction {
                    action_type: "enchant".to_string(),
                    prism: None,
                    source_index: Some(source_idx as i32),
                    target_affix_id: Some(target_affix_id),
                });
            }
        };

    if let Some(enc_idx) = enchanted_index {
        let enc_entry = &state.affixes[enc_idx];
        if !enc_entry.affix_id.is_empty() && !enc_entry.is_ga {
            let include_same = unsatisfactory_ids.contains(enc_entry.affix_id.as_str());
            push_enchant_for_slot(&mut actions, enc_idx, enc_entry, include_same);
        }
    } else {
        for (idx, entry) in state.affixes.iter().enumerate() {
            if entry.affix_id.is_empty() {
                continue;
            }
            push_enchant_for_slot(&mut actions, idx, entry, true);
        }
    }

    actions
}

// ── getValidActionsV2 ─────────────────────────────────────────────────────────

/// Mirrors JS `getMissingTargetAffixIdsV2`.
fn get_missing_target_affix_ids_v2(state: &JsState, env: &TranslationEnv) -> Vec<String> {
    let mut state_counts: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for entry in &state.affixes {
        *state_counts.entry(entry.affix_id.as_str()).or_insert(0) += 1;
    }
    let mut missing = Vec::new();
    for (affix_id, &required) in &env.target_counts {
        let have = state_counts.get(affix_id.as_str()).copied().unwrap_or(0);
        for _ in have..required {
            missing.push(affix_id.clone());
        }
    }
    missing
}

/// Mirrors JS `getGADonorSourceIndexes`.
fn get_ga_donor_source_indexes(state: &JsState, env: &TranslationEnv) -> Vec<usize> {
    let state_counts: std::collections::HashMap<&str, u32> = {
        let mut m = std::collections::HashMap::new();
        for entry in &state.affixes {
            *m.entry(entry.affix_id.as_str()).or_insert(0) += 1;
        }
        m
    };
    let mut indexes = Vec::new();
    for (idx, entry) in state.affixes.iter().enumerate() {
        if !entry.is_ga || entry.is_enchanted {
            continue;
        }
        // isDisposableEnchantSource: can we lose this slot without losing target coverage?
        let count = state_counts.get(entry.affix_id.as_str()).copied().unwrap_or(0);
        let required = env.target_counts.get(&entry.affix_id).copied().unwrap_or(0);
        if count.saturating_sub(1) < required {
            continue;
        }
        indexes.push(idx);
    }
    indexes
}

/// Mirrors JS `getForcedGAEnchantActions`.
fn get_forced_ga_enchant_actions(state: &JsState, env: &TranslationEnv) -> Vec<JsAction> {
    // Only when no slot is already enchanted.
    if state.affixes.iter().any(|e| e.is_enchanted) {
        return vec![];
    }
    // getMissingRequiredGAIdsV2 always returns [] in current JS code.
    // Total required GA count is always 0 in current JS code.
    // So this function always returns [].
    vec![]
}

/// Mirrors JS `isDisposableEnchantSource`.
fn is_disposable_enchant_source(state: &JsState, source_index: usize, env: &TranslationEnv) -> bool {
    let entry = match state.affixes.get(source_index) {
        Some(e) => e,
        None => return false,
    };
    if entry.is_enchanted {
        return false;
    }
    let mut state_counts: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for e in &state.affixes {
        *state_counts.entry(e.affix_id.as_str()).or_insert(0) += 1;
    }
    let count = state_counts.get(entry.affix_id.as_str()).copied().unwrap_or(0);
    let required = env.target_counts.get(&entry.affix_id).copied().unwrap_or(0);
    count.saturating_sub(1) >= required
}

/// Mirrors JS `getLateEnchantActions`.
fn get_late_enchant_actions(
    state: &JsState,
    env: &TranslationEnv,
    actions: &[JsAction],
) -> Vec<JsAction> {
    if state.affixes.iter().any(|e| e.is_enchanted) {
        return vec![];
    }

    let missing_target_ids = get_missing_target_affix_ids_v2(state, env);
    let unsatisfactory_ids: Vec<String> = state
        .unsatisfactory_affix_ids
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect();

    let mut unresolved: Vec<String> = {
        let mut set: IndexedSet = IndexedSet::new();
        for id in &missing_target_ids {
            set.insert(id.clone());
        }
        for id in &unsatisfactory_ids {
            set.insert(id.clone());
        }
        set.into_iter().collect()
    };
    // Only when exactly one unresolved target
    if unresolved.len() != 1 {
        return vec![];
    }
    let target_affix_id = unresolved.remove(0);
    let unsatisfactory_only = unsatisfactory_ids.contains(&target_affix_id) && missing_target_ids.is_empty();

    actions
        .iter()
        .filter(|action| {
            if action.action_type != "enchant" {
                return false;
            }
            if action.target_affix_id.as_deref() != Some(target_affix_id.as_str()) {
                return false;
            }
            let src_idx = match action.source_index {
                Some(i) if i >= 0 => i as usize,
                _ => return false,
            };
            let entry = match state.affixes.get(src_idx) {
                Some(e) => e,
                None => return false,
            };
            if entry.is_enchanted {
                return false;
            }
            if entry.affix_id == target_affix_id && !unsatisfactory_only {
                return false;
            }
            if unsatisfactory_only {
                return entry.affix_id == target_affix_id;
            }
            is_disposable_enchant_source(state, src_idx, env)
        })
        .cloned()
        .collect()
}

/// Simple ordered set (preserves insertion order, deduplicates).
struct IndexedSet {
    items: Vec<String>,
    seen: HashSet<String>,
}

impl IndexedSet {
    fn new() -> Self {
        Self {
            items: Vec::new(),
            seen: HashSet::new(),
        }
    }
    fn insert(&mut self, s: String) {
        if self.seen.insert(s.clone()) {
            self.items.push(s);
        }
    }
    fn into_iter(self) -> impl Iterator<Item = String> {
        self.items.into_iter()
    }
}

/// Deduplicate actions by action key.
fn dedupe_actions(actions: Vec<JsAction>) -> Vec<JsAction> {
    use crate::keys::action_key;
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for a in actions {
        let key = action_key(&a);
        if seen.insert(key) {
            out.push(a);
        }
    }
    out
}

/// Mirrors JS `getRelevantAddPrismsV2` - returns the set of categories
/// that contain any missing target affix.
fn get_relevant_add_prisms_v2(state: &JsState, env: &TranslationEnv) -> HashSet<String> {
    let missing = get_missing_target_affix_ids_v2(state, env);
    let mut prisms: HashSet<String> = HashSet::new();
    for affix_id in &missing {
        if let Some(affix) = env.affix_map.get(affix_id) {
            for cat in &affix.categories {
                prisms.insert(cat.clone());
            }
        }
    }
    prisms
}

/// Port of JS `getValidActionsV2`. Extends v1 with:
/// - filters add actions to relevant-prism categories only
/// - filters enchant to exclude same-affix (except GA donors, late enchants, prism-unblocks)
/// - adds GA donor enchants, late enchants, prism-unblock enchants
pub fn get_valid_actions_v2(
    state: &JsState,
    target: &JsTarget,
    env: &TranslationEnv,
) -> Vec<JsAction> {
    let relevant_add_prisms = get_relevant_add_prisms_v2(state, env);

    let actions: Vec<JsAction> = get_valid_actions(state, target, env)
        .into_iter()
        .filter(|action| {
            if action.action_type == "add" {
                return action.prism.as_deref().map_or(false, |p| relevant_add_prisms.contains(p));
            }
            if action.action_type != "enchant" {
                return true;
            }
            let src_idx = match action.source_index {
                Some(i) if i >= 0 => i as usize,
                _ => return false,
            };
            let entry = match state.affixes.get(src_idx) {
                Some(e) => e,
                None => return false,
            };
            // Filter out same-affix enchants (they'll be re-added as prism-unblocks)
            action.target_affix_id.as_deref() != Some(entry.affix_id.as_str())
        })
        .collect();

    // Forced GA enchants take priority (always [] in current code).
    let forced = get_forced_ga_enchant_actions(state, env);
    if !forced.is_empty() {
        return dedupe_actions(forced);
    }

    let late_enchants = get_late_enchant_actions(state, env, &actions);

    // Prism-unblock enchants: same-affix on protected-GA slots or non-GA matched-target slots.
    let prism_unblock: Vec<JsAction> = if state.affixes.iter().any(|e| e.is_enchanted) {
        vec![]
    } else {
        state
            .affixes
            .iter()
            .enumerate()
            .filter_map(|(i, entry)| {
                if entry.affix_id.is_empty() {
                    return None;
                }
                let is_protected = is_protected_ga(entry, env);
                let is_non_ga_matched = !entry.is_ga
                    && env.target_counts.get(&entry.affix_id).copied().unwrap_or(0) > 0;
                if is_protected || is_non_ga_matched {
                    Some(JsAction {
                        action_type: "enchant".to_string(),
                        prism: None,
                        source_index: Some(i as i32),
                        target_affix_id: Some(entry.affix_id.clone()),
                    })
                } else {
                    None
                }
            })
            .collect()
    };

    // Combine: non-enchant actions + late enchants + prism-unblocks (no change-enchants).
    let combined: Vec<JsAction> = actions
        .into_iter()
        .filter(|a| a.action_type != "enchant")
        .chain(late_enchants)
        .chain(prism_unblock)
        .collect();

    dedupe_actions(combined)
}
