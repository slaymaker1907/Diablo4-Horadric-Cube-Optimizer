use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::types::{AffixData, JsEnvData, JsGaConfig, JsTarget};

/// Cached `(family_counts, total_effective_weight)` for a resolved affix pool.
pub type PoolWeights = (HashMap<String, usize>, f64);

/// Translation tables built once per optimization run from the JS affix catalog.
/// All subsequent Rust functions take an env handle rather than re-parsing JSON.
pub struct TranslationEnv {
    // Affix token IDs: 0 = empty slot, 1..N = real affix IDs (registration order)
    pub affix_id_to_token: HashMap<String, u16>,
    pub token_to_affix_id: Vec<String>, // index = token_id; [0] = "" (empty)

    // Gear slot IDs: 0 = "Any"
    pub gear_slot_to_id: HashMap<String, u8>,
    pub id_to_gear_slot: Vec<String>,

    // Class IDs: 0 = "Any"
    pub class_to_id: HashMap<String, u8>,
    pub id_to_class: Vec<String>,

    // Affix metadata (Phase 1: token mapping)
    pub affix_categories: HashMap<String, Vec<String>>,
    pub affix_family: HashMap<String, String>,

    // Pre-computed from target + gaConfig
    pub ga_required_counts: HashMap<String, u32>,
    pub target_counts: HashMap<String, u32>,

    // ── Phase 2: full affix catalog + category lookup tables ─────────────────

    /// Full affix data by ID (includes gear_slots, class, operation_categories, etc.)
    pub affix_map: HashMap<String, AffixData>,

    /// Base category → affix IDs (for "Any" gear slot, "Any" class).
    pub category_affix_ids: HashMap<String, Vec<String>>,

    /// slot → category → affix IDs (filtered to legal gear slot).
    pub category_affix_ids_by_slot: HashMap<String, HashMap<String, Vec<String>>>,

    /// slot → class → category → affix IDs (filtered to slot AND class).
    pub category_affix_ids_by_slot_by_class:
        HashMap<String, HashMap<String, HashMap<String, Vec<String>>>>,

    /// Ordered list of known gear slots (first element = "Any").
    pub gear_slots: Vec<String>,

    /// Ordered list of known classes (first element = "Any").
    pub classes: Vec<String>,

    /// Ordered category names from the catalog.
    pub category_names: Vec<String>,

    /// strictMode from gaConfig.
    pub strict_mode: bool,

    /// Source GA counts per affix (from gaConfig.currentGAAffixes).
    pub source_ga_counts: HashMap<String, u32>,

    /// For each family, the first target affix from that family (JS: wantedByFamily).
    pub wanted_by_family: HashMap<String, String>,

    /// maxAffixSlots from the data payload (if provided).
    pub max_affix_slots_from_data: Option<u32>,

    // ── Phase 3: v2 / residual solver fields ─────────────────────────────────

    /// family → placeholder "other" affix ID (elemental-damage, specific-resistance).
    pub family_other_id: HashMap<String, String>,

    /// Counts of affixes in gaConfig.unsatisfactoryAffixIds (needs-improvement).
    pub unsatisfactory_counts: HashMap<String, u32>,

    /// Static impossibility reason from target family analysis (empty = ok).
    pub impossible_target_ga_reason: String,

    /// Number of non-null entries in gaConfig.currentGAAffixes.
    pub source_total_ga_count: u32,

    // ── Memoization caches (interior-mutable; single-threaded WASM) ───────────
    //
    // The eligible affix pool for a category depends ONLY on
    // (gear_slot, class, category, op_type) — never on the specific affixes in
    // a state — and the family-normalized weights are a pure function of that
    // pool. Both are therefore safe to memoize for the env's lifetime and are
    // reused across every node × action enumeration and every MC rollout step.
    // Mirrors the JS env caches (eligibleByCategoryCache / categoryWeightTotals).
    /// `slot|class|category|op` → resolved affix-id list (after op_type filter).
    pub category_pool_cache: RefCell<HashMap<String, Rc<Vec<String>>>>,
    /// `slot|class|category|op` → `(family_counts, total_effective_weight)`.
    pub pool_weight_cache: RefCell<HashMap<String, Rc<PoolWeights>>>,

    // ── Integer hot-path fields (zero-alloc inner loop) ───────────────────────

    /// Category names in lexicographic order, including "_" at its correct position.
    pub category_to_id: HashMap<String, u16>,
    /// Indexed by category ID; same sorted order.
    pub id_to_category: Vec<String>,
    /// Category ID of the string "_" (None-prism sentinel for action_sort_key).
    pub prism_none_id: u16,

    /// "trash<sig>" strings → their unified token ID.
    pub trash_sig_to_token: HashMap<String, u16>,
    /// For each real affix token, the unified token ID of its trash pseudo-token.
    /// Indexed by token; index 0 = 0 (unused).
    pub token_to_trash_token: Vec<u16>,
    /// Unified token ID of the string "_" (None-target sentinel for action_sort_key).
    pub affix_none_token: u16,

    /// Family ID for each real affix token (0 = no family).
    /// Indexed by token; size = total token count.
    pub token_family_id: Vec<u8>,
    /// Canonical token for each real affix token (result of canonicalize_affix_id).
    pub token_canonical: Vec<u16>,
    /// How many times each token appears in the target spec.
    pub token_target_count: Vec<u32>,
    /// How many GAs of each token are required (from ga_required_counts).
    pub token_ga_required: Vec<u32>,

    /// Family IDs (index 0 = "" / no family, index 1..K = real families).
    pub family_names: Vec<String>,
    /// Family name → family ID.
    pub family_name_to_id: HashMap<String, u8>,
    /// For each family ID, the token of the "other" placeholder (0 = none).
    pub family_other_token: Vec<u16>,
    /// For each family ID, the token of the wanted affix (0 = none).
    pub family_wanted_token: Vec<u16>,

    /// Deduplicated set of token IDs required by the target.
    pub required_target_tokens: Vec<u16>,
}

thread_local! {
    static ENV_ARENA: RefCell<Vec<Option<TranslationEnv>>> = RefCell::new(Vec::new());
}

pub fn store_env(env: TranslationEnv) -> u32 {
    ENV_ARENA.with(|arena| {
        let mut arena = arena.borrow_mut();
        if let Some(idx) = arena.iter().position(|e| e.is_none()) {
            arena[idx] = Some(env);
            return idx as u32;
        }
        arena.push(Some(env));
        (arena.len() - 1) as u32
    })
}

pub fn release_env(handle: u32) {
    ENV_ARENA.with(|arena| {
        let mut arena = arena.borrow_mut();
        if let Some(slot) = arena.get_mut(handle as usize) {
            *slot = None;
        }
    });
}

pub fn with_env<F, R>(handle: u32, f: F) -> Option<R>
where
    F: FnOnce(&TranslationEnv) -> R,
{
    ENV_ARENA.with(|arena| {
        arena
            .borrow()
            .get(handle as usize)
            .and_then(|e| e.as_ref())
            .map(f)
    })
}

// ── Construction ─────────────────────────────────────────────────────────────

pub const DEFAULT_GEAR_SLOT: &str = "Any";
pub const DEFAULT_CLASS: &str = "Any";
const DEFAULT_MAX_AFFIX_SLOTS: u32 = 4;

/// True if `affix` can appear on `gear_slot`.
pub fn affix_supports_gear_slot(affix: &AffixData, gear_slot: &str) -> bool {
    if gear_slot.is_empty() || gear_slot == DEFAULT_GEAR_SLOT {
        return true;
    }
    match &affix.gear_slots {
        None => true,
        Some(slots) if slots.is_empty() => true,
        Some(slots) => slots.iter().any(|s| s == DEFAULT_GEAR_SLOT || s == gear_slot),
    }
}

/// True if `affix` can appear for the given character class.
pub fn affix_supports_class(affix: &AffixData, class_name: &str) -> bool {
    if class_name.is_empty() || class_name == DEFAULT_CLASS {
        return true;
    }
    match &affix.class {
        None => true,
        Some(c) if c.is_empty() || c == DEFAULT_CLASS => true,
        Some(c) => c == class_name,
    }
}

/// Returns the effective max affix slots for a state + data combo.
pub fn get_max_affix_slots(state: &crate::types::JsState, env: &TranslationEnv) -> usize {
    if let Some(v) = env.max_affix_slots_from_data {
        if v > 0 {
            return v as usize;
        }
    }
    if let Some(v) = state.max_affix_slots {
        if v > 0 {
            return v as usize;
        }
    }
    DEFAULT_MAX_AFFIX_SLOTS as usize
}

pub fn build_env(data: JsEnvData, ga_config: JsGaConfig, target: JsTarget) -> TranslationEnv {
    // ── Pass 1: build affix metadata (affix_map, affix_categories, affix_family) ─
    let mut affix_categories: HashMap<String, Vec<String>> = HashMap::new();
    let mut affix_family: HashMap<String, String> = HashMap::new();
    let mut affix_map: HashMap<String, AffixData> = HashMap::new();

    for affix in &data.affixes {
        if !affix.categories.is_empty() {
            affix_categories.insert(affix.id.clone(), affix.categories.clone());
        }
        if let Some(ref fam) = affix.family {
            if !fam.is_empty() {
                affix_family.insert(affix.id.clone(), fam.clone());
            }
        }
        affix_map.insert(affix.id.clone(), affix.clone());
    }

    // ── Pass 2: compute trash signatures for all unique affixes ──────────────
    let mut unique_affix_ids: Vec<&str> = data.affixes.iter().map(|a| a.id.as_str()).collect();
    unique_affix_ids.sort_unstable();
    unique_affix_ids.dedup();

    // Helper: compute trash signature string for an affix ID.
    let compute_trash_sig = |id: &str| -> String {
        let affix = affix_map.get(id);
        let mut cats: Vec<String> = affix.map(|a| a.categories.clone()).unwrap_or_default();
        cats.sort_unstable();
        let cat_str = cats.join("&");
        let family = affix_family
            .get(id)
            .map(|s| s.as_str())
            .unwrap_or_else(|| crate::actions::infer_affix_family(id));
        if !family.is_empty() {
            format!("{}::{}", cat_str, family)
        } else {
            cat_str
        }
    };

    let mut trash_sigs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for &id in &unique_affix_ids {
        trash_sigs.insert(format!("trash<{}>", compute_trash_sig(id)));
    }

    // ── Pass 3: build unified sorted token list ───────────────────────────────
    // Unified token list = sorted(all_affix_ids + all_trash_sig_strings + "_").
    // Token 0 = empty slot marker (not in the list, inserted at index 0 separately).
    let mut unified: Vec<String> = unique_affix_ids
        .iter()
        .map(|s| s.to_string())
        .chain(trash_sigs.iter().cloned())
        .chain(std::iter::once("_".to_string()))
        .collect();
    unified.sort_unstable();

    let mut affix_id_to_token: HashMap<String, u16> = HashMap::new();
    let mut token_to_affix_id: Vec<String> = vec!["".to_string()]; // index 0 = empty
    let mut trash_sig_to_token: HashMap<String, u16> = HashMap::new();
    let mut affix_none_token: u16 = 0;

    for s in &unified {
        let token = token_to_affix_id.len() as u16;
        token_to_affix_id.push(s.clone());
        if s == "_" {
            affix_none_token = token;
        } else if s.starts_with("trash<") {
            trash_sig_to_token.insert(s.clone(), token);
        } else {
            affix_id_to_token.insert(s.clone(), token);
        }
    }

    // For each real affix token → precompute its trash token.
    let total_tokens = token_to_affix_id.len();
    let mut token_to_trash_token: Vec<u16> = vec![0u16; total_tokens];
    for &id in &unique_affix_ids {
        if let Some(&real_tok) = affix_id_to_token.get(id) {
            let sig = compute_trash_sig(id);
            let trash_str = format!("trash<{}>", sig);
            if let Some(&trash_tok) = trash_sig_to_token.get(&trash_str) {
                token_to_trash_token[real_tok as usize] = trash_tok;
            }
        }
    }

    // ── Gear slot mapping ─────────────────────────────────────────────────────
    let mut gear_slot_to_id: HashMap<String, u8> = HashMap::new();
    let mut id_to_gear_slot: Vec<String> = vec![];

    let mut gear_slots: Vec<String> = vec![DEFAULT_GEAR_SLOT.to_string()];
    if let Some(slots) = &data.gear_slots {
        for s in slots {
            if !s.is_empty() && !gear_slots.contains(s) {
                gear_slots.push(s.clone());
            }
        }
    }
    for slot in &gear_slots {
        gear_slot_to_id.insert(slot.clone(), id_to_gear_slot.len() as u8);
        id_to_gear_slot.push(slot.clone());
    }

    // ── Class mapping ─────────────────────────────────────────────────────────
    let mut class_to_id: HashMap<String, u8> = HashMap::new();
    let mut id_to_class: Vec<String> = vec![];

    let mut classes: Vec<String> = vec![DEFAULT_CLASS.to_string()];
    if let Some(cls_list) = &data.classes {
        for c in cls_list {
            if !c.is_empty() && !classes.contains(c) {
                classes.push(c.clone());
            }
        }
    }
    for cls in &classes {
        class_to_id.insert(cls.clone(), id_to_class.len() as u8);
        id_to_class.push(cls.clone());
    }

    // ── Category affix ID lists ───────────────────────────────────────────────
    let category_names: Vec<String> = data.categories.keys().cloned().collect();

    // Base list (Any slot, Any class): just affix IDs from categories map
    let mut category_affix_ids: HashMap<String, Vec<String>> = HashMap::new();
    for (cat_name, id_list) in &data.categories {
        let valid_ids: Vec<String> = id_list
            .iter()
            .filter(|id| affix_map.contains_key(*id))
            .cloned()
            .collect();
        category_affix_ids.insert(cat_name.clone(), valid_ids);
    }

    // Per-slot: filter by gear slot legality
    let mut category_affix_ids_by_slot: HashMap<String, HashMap<String, Vec<String>>> =
        HashMap::new();
    for slot in &gear_slots {
        if slot == DEFAULT_GEAR_SLOT {
            category_affix_ids_by_slot.insert(slot.clone(), category_affix_ids.clone());
            continue;
        }
        let mut slot_map: HashMap<String, Vec<String>> = HashMap::new();
        for (cat_name, ids) in &category_affix_ids {
            let filtered: Vec<String> = ids
                .iter()
                .filter(|id| {
                    affix_map
                        .get(*id)
                        .map(|a| affix_supports_gear_slot(a, slot))
                        .unwrap_or(false)
                })
                .cloned()
                .collect();
            slot_map.insert(cat_name.clone(), filtered);
        }
        category_affix_ids_by_slot.insert(slot.clone(), slot_map);
    }

    // Per-slot-per-class: further filter by class
    let mut category_affix_ids_by_slot_by_class: HashMap<
        String,
        HashMap<String, HashMap<String, Vec<String>>>,
    > = HashMap::new();
    for slot in &gear_slots {
        let slot_base = category_affix_ids_by_slot
            .get(slot)
            .unwrap_or(&category_affix_ids);
        let mut class_map: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
        for cls in &classes {
            if cls == DEFAULT_CLASS {
                class_map.insert(cls.clone(), slot_base.clone());
                continue;
            }
            let mut cat_map: HashMap<String, Vec<String>> = HashMap::new();
            for (cat_name, ids) in slot_base {
                let filtered: Vec<String> = ids
                    .iter()
                    .filter(|id| {
                        affix_map
                            .get(*id)
                            .map(|a| affix_supports_class(a, cls))
                            .unwrap_or(false)
                    })
                    .cloned()
                    .collect();
                cat_map.insert(cat_name.clone(), filtered);
            }
            class_map.insert(cls.clone(), cat_map);
        }
        category_affix_ids_by_slot_by_class.insert(slot.clone(), class_map);
    }

    // ── Target counts ─────────────────────────────────────────────────────────
    let mut target_counts: HashMap<String, u32> = HashMap::new();
    let mut wanted_by_family: HashMap<String, String> = HashMap::new();
    for req in &target.affixes {
        if !req.affix_id.is_empty() {
            *target_counts.entry(req.affix_id.clone()).or_insert(0) += 1;
            // Use catalog family first; fall back to inferred family so that
            // "elemental-damage-physical" / "specific-resistance-fire" etc. are
            // recognised even when the catalog entry is a plain string with no
            // explicit family field.
            let fam = affix_family
                .get(&req.affix_id)
                .map(|s| s.as_str())
                .unwrap_or_else(|| crate::actions::infer_affix_family(&req.affix_id));
            if !fam.is_empty() {
                wanted_by_family
                    .entry(fam.to_string())
                    .or_insert_with(|| req.affix_id.clone());
            }
        }
    }

    // ── GA required counts ────────────────────────────────────────────────────
    let mut source_ga_counts: HashMap<String, u32> = HashMap::new();
    for maybe_id in &ga_config.current_ga_affixes {
        if let Some(id) = maybe_id {
            if !id.is_empty() {
                *source_ga_counts.entry(id.clone()).or_insert(0) += 1;
            }
        }
    }

    let mut ga_required_counts: HashMap<String, u32> = HashMap::new();
    for (affix_id, &source_count) in &source_ga_counts {
        let target_count = target_counts.get(affix_id).copied().unwrap_or(0);
        if target_count > 0 {
            ga_required_counts.insert(affix_id.clone(), source_count.min(target_count));
        }
    }

    // ── Family other IDs + synthetic placeholder affixes ─────────────────────
    const ELEMENTAL_DAMAGE_FAMILY: &str = "elemental-damage";
    const SPECIFIC_RESISTANCE_FAMILY: &str = "specific-resistance";

    let mut family_other_id: HashMap<String, String> = HashMap::new();
    family_other_id.insert(ELEMENTAL_DAMAGE_FAMILY.to_string(), "elemental-damage-other".to_string());
    family_other_id.insert(SPECIFIC_RESISTANCE_FAMILY.to_string(), "specific-resistance-other".to_string());

    // Add synthetic "other" placeholder affixes for each family that has members.
    // Seed by family field OR inferred family (for JS catalog entries that don't
    // set an explicit family on individual elemental-damage-* variants).
    for (family, other_id) in &family_other_id {
        if affix_map.contains_key(other_id) {
            continue;
        }
        let seed = affix_map.values().find(|a| {
            let explicit = a.family.as_deref().unwrap_or("");
            if explicit == family { return true; }
            if explicit.is_empty() {
                let inferred = crate::actions::infer_affix_family(&a.id);
                if inferred == family { return true; }
            }
            false
        }).cloned();
        if let Some(seed_affix) = seed {
            let other_affix = AffixData {
                id: other_id.clone(),
                categories: seed_affix.categories.clone(),
                family: Some(family.clone()),
                roll_weight: 1.0,
                family_roll_weight: 0.0,
                class: None,
                gear_slots: seed_affix.gear_slots.clone(),
                operation_categories: None,
            };
            affix_map.insert(other_id.clone(), other_affix);
        }
    }

    // ── Unsatisfactory counts (v2 / residual) ─────────────────────────────────
    let mut unsatisfactory_counts: HashMap<String, u32> = HashMap::new();
    for affix_id in &ga_config.unsatisfactory_affix_ids {
        if !affix_id.is_empty() {
            *unsatisfactory_counts.entry(affix_id.clone()).or_insert(0) += 1;
        }
    }

    // ── Impossible target GA reason ───────────────────────────────────────────
    let source_total_ga_count = ga_config
        .current_ga_affixes
        .iter()
        .filter(|x| x.is_some())
        .count() as u32;

    let impossible_target_ga_reason = {
        let mut family_counts: HashMap<String, u32> = HashMap::new();
        for (affix_id, &count) in &target_counts {
            let fam = affix_family.get(affix_id).map(|s| s.as_str()).unwrap_or("");
            if !fam.is_empty() {
                *family_counts.entry(fam.to_string()).or_insert(0) += count;
            }
        }
        if family_counts.get(ELEMENTAL_DAMAGE_FAMILY).copied().unwrap_or(0) > 1 {
            "Impossible target: only one Elemental Damage type can exist on an item.".to_string()
        } else if family_counts.get(SPECIFIC_RESISTANCE_FAMILY).copied().unwrap_or(0) > 1 {
            "Impossible target: only one Specific Resistance type can exist on an item.".to_string()
        } else {
            String::new()
        }
    };

    // ── Integer hot-path precomputation ──────────────────────────────────────

    // Category IDs in lexicographic order (including "_" at its sorted position).
    let mut all_cats_with_sentinel: Vec<String> = data.categories.keys().cloned().collect();
    all_cats_with_sentinel.push("_".to_string());
    all_cats_with_sentinel.sort_unstable();
    let mut category_to_id: HashMap<String, u16> = HashMap::new();
    let mut id_to_category: Vec<String> = Vec::new();
    let mut prism_none_id: u16 = 0;
    for (i, cat) in all_cats_with_sentinel.iter().enumerate() {
        category_to_id.insert(cat.clone(), i as u16);
        id_to_category.push(cat.clone());
        if cat == "_" {
            prism_none_id = i as u16;
        }
    }

    // Family system.
    let mut family_names: Vec<String> = vec!["".to_string()]; // 0 = no family
    let mut family_name_to_id: HashMap<String, u8> = HashMap::new();
    {
        let mut unique_fams: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for id in &unique_affix_ids {
            let fam = affix_family
                .get(*id)
                .map(|s| s.as_str())
                .unwrap_or_else(|| crate::actions::infer_affix_family(id));
            if !fam.is_empty() {
                unique_fams.insert(fam.to_string());
            }
        }
        for (fam, _) in &family_other_id {
            unique_fams.insert(fam.clone());
        }
        for (i, fam) in unique_fams.iter().enumerate() {
            let fid = (i + 1) as u8;
            family_name_to_id.insert(fam.clone(), fid);
            family_names.push(fam.clone());
        }
    }
    let num_families = family_names.len();

    // Per-token data arrays (size = total_tokens).
    let mut token_family_id: Vec<u8> = vec![0u8; total_tokens];
    let mut token_target_count: Vec<u32> = vec![0u32; total_tokens];
    let mut token_ga_required: Vec<u32> = vec![0u32; total_tokens];

    for &id in &unique_affix_ids {
        if let Some(&tok) = affix_id_to_token.get(id) {
            let fam = affix_family
                .get(id)
                .map(|s| s.as_str())
                .unwrap_or_else(|| crate::actions::infer_affix_family(id));
            if !fam.is_empty() {
                if let Some(&fid) = family_name_to_id.get(fam) {
                    token_family_id[tok as usize] = fid;
                }
            }
            if let Some(&cnt) = target_counts.get(id) {
                token_target_count[tok as usize] = cnt;
            }
            if let Some(&cnt) = ga_required_counts.get(id) {
                token_ga_required[tok as usize] = cnt;
            }
        }
    }
    // Also handle synthetic "other" tokens added to affix_map after the unique_affix_ids pass.
    for (id, data_entry) in &affix_map {
        if let Some(&tok) = affix_id_to_token.get(id) {
            if token_family_id[tok as usize] == 0 {
                if let Some(ref fam) = data_entry.family {
                    if !fam.is_empty() {
                        if let Some(&fid) = family_name_to_id.get(fam.as_str()) {
                            token_family_id[tok as usize] = fid;
                        }
                    }
                }
            }
        }
    }

    // family_other_token and family_wanted_token.
    let mut family_other_token: Vec<u16> = vec![0u16; num_families];
    let mut family_wanted_token: Vec<u16> = vec![0u16; num_families];
    for (fam, other_id) in &family_other_id {
        if let Some(&fid) = family_name_to_id.get(fam.as_str()) {
            if let Some(&tok) = affix_id_to_token.get(other_id.as_str()) {
                family_other_token[fid as usize] = tok;
            }
        }
    }
    for (fam, wanted_id) in &wanted_by_family {
        if let Some(&fid) = family_name_to_id.get(fam.as_str()) {
            if let Some(&tok) = affix_id_to_token.get(wanted_id.as_str()) {
                family_wanted_token[fid as usize] = tok;
            }
        }
    }

    // token_canonical: canonicalize_affix_id result for each real token.
    let mut token_canonical: Vec<u16> = (0..total_tokens as u16).collect();
    for &id in &unique_affix_ids {
        if let Some(&tok) = affix_id_to_token.get(id) {
            let fid = token_family_id[tok as usize];
            let canonical = if fid == 0 {
                tok
            } else {
                let wanted = family_wanted_token[fid as usize];
                if wanted != 0 && tok == wanted {
                    tok
                } else {
                    let other = family_other_token[fid as usize];
                    if other != 0 { other } else { tok }
                }
            };
            token_canonical[tok as usize] = canonical;
        }
    }

    // required_target_tokens: deduplicated set of tokens required by target.
    let required_target_tokens: Vec<u16> = {
        let mut set: std::collections::HashSet<u16> = std::collections::HashSet::new();
        for id in target_counts.keys() {
            if let Some(&tok) = affix_id_to_token.get(id) {
                set.insert(tok);
            }
        }
        set.into_iter().collect()
    };

    TranslationEnv {
        affix_id_to_token,
        token_to_affix_id,
        gear_slot_to_id,
        id_to_gear_slot,
        class_to_id,
        id_to_class,
        affix_categories,
        affix_family,
        ga_required_counts,
        target_counts,
        // Phase 2
        affix_map,
        category_affix_ids,
        category_affix_ids_by_slot,
        category_affix_ids_by_slot_by_class,
        gear_slots,
        classes,
        category_names,
        strict_mode: ga_config.strict_mode,
        source_ga_counts,
        wanted_by_family,
        max_affix_slots_from_data: data.max_affix_slots,
        // Phase 3
        family_other_id,
        unsatisfactory_counts,
        impossible_target_ga_reason,
        source_total_ga_count,
        // Memoization caches (start empty)
        category_pool_cache: RefCell::new(HashMap::new()),
        pool_weight_cache: RefCell::new(HashMap::new()),
        // Integer hot-path
        category_to_id,
        id_to_category,
        prism_none_id,
        trash_sig_to_token,
        token_to_trash_token,
        affix_none_token,
        token_family_id,
        token_canonical,
        token_target_count,
        token_ga_required,
        family_names,
        family_name_to_id,
        family_other_token,
        family_wanted_token,
        required_target_tokens,
    }
}
