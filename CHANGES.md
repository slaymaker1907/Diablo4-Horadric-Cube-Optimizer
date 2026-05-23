# CHANGES

## v2 to v3

This file tracks the staged transition from the v2 exact-SSP solver to the v3 hybrid architecture documented in [v2-improvement-notes/original-plan.md](v2-improvement-notes/original-plan.md).

## Current Status

- Phase 0 implemented: v3 worker scaffold, v3 HTML scaffold, ILP module scaffold, and repo-local handoff notes.
- Phase 1 implemented: feasibility checks F1 through F7 with structured diagnostics.
- Phase 2 implemented: closed-form Case A through G classification, exact expected-step formulas, residual-only explanations, and a stable target-slot coefficient table builder.
- Phase 3 implemented: exact small-problem ILP solving with presolve, two-phase simplex LP relaxations, most-fractional branch-and-bound, and a rounded-LP repair heuristic.
- Phase 4 implemented: the v3 worker now solves decomposition-safe cases end to end through the closed-form cost engine plus the scoped ILP layer.
- Phase 5 implemented: residual-only cases now route through an abstract-state residual solver with LAO*-style policy-graph backups and exact differentials against the abstract oracle.
- Phase 6 implemented: the v3 worker now exposes a stable top-level result contract across feasibility failure, decomposition success, residual success, and residual solver-limit outcomes, while preserving the existing done-message pattern.
- Phase 7 implemented: the v3 UI now renders the stable worker diagnostics contract, including feasibility failures, decomposition-versus-residual strategy choice, ILP outcomes, and residual solver-limit failures.
- Phase 8 implemented: requirement mapping, final validation consolidation, public-contract freeze review, and final handoff notes.

## Phase 8 Outputs

- Requirement matrix: [v2-improvement-notes/requirement-matrix.md](v2-improvement-notes/requirement-matrix.md)
- Final note-set status: [v2-improvement-notes/overview.md](v2-improvement-notes/overview.md), [v2-improvement-notes/progress.md](v2-improvement-notes/progress.md), [v2-improvement-notes/next-steps.md](v2-improvement-notes/next-steps.md), [v2-improvement-notes/decisions.md](v2-improvement-notes/decisions.md), and [v2-improvement-notes/open-issues.md](v2-improvement-notes/open-issues.md)

## Correctness Fixes Landed So Far

- Added explicit v3 feasibility diagnostics with stable check IDs (`F1` through `F7`).
- Added the tightened F2 enchant-host existence check so missing GA transfer requests fail clearly when no unlocked disposable GA host exists.
- Added the F3 GA-improvement collision check so the one-time enchant cannot be silently double-booked.
- Added a Phase 2 closed-form classifier that can explain when a target-slot pair must be escalated to the residual solver instead of forcing an unsupported coefficient.
- Added exact oracle-based differential tests for Cases A through G so the closed-form formulas are checked against tabular Markov expectations.
- Added direct ILP regression coverage for knapsack, assignment, set-cover, infeasible, unbounded LP-layer, and presolve-driven singleton cases.
- Added Phase 4 decomposition integration so decomposition-safe instances no longer rely on the v2 fallback path.
- Added an ILP-vs-exhaustive-enumeration differential for a same-category scheduling case.
- Added a residual abstraction key, an abstract-state graph builder, LAO*-style policy-graph backups, and exact abstract-oracle differentials for residual-only cases.
- Added explicit residual iteration-limit and abstract-state-limit diagnostics instead of silently falling back to v2.
- Added a normalized v3 diagnostics contract so `feasibility`, `decomposition`, `ilp`, and `residual` diagnostics are always present with explicit statuses, even when a layer is not run.
- Added worker-integration coverage for infeasible, decomposition, residual, residual iteration-limit, and done-message result paths.
- Added Phase 7 browser rendering for the stable diagnostics contract, including dedicated strategy, feasibility, decomposition/ILP, and residual summary fields plus detailed solver-diagnostics text.
- Fixed a browser-only worker bootstrap bug where importing `d4cubeoptimv2-worker.js` into `d4cubeoptimv3-worker.js` via `importScripts(...)` collided on the shared `baseWorker` binding.
- Fixed a decomposition routing false negative where a globally infeasible ILP host assignment was surfaced as terminal `INFEASIBLE` instead of escalating into the residual solver.
- Fixed the residual-budget policy so `payload.timeMs` now widens the residual abstract-state and iteration caps instead of leaving every browser run pinned to the 500-state / 4096-iteration defaults.
- Added shared gear-slot legality tables from [gear_to_affix.md](gear_to_affix.md), applied them to the shared worker and v3 closed-form pool sizes, and wired all browser entry points so a concrete slot prunes impossible affixes while `Any` preserves the full pool.

## Planned Algorithmic Differences

- v3 will replace the monolithic exact-SSP approach with feasibility analysis, closed-form common-case costs, a scoped exact ILP for host assignment and ordering, and a residual LAO* solver.
- The ILP solver in [ilp.js](ilp.js) is intentionally scoped for exact small binary ILPs. It now implements presolve, two-phase simplex relaxations, and branch-and-bound without cuts, and it should not be described as branch-and-cut or state-of-the-art.
- The current residual implementation expands the abstract graph up front within a budget derived from Thinking Time (500-state / 4096-iteration base, up to 4096 states and 1048576 iterations with a steeper iteration ramp), then runs LAO*-style policy-graph backups on that abstraction. This is exact for the supported residual slice, but it is not yet a large-state sparse-expansion residual engine.

## Validation Notes

- Current focused ILP validation command: `node --test ilp.test.js`
- Current focused validation command: `node --test d4cubeoptimv3-worker.test.js`
- Existing v2 regression command remains: `node --test d4cubeoptim-worker.test.js d4cubeoptimv2-worker.test.js`
- Phase 3 validation currently passes 6 direct ILP tests in `ilp.test.js`.
- Phase 5 validation currently passes 22 tests in the focused v3 worker suite.
- Phase 6 validation currently passes 25 tests in the focused v3 worker suite.
- Phase 7 browser smoke results:
	- infeasible typed-family conflict renders `Feasibility Stop` with `F6` in the UI.
	- decomposition case renders `Decomposition + ILP` with selected-option details.
	- residual full-item remove-ambiguity case renders `Residual LAO*` with explicit `State Limit` diagnostics.
- Current focused v3 worker validation status: 29 tests passing.
- Current combined regression command: `node --test ilp.test.js d4cubeoptim-worker.test.js d4cubeoptimv2-worker.test.js d4cubeoptimv3-worker.test.js`
- Current combined regression status: 73 tests passing.

## Deferred Work

- Sparse residual expansion beyond the current bounded abstract-graph approach if larger browser cases make that necessary.
- Slot-specific roll weights, class-specific legality refinements, and value-threshold objectives if those become in-scope.
- Any future public-contract changes should be treated as deliberate post-Phase-8 work rather than implied cleanup.