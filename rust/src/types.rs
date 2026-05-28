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
    /// The canonical sort token, matching JS: `${affixId}|${isGA?1:0}|${isEnchanted?1:0}`
    pub fn sort_token(&self) -> String {
        format!(
            "{}|{}|{}",
            self.affix_id,
            if self.is_ga { 1 } else { 0 },
            if self.is_enchanted { 1 } else { 0 }
        )
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct JsState {
    #[serde(rename = "isLegendary", default)]
    pub is_legendary: bool,
    #[serde(rename = "gearSlot")]
    pub gear_slot: Option<String>,
    #[serde(rename = "class")]
    pub class: Option<String>,
    #[serde(default)]
    pub affixes: Vec<AffixEntry>,
    /// Present in residual/v2 states only.
    #[serde(rename = "unsatisfactoryAffixIds", default)]
    pub unsatisfactory_affix_ids: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct TargetAffixEntry {
    #[serde(rename = "affixId")]
    pub affix_id: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct JsTarget {
    #[serde(default)]
    pub affixes: Vec<TargetAffixEntry>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct JsGaConfig {
    #[serde(rename = "currentGAAffixes", default)]
    pub current_ga_affixes: Vec<Option<String>>,
}

impl Default for JsGaConfig {
    fn default() -> Self {
        JsGaConfig { current_ga_affixes: vec![] }
    }
}

#[derive(Deserialize, Clone, Debug)]
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
}

#[derive(Deserialize, Clone, Debug)]
pub struct JsEnvData {
    #[serde(default)]
    pub affixes: Vec<AffixData>,
    #[serde(default)]
    pub categories: HashMap<String, Vec<String>>,
    #[serde(rename = "gearSlots", default)]
    pub gear_slots: Option<Vec<String>>,
    #[serde(default)]
    pub classes: Option<Vec<String>>,
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
