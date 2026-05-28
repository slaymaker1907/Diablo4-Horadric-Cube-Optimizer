use std::cell::RefCell;
use std::collections::HashMap;

use crate::types::{AffixData, JsEnvData, JsGaConfig, JsTarget};

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
    // ── Affix token mapping ───────────────────────────────────────────────────
    let mut affix_id_to_token: HashMap<String, u16> = HashMap::new();
    let mut token_to_affix_id: Vec<String> = vec!["".to_string()]; // 0 = empty
    let mut affix_categories: HashMap<String, Vec<String>> = HashMap::new();
    let mut affix_family: HashMap<String, String> = HashMap::new();
    let mut affix_map: HashMap<String, AffixData> = HashMap::new();

    for affix in &data.affixes {
        if !affix_id_to_token.contains_key(&affix.id) {
            let token = token_to_affix_id.len() as u16;
            token_to_affix_id.push(affix.id.clone());
            affix_id_to_token.insert(affix.id.clone(), token);
        }
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
            if let Some(fam) = affix_family.get(&req.affix_id) {
                wanted_by_family.entry(fam.clone()).or_insert_with(|| req.affix_id.clone());
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
    for (family, other_id) in &family_other_id {
        if affix_map.contains_key(other_id) {
            continue;
        }
        let seed = affix_map.values().find(|a| {
            a.family.as_deref().unwrap_or("") == family
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
    }
}
