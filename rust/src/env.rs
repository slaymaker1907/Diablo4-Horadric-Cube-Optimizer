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

    // Affix metadata (needed for stateKeyV2 / residual in Phase 3)
    pub affix_categories: HashMap<String, Vec<String>>,
    pub affix_family: HashMap<String, String>,

    // Pre-computed from target + gaConfig
    pub ga_required_counts: HashMap<String, u32>,
    pub target_counts: HashMap<String, u32>,
}

thread_local! {
    static ENV_ARENA: RefCell<Vec<Option<TranslationEnv>>> = RefCell::new(Vec::new());
}

pub fn store_env(env: TranslationEnv) -> u32 {
    ENV_ARENA.with(|arena| {
        let mut arena = arena.borrow_mut();
        // Reuse freed slots before growing.
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

const DEFAULT_GEAR_SLOT: &str = "Any";
const DEFAULT_CLASS: &str = "Any";

pub fn build_env(data: JsEnvData, ga_config: JsGaConfig, target: JsTarget) -> TranslationEnv {
    // ── Affix token mapping ───────────────────────────────────────────────
    let mut affix_id_to_token: HashMap<String, u16> = HashMap::new();
    let mut token_to_affix_id: Vec<String> = vec!["".to_string()]; // 0 = empty
    let mut affix_categories: HashMap<String, Vec<String>> = HashMap::new();
    let mut affix_family: HashMap<String, String> = HashMap::new();

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
            affix_family.insert(affix.id.clone(), fam.clone());
        }
    }

    // ── Gear slot mapping ─────────────────────────────────────────────────
    let mut gear_slot_to_id: HashMap<String, u8> = HashMap::new();
    let mut id_to_gear_slot: Vec<String> = vec![];

    let mut gear_slots: Vec<String> = vec![DEFAULT_GEAR_SLOT.to_string()];
    if let Some(slots) = data.gear_slots {
        for s in slots {
            if !s.is_empty() && !gear_slots.contains(&s) {
                gear_slots.push(s);
            }
        }
    }
    for slot in &gear_slots {
        gear_slot_to_id.insert(slot.clone(), id_to_gear_slot.len() as u8);
        id_to_gear_slot.push(slot.clone());
    }

    // ── Class mapping ─────────────────────────────────────────────────────
    let mut class_to_id: HashMap<String, u8> = HashMap::new();
    let mut id_to_class: Vec<String> = vec![];

    let mut classes: Vec<String> = vec![DEFAULT_CLASS.to_string()];
    if let Some(cls_list) = data.classes {
        for c in cls_list {
            if !c.is_empty() && !classes.contains(&c) {
                classes.push(c);
            }
        }
    }
    for cls in &classes {
        class_to_id.insert(cls.clone(), id_to_class.len() as u8);
        id_to_class.push(cls.clone());
    }

    // ── Target counts ─────────────────────────────────────────────────────
    let mut target_counts: HashMap<String, u32> = HashMap::new();
    for req in &target.affixes {
        if !req.affix_id.is_empty() {
            *target_counts.entry(req.affix_id.clone()).or_insert(0) += 1;
        }
    }

    // ── GA required counts (mirrors JS buildEnv logic) ────────────────────
    // For each source GA that is also a target, we require it to be preserved.
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
    }
}
