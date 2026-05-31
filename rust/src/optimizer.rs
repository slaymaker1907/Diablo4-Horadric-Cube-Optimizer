use std::collections::HashMap;
#[cfg(not(target_arch = "wasm32"))]
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::closed_form::is_case_a_stuck_recovery_risk;
use crate::decomposition::build_decomposition_plan_input;
use crate::env::TranslationEnv;
use crate::feasibility::analyze_feasibility;
use crate::residual::{
    attach_unsatisfactory_to_state, build_residual_reachable_graph_v3,
    build_residual_result_from_solution, get_action_outcomes, normalize_outcome_state_v2,
    BuildGraphOptions, SolverStatus, RESIDUAL_MAX_ITERATIONS, RESIDUAL_PHASE2_EPSILON,
    RESIDUAL_STATE_LIMIT,
};
use crate::terminal::is_terminal;
use crate::types::{FeasibilityResult, OptimizePayload};

// ── Constants mirroring worker.js ─────────────────────────────────────────────

const RESIDUAL_STATE_LIMIT_CAP: usize = 4096;
const RESIDUAL_MAX_ITERATIONS_CAP: usize = 1_048_576;
const RESIDUAL_STATE_LIMIT_PER_SECOND: f64 = 50.0;
const RESIDUAL_MAX_ITERATIONS_PER_SECOND: f64 = 32768.0;
const ILP_APPROX_BOUND_GAP_THRESHOLD: f64 = 0.25;
const APPROX_COMPARE_SUCCESS_EPSILON: f64 = 1e-9;
const APPROX_COMPARE_STEPS_EPSILON: f64 = 1e-9;

const FEASIBILITY_STRATEGY: &str = "v3-feasibility";
const RESIDUAL_STRATEGY: &str = "v3-residual-lao-star";
const DECOMPOSITION_STRATEGY: &str = "v3-decomposition-ilp";

// ── ILP callback type ─────────────────────────────────────────────────────────

/// Callback that takes plan-input JSON → returns solveDecompositionPlanV3 result JSON.
/// Returns None when ILP is unavailable.
pub type SolveIlpFn<'a> = &'a dyn Fn(&str) -> Option<Value>;

// ── Timing helper ─────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    now_ms_pub()
}

pub fn now_ms_pub() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now() as u64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

// ── Residual env overrides ────────────────────────────────────────────────────

pub fn get_residual_env_overrides(time_ms: Option<f64>) -> (usize, usize) {
    match time_ms {
        None => (RESIDUAL_STATE_LIMIT, RESIDUAL_MAX_ITERATIONS),
        Some(t) if !t.is_finite() => (RESIDUAL_STATE_LIMIT, RESIDUAL_MAX_ITERATIONS),
        Some(t) if t <= 0.0 => (RESIDUAL_STATE_LIMIT_CAP, RESIDUAL_MAX_ITERATIONS_CAP),
        Some(t) => {
            let secs = (t / 1000.0).max(0.0);
            let sl = (RESIDUAL_STATE_LIMIT as f64 + secs * RESIDUAL_STATE_LIMIT_PER_SECOND)
                .round() as usize;
            let mi = (RESIDUAL_MAX_ITERATIONS as f64
                + secs * RESIDUAL_MAX_ITERATIONS_PER_SECOND)
                .round() as usize;
            (
                sl.min(RESIDUAL_STATE_LIMIT_CAP),
                mi.min(RESIDUAL_MAX_ITERATIONS_CAP),
            )
        }
    }
}

// ── Empty / failure result builders ──────────────────────────────────────────

fn empty_summary(reason: &str) -> Value {
    json!({
        "action": null,
        "expectedSteps": null,
        "variance": null,
        "stdDev": null,
        "successProb": 0,
        "oneStepRisk": [],
        "diagnostics": {
            "reason": reason,
            "rootVisits": 0,
            "candidateActions": [],
        },
    })
}

fn build_worker_diagnostics(
    summary_diag: &Value,
    strategy: &str,
    phase: &str,
    feasibility: &FeasibilityResult,
    decomposition: Value,
    ilp: Value,
    residual: Value,
) -> Value {
    let base = if summary_diag.is_object() {
        summary_diag.clone()
    } else {
        json!({})
    };
    let reason = base["reason"].as_str().unwrap_or("").to_string();
    let root_visits = base["rootVisits"].as_i64().unwrap_or(0);
    let candidate_actions = base["candidateActions"]
        .as_array()
        .cloned()
        .map(Value::Array)
        .unwrap_or_else(|| json!([]));
    let feasibility_val = serde_json::to_value(feasibility).unwrap_or(json!({}));
    json!({
        "reason": reason,
        "rootVisits": root_visits,
        "candidateActions": candidate_actions,
        "strategy": strategy,
        "phase": phase,
        "feasibility": feasibility_val,
        "decomposition": decomposition,
        "ilp": ilp,
        "residual": residual,
        // Forward any extra keys from summary_diag (e.g. note, expandedStates, etc.)
        "expandedStates": base["expandedStates"],
        "deadStates": base["deadStates"],
        "phase1Iterations": base["phase1Iterations"],
        "phase2Iterations": base["phase2Iterations"],
        "phase1Converged": base["phase1Converged"],
        "phase2Converged": base["phase2Converged"],
        "stepEstimatesReliable": base["stepEstimatesReliable"],
    })
}

pub fn build_feasibility_failure_result(feasibility: &FeasibilityResult) -> Value {
    let mut result = empty_summary(&feasibility.message);
    let diag = build_worker_diagnostics(
        &result["diagnostics"],
        FEASIBILITY_STRATEGY,
        "phase-1",
        feasibility,
        json!({ "status": "NOT_RUN", "applicable": null, "reason": "", "optionCount": 0, "targetCount": 0, "residualTargets": [], "selectedOptions": [] }),
        json!({ "status": "NOT_RUN", "approximate": false, "objective": null, "bestBound": null, "nodesVisited": 0, "iterations": 0 }),
        json!({ "status": "NOT_RUN", "approximate": false, "abstractStates": 0, "deadStates": 0, "stateLimit": RESIDUAL_STATE_LIMIT, "phase1Iterations": 0, "phase2Iterations": 0, "phase1Converged": null, "phase2Converged": null }),
    );
    result["diagnostics"] = diag;
    json!({
        "iterations": 0,
        "action": null,
        "expectedSteps": null,
        "variance": null,
        "stdDev": null,
        "successProb": 0,
        "oneStepRisk": [],
        "diagnostics": result["diagnostics"],
        "tree": null,
        "stoppedByUser": false,
        "elapsedMs": 0,
    })
}

// ── ILP solution processing ───────────────────────────────────────────────────

fn build_decomp_decomposition_diag(solution: &Value) -> Value {
    let plan_input = &solution["planInput"];
    let option_count = plan_input["options"].as_array().map(|a| a.len()).unwrap_or(0);
    let target_count = plan_input["targets"].as_array().map(|a| a.len()).unwrap_or(0);
    let approximate = solution["approximate"].as_bool().unwrap_or(false);
    let reason = if approximate {
        "Decomposition returned the best feasible ILP incumbent found before the solver limit; this action is not proven optimal."
    } else if solution["action"].is_null() {
        "Current state already satisfies the target under the decomposition model."
    } else {
        "Decomposition solved the instance exactly with the scoped ILP layer."
    };

    let selected_options = solution["selectedOptions"]
        .as_array()
        .cloned()
        .map(Value::Array)
        .unwrap_or_else(|| json!([]));

    json!({
        "status": if approximate { "APPROXIMATE_LIMIT" } else { "APPLICABLE" },
        "applicable": true,
        "reason": if approximate { reason } else { "" },
        "optionCount": option_count,
        "targetCount": target_count,
        "selectedOptions": selected_options,
        "residualTargets": [],
    })
}

fn build_decomp_ilp_diag(solution: &Value) -> Value {
    let ilp = &solution["ilpResult"];
    if ilp.is_null() || ilp.is_null() {
        return json!({ "status": "NOT_RUN", "approximate": false, "objective": null, "bestBound": null, "nodesVisited": 0, "iterations": 0 });
    }
    json!({
        "status": ilp["status"].as_str().unwrap_or("NOT_RUN"),
        "approximate": solution["approximate"].as_bool().unwrap_or(false),
        "objective": ilp["objective"],
        "bestBound": ilp["bestBound"],
        "nodesVisited": ilp["nodesVisited"].as_i64().unwrap_or(0),
        "iterations": ilp["iterations"].as_i64().unwrap_or(0),
    })
}

pub fn build_decomposition_result_v3(solution: &Value, feasibility: &FeasibilityResult) -> Value {
    let approximate = solution["approximate"].as_bool().unwrap_or(false);
    let reason = if approximate {
        "Decomposition returned the best feasible ILP incumbent found before the solver limit; this action is not proven optimal."
    } else if solution["action"].is_null() {
        "Current state already satisfies the target under the decomposition model."
    } else {
        "Decomposition solved the instance exactly with the scoped ILP layer."
    };

    let schedule = solution["schedule"].as_array().cloned().unwrap_or_default();
    let candidate_actions: Vec<Value> = schedule
        .iter()
        .map(|step| {
            json!({
                "action": step["action"],
                "expectedSteps": step["expectedSteps"],
                "successProb": 1,
                "visits": 0,
                "sourceBreakdown": [],
                "probabilityBreakdown": [],
                "targetAffixId": step["targetAffixId"],
                "caseId": step["caseId"],
                "slotIndex": step["slotIndex"],
                "stage": step["stage"],
            })
        })
        .collect();

    let summary_diag = json!({
        "reason": reason,
        "rootVisits": 0,
        "candidateActions": candidate_actions,
    });

    let decomp_diag = build_decomp_decomposition_diag(solution);
    let ilp_diag = build_decomp_ilp_diag(solution);

    let diagnostics = build_worker_diagnostics(
        &summary_diag,
        DECOMPOSITION_STRATEGY,
        "phase-4-decomposition-ilp",
        feasibility,
        decomp_diag,
        ilp_diag,
        json!({ "status": "NOT_RUN", "approximate": false, "abstractStates": 0, "deadStates": 0, "stateLimit": RESIDUAL_STATE_LIMIT, "phase1Iterations": 0, "phase2Iterations": 0, "phase1Converged": null, "phase2Converged": null }),
    );

    let iterations = solution["ilpResult"]["iterations"].as_i64().unwrap_or(0);

    json!({
        "iterations": iterations,
        "approximate": approximate,
        "action": solution["action"],
        "expectedSteps": solution["expectedSteps"],
        "variance": null,
        "stdDev": null,
        "successProb": 1,
        "oneStepRisk": [],
        "diagnostics": diagnostics,
        "tree": null,
        "stoppedByUser": false,
        "elapsedMs": 0,
    })
}

fn build_ilp_failure_result(solution: &Value, feasibility: &FeasibilityResult) -> Value {
    let reason = solution["reason"]
        .as_str()
        .unwrap_or("ILP solver failed.")
        .to_string();
    let mut result = empty_summary(&reason);
    let plan_input = &solution["planInput"];
    let option_count = plan_input["options"].as_array().map(|a| a.len()).unwrap_or(0);
    let target_count = plan_input["targets"].as_array().map(|a| a.len()).unwrap_or(0);
    let ilp_diag = if solution["ilpResult"].is_null() {
        json!({ "status": "UNAVAILABLE" })
    } else {
        build_decomp_ilp_diag(solution)
    };
    let diagnostics = build_worker_diagnostics(
        &result["diagnostics"],
        DECOMPOSITION_STRATEGY,
        "phase-4-decomposition-ilp",
        feasibility,
        json!({ "status": "APPLICABLE", "applicable": true, "reason": "", "optionCount": option_count, "targetCount": target_count, "residualTargets": [], "selectedOptions": [] }),
        ilp_diag,
        json!({ "status": "NOT_RUN", "approximate": false, "abstractStates": 0, "deadStates": 0, "stateLimit": RESIDUAL_STATE_LIMIT, "phase1Iterations": 0, "phase2Iterations": 0, "phase1Converged": null, "phase2Converged": null }),
    );
    result["diagnostics"] = diagnostics;
    let iterations = solution["ilpResult"]["iterations"].as_i64().unwrap_or(0);
    json!({
        "iterations": iterations,
        "action": null,
        "expectedSteps": null,
        "variance": null,
        "stdDev": null,
        "successProb": 0,
        "oneStepRisk": [],
        "diagnostics": result["diagnostics"],
        "tree": null,
        "stoppedByUser": false,
        "elapsedMs": 0,
    })
}

fn should_compare_approximate_ilp_with_residual(solution: &Value) -> bool {
    if !solution["ok"].as_bool().unwrap_or(false) {
        return false;
    }
    if !solution["approximate"].as_bool().unwrap_or(false) {
        return false;
    }
    let ilp = &solution["ilpResult"];
    if ilp.is_null() {
        return false;
    }
    if ilp["status"].as_str() != Some("ITERATION_LIMIT") {
        return false;
    }
    let objective = ilp["objective"].as_f64();
    let best_bound = ilp["bestBound"].as_f64();
    match (objective, best_bound) {
        (Some(o), Some(b)) => (o - b).max(0.0) > ILP_APPROX_BOUND_GAP_THRESHOLD,
        _ => true,
    }
}

fn choose_preferred_approximate_result(decomp: Value, residual: Value) -> Value {
    let rs = residual["successProb"].as_f64().unwrap_or(f64::NAN);
    let ds = decomp["successProb"].as_f64().unwrap_or(f64::NAN);
    if rs.is_finite() && ds.is_finite() {
        if rs > ds + APPROX_COMPARE_SUCCESS_EPSILON {
            return residual;
        }
        if ds > rs + APPROX_COMPARE_SUCCESS_EPSILON {
            return decomp;
        }
    }
    let re = residual["expectedSteps"].as_f64().unwrap_or(f64::NAN);
    let de = decomp["expectedSteps"].as_f64().unwrap_or(f64::NAN);
    if re.is_finite() && de.is_finite() {
        if re + APPROX_COMPARE_STEPS_EPSILON < de {
            return residual;
        }
        if de + APPROX_COMPARE_STEPS_EPSILON < re {
            return decomp;
        }
    }
    let r_status = residual["diagnostics"]["residual"]["status"]
        .as_str()
        .unwrap_or("");
    if r_status == "OPTIMAL" {
        return residual;
    }
    decomp
}

// ── Residual failure / result builders ───────────────────────────────────────

fn build_residual_failure_result(
    message: &str,
    feasibility: &FeasibilityResult,
    decomp_input_val: &Value,
    details: Value,
) -> Value {
    let mut result = empty_summary(message);
    let reason_str = decomp_input_val["reason"].as_str().unwrap_or("").to_string();
    let option_count = decomp_input_val["options"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    let target_count = decomp_input_val["targets"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    let residual_targets = decomp_input_val["residualTargets"]
        .as_array()
        .cloned()
        .map(Value::Array)
        .unwrap_or_else(|| json!([]));
    let decomp_diag = json!({
        "status": "ESCALATED",
        "applicable": false,
        "reason": reason_str,
        "optionCount": option_count,
        "targetCount": target_count,
        "residualTargets": residual_targets,
        "selectedOptions": [],
    });
    let iterations = details["iterations"].as_i64().unwrap_or(0);
    let status = details["status"].as_str().unwrap_or("UNKNOWN");
    let residual_diag = json!({
        "status": status,
        "approximate": false,
        "abstractStates": details["abstractStates"].as_i64().unwrap_or(0),
        "deadStates": details["deadStates"].as_i64().unwrap_or(0),
        "stateLimit": details["stateLimit"].as_i64().unwrap_or(RESIDUAL_STATE_LIMIT as i64),
        "phase1Iterations": 0,
        "phase2Iterations": 0,
        "phase1Converged": null,
        "phase2Converged": null,
    });
    let diag = build_worker_diagnostics(
        &result["diagnostics"],
        RESIDUAL_STRATEGY,
        "phase-5-residual-lao-star",
        feasibility,
        decomp_diag,
        json!({ "status": "NOT_RUN", "approximate": false, "objective": null, "bestBound": null, "nodesVisited": 0, "iterations": 0 }),
        residual_diag,
    );
    result["diagnostics"] = diag;
    json!({
        "iterations": iterations,
        "action": null,
        "expectedSteps": null,
        "variance": null,
        "stdDev": null,
        "successProb": 0,
        "oneStepRisk": [],
        "diagnostics": result["diagnostics"],
        "tree": null,
        "stoppedByUser": false,
        "elapsedMs": 0,
    })
}

fn build_residual_result(
    summary: Value,
    graph_node_count: usize,
    graph_dead_states: usize,
    graph_state_limit: usize,
    phase1: &crate::residual::Phase1Result,
    phase2: &crate::residual::Phase2Result,
    feasibility: &FeasibilityResult,
    decomp_input_val: &Value,
) -> Value {
    let reason_str = decomp_input_val["reason"].as_str().unwrap_or("").to_string();
    let option_count = decomp_input_val["options"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    let target_count = decomp_input_val["targets"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    let residual_targets = decomp_input_val["residualTargets"]
        .as_array()
        .cloned()
        .map(Value::Array)
        .unwrap_or_else(|| json!([]));
    let decomp_diag = json!({
        "status": "ESCALATED",
        "applicable": false,
        "reason": reason_str,
        "optionCount": option_count,
        "targetCount": target_count,
        "residualTargets": residual_targets,
        "selectedOptions": [],
    });
    let residual_diag = json!({
        "status": "OPTIMAL",
        "approximate": false,
        "abstractStates": graph_node_count,
        "deadStates": graph_dead_states,
        "stateLimit": graph_state_limit,
        "phase1Iterations": phase1.iterations,
        "phase2Iterations": phase2.iterations,
        "phase1Converged": phase1.converged,
        "phase2Converged": phase2.converged,
        "phase1Residual": phase1.residual,
        "phase2Residual": phase2.residual,
        "heuristic": "Closed-form lower bound on the hardest unresolved target; success heuristic is optimistic 1.",
    });
    let diag = build_worker_diagnostics(
        &summary["diagnostics"],
        RESIDUAL_STRATEGY,
        "phase-5-residual-lao-star",
        feasibility,
        decomp_diag,
        json!({ "status": "NOT_RUN", "approximate": false, "objective": null, "bestBound": null, "nodesVisited": 0, "iterations": 0 }),
        residual_diag,
    );
    let iterations = phase1.iterations + phase2.iterations;
    let mut out = summary.clone();
    out["iterations"] = json!(iterations);
    out["diagnostics"] = diag;
    out["tree"] = json!(null);
    out["stoppedByUser"] = json!(false);
    out["elapsedMs"] = json!(0);
    out
}

// ── Core residual solve ───────────────────────────────────────────────────────

pub fn solve_residual_payload_v3(
    payload: &OptimizePayload,
    env: &TranslationEnv,
    feasibility: &FeasibilityResult,
    decomp_input_val: &Value,
    state_limit: usize,
    max_iterations: usize,
) -> Value {
    let attached_root = attach_unsatisfactory_to_state(&payload.state, &payload.ga_config);
    let root = normalize_outcome_state_v2(attached_root);

    let graph = build_residual_reachable_graph_v3(
        &root,
        &payload.target,
        &payload.ga_config,
        env,
        BuildGraphOptions {
            state_limit: Some(state_limit),
            feasibility: Some(feasibility),
            root_already_attached: true,
        },
    );

    if !graph.ok {
        return build_residual_failure_result(
            &graph.reason,
            feasibility,
            decomp_input_val,
            json!({
                "status": "STATE_LIMIT",
                "abstractStates": graph.nodes.len(),
                "deadStates": graph.dead_states,
                "stateLimit": state_limit,
            }),
        );
    }

    let solution = solve_residual_lao_star_v3_with_limits(&graph, max_iterations);

    match solution.status {
        SolverStatus::IterationLimit => {
            // If phase1 converged, return approximate result
            if let Some(ref p1) = solution.phase1 {
                if p1.converged {
                    let eff_phase2 = solution.phase2.as_ref().cloned().unwrap_or_else(|| {
                        crate::residual::Phase2Result {
                            costs: vec![0.0; graph.nodes.len()],
                            iterations: 0,
                            converged: false,
                            residual: f64::INFINITY,
                        }
                    });
                    let summary = build_residual_result_from_solution(
                        &graph,
                        p1,
                        &eff_phase2,
                        &payload.target,
                        env,
                        Some("Residual abstract-state solver returned the best policy found before reaching solver limits."),
                    );
                    let mut out = build_residual_result(
                        summary,
                        graph.nodes.len(),
                        graph.dead_states,
                        state_limit,
                        p1,
                        &eff_phase2,
                        feasibility,
                        decomp_input_val,
                    );
                    out["approximate"] = json!(true);
                    // Override residual.status in diagnostics
                    if let Some(r) = out["diagnostics"]["residual"].as_object_mut() {
                        r.insert("status".to_string(), json!("APPROXIMATE_LIMIT"));
                        r.insert("approximate".to_string(), json!(true));
                    }
                    return out;
                }
            }
            let p1_iters = solution.phase1.as_ref().map(|p| p.iterations).unwrap_or(0);
            let p2_iters = solution.phase2.as_ref().map(|p| p.iterations).unwrap_or(0);
            build_residual_failure_result(
                &format!("Residual solver reached {} iterations without convergence.", max_iterations),
                feasibility,
                decomp_input_val,
                json!({
                    "status": "ITERATION_LIMIT",
                    "iterations": p1_iters + p2_iters,
                    "abstractStates": graph.nodes.len(),
                    "deadStates": graph.dead_states,
                    "stateLimit": state_limit,
                }),
            )
        }
        SolverStatus::Optimal => {
            let phase1 = solution.phase1.as_ref().unwrap();
            let phase2 = solution.phase2.as_ref().unwrap();
            let summary = build_residual_result_from_solution(
                &graph,
                phase1,
                phase2,
                &payload.target,
                env,
                Some("Residual abstract-state solver selected this action after decomposition escalation."),
            );
            build_residual_result(
                summary,
                graph.nodes.len(),
                graph.dead_states,
                state_limit,
                phase1,
                phase2,
                feasibility,
                decomp_input_val,
            )
        }
    }
}

fn solve_residual_lao_star_v3_with_limits(
    graph: &crate::residual::ResidualGraph,
    max_iterations: usize,
) -> crate::residual::ResidualSolution {
    let phase1 = crate::residual::solve_residual_lao_phase1_v3(
        graph,
        max_iterations,
        crate::residual::RESIDUAL_EPSILON,
    );
    if !phase1.converged {
        return crate::residual::ResidualSolution {
            status: SolverStatus::IterationLimit,
            phase1: Some(phase1),
            phase2: None,
        };
    }
    let phase2 = crate::residual::solve_residual_lao_phase2_v3(
        graph,
        &phase1,
        max_iterations,
        crate::residual::RESIDUAL_EPSILON,
        RESIDUAL_PHASE2_EPSILON,
    );
    if !phase2.converged {
        return crate::residual::ResidualSolution {
            status: SolverStatus::IterationLimit,
            phase1: Some(phase1),
            phase2: Some(phase2),
        };
    }
    crate::residual::ResidualSolution {
        status: SolverStatus::Optimal,
        phase1: Some(phase1),
        phase2: Some(phase2),
    }
}

// ── Tag loose estimate ────────────────────────────────────────────────────────

fn tag_loose_estimate(mut result: Value, payload: &OptimizePayload, env: &TranslationEnv) -> Value {
    if result["diagnostics"].is_null() {
        return result;
    }
    let action = &result["action"];
    if action.is_null() {
        return result;
    }
    let action_type = action["type"].as_str().unwrap_or("");
    if action_type != "add" {
        return result;
    }
    let prism = match action["prism"].as_str() {
        Some(p) if !p.is_empty() => p,
        _ => return result,
    };
    if is_case_a_stuck_recovery_risk(&payload.state, &payload.target, env, prism) {
        if let Some(diag) = result["diagnostics"].as_object_mut() {
            diag.insert("looseEstimate".to_string(), json!(true));
        }
    }
    result
}

// ── compute_optimization_result_v3 ───────────────────────────────────────────

pub fn compute_optimization_result_v3(
    payload: &OptimizePayload,
    env: &TranslationEnv,
    solve_ilp: SolveIlpFn,
) -> Value {
    let feasibility = analyze_feasibility(&payload.state, &payload.target, &payload.ga_config, env);
    if !feasibility.ok {
        return build_feasibility_failure_result(&feasibility);
    }

    let (state_limit, max_iterations) = get_residual_env_overrides(payload.time_ms);

    let decomp_input = build_decomposition_plan_input(
        &payload.state,
        &payload.target,
        &payload.ga_config,
        env,
        Some(feasibility.clone()),
    );
    let decomp_input_val = serde_json::to_value(&decomp_input).unwrap_or(json!({}));

    if decomp_input.ok {
        // Try ILP solver
        if let Some(solution) = solve_ilp(&serde_json::to_string(&decomp_input).unwrap_or_default()) {
            let ilp_ok = solution["ok"].as_bool().unwrap_or(false);
            if ilp_ok {
                let decomp_result = build_decomposition_result_v3(&solution, &feasibility);
                if !should_compare_approximate_ilp_with_residual(&solution) {
                    return decomp_result;
                }
                // Wide-gap approximate — also run residual, pick better
                let residual_decomp_val = {
                    let mut v = decomp_input_val.clone();
                    v["ok"] = json!(false);
                    v["reason"] = json!("Decomposition returned only a wide-gap approximate ILP incumbent, so the case was also evaluated by the residual solver.");
                    v
                };
                let residual_result = solve_residual_payload_v3(
                    payload,
                    env,
                    &feasibility,
                    &residual_decomp_val,
                    state_limit,
                    max_iterations,
                );
                return choose_preferred_approximate_result(decomp_result, residual_result);
            }
            // ILP returned a result but ok=false
            let ilp_status = solution["ilpResult"]["status"].as_str().unwrap_or("");
            if ilp_status == "INFEASIBLE" {
                let mut infeasible_decomp = decomp_input_val.clone();
                infeasible_decomp["ok"] = json!(false);
                infeasible_decomp["reason"] = json!("The decomposition ILP found no feasible exact host assignment, so the case was escalated to the residual solver.");
                return solve_residual_payload_v3(
                    payload,
                    env,
                    &feasibility,
                    &infeasible_decomp,
                    state_limit,
                    max_iterations,
                );
            }
            if !solution["ilpResult"].is_null() {
                return build_ilp_failure_result(&solution, &feasibility);
            }
        }
        // ILP unavailable (callback returned None) — fall through to residual
    }

    solve_residual_payload_v3(
        payload,
        env,
        &feasibility,
        &decomp_input_val,
        state_limit,
        max_iterations,
    )
}

// ── Refinement helpers ────────────────────────────────────────────────────────

fn should_refine_result(result: &Value) -> bool {
    if result["diagnostics"].is_null() {
        return false;
    }
    let strategy = result["diagnostics"]["strategy"].as_str().unwrap_or("");
    if strategy != RESIDUAL_STRATEGY {
        return false;
    }
    if result["action"].is_null() {
        return false;
    }
    result["expectedSteps"].as_f64().map(|v| v.is_finite()).unwrap_or(false)
}

/// One-step Bellman backup for a single action.
/// Returns `Some((refined_steps, any_loose))` or None if any successor is unevaluable.
fn refine_one_action(
    payload: &OptimizePayload,
    action: &Value,
    env: &TranslationEnv,
    sub_refine_depth: usize,
    cache: &mut HashMap<u64, Option<(f64, bool)>>,
    solve_ilp: SolveIlpFn,
) -> Option<(f64, bool)> {
    let action_js: crate::types::JsAction = serde_json::from_value(action.clone()).ok()?;
    let outcomes = get_action_outcomes(&payload.state, &action_js, env);
    if outcomes.is_empty() {
        return None;
    }

    let mut sum = 0.0_f64;
    let mut any_loose = false;

    for outcome in &outcomes {
        let key = crate::intern::istate_key_v1(&crate::intern::intern_state(&outcome.state, env));
        if !cache.contains_key(&key) {
            let term = is_terminal(&outcome.state, &payload.target, env);
            let entry = if term.terminal && term.success {
                Some((0.0_f64, false))
            } else if term.terminal && !term.success {
                Some((f64::INFINITY, false))
            } else {
                let successor_payload = OptimizePayload {
                    state: outcome.state.clone(),
                    target: payload.target.clone(),
                    data: payload.data.clone(),
                    ga_config: payload.ga_config.clone(),
                    time_ms: None,
                    tighten_steps_level: None,
                    tighten_steps_overrides: None,
                };
                let sub_result =
                    optimize_payload_v3(&successor_payload, env, solve_ilp, sub_refine_depth, 1);
                let val = sub_result["expectedSteps"].as_f64();
                let loose = sub_result["diagnostics"]["looseEstimate"]
                    .as_bool()
                    .unwrap_or(false);
                val.filter(|v| v.is_finite()).map(|v| (v, loose))
            };
            cache.insert(key.clone(), entry);
        }
        let cached = cache[&key]?;
        if !cached.0.is_finite() {
            return None;
        }
        if cached.1 {
            any_loose = true;
        }
        sum += outcome.probability * cached.0;
    }
    Some((1.0 + sum, any_loose))
}

fn refine_root_action_v3(
    payload: &OptimizePayload,
    result: Value,
    refine_depth: usize,
    refine_top_k: usize,
    refine_budget_ms: Option<u64>,
    env: &TranslationEnv,
    solve_ilp: SolveIlpFn,
) -> Value {
    let all_candidates = result["diagnostics"]["candidateActions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let k = (refine_top_k.max(1)).min(all_candidates.len().max(1));
    let candidates = &all_candidates[..k.min(all_candidates.len())];

    let mut cache: HashMap<u64, Option<(f64, bool)>> = HashMap::new();
    let t0 = now_ms();
    let mut best_refined: Option<(f64, bool, Value)> = None; // (steps, loose, action)

    for candidate in candidates {
        if let Some(budget) = refine_budget_ms {
            if now_ms().saturating_sub(t0) > budget {
                break;
            }
        }
        let action = &candidate["action"];
        if action.is_null() {
            continue;
        }
        let r = refine_one_action(
            payload,
            action,
            env,
            refine_depth.saturating_sub(1),
            &mut cache,
            solve_ilp,
        );
        if r.is_none() {
            continue;
        }
        let (refined_steps, any_loose) = r.unwrap();
        // Pick by the concrete refined value — the more accurate estimate. We do
        // NOT filter by `refined <= abstract`: the residual abstract value is not
        // always an upper bound (when a prism holds a matched target it
        // under-estimates the random-source collision cost), and filtering those
        // out discarded the genuinely-cheapest action, letting the solver
        // recommend a regressive reroll. Mirrors refineRootActionV3 in the JS worker.
        if best_refined
            .as_ref()
            .map(|(bs, _, _)| refined_steps < *bs)
            .unwrap_or(true)
        {
            best_refined = Some((refined_steps, any_loose, action.clone()));
        }
    }

    let (refined_steps, any_loose, best_action) = match best_refined {
        None => return result,
        Some(x) => x,
    };

    let original_action = result["action"].clone();
    let original_steps = result["expectedSteps"].as_f64().unwrap_or(f64::NAN);
    let timed_out = refine_budget_ms
        .map(|b| now_ms().saturating_sub(t0) > b)
        .unwrap_or(false);

    let mut out = result.clone();
    out["action"] = best_action;
    out["expectedSteps"] = json!(refined_steps);
    if let Some(diag) = out["diagnostics"].as_object_mut() {
        if any_loose {
            diag.insert("looseEstimate".to_string(), json!(true));
        }
        diag.insert(
            "refinement".to_string(),
            json!({
                "applied": true,
                "topK": k,
                "depth": refine_depth,
                "originalAction": original_action,
                "originalSteps": original_steps,
                "refinedSteps": refined_steps,
                "timedOut": timed_out,
            }),
        );
    }
    out
}

// ── optimize_payload_v3 ───────────────────────────────────────────────────────

/// Main optimizer entry point.
pub fn optimize_payload_v3(
    payload: &OptimizePayload,
    env: &TranslationEnv,
    solve_ilp: SolveIlpFn,
    refine_depth: usize,
    refine_top_k: usize,
) -> Value {
    let result = compute_optimization_result_v3(payload, env, solve_ilp);
    let refined = if refine_depth > 0 && should_refine_result(&result) {
        refine_root_action_v3(
            payload,
            result,
            refine_depth,
            refine_top_k,
            None,
            env,
            solve_ilp,
        )
    } else {
        result
    };
    tag_loose_estimate(refined, payload, env)
}
