use crate::env::TranslationEnv;
use crate::types::{AffixEntry, JsAction, JsState};

// ── stateKey ──────────────────────────────────────────────────────────────────
//
// Mirrors JS `stateKey` (d4cubeoptimv3-worker.js:636).
// The JS default for gearSlot is lowercase "any" and for class is "Any".
// This quirk is intentional — we reproduce it exactly so Rust and JS cache
// keys are identical.

pub fn state_key(state: &JsState) -> String {
    let mut tokens: Vec<String> = state.affixes.iter().map(|e| e.sort_token()).collect();
    tokens.sort();

    let gear_slot = state
        .gear_slot
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("any"); // lowercase — mirrors JS `state.gearSlot || "any"`
    let class = state
        .class
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("Any"); // matches JS DEFAULT_CLASS = "Any"

    format!(
        "L{}#S{}#C{}#{}",
        if state.is_legendary { 1 } else { 0 },
        gear_slot,
        class,
        tokens.join(",")
    )
}

// ── actionKey ─────────────────────────────────────────────────────────────────
//
// Mirrors JS `actionKey` (d4cubeoptimv3-worker.js:780).

pub fn action_key(action: &JsAction) -> String {
    let source = action
        .source_index
        .map(|i| i.to_string())
        .unwrap_or_else(|| "_".to_string());
    let target = action.target_affix_id.as_deref().unwrap_or("_");
    let prism = action.prism.as_deref().unwrap_or("_");
    format!("{}|{}|{}|{}", action.action_type, prism, source, target)
}

// ── state_key_u64 ─────────────────────────────────────────────────────────────
//
// Packed 57-bit state representation. Intended for internal Rust use in the
// LAO* graph (Phase 3) — produces a canonical u64 key for the same state.
//
// Bit layout (lsb = bit 0):
//   0      : isLegendary
//   1-4    : gear_slot_id  (4 bits, 12 values)
//   5-8    : class_id      (4 bits,  9 values)
//   9-17   : token_id[0]   (9 bits, ≤512 values)
//   18     : isGA[0]
//   19     : isEnchanted[0]
//   20     : isUnsatisfactory[0]  (unused in stateKey; set in residual state)
//   21-29  : token_id[1]
//   30     : isGA[1]
//   31     : isEnchanted[1]
//   32     : isUnsatisfactory[1]
//   33-41  : token_id[2]
//   42     : isGA[2]
//   43     : isEnchanted[2]
//   44     : isUnsatisfactory[2]
//   45-53  : token_id[3]
//   54     : isGA[3]
//   55     : isEnchanted[3]
//   56     : isUnsatisfactory[3]
//
// Affix slots are sorted by their sort_token() string before packing,
// matching the canonical order used by stateKey().

const AFFIX_BITS: u64 = 12; // 9 token + 1 GA + 1 enchanted + 1 unsatisfactory

pub fn state_key_u64(state: &JsState, env: &TranslationEnv) -> u64 {
    let gear_slot_id = env
        .gear_slot_to_id
        .get(state.gear_slot.as_deref().unwrap_or("Any"))
        .copied()
        .unwrap_or(0) as u64;

    let class_id = env
        .class_to_id
        .get(state.class.as_deref().unwrap_or("Any"))
        .copied()
        .unwrap_or(0) as u64;

    // Sort affixes by their canonical sort token, then pack up to 4 slots.
    let mut sorted_entries: Vec<&AffixEntry> = state.affixes.iter().collect();
    sorted_entries.sort_by(|a, b| a.sort_token().cmp(&b.sort_token()));

    let mut packed_affixes: u64 = 0;
    for (i, entry) in sorted_entries.iter().take(4).enumerate() {
        let token_id = env
            .affix_id_to_token
            .get(&entry.affix_id)
            .copied()
            .unwrap_or(0) as u64;
        let ga = if entry.is_ga { 1u64 } else { 0 };
        let enchanted = if entry.is_enchanted { 1u64 } else { 0 };
        let slot_offset = i as u64 * AFFIX_BITS;
        packed_affixes |= (token_id & 0x1ff) << slot_offset;
        packed_affixes |= ga << (slot_offset + 9);
        packed_affixes |= enchanted << (slot_offset + 10);
        // bit 11 (isUnsatisfactory) left as 0 for plain stateKey
    }

    let legendary = if state.is_legendary { 1u64 } else { 0 };
    legendary | (gear_slot_id << 1) | (class_id << 5) | (packed_affixes << 9)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AffixEntry;

    fn make_state(
        legendary: bool,
        gear_slot: &str,
        class: &str,
        affixes: &[(&str, bool, bool)],
    ) -> JsState {
        JsState {
            is_legendary: legendary,
            gear_slot: Some(gear_slot.to_string()),
            class: Some(class.to_string()),
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
    fn state_key_empty_affixes() {
        let s = make_state(false, "Any", "Any", &[]);
        assert_eq!(state_key(&s), "L0#SAny#CAny#");
    }

    #[test]
    fn state_key_sorted() {
        // Affixes given in reverse alphabetical order — should be sorted in output.
        let s = make_state(
            false,
            "Amulet",
            "Barbarian",
            &[
                ("maximum-life", false, false),
                ("attack-speed", false, false),
            ],
        );
        let k = state_key(&s);
        // attack-speed sorts before maximum-life
        assert!(k.contains("attack-speed|0|0,maximum-life|0|0"), "got: {}", k);
    }

    #[test]
    fn action_key_basic() {
        let a = JsAction {
            action_type: "enchant".to_string(),
            prism: Some("Aggressive".to_string()),
            source_index: Some(1),
            target_affix_id: Some("critical-strike-chance".to_string()),
        };
        assert_eq!(action_key(&a), "enchant|Aggressive|1|critical-strike-chance");
    }

    #[test]
    fn action_key_defaults() {
        let a = JsAction {
            action_type: "add".to_string(),
            prism: None,
            source_index: None,
            target_affix_id: None,
        };
        assert_eq!(action_key(&a), "add|_|_|_");
    }
}
