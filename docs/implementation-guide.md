# Implementation Guide

## Start From v3

- The live product surfaces are [d4cubeoptimv3.html](../d4cubeoptimv3.html) and [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).
- The focused regression suite is [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js).
- The exact small ILP engine is [ilp.js](../ilp.js) with direct coverage in [ilp.test.js](../ilp.test.js).
- Shared action semantics still come from [d4cubeoptim-worker.js](../d4cubeoptim-worker.js), and the v3 residual layer still depends on helper semantics from [d4cubeoptimv2-worker.js](../d4cubeoptimv2-worker.js).

## Current v3 Routing Model

- Preserve the current route ordering in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js): feasibility checks, closed-form cases, decomposition plus ILP, then the finite-horizon residual budget DP.
- Every run carries a hard step budget (`payload.maxSteps`, default 200): exceeding it is failure, like a GA break. Exact decomposition results are kept only when `expectedSteps <= maxSteps/4` (the deadline provably barely binds — `diagnostics.budget.binds = false`); everything else routes to `solveResidualBudgetPayloadV3` (strategy `v3-residual-budget-dp`). The residual LAO* and the concrete Bellman-backup refinement remain exported and unit-tested but are no longer routed in production.
- Decomposition `INFEASIBLE` is not a terminal user result in v3. When the decomposition assignment model cannot produce a feasible exact host assignment, the worker escalates to the residual solver.
- The public diagnostics contract is part of the product interface. Keep `diagnostics.feasibility`, `diagnostics.decomposition`, `diagnostics.ilp`, and `diagnostics.residual` present with explicit statuses.

## File Responsibilities

- [d4cubeoptimv3.html](../d4cubeoptimv3.html): browser UI, persisted state, worker wiring, result rendering, manual outcome application, and cache-busting `WORKER_VERSION`.
- [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js): v3 orchestrator, feasibility checks, closed-form engine, decomposition model, residual abstraction, LAO*-style solver, and final result packaging.
- [d4cubeoptim-worker.js](../d4cubeoptim-worker.js): shared action generation, outcome distributions, strict-mode handling, one-step GA risk, and legality-aware category pools.
- [d4cubeoptimv2-worker.js](../d4cubeoptimv2-worker.js): exact SSP helper semantics still reused by the v3 residual environment, especially GA accounting and state normalization.
- [d4cubeoptimv3-rules-solver.js](../d4cubeoptimv3-rules-solver.js): secondary, purely rules-based policy (ordered plain-JS rule list `RULES_V3`, dependency-injected worker helpers, actions always drawn from `getValidActions`). Evaluated against the LAO* policy via the shared MC engine (`runPolicyMCEvaluationV3`) and [scripts/compare-rules-vs-lao.js](../scripts/compare-rules-vs-lao.js); surfaced in the browser as the off-by-default Settings → Developer → "Compare rules-based policy" toggle (`diagnostics.rulesPolicy`). Tests in [d4cubeoptimv3-rules-solver.test.js](../d4cubeoptimv3-rules-solver.test.js).
- [gear-slot-legality.js](../gear-slot-legality.js): machine-readable legality table.
- [weight-tracking.js](../weight-tracking.js): shared UMD module for outcome tracking and Bayesian roll-weight learning (Plackett–Luce MM update). Used by the browser tracker and by [scripts/learn-weights-from-tracking.js](../scripts/learn-weights-from-tracking.js), which patches `config.LEARNED_WEIGHTS` and bumps `MODEL_VERSION`. See [docs/game-mechanics.md](game-mechanics.md#learned-roll-weights-outcome-tracking).
- [docs/verified-affixes.md](verified-affixes.md): authoritative human-readable legality source. Unverified legacy entries are in [docs/maybe-affixes.md](maybe-affixes.md).
- [CHANGES.md](../CHANGES.md) plus [v2-improvement-notes](../v2-improvement-notes/): implementation history, requirement mapping, decisions, open issues, and next steps.

## High-Value Gotchas

- If you change behavior in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js), bump `WORKER_VERSION` in [d4cubeoptimv3.html](../d4cubeoptimv3.html) or the browser may keep a stale worker.
- `config.MODEL_VERSION` is broader than `WORKER_VERSION`: bump it on any change to the roll model, solver, or affix weights (a superset of `WORKER_VERSION`). It gates outcome-tracking data validity in the browser and is bumped automatically by the weight-learning script.
- `timeMs <= 0` currently means "use the largest configured residual cap," not "minimal search."
- For GA-sensitive residual benchmarking, populate `gaConfig.currentGAAffixes`. The residual environment still uses GA-count semantics inherited from [d4cubeoptimv2-worker.js](../d4cubeoptimv2-worker.js).
- Concrete gear slots are required for meaningful residual benchmarking. `Any` preserves a broader pool and can hide slot-specific behavior.
- Imported browser worker scripts share one global scope under `importScripts(...)`. Avoid top-level binding name collisions across [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js), [d4cubeoptimv2-worker.js](../d4cubeoptimv2-worker.js), and [d4cubeoptim-worker.js](../d4cubeoptim-worker.js).
- Some older markdown still describes the ILP layer more narrowly than the live code. When in doubt, trust [ilp.js](../ilp.js) and [ilp.test.js](../ilp.test.js).
- Slot-legality changes are cross-cutting: update [gear-slot-legality.js](../gear-slot-legality.js) and [docs/verified-affixes.md](verified-affixes.md). The UI and workers read the table dynamically, so no further changes are required for legality-only additions.

## Validation Workflow

- Focused v3 validation: `node --test d4cubeoptimv3-worker.test.js`
- Focused ILP validation: `node --test ilp.test.js`
- Full regression when shared helpers, legality, or cross-layer routing changes: `node --test ilp.test.js d4cubeoptim-worker.test.js d4cubeoptimv2-worker.test.js d4cubeoptimv3-worker.test.js`
- Browser smoke for UI changes: run `python3 -m http.server 8123` from the repo root and open [d4cubeoptimv3.html](../d4cubeoptimv3.html)

## Documentation Update Policy

- Update [AGENTS.md](../AGENTS.md), [docs/business-requirements.md](business-requirements.md), and [docs/implementation-guide.md](implementation-guide.md) when the v3 product contract or solver assumptions change.
- Update [CHANGES.md](../CHANGES.md) when the shipped v3 behavior, solver scope, or validation status changes.
- Update the relevant note in [v2-improvement-notes](../v2-improvement-notes/) when architecture, deferred work, or historical validation claims change.