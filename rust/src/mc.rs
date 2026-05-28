use std::collections::HashMap;

use serde_json::{json, Value};

use crate::env::TranslationEnv;
use crate::feasibility::analyze_feasibility;
use crate::optimizer::{get_residual_env_overrides, optimize_payload_v3, SolveIlpFn};
use crate::residual::{
    action_to_json, attach_unsatisfactory_to_state, build_residual_reachable_graph_v3,
    extract_residual_policy_indices, get_action_outcomes, get_residual_affix_token_v3,
    get_residual_relevant_affix_ids_v3, has_duplicate_affix_ids_v2, normalize_outcome_state_v2,
    residual_state_key_v3, solve_residual_lao_phase1_v3, solve_residual_lao_phase2_v3,
    BuildGraphOptions, ResidualContext, RESIDUAL_EPSILON, RESIDUAL_PHASE2_EPSILON,
};
use crate::terminal::is_terminal;
use crate::types::{AffixEntry, JsAction, JsState, OptimizePayload};
use crate::keys::state_key as compute_state_key;

const MC_LIGHT_ROLLOUTS: usize = 100;
const MC_HEAVY_ROLLOUTS: usize = 500;
const MC_ADAPTIVE_MAX_ROLLOUTS: usize = 2000;
const MC_ADAPTIVE_WALL_BUDGET_MS: u64 = 120_000;
const MC_ADAPTIVE_CHECK_EVERY: usize = 50;
const MC_ADAPTIVE_TARGET_REL_HALF_WIDTH: f64 = 0.1;
const MC_ROLLOUT_STEP_CAP: usize = 1000;
const MC_PROGRESS_EVERY: usize = 20;

// ── Budget ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct MCBudget {
    pub level: String,
    pub target_rollouts: usize,
    pub max_rollouts: usize,
    pub wall_budget_ms: Option<u64>,
    pub adaptive: bool,
}

pub fn resolve_mc_budget(payload: &OptimizePayload) -> Option<MCBudget> {
    let level = payload.tighten_steps_level.as_deref()?;
    let overrides = payload.tighten_steps_overrides.as_ref();

    fn get_override(overrides: Option<&Value>, key: &str) -> Option<usize> {
        overrides?.get(key)?.as_u64().map(|v| v as usize)
    }

    match level {
        "light" => {
            let target = get_override(overrides, "lightRollouts").unwrap_or(MC_LIGHT_ROLLOUTS);
            Some(MCBudget {
                level: "light".to_string(),
                target_rollouts: target,
                max_rollouts: target,
                wall_budget_ms: None,
                adaptive: false,
            })
        }
        "heavy" => {
            let target = get_override(overrides, "heavyRollouts").unwrap_or(MC_HEAVY_ROLLOUTS);
            Some(MCBudget {
                level: "heavy".to_string(),
                target_rollouts: target,
                max_rollouts: target,
                wall_budget_ms: None,
                adaptive: false,
            })
        }
        "adaptive" => {
            let max_r = get_override(overrides, "adaptiveMaxRollouts")
                .unwrap_or(MC_ADAPTIVE_MAX_ROLLOUTS);
            let wall = overrides
                .and_then(|v| v.get("adaptiveWallBudgetMs"))
                .and_then(|v| v.as_u64())
                .unwrap_or(MC_ADAPTIVE_WALL_BUDGET_MS);
            Some(MCBudget {
                level: "adaptive".to_string(),
                target_rollouts: max_r,
                max_rollouts: max_r,
                wall_budget_ms: Some(wall),
                adaptive: true,
            })
        }
        _ => None,
    }
}

// ── Statistics ────────────────────────────────────────────────────────────────

pub struct MCStats {
    pub mean: f64,
    pub stdev: f64,
    pub ci95_half_width: f64,
}

pub fn compute_mc_stats(step_counts: &[usize]) -> MCStats {
    let n = step_counts.len();
    if n == 0 {
        return MCStats {
            mean: f64::NAN,
            stdev: f64::NAN,
            ci95_half_width: f64::NAN,
        };
    }
    let sum: f64 = step_counts.iter().map(|&x| x as f64).sum();
    let mean = sum / n as f64;
    if n == 1 {
        return MCStats {
            mean,
            stdev: 0.0,
            ci95_half_width: 0.0,
        };
    }
    let sq_sum: f64 = step_counts
        .iter()
        .map(|&x| {
            let d = x as f64 - mean;
            d * d
        })
        .sum();
    let stdev = (sq_sum / (n - 1) as f64).sqrt();
    let ci = 1.96 * stdev / (n as f64).sqrt();
    MCStats {
        mean,
        stdev,
        ci95_half_width: ci,
    }
}

// ── Weighted outcome sampling ─────────────────────────────────────────────────

pub fn pick_weighted_outcome<'a, T>(
    outcomes: &'a [T],
    probability_of: impl Fn(&T) -> f64,
) -> &'a T {
    let r = pseudo_random_f64();
    let mut acc = 0.0_f64;
    for o in outcomes.iter() {
        acc += probability_of(o);
        if r <= acc {
            return o;
        }
    }
    outcomes.last().unwrap()
}

/// Simple LCG pseudo-random for WASM (no std::time in no_std; uses a thread_local).
fn pseudo_random_f64() -> f64 {
    use std::cell::Cell;
    thread_local! {
        static STATE: Cell<u64> = Cell::new(6364136223846793005);
    }
    STATE.with(|s| {
        let v = s.get().wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        s.set(v);
        // Map to [0, 1)
        (v >> 11) as f64 / (1u64 << 53) as f64
    })
}

// ── MC outcome filtering ──────────────────────────────────────────────────────

fn state_has_duplicate_affixes(state: &JsState) -> bool {
    has_duplicate_affix_ids_v2(state)
}

pub fn filter_valid_mc_outcomes<'a>(
    outcomes: &'a [crate::residual::Outcome],
) -> Vec<(f64, &'a JsState)> {
    let valid: Vec<_> = outcomes
        .iter()
        .filter(|o| !state_has_duplicate_affixes(&o.state))
        .collect();
    if valid.is_empty() {
        return vec![];
    }
    let total: f64 = valid.iter().map(|o| o.probability).sum();
    if total <= 0.0 {
        return vec![];
    }
    valid
        .iter()
        .map(|o| (o.probability / total, &o.state))
        .collect()
}

// ── Family-other expansion ────────────────────────────────────────────────────

pub fn expand_family_other_in_state(
    state: JsState,
    env: &TranslationEnv,
    target: &crate::types::JsTarget,
) -> JsState {
    use std::collections::HashSet;

    if env.family_other_id.is_empty() {
        return state;
    }

    let other_ids: HashSet<&str> = env.family_other_id.values().map(|s| s.as_str()).collect();
    if other_ids.is_empty() {
        return state;
    }

    let target_ids: HashSet<&str> = target
        .affixes
        .iter()
        .filter(|e| !e.affix_id.is_empty())
        .map(|e| e.affix_id.as_str())
        .collect();

    let present_ids: HashSet<&str> = state.affixes.iter().map(|a| a.affix_id.as_str()).collect();

    let mut replaced = false;
    let mut new_affixes: Vec<AffixEntry> = state.affixes.clone();
    let mut updated_present: HashSet<String> = present_ids.iter().map(|s| s.to_string()).collect();

    for (i, entry) in state.affixes.iter().enumerate() {
        if !other_ids.contains(entry.affix_id.as_str()) {
            continue;
        }
        // Find the family for this "other" placeholder
        let family = env
            .affix_map
            .get(&entry.affix_id)
            .and_then(|a| a.family.as_deref())
            .unwrap_or("");
        if family.is_empty() {
            // Try prefix-based family inference
            let inferred = if entry.affix_id.starts_with("elemental-damage-") {
                "elemental-damage"
            } else if entry.affix_id.starts_with("specific-resistance-") {
                "specific-resistance"
            } else {
                ""
            };
            if inferred.is_empty() {
                continue;
            }
            // Find candidates
            let candidates: Vec<&str> = env
                .affix_map
                .values()
                .filter(|a| {
                    a.family.as_deref() == Some(inferred)
                        && !other_ids.contains(a.id.as_str())
                        && !target_ids.contains(a.id.as_str())
                        && !updated_present.contains(&a.id)
                })
                .map(|a| a.id.as_str())
                .collect();
            if candidates.is_empty() {
                continue;
            }
            let pick_idx =
                (pseudo_random_f64() * candidates.len() as f64) as usize % candidates.len();
            let pick_id = candidates[pick_idx].to_string();
            updated_present.remove(&entry.affix_id);
            updated_present.insert(pick_id.clone());
            new_affixes[i] = AffixEntry {
                affix_id: pick_id,
                is_ga: entry.is_ga,
                is_enchanted: entry.is_enchanted,
            };
            replaced = true;
        } else {
            let candidates: Vec<&str> = env
                .affix_map
                .values()
                .filter(|a| {
                    a.family.as_deref() == Some(family)
                        && !other_ids.contains(a.id.as_str())
                        && !target_ids.contains(a.id.as_str())
                        && !updated_present.contains(&a.id)
                })
                .map(|a| a.id.as_str())
                .collect();
            if candidates.is_empty() {
                continue;
            }
            let pick_idx =
                (pseudo_random_f64() * candidates.len() as f64) as usize % candidates.len();
            let pick_id = candidates[pick_idx].to_string();
            updated_present.remove(&entry.affix_id);
            updated_present.insert(pick_id.clone());
            new_affixes[i] = AffixEntry {
                affix_id: pick_id,
                is_ga: entry.is_ga,
                is_enchanted: entry.is_enchanted,
            };
            replaced = true;
        }
    }

    if !replaced {
        return state;
    }
    JsState {
        affixes: new_affixes,
        ..state
    }
}

// ── Policy table (Option 2: memoized residual policy for MC fast-path) ────────
//
// At the start of MC, we build the residual graph from the root state and run
// LAO* on it. From the solution we extract a `state_key → best_action` table.
// During rollouts, before falling back to a full `optimize_payload_v3` sub-call,
// we consult the table: if the rollout's current state abstracts to a node in
// the graph, we get the policy action in O(1).
//
// Two wrinkles:
//   (1) The policy key is the residual **abstract** state key (which collapses
//       irrelevant affixes to family signatures), not the raw `state_key`.
//       Multiple concrete states can map to the same abstract key — that's the
//       whole point of the abstraction.
//   (2) Actions with `sourceIndex` reference a specific slot index in the
//       graph node's concrete state. We rewrite `sourceIndex` to point at the
//       matching slot (by `(token, isGA, isEnchanted)` signature) in the MC's
//       concrete state.
//
// Misses (residual graph absent, abstract key not in table, no matching slot)
// fall through to the existing `optimize_payload_v3` path — zero correctness
// risk; the table is purely an optimization.

#[derive(Clone)]
struct SlotSignature {
    token: String,
    is_ga: bool,
    is_enchanted: bool,
}

struct PolicyEntry {
    action: JsAction,
    /// Set for actions that reference a slot via `sourceIndex` (remove,
    /// focused, chaotic, enchant). `None` for `add`.
    source_slot_signature: Option<SlotSignature>,
}

struct PolicyTable {
    entries: HashMap<String, PolicyEntry>,
    context: ResidualContext,
}

fn slot_signature_for_index(
    state: &JsState,
    idx: usize,
    context: &ResidualContext,
    env: &TranslationEnv,
) -> Option<SlotSignature> {
    let slot = state.affixes.get(idx)?;
    if slot.affix_id.is_empty() {
        return None;
    }
    Some(SlotSignature {
        token: get_residual_affix_token_v3(slot, context, env),
        is_ga: slot.is_ga,
        is_enchanted: slot.is_enchanted,
    })
}

fn build_policy_table(
    payload: &OptimizePayload,
    env: &TranslationEnv,
) -> Option<PolicyTable> {
    let feasibility = analyze_feasibility(&payload.state, &payload.target, &payload.ga_config, env);
    if !feasibility.ok {
        return None;
    }

    let (state_limit, max_iterations) = get_residual_env_overrides(payload.time_ms);

    let attached_root = attach_unsatisfactory_to_state(&payload.state, &payload.ga_config);
    let root = normalize_outcome_state_v2(attached_root);

    let graph = build_residual_reachable_graph_v3(
        &root,
        &payload.target,
        &payload.ga_config,
        env,
        BuildGraphOptions {
            state_limit: Some(state_limit),
            feasibility: Some(&feasibility),
            root_already_attached: true,
        },
    );
    if !graph.ok {
        return None;
    }

    let phase1 = solve_residual_lao_phase1_v3(&graph, max_iterations, RESIDUAL_EPSILON);
    if !phase1.converged {
        return None;
    }
    let phase2 = solve_residual_lao_phase2_v3(
        &graph,
        &phase1,
        max_iterations,
        RESIDUAL_EPSILON,
        RESIDUAL_PHASE2_EPSILON,
    );

    let policy_indices = extract_residual_policy_indices(&graph, &phase1, &phase2);

    let context = ResidualContext {
        relevant_affix_ids: get_residual_relevant_affix_ids_v3(
            &payload.target,
            &payload.ga_config,
            Some(&feasibility),
        ),
    };

    let mut entries: HashMap<String, PolicyEntry> = HashMap::with_capacity(graph.nodes.len());
    for (i, node) in graph.nodes.iter().enumerate() {
        let action_idx = match policy_indices[i] {
            Some(idx) => idx,
            None => continue,
        };
        let action = node.action_entries[action_idx].action.clone();
        let source_slot_signature = action
            .source_index
            .and_then(|si| usize::try_from(si).ok())
            .and_then(|idx| slot_signature_for_index(&node.state, idx, &context, env));
        // Sanity: if the action declares a sourceIndex but we couldn't extract
        // a signature, skip the entry — we'd have no way to remap it.
        if action.source_index.is_some() && source_slot_signature.is_none() {
            continue;
        }
        entries.insert(
            node.key.clone(),
            PolicyEntry {
                action,
                source_slot_signature,
            },
        );
    }

    Some(PolicyTable { entries, context })
}

/// Look up the policy action for a concrete MC state. Returns the action as
/// JSON (matching the action_cache format) on a hit, or `None` on a miss.
fn lookup_policy_action(
    state: &JsState,
    table: &PolicyTable,
    ga_config: &crate::types::JsGaConfig,
    env: &TranslationEnv,
) -> Option<Value> {
    // Mirror the preprocessing the optimizer does at the top of
    // solve_residual_payload_v3 so the abstract key matches graph nodes.
    let attached = attach_unsatisfactory_to_state(state, ga_config);
    let normalized = normalize_outcome_state_v2(attached);
    let key = residual_state_key_v3(&normalized, &table.context, env);
    let entry = table.entries.get(&key)?;
    let mut action = entry.action.clone();
    if let Some(ref src_sig) = entry.source_slot_signature {
        let matched_idx = normalized.affixes.iter().enumerate().find_map(|(idx, slot)| {
            if slot.affix_id.is_empty() {
                return None;
            }
            let tok = get_residual_affix_token_v3(slot, &table.context, env);
            if tok == src_sig.token
                && slot.is_ga == src_sig.is_ga
                && slot.is_enchanted == src_sig.is_enchanted
            {
                Some(idx as i32)
            } else {
                None
            }
        })?;
        action.source_index = Some(matched_idx);
    }
    Some(action_to_json(&action))
}

// ── Main MC verification loop ─────────────────────────────────────────────────

pub fn run_mc_verification_v3(
    payload: &OptimizePayload,
    env: &TranslationEnv,
    intermediate_result: Value,
    solve_ilp: SolveIlpFn,
    on_progress: Option<&dyn Fn(Value)>,
) -> Value {
    let budget = match resolve_mc_budget(payload) {
        Some(b) => b,
        None => return intermediate_result,
    };
    if intermediate_result["action"].is_null() {
        return intermediate_result;
    }
    let initial_steps = intermediate_result["expectedSteps"].as_f64();
    if initial_steps.map(|s| !s.is_finite()).unwrap_or(true) {
        return intermediate_result;
    }

    let mut action_cache: HashMap<String, Option<Value>> = HashMap::new();

    let root_key = compute_state_key(&payload.state);
    action_cache.insert(root_key, Some(intermediate_result["action"].clone()));

    // Build the residual-graph policy table once. On a hit during a rollout,
    // we get the policy action in O(1) instead of recomputing the optimizer
    // for that state. Misses fall through to the existing sub-call path.
    let policy_table = build_policy_table(payload, env);
    let mut policy_hits: usize = 0;
    let mut policy_misses: usize = 0;

    let mut step_counts: Vec<usize> = Vec::with_capacity(budget.max_rollouts);
    let mut truncated_rollout_count: usize = 0;
    let start_ms = crate::optimizer::now_ms_pub();

    if let Some(f) = on_progress {
        f(json!({
            "completed": 0,
            "total": budget.target_rollouts,
            "intermediateResult": intermediate_result,
        }));
    }

    let mut aborted = false;
    let mut early_converged = false;

    'outer: for _rollout in 0..budget.max_rollouts {
        if let Some(wall) = budget.wall_budget_ms {
            if crate::optimizer::now_ms_pub().saturating_sub(start_ms) > wall {
                aborted = true;
                break;
            }
        }

        let mut state = payload.state.clone();
        let mut steps: usize = 0;
        let mut truncated = false;

        loop {
            let term = is_terminal(&state, &payload.target, env);
            if term.terminal {
                if !term.success {
                    truncated = true;
                    steps = MC_ROLLOUT_STEP_CAP;
                }
                break;
            }
            if steps >= MC_ROLLOUT_STEP_CAP {
                truncated = true;
                break;
            }

            let key = compute_state_key(&state);
            let action = if let Some(cached) = action_cache.get(&key) {
                cached.clone()
            } else if let Some(policy_action) = policy_table
                .as_ref()
                .and_then(|pt| lookup_policy_action(&state, pt, &payload.ga_config, env))
            {
                policy_hits += 1;
                let act = Some(policy_action);
                action_cache.insert(key, act.clone());
                act
            } else {
                if policy_table.is_some() {
                    policy_misses += 1;
                }
                // Sub-call must inherit `time_ms` so the residual solver uses
                // the same state-limit budget as the parent call. Mirrors JS
                // `optimizePayloadV3({ ...payload, state })` in runMCVerificationV3.
                let sub_payload = OptimizePayload {
                    state: state.clone(),
                    target: payload.target.clone(),
                    data: payload.data.clone(),
                    ga_config: payload.ga_config.clone(),
                    time_ms: payload.time_ms,
                    tighten_steps_level: payload.tighten_steps_level.clone(),
                    tighten_steps_overrides: payload.tighten_steps_overrides.clone(),
                };
                let sub_result = optimize_payload_v3(&sub_payload, env, solve_ilp, 0, 1);
                let act = if sub_result["action"].is_null() {
                    None
                } else {
                    Some(sub_result["action"].clone())
                };
                action_cache.insert(key, act.clone());
                act
            };

            let action = match action {
                Some(a) => a,
                None => {
                    truncated = true;
                    steps = MC_ROLLOUT_STEP_CAP;
                    break;
                }
            };

            let action_js: crate::types::JsAction = match serde_json::from_value(action.clone()) {
                Ok(a) => a,
                Err(_) => {
                    truncated = true;
                    break;
                }
            };

            let raw_outcomes = get_action_outcomes(&state, &action_js, env);
            if raw_outcomes.is_empty() {
                truncated = true;
                break;
            }
            let valid = filter_valid_mc_outcomes(&raw_outcomes);
            if valid.is_empty() {
                truncated = true;
                break;
            }

            let chosen = pick_weighted_outcome(&valid, |(p, _)| *p);
            let next_state = expand_family_other_in_state(chosen.1.clone(), env, &payload.target);
            state = next_state;
            steps += 1;
        }

        step_counts.push(steps);
        if truncated {
            truncated_rollout_count += 1;
        }

        let completed = step_counts.len();
        if let Some(f) = on_progress {
            if completed % MC_PROGRESS_EVERY == 0 || completed == budget.max_rollouts {
                let stats = compute_mc_stats(&step_counts);
                f(json!({
                    "completed": completed,
                    "total": budget.target_rollouts,
                    "intermediateMean": if stats.mean.is_finite() { json!(stats.mean) } else { json!(null) },
                }));
            }
        }

        if budget.adaptive
            && completed >= MC_ADAPTIVE_CHECK_EVERY
            && completed % MC_ADAPTIVE_CHECK_EVERY == 0
        {
            let stats = compute_mc_stats(&step_counts);
            if stats.ci95_half_width.is_finite()
                && stats.mean.is_finite()
                && stats.mean > 0.0
                && stats.ci95_half_width
                    <= MC_ADAPTIVE_TARGET_REL_HALF_WIDTH * stats.mean
            {
                early_converged = true;
                break 'outer;
            }
        }
    }

    let stats = compute_mc_stats(&step_counts);
    let wall_time_ms = crate::optimizer::now_ms_pub().saturating_sub(start_ms);
    let completed_rollouts = step_counts.len();
    let final_approximate = intermediate_result["approximate"].as_bool().unwrap_or(false)
        || aborted
        || (budget.adaptive && !early_converged && completed_rollouts >= budget.max_rollouts);

    let expected_steps = if stats.mean.is_finite() {
        json!(stats.mean)
    } else {
        intermediate_result["expectedSteps"].clone()
    };

    let mut out = intermediate_result.clone();
    out["expectedSteps"] = expected_steps;
    out["approximate"] = json!(final_approximate);
    if let Some(diag) = out["diagnostics"].as_object_mut() {
        diag.insert(
            "goldStandard".to_string(),
            json!({
                "applied": true,
                "level": budget.level,
                "rollouts": completed_rollouts,
                "mean": if stats.mean.is_finite() { json!(stats.mean) } else { json!(null) },
                "ci95halfWidth": if stats.ci95_half_width.is_finite() { json!(stats.ci95_half_width) } else { json!(null) },
                "stdev": if stats.stdev.is_finite() { json!(stats.stdev) } else { json!(null) },
                "intermediateSteps": initial_steps,
                "truncatedRolloutCount": truncated_rollout_count,
                "wallTimeMs": wall_time_ms,
                "aborted": aborted,
                "earlyConverged": early_converged,
                "adaptive": budget.adaptive,
                "policyTable": json!({
                    "built": policy_table.is_some(),
                    "size": policy_table.as_ref().map(|t| t.entries.len()).unwrap_or(0),
                    "hits": policy_hits,
                    "misses": policy_misses,
                }),
            }),
        );
    }
    out
}
