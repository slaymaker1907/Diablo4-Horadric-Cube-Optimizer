use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize, Clone, Debug)]
pub struct AffixEntry {
    #[serde(rename = "affixId")]
    pub affix_id: String,
    #[serde(rename = "isGA", default)]
    pub is_ga: bool,
    #[serde(rename = "isEnchanted", default)]
    pub is_enchanted: bool,
}

impl AffixEntry {
    pub fn sort_token(&self) -> String {
        format!(
            "{}|{}|{}",
            self.affix_id,
            if self.is_ga { 1 } else { 0 },
            if self.is_enchanted { 1 } else { 0 }
        )
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct JsState {
    #[serde(rename = "isLegendary", default)]
    pub is_legendary: bool,
    #[serde(rename = "gearSlot")]
    pub gear_slot: Option<String>,
    #[serde(rename = "class")]
    pub class: Option<String>,
    #[serde(default)]
    pub affixes: Vec<AffixEntry>,
    #[serde(rename = "unsatisfactoryAffixIds", default)]
    pub unsatisfactory_affix_ids: Vec<String>,
    /// Optional per-state max slots override.
    #[serde(rename = "maxAffixSlots", default)]
    pub max_affix_slots: Option<u32>,
}

/// Used in target.affixes — extended to carry needsImprovement (Phase 2).
#[derive(Deserialize, Clone, Debug, Default)]
pub struct TargetAffixEntry {
    #[serde(rename = "affixId")]
    pub affix_id: String,
    #[serde(rename = "needsImprovement", default)]
    pub needs_improvement: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct JsTarget {
    #[serde(default)]
    pub affixes: Vec<TargetAffixEntry>,
    #[serde(rename = "forbiddenAffixIds", default)]
    pub forbidden_affix_ids: Vec<String>,
    #[serde(rename = "protectedAffixIds", default)]
    pub protected_affix_ids: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct JsGaConfig {
    #[serde(rename = "currentGAAffixes", default)]
    pub current_ga_affixes: Vec<Option<String>>,
    #[serde(rename = "strictMode", default)]
    pub strict_mode: bool,
    #[serde(rename = "rulesEnabled")]
    pub rules_enabled: Option<bool>,
    #[serde(rename = "forbiddenAffixIds", default)]
    pub forbidden_affix_ids: Vec<String>,
    #[serde(rename = "protectedAffixIds", default)]
    pub protected_affix_ids: Vec<String>,
    #[serde(rename = "unsatisfactoryAffixIds", default)]
    pub unsatisfactory_affix_ids: Vec<String>,
    #[serde(rename = "disableEnchanting", default)]
    pub disable_enchanting: bool,
}

impl Default for JsGaConfig {
    fn default() -> Self {
        JsGaConfig {
            current_ga_affixes: vec![],
            strict_mode: false,
            rules_enabled: None,
            forbidden_affix_ids: vec![],
            protected_affix_ids: vec![],
            unsatisfactory_affix_ids: vec![],
            disable_enchanting: false,
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct AffixData {
    pub id: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(rename = "rollWeight", default)]
    pub roll_weight: f64,
    #[serde(rename = "familyRollWeight", default)]
    pub family_roll_weight: f64,
    #[serde(rename = "class", default)]
    pub class: Option<String>,
    #[serde(rename = "gearSlots", default)]
    pub gear_slots: Option<Vec<String>>,
    /// Per-operation-type category overrides. When present, `operationCategories["add"]`
    /// is used instead of `categories` for add-type operations, etc.
    #[serde(rename = "operationCategories", default)]
    pub operation_categories: Option<HashMap<String, Vec<String>>>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct JsEnvData {
    #[serde(default)]
    pub affixes: Vec<AffixData>,
    #[serde(default)]
    pub categories: HashMap<String, Vec<String>>,
    #[serde(rename = "gearSlots", default)]
    pub gear_slots: Option<Vec<String>>,
    #[serde(default)]
    pub classes: Option<Vec<String>>,
    #[serde(rename = "maxAffixSlots", default)]
    pub max_affix_slots: Option<u32>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct JsAction {
    #[serde(rename = "type")]
    pub action_type: String,
    #[serde(default)]
    pub prism: Option<String>,
    #[serde(rename = "sourceIndex", default)]
    pub source_index: Option<i32>,
    #[serde(rename = "targetAffixId", default)]
    pub target_affix_id: Option<String>,
}

#[derive(Serialize)]
pub struct TerminalResult {
    pub terminal: bool,
    pub success: bool,
}

// ── Phase 2 types ─────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct FeasibilityResult {
    pub ok: bool,
    pub check: Option<String>,
    pub message: String,
    pub details: serde_json::Value,
}

/// One closed-form candidate for a (targetEntry, slotIndex) pair.
/// Shape mirrors JS `createClosedFormCandidateV3`.
#[derive(Serialize, Clone, Debug)]
pub struct ClosedFormCandidate {
    pub ok: bool,
    #[serde(rename = "caseId")]
    pub case_id: String,
    #[serde(rename = "slotIndex")]
    pub slot_index: usize,
    #[serde(rename = "targetAffixId")]
    pub target_affix_id: String,
    #[serde(rename = "expectedSteps")]
    pub expected_steps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prism: Option<String>,
    #[serde(rename = "removePrism", skip_serializing_if = "Option::is_none")]
    pub remove_prism: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denominator: Option<f64>,
    #[serde(rename = "useEnchantFollowUp", default)]
    pub use_enchant_follow_up: bool,
    #[serde(rename = "looseEstimate", default)]
    pub loose_estimate: bool,
    #[serde(rename = "actionType", skip_serializing_if = "Option::is_none")]
    pub action_type: Option<String>,
    #[serde(rename = "sourceIndex", skip_serializing_if = "Option::is_none")]
    pub source_index: Option<usize>,
}

/// One option in a decomposition plan (one (target, slot, case) combination).
#[derive(Serialize, Clone, Debug)]
pub struct DecompositionOption {
    pub id: String,
    pub key: String,
    #[serde(rename = "targetIndex")]
    pub target_index: usize,
    #[serde(rename = "targetAffixId")]
    pub target_affix_id: String,
    #[serde(rename = "slotIndex")]
    pub slot_index: usize,
    #[serde(rename = "caseId")]
    pub case_id: String,
    pub prism: String,
    #[serde(rename = "removePrism")]
    pub remove_prism: String,
    #[serde(rename = "prismDelta")]
    pub prism_delta: i32,
    #[serde(rename = "usesEnchant")]
    pub uses_enchant: bool,
    #[serde(rename = "costKind")]
    pub cost_kind: String,
    #[serde(rename = "constantCost")]
    pub constant_cost: f64,
    #[serde(rename = "baseDenominator")]
    pub base_denominator: Option<f64>,
    #[serde(rename = "requiresStage")]
    pub requires_stage: bool,
    #[serde(rename = "sourceIndex")]
    pub source_index: usize,
    #[serde(rename = "useEnchantFollowUp")]
    pub use_enchant_follow_up: bool,
    #[serde(rename = "looseEstimate")]
    pub loose_estimate: bool,
    pub action: Option<serde_json::Value>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ResidualSlotInfo {
    #[serde(rename = "slotIndex")]
    pub slot_index: usize,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ResidualTargetInfo {
    #[serde(rename = "targetIndex")]
    pub target_index: usize,
    #[serde(rename = "targetAffixId")]
    pub target_affix_id: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct TargetRow {
    #[serde(rename = "targetIndex")]
    pub target_index: usize,
    #[serde(rename = "targetAffixId")]
    pub target_affix_id: String,
    pub options: Vec<DecompositionOption>,
    #[serde(rename = "residualSlots")]
    pub residual_slots: Vec<ResidualSlotInfo>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DecompositionPlanInput {
    pub ok: bool,
    pub reason: String,
    /// Env handle used for this decomposition. Not serialized (Rust-internal).
    #[serde(skip)]
    pub _env_handle: u32,
    pub feasibility: FeasibilityResult,
    #[serde(rename = "maxAffixSlots")]
    pub max_affix_slots: usize,
    pub targets: Vec<TargetRow>,
    pub options: Vec<DecompositionOption>,
    #[serde(rename = "residualTargets")]
    pub residual_targets: Vec<ResidualTargetInfo>,
}

/// Full optimizer payload. Used by optimize_payload WASM export.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct OptimizePayload {
    pub state: JsState,
    pub target: JsTarget,
    #[serde(default)]
    pub data: JsEnvData,
    #[serde(rename = "gaConfig", default)]
    pub ga_config: JsGaConfig,
    #[serde(rename = "timeMs", default)]
    pub time_ms: Option<f64>,
    #[serde(rename = "tightenStepsLevel", default)]
    pub tighten_steps_level: Option<String>,
    #[serde(rename = "tightenStepsOverrides", default)]
    pub tighten_steps_overrides: Option<serde_json::Value>,
    #[serde(rename = "includeRolloutData", default)]
    pub include_rollout_data: bool,
}

/// Options passed to get_closed_form_plan_candidates.
#[derive(Deserialize, Default, Clone, Debug)]
pub struct ClosedFormOptions {
    #[serde(rename = "maxAffixSlots", default)]
    pub max_affix_slots: Option<u32>,
    #[serde(rename = "allowDiscretionaryEnchant", default)]
    pub allow_discretionary_enchant: bool,
    #[serde(rename = "touchOnlyImprovement", default)]
    pub touch_only_improvement: bool,
    /// Pre-computed protected IDs from feasibility, used in isDiscretionaryEnchantSlotV3.
    #[serde(rename = "protectedAffixIds", default)]
    pub protected_affix_ids: Vec<String>,
    /// The full target spec (for isCaseAStuckRecoveryRiskV3 and discretionary enchant check).
    pub target: Option<JsTarget>,
    /// The GA config (for discretionary enchant check).
    #[serde(rename = "gaConfig", default)]
    pub ga_config: Option<JsGaConfig>,
}
