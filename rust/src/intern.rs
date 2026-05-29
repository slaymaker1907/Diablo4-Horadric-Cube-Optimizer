// intern.rs
// Zero-heap integer representations of game states and actions for the hot-path
// optimization loop. All operations on these types are allocation-free.

use std::collections::HashSet;

use crate::env::TranslationEnv;
use crate::types::{AffixEntry, JsAction, JsState};

// ── Types ─────────────────────────────────────────────────────────────────────

/// A single affix slot packed as three integers — no heap allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct InternedAffix {
    /// Unified token id (0 = empty slot).
    pub token: u16,
    pub is_ga: bool,
    pub is_enchanted: bool,
}

impl InternedAffix {
    #[inline]
    pub fn is_empty(self) -> bool {
        self.token == 0
    }

    /// Sort key that matches the lexicographic order of `sort_token()` strings
    /// when token IDs are assigned in lexicographic order of affix IDs.
    #[inline]
    pub fn sort_key(self) -> u32 {
        ((self.token as u32) << 2) | ((self.is_ga as u32) << 1) | (self.is_enchanted as u32)
    }
}

/// A game state without any heap allocation (stack-only, `Copy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InternedState {
    pub is_legendary: bool,
    pub gear_slot_id: u8,
    pub class_id: u8,
    pub affixes: [InternedAffix; 4],
    pub affix_count: u8,
    /// Sorted token IDs of unsatisfactory affixes (0-padded).
    pub unsatisfactory: [u16; 4],
    pub unsat_count: u8,
}

impl Default for InternedState {
    fn default() -> Self {
        Self {
            is_legendary: false,
            gear_slot_id: 0,
            class_id: 0,
            affixes: [InternedAffix::default(); 4],
            affix_count: 0,
            unsatisfactory: [0u16; 4],
            unsat_count: 0,
        }
    }
}

impl InternedState {
    #[inline]
    pub fn live_affixes(&self) -> &[InternedAffix] {
        &self.affixes[..self.affix_count as usize]
    }

    #[inline]
    pub fn live_unsat(&self) -> &[u16] {
        &self.unsatisfactory[..self.unsat_count as usize]
    }

    /// Count how many times `token` appears in the unsatisfactory list.
    #[inline]
    pub fn unsat_count_for(&self, token: u16) -> u32 {
        self.live_unsat().iter().filter(|&&t| t == token).count() as u32
    }

    /// Count how many times `token` appears in the affix slots.
    #[inline]
    pub fn affix_token_count(&self, token: u16) -> u32 {
        self.live_affixes().iter().filter(|a| a.token == token).count() as u32
    }
}

// Action type constants — sorted alphabetically so the IDs maintain lex order.
pub const ACTION_TYPE_ADD: u8 = 0;
pub const ACTION_TYPE_CHAOTIC: u8 = 1;
pub const ACTION_TYPE_ENCHANT: u8 = 2;
pub const ACTION_TYPE_FOCUSED: u8 = 3;
pub const ACTION_TYPE_REMOVE: u8 = 4;

/// A game action without any heap allocation (stack-only, `Copy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InternedAction {
    /// 0=add, 1=chaotic, 2=enchant, 3=focused, 4=remove
    pub action_type_id: u8,
    /// Category ID. `env.prism_none_id` = no prism / None.
    pub prism_id: u16,
    /// Source affix slot index. -1 = None.
    pub source_index: i8,
    /// Target affix token. `env.affix_none_token` = None.
    pub target_token: u16,
}

impl InternedAction {
    pub fn action_type_str(self) -> &'static str {
        match self.action_type_id {
            ACTION_TYPE_ADD => "add",
            ACTION_TYPE_CHAOTIC => "chaotic",
            ACTION_TYPE_ENCHANT => "enchant",
            ACTION_TYPE_FOCUSED => "focused",
            ACTION_TYPE_REMOVE => "remove",
            _ => "unknown",
        }
    }

    #[inline]
    pub fn is_cube_action(self) -> bool {
        matches!(
            self.action_type_id,
            ACTION_TYPE_ADD | ACTION_TYPE_REMOVE | ACTION_TYPE_CHAOTIC | ACTION_TYPE_FOCUSED
        )
    }
}

// ── Conversion: JsState ↔ InternedState ──────────────────────────────────────

pub fn intern_state(state: &JsState, env: &TranslationEnv) -> InternedState {
    let gear_slot_id = env
        .gear_slot_to_id
        .get(state.gear_slot.as_deref().unwrap_or("Any"))
        .copied()
        .unwrap_or(0);
    let class_id = env
        .class_to_id
        .get(state.class.as_deref().unwrap_or("Any"))
        .copied()
        .unwrap_or(0);

    let mut affixes = [InternedAffix::default(); 4];
    let affix_count = state.affixes.len().min(4);
    for (i, e) in state.affixes.iter().take(4).enumerate() {
        affixes[i] = InternedAffix {
            token: env
                .affix_id_to_token
                .get(&e.affix_id)
                .copied()
                .unwrap_or(0),
            is_ga: e.is_ga,
            is_enchanted: e.is_enchanted,
        };
    }

    let mut unsat_arr = [0u16; 4];
    let mut unsat_count = 0usize;
    for id in &state.unsatisfactory_affix_ids {
        if unsat_count >= 4 {
            break;
        }
        if let Some(&tok) = env.affix_id_to_token.get(id.as_str()) {
            if tok != 0 {
                unsat_arr[unsat_count] = tok;
                unsat_count += 1;
            }
        }
    }
    unsat_arr[..unsat_count].sort_unstable();

    InternedState {
        is_legendary: state.is_legendary,
        gear_slot_id,
        class_id,
        affixes,
        affix_count: affix_count as u8,
        unsatisfactory: unsat_arr,
        unsat_count: unsat_count as u8,
    }
}

pub fn unintern_state(state: &InternedState, env: &TranslationEnv) -> JsState {
    let gear_slot = env
        .id_to_gear_slot
        .get(state.gear_slot_id as usize)
        .cloned()
        .unwrap_or_else(|| "Any".to_string());
    let class = env
        .id_to_class
        .get(state.class_id as usize)
        .cloned()
        .unwrap_or_else(|| "Any".to_string());

    let affixes = state
        .live_affixes()
        .iter()
        .map(|a| AffixEntry {
            affix_id: env
                .token_to_affix_id
                .get(a.token as usize)
                .cloned()
                .unwrap_or_default(),
            is_ga: a.is_ga,
            is_enchanted: a.is_enchanted,
        })
        .collect();

    let unsatisfactory_affix_ids = state
        .live_unsat()
        .iter()
        .map(|&tok| {
            env.token_to_affix_id
                .get(tok as usize)
                .cloned()
                .unwrap_or_default()
        })
        .collect();

    JsState {
        is_legendary: state.is_legendary,
        gear_slot: Some(gear_slot),
        class: Some(class),
        affixes,
        unsatisfactory_affix_ids,
        max_affix_slots: None,
    }
}

// ── Conversion: JsAction ↔ InternedAction ────────────────────────────────────

pub fn intern_action(action: &JsAction, env: &TranslationEnv) -> InternedAction {
    let action_type_id = match action.action_type.as_str() {
        "add" => ACTION_TYPE_ADD,
        "chaotic" => ACTION_TYPE_CHAOTIC,
        "enchant" => ACTION_TYPE_ENCHANT,
        "focused" => ACTION_TYPE_FOCUSED,
        "remove" => ACTION_TYPE_REMOVE,
        _ => 0,
    };
    let prism_id = action
        .prism
        .as_deref()
        .and_then(|p| env.category_to_id.get(p))
        .copied()
        .unwrap_or(env.prism_none_id);
    let source_index = action.source_index.map(|i| i as i8).unwrap_or(-1);
    let target_token = action
        .target_affix_id
        .as_deref()
        .and_then(|t| env.affix_id_to_token.get(t))
        .copied()
        .unwrap_or(env.affix_none_token);

    InternedAction {
        action_type_id,
        prism_id,
        source_index,
        target_token,
    }
}

pub fn unintern_action(action: &InternedAction, env: &TranslationEnv) -> JsAction {
    let prism = if action.prism_id == env.prism_none_id {
        None
    } else {
        env.id_to_category.get(action.prism_id as usize).cloned()
    };
    let source_index = if action.source_index < 0 {
        None
    } else {
        Some(action.source_index as i32)
    };
    let target_affix_id = if action.target_token == env.affix_none_token
        || action.target_token == 0
    {
        None
    } else {
        env.token_to_affix_id
            .get(action.target_token as usize)
            .cloned()
    };

    JsAction {
        action_type: action.action_type_str().to_string(),
        prism,
        source_index,
        target_affix_id,
    }
}

pub fn interned_action_to_json(action: &InternedAction, env: &TranslationEnv) -> serde_json::Value {
    use serde_json::json;
    let mut obj = json!({ "type": action.action_type_str() });
    if action.prism_id != env.prism_none_id {
        if let Some(name) = env.id_to_category.get(action.prism_id as usize) {
            obj["prism"] = json!(name);
        }
    }
    if action.source_index >= 0 {
        obj["sourceIndex"] = json!(action.source_index as i32);
    }
    if action.target_token != env.affix_none_token && action.target_token != 0 {
        if let Some(id) = env.token_to_affix_id.get(action.target_token as usize) {
            obj["targetAffixId"] = json!(id);
        }
    }
    obj
}

// ── Integer key functions ─────────────────────────────────────────────────────
//
// Bit layout per affix slot (12 bits total):
//   bits 0-9   : token (10 bits, max 1023)
//   bit  10    : is_ga
//   bit  11    : is_enchanted
//
// State key (u64) layout:
//   bit  0     : is_legendary
//   bits 1-4   : gear_slot_id (4 bits)
//   bits 5-8   : class_id (4 bits)
//   bits 9-56  : 4 affix slots × 12 bits = 48 bits
//   Total: 57 bits

const SLOT_BITS: u32 = 12;

#[inline]
fn pack_slot(token: u16, is_ga: bool, is_enc: bool, i: usize) -> u64 {
    let off = 9 + i as u64 * SLOT_BITS as u64;
    ((token as u64 & 0x3FF) << off)
        | ((is_ga as u64) << (off + 10))
        | ((is_enc as u64) << (off + 11))
}

/// v1 state key (no unsatisfactory): uses real tokens sorted by sort_key().
pub fn istate_key_v1(state: &InternedState) -> u64 {
    let n = state.affix_count as usize;
    let mut slots = state.affixes;
    slots[..n].sort_unstable_by_key(|a| a.sort_key());

    let mut key = (state.is_legendary as u64)
        | ((state.gear_slot_id as u64) << 1)
        | ((state.class_id as u64) << 5);
    for (i, a) in slots[..n].iter().enumerate() {
        key |= pack_slot(a.token, a.is_ga, a.is_enchanted, i);
    }
    key
}

/// Compute the effective token for `state_key_v2` / symmetric-trash collapsing.
/// Non-GA, non-enchanted, non-target, non-unsat affixes collapse to their trash token.
#[inline]
pub fn effective_v2_token(a: &InternedAffix, state: &InternedState, env: &TranslationEnv) -> u16 {
    if a.is_ga || a.is_enchanted {
        return a.token;
    }
    if env
        .token_target_count
        .get(a.token as usize)
        .copied()
        .unwrap_or(0)
        > 0
    {
        return a.token;
    }
    if state.unsat_count_for(a.token) > 0 {
        return a.token;
    }
    env.token_to_trash_token
        .get(a.token as usize)
        .copied()
        .unwrap_or(a.token)
}

/// Compute the effective token for `residual_state_key_v3`.
/// Affixes not in the relevant set collapse to their trash token.
#[inline]
pub fn effective_residual_token(
    token: u16,
    relevant: &HashSet<u16>,
    env: &TranslationEnv,
) -> u16 {
    if relevant.contains(&token) {
        token
    } else {
        env.token_to_trash_token
            .get(token as usize)
            .copied()
            .unwrap_or(token)
    }
}

/// v2 state key (with symmetric-trash + unsatisfactory).
/// Low 64 bits: affix content using effective v2 tokens.
/// High 64 bits: unsatisfactory token list (4 × 16 bits).
pub fn istate_key_v2(state: &InternedState, env: &TranslationEnv) -> u128 {
    let n = state.affix_count as usize;

    // Sort by (effective_token << 2 | is_ga << 1 | is_enc).
    let mut sorted: [(u32, u16, bool, bool); 4] = Default::default();
    for (i, a) in state.affixes[..n].iter().enumerate() {
        let eff = effective_v2_token(a, state, env);
        sorted[i] = (
            ((eff as u32) << 2) | ((a.is_ga as u32) << 1) | (a.is_enchanted as u32),
            eff,
            a.is_ga,
            a.is_enchanted,
        );
    }
    sorted[..n].sort_unstable_by_key(|s| s.0);

    let mut low = (state.is_legendary as u64)
        | ((state.gear_slot_id as u64) << 1)
        | ((state.class_id as u64) << 5);
    for (i, &(_, eff, is_ga, is_enc)) in sorted[..n].iter().enumerate() {
        low |= pack_slot(eff, is_ga, is_enc, i);
    }

    // Pack unsatisfactory tokens into high 64 bits (16 bits each, 4 slots).
    let mut high: u64 = 0;
    for (i, &tok) in state.live_unsat().iter().enumerate() {
        high |= (tok as u64) << (i * 16);
    }

    ((high as u128) << 64) | (low as u128)
}

/// v3 residual key: like v2 but uses residual tokens (trash for non-relevant affixes).
pub fn iresidual_key_v3(
    state: &InternedState,
    relevant: &HashSet<u16>,
    env: &TranslationEnv,
) -> u128 {
    let n = state.affix_count as usize;

    let mut sorted: [(u32, u16, bool, bool); 4] = Default::default();
    let mut count = 0usize;
    for a in state.affixes[..n].iter() {
        if a.token == 0 {
            continue;
        }
        let eff = effective_residual_token(a.token, relevant, env);
        sorted[count] = (
            ((eff as u32) << 2) | ((a.is_ga as u32) << 1) | (a.is_enchanted as u32),
            eff,
            a.is_ga,
            a.is_enchanted,
        );
        count += 1;
    }
    sorted[..count].sort_unstable_by_key(|s| s.0);

    let mut low = (state.is_legendary as u64)
        | ((state.gear_slot_id as u64) << 1)
        | ((state.class_id as u64) << 5);
    for (i, &(_, eff, is_ga, is_enc)) in sorted[..count].iter().enumerate() {
        low |= pack_slot(eff, is_ga, is_enc, i);
    }

    let mut high: u64 = 0;
    for (i, &tok) in state.live_unsat().iter().enumerate() {
        high |= (tok as u64) << (i * 16);
    }

    ((high as u128) << 64) | (low as u128)
}

/// Action sort key that maintains the SAME lexicographic ordering as `action_key()` strings,
/// provided category and affix token IDs are assigned in lexicographic order of the
/// underlying strings (guaranteed by `build_env`).
///
/// Bit layout (most-significant first for correct comparison):
///   bits 63-56 : action_type_id (8 bits)
///   bits 55-40 : prism_id       (16 bits; prism_none_id at lex position of "_")
///   bits 39-32 : source encoded (8 bits; None → 4 which is > "3" in ASCII, same as "_" > "3")
///   bits 31-16 : target_token   (16 bits; affix_none_token at lex position of "_")
///   bits 15-0  : unused
pub fn action_sort_key(action: &InternedAction, _env: &TranslationEnv) -> u64 {
    let src = if action.source_index < 0 {
        4u8
    } else {
        action.source_index as u8
    };
    ((action.action_type_id as u64) << 56)
        | ((action.prism_id as u64) << 40)
        | ((src as u64) << 32)
        | ((action.target_token as u64) << 16)
}
