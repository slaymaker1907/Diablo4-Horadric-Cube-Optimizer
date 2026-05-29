use std::collections::HashMap;

use serde_json::{json, Value};

use crate::env::TranslationEnv;
use crate::optimizer::{optimize_payload_v3, SolveIlpFn};
use crate::residual::{get_action_outcomes, has_duplicate_affix_ids_v2};
use crate::terminal::is_terminal;
use crate::types::{AffixEntry, JsState, OptimizePayload};
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

    // Memoized valid, normalized outcome list per (state_key, action_key).
    // `get_action_outcomes` + `filter_valid_mc_outcomes` are pure deterministic
    // functions of the *concrete* state (state_key uses real affix ids, no trash
    // collapse) and the action, so caching is output-identical. MC revisits the
    // same states heavily, so this amortizes the O(pool) outcome build away from
    // every step — mirrors the JS env `actionOutcomeCache`. The random pick and
    // family-other expansion still run per step on the cached list, so the
    // sampled distribution is unchanged.
    let mut outcome_cache: HashMap<String, Vec<(f64, JsState)>> = HashMap::new();

    let root_key = compute_state_key(&payload.state);
    action_cache.insert(root_key, Some(intermediate_result["action"].clone()));

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
            } else {
                // Recompute the optimal action for this concrete state via the
                // full optimizer (ILP/decomposition + residual), exactly mirroring
                // JS `optimizePayloadV3({ ...payload, state })` in
                // runMCVerificationV3. The result is memoized per concrete
                // state_key, so each distinct state is optimized at most once.
                //
                // NOTE: an earlier residual-only "policy table" fast-path was
                // removed here — it extracted actions purely from the residual
                // LAO* graph and so bypassed the ILP/decomposition branch the
                // optimizer uses for many states, yielding a *different* (and
                // therefore biased) MC step distribution than JS. See the MC
                // mean-divergence investigation.
                //
                // Sub-call must inherit `time_ms` so the residual solver uses
                // the same state-limit budget as the parent call.
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
                action_cache.insert(key.clone(), act.clone());
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

            // Memoized valid outcomes for (state, action). Cache key reuses the
            // concrete state_key (computed above) plus the action key.
            let outcome_key = format!("{}\u{1f}{}", key, crate::keys::action_key(&action_js));
            let valid = outcome_cache.entry(outcome_key).or_insert_with(|| {
                let raw_outcomes = get_action_outcomes(&state, &action_js, env);
                filter_valid_mc_outcomes(&raw_outcomes)
                    .into_iter()
                    .map(|(p, s)| (p, s.clone()))
                    .collect()
            });
            if valid.is_empty() {
                truncated = true;
                break;
            }

            let chosen = pick_weighted_outcome(valid.as_slice(), |(p, _)| *p);
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
            }),
        );
    }
    out
}
