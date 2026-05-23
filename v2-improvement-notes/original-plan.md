## Plan: Phased v3 Hybrid Solver Delivery

Build v3 as a gated, test-first rewrite that keeps the browser-only deployment model, fixes the known correctness issues in the common-case decomposition, and limits the new ILP solver to an exact small-problem engine that is realistic to implement and verify. The work should proceed in strict phases: lock interfaces first, prove the decomposition math second, then add the scoped ILP, then add the residual LAO* solver, and only after that finish end-to-end integration, progress handoff notes, and UI reporting.

## Goals

- Deliver new versioned files: `d4cubeoptimv3.html`, `d4cubeoptimv3-worker.js`, `ilp.js`, a Node-runnable v3 test harness, and `CHANGES.md`.
- Keep the no-build-step browser model: static JS and HTML only, no npm install, no bundler, no external optimizer dependency.
- Replace the v2 monolithic exact-SSP approach with a hybrid architecture: feasibility checks, closed-form decomposition for the common case, joint assignment-plus-scheduling optimization via ILP, and LAO* for residual hard cases.
- Preserve the lexicographic objective explicitly in the v3 worker: maximize `P(success)` first, then minimize `E[N | success]` among optimal-success policies.
- Ensure every mathematically-derived component has differential tests rather than relying on Monte Carlo or loose sanity checks.
- Prevent overclaiming: the ILP solver must be described honestly as a scoped exact solver for small binary ILPs, not as a full state-of-the-art branch-and-cut system.
- Maintain resumable in-repo progress notes under `/home/gagnier/Documents/Git/d4cubeoptim/v2-improvement-notes` so future Copilot sessions can continue from a clean written state.

## Scope Boundaries

### In Scope

- Feasibility checks F1 through F7 with structured diagnostics.
- Closed-form common-case sub-plan costs for Cases A through G.
- A from-scratch exact ILP solver sufficient for the assignment and scheduling problems in this project.
- A jointly optimized assignment and same-category ordering model.
- A residual exact solver using LAO* over an abstracted state space.
- A browser-facing v3 UI that surfaces failed feasibility checks, ILP non-optimal statuses, and residual iteration-limit failures.
- A test harness covering feasibility, closed-form formulas, ILP correctness, LAO* correctness, and end-to-end integration.
- A maintained markdown note set under `v2-improvement-notes` for progress, decisions, open issues, and next steps.

### Out of Scope

- A general-purpose production MIP engine with cutting planes, strong branching, conflict analysis, certificates, or advanced revised-simplex basis updates.
- Any new action beyond the existing cube action set: Add Affix, Chaotic Reroll, Focused Reroll, Remove Affix, Enchant.
- Bundled dependencies, transpilation, code generation, or platform-specific native code.
- Silent fallback from an incomplete phase to a later one; partial implementations must remain explicitly marked partial.

## Architecture Overview

### Worker Orchestrator

The v3 worker should be the top-level coordinator. It receives the existing payload shape, normalizes state and target predicates, runs feasibility checks first, then either solves the common case through decomposition plus ILP or escalates to the residual LAO* solver when decomposition assumptions do not hold.

### Feasibility Layer

This layer computes and validates the structural preconditions for solvability and decomposition. It is responsible for the tightened F2 host-existence check, the GA/improvement collision rule in F3, legality and exclusion checks, and structured diagnostics that can be displayed in the UI without reinterpreting internal errors.

### Closed-Form Cost Engine

This layer classifies candidate `(target affix, host slot)` pairs into Cases A through G and returns exact expected step formulas when a closed form is valid. It also provides the admissible heuristic inputs for the residual LAO* solver.

### ILP Layer

The ILP module should solve the small binary assignment-and-ordering model exactly. Its purpose is to select hosts and same-category execution order jointly, not to serve as a universal optimization package. The worker must only accept `OPTIMAL` from this layer and convert all other statuses into explicit diagnostics.

### Residual Solver

The residual solver handles cases the closed-form decomposition cannot safely cover, such as non-unique Remove victims, cross-category orphan interactions, or pool-dependence states that cannot be linearized cleanly. It should work over an abstraction that preserves all target-relevant information while collapsing uninteresting affixes into category-equivalence classes.

### UI Layer

The v3 UI should stay parallel to v2 for ease of adoption, but it must expose the richer diagnostics from the new architecture: failed feasibility check IDs, decomposition-vs-residual strategy choice, ILP solver failure states, and residual iteration-limit failures.

### Progress and Handoff Notes

The implementation should maintain a repo-local note set under `/home/gagnier/Documents/Git/d4cubeoptim/v2-improvement-notes` to survive Copilot session limits. These notes are part of the execution plan, not an optional convenience.

Recommended note files:
- `overview.md` — current objective, architecture summary, and overall status.
- `progress.md` — completed phases, files changed, tests run, and notable outcomes.
- `next-steps.md` — the exact next tasks to attempt in order, with blockers and dependencies.
- `decisions.md` — important design decisions, tradeoffs, and explicit non-goals.
- `open-issues.md` — unresolved correctness, performance, or UX issues.

Maintenance rule:
- create the folder and initial note files in Phase 0.
- update `progress.md` and `next-steps.md` at the end of every completed phase.
- update `decisions.md` whenever scope or architecture changes.
- update `open-issues.md` whenever a known problem is discovered but not fixed in the current phase.
- ensure the final entry in `next-steps.md` is always specific enough that a later session can resume work without rediscovering context.

## Phase 0: Foundations, Interfaces, and Handoff Scaffolding

Create the new v3 file set and lock the interfaces before writing solver logic. Mirror the v2 browser-worker protocol so the new worker can be dropped into the current workflow without additional tooling. Define and document the shared result shapes early so later phases do not drift. Create the progress-note scaffolding in the repository immediately so later phases always have a place to record handoff state.

Artifacts for this phase:
- `d4cubeoptimv3-worker.js` skeleton with documented top-of-file lex objective and worker message handling.
- `d4cubeoptimv3.html` skeleton wired to the v3 worker.
- `ilp.js` skeleton exporting the public solver API.
- test harness skeleton with shared timeout helper utilities.
- `CHANGES.md` skeleton with placeholder sections for algorithm changes, correctness fixes, and implementation scope notes.
- `v2-improvement-notes/overview.md` with project summary and phase map.
- `v2-improvement-notes/progress.md` with an initial execution log template.
- `v2-improvement-notes/next-steps.md` with the initial ordered task queue.
- `v2-improvement-notes/decisions.md` with initial scope boundaries and non-goals.
- `v2-improvement-notes/open-issues.md` with any known carry-forward issues from v2.

Phase exit criteria:
- v3 worker loads in browser and Node without syntax or runtime boot errors.
- result and diagnostic shapes are documented and stable enough for the next phases.
- test harness can execute at least one placeholder smoke test with enforced timeout.
- the `v2-improvement-notes` folder exists with the initial markdown files populated.

## Phase 1: Feasibility and State Classification

Implement F1 through F7 as a self-contained worker slice before any optimization work. This phase should normalize the target into the sets needed by later phases: required non-GA affixes, required GA affixes, protected affixes already present and needing preservation, improve-flagged affixes, and forbidden affixes. It should also compute the concrete enchant-host implications used by later phases instead of leaving them as implicit assumptions.

Required behavior in this phase:
- F1 validates initial GA-count sufficiency.
- F2 validates both the count bound and the existence of a specific disposable GA host for the one-time enchant.
- F3 detects collisions between GA-transfer use of enchant and GA-preserving improvement requirements.
- F4 validates slot-capacity against required and protected content.
- F5 validates slot or class pool legality for each required affix.
- F6 validates mutual exclusions such as typed-family conflicts.
- F7 validates required and forbidden disjointness.

Phase exit criteria:
- all feasibility checks return structured diagnostics of the form `{ ok, check, message, details }`.
- each check has a minimal failing test and a minimal passing test.
- the worker can halt early on feasibility failure and the UI can render that failure directly.
- `v2-improvement-notes/progress.md` records what was implemented and tested in this phase.
- `v2-improvement-notes/next-steps.md` is updated to point at the first unfinished task in Phase 2.

## Phase 2: Closed-Form Cost Model and Oracle Proofs

Implement the common-case cost engine next, because the ILP depends on it and the residual LAO* heuristic depends on the same formulas. Each case must be implemented through a clear classifier plus a formula evaluator, and every formula must be validated against a small exact tabular oracle rather than statistical testing.

Required behavior in this phase:
- implement Case A with the corrected formula `n - 1 + 1/n` rather than a naive `1/p` expectation.
- implement Cases B through G exactly as specified.
- detect when a candidate pair does not satisfy the assumptions of its nominal case and mark it as residual-only rather than forcing a bad coefficient.
- build a tabular transient-state oracle for each case and compare the closed-form answer to the oracle to within `1e-9`.

Phase exit criteria:
- every case A through G has differential oracle coverage.
- the classifier can explain why a candidate pair is closed-form solvable or residual-only.
- the worker has a stable way to populate ILP coefficients from trusted formulas.
- `v2-improvement-notes/progress.md` records formulas implemented, oracle results, and any residual-only edge cases discovered.
- `v2-improvement-notes/open-issues.md` records any ambiguous case-classification issues not solved in this phase.
- `v2-improvement-notes/next-steps.md` points at the concrete ILP work items for Phase 3.

## Phase 3: Scoped Exact ILP Solver

Build `ilp.js` only after the coefficients it will optimize are already trusted. The solver should be exact for small binary ILPs and honest about its limits. It should support the model structure this project needs well without pretending to be a general branch-and-cut engine.

Required implementation scope:
- linear minimization objective.
- `<=`, `>=`, and `=` linear constraints.
- variable bounds.
- binary variables mandatory; general integers optional if the implementation stays manageable.
- status reporting: `OPTIMAL`, `INFEASIBLE`, `UNBOUNDED`, `ITERATION_LIMIT`.
- two-phase simplex for the LP relaxation.
- basic presolve: fixed-variable elimination, trivial bound tightening, empty or redundant constraint removal, safe singleton substitution.
- branch-and-bound with a simple branching rule such as most-fractional branching.
- a small primal heuristic such as rounded-LP repair.
- clear tolerances and solver options surfaced in the API.

Required honesty constraints:
- do not call the solver branch-and-cut unless cuts are actually implemented.
- do not label a feasible incumbent as `OPTIMAL` without proof of optimality.
- if the search stops early, return `ITERATION_LIMIT` and propagate that status to the worker.

Phase exit criteria:
- `ilp.js` passes direct unit tests on small knapsack, assignment, set-cover, infeasible, and unbounded-style cases as supported by the LP layer.
- the API is stable enough for worker integration.
- `CHANGES.md` explicitly documents the scoped nature of the solver and what is intentionally not implemented.
- `v2-improvement-notes/progress.md` records solver features completed, known limitations, and test coverage.
- `v2-improvement-notes/decisions.md` records any important implementation tradeoffs inside `ilp.js`.
- `v2-improvement-notes/next-steps.md` points at the Phase 4 modeling work.

## Phase 4: Joint Assignment and Same-Category Scheduling

With the ILP engine available, encode the host-assignment and same-category ordering problem in one model. This phase is where the decomposition becomes globally optimized rather than greedily composed.

Required modeling behavior:
- binary host assignment variables for `(target, slot)` pairs.
- enchant-allocation variables where relevant.
- same-category ordering or position variables so later sub-plans in the same category see the shrunken pool size.
- protected slots excluded from host pools.
- forced enchant placement from F2 represented as fixed constraints rather than post-hoc logic.
- no separate scheduling pass after assignment; the ILP must optimize both jointly.

Required verification behavior:
- enumerate all legal assignment-and-ordering combinations for representative small scenarios.
- compute the exact total cost for each combination using the trusted closed-form formulas.
- verify the ILP returns the global minimum.
- include at least one case where greedy assignment or assignment-without-ordering is suboptimal.

Phase exit criteria:
- worker can solve decomposition-eligible instances end to end without invoking LAO*.
- ILP-vs-exhaustive-enumeration differential tests pass.
- the assignment layer exposes enough detail to explain the chosen host and order decisions in diagnostics if needed.
- `v2-improvement-notes/progress.md` records the final model shape, validation results, and any modeling simplifications.
- `v2-improvement-notes/next-steps.md` points at the residual LAO* work for Phase 5.

## Phase 5: Residual LAO* Solver

Implement LAO* only after the decomposition path is already correct and testable. The residual solver exists to handle exactly those states where the decomposition assumptions break, not to replace the whole architecture.

Required behavior in this phase:
- trigger residual solving for non-unique Remove victims, cross-category orphan cases, pool starvation, or any other case where the closed-form classifier declines to assign an exact sub-plan cost.
- abstract all affixes outside the relevant set `{required-NGA, required-GA, protected, improve, forbidden}` into category-equivalence representatives carrying only category, GA, and enchanted flags.
- use an admissible heuristic derived from the closed-form sub-costs while ignoring setup costs when necessary to maintain admissibility.
- solve the two-phase lex objective in the residual state space: first maximize success probability, then minimize conditional expected steps among success-optimal actions.
- enforce convergence tolerance `1e-9` and a hard iteration cap of `4096`, surfacing a clear solver error if the cap is hit.

Required verification behavior:
- on abstract instances with reachable state count at most `500`, compare LAO* against exact value iteration to within `1e-9` on both `V1` and `V2`.
- include at least one regression for a residual-trigger case that decomposition must refuse.

Phase exit criteria:
- residual-only scenarios solve correctly with exact differential evidence.
- the worker can explain why a case was escalated from decomposition to LAO*.
- iteration-limit failures are returned as explicit, user-visible diagnostics.
- `v2-improvement-notes/progress.md` records abstraction choices, heuristic details, and differential-test outcomes.
- `v2-improvement-notes/open-issues.md` records any remaining convergence or scaling concerns.
- `v2-improvement-notes/next-steps.md` points at integration and UI work for the next phase.

## Phase 6: End-to-End Worker Integration

Once the solver components are individually trustworthy, wire them into the v3 worker’s top-level decision flow. This phase is where the final behavior contract is established.

Required decision flow:
1. Normalize state and target inputs.
2. Run F1 through F7 and fail early on infeasible inputs.
3. Build candidate common-case sub-plans and determine whether decomposition is fully applicable.
4. If decomposition is fully applicable, solve joint assignment-plus-ordering via ILP and return that strategy.
5. If decomposition is not fully applicable, escalate to residual LAO* and return that strategy.
6. Convert all internal solver statuses into stable public diagnostics rather than surfacing raw exceptions.

Required output behavior:
- preserve the worker message pattern used by v2.
- return a stable result schema across feasibility failure, decomposition success, residual success, and solver-limit or error outcomes.
- include strategy identifiers and structured diagnostics so the UI can render them without worker-specific special cases.

Phase exit criteria:
- decomposition-only cases, residual-required cases, and infeasible cases all route correctly through the worker.
- top-of-file documentation explicitly states the lex objective and the conditional-on-success interpretation of the second objective.
- worker integration tests pass under Node.
- `v2-improvement-notes/progress.md` records the final orchestration path and end-to-end validation status.
- `v2-improvement-notes/next-steps.md` points at UI and final validation tasks.

## Phase 7: UI Integration and Diagnostics

Finish the v3 HTML only after the worker’s external contract is stable. Keep the interaction model familiar to users of v2, but expose the richer solver reasoning from v3 instead of compressing everything into a single opaque recommendation.

Required UI behavior:
- load `d4cubeoptimv3-worker.js` and keep the same static browser deployment model.
- surface failed feasibility checks with both the check ID and human-readable explanation.
- surface whether the chosen strategy was decomposition-plus-ILP or residual LAO*.
- surface ILP non-optimal statuses and residual iteration-limit failures explicitly.
- preserve the current user workflow for entering item state, target affixes, and GA or improvement flags.

Phase exit criteria:
- manual smoke test in browser succeeds for at least one infeasible case, one decomposition case, and one residual case.
- UI renders diagnostics without requiring developer-console inspection.
- `v2-improvement-notes/progress.md` records manual smoke-test results and any UI rough edges.
- `v2-improvement-notes/next-steps.md` points at documentation and final handoff tasks.

## Phase 8: Documentation, Validation, and Handoff

Complete the project by hardening the tests, running full validation, and documenting what changed from v2 to v3. This phase should make it difficult for a later implementation to overclaim completeness.

Required deliverables in this phase:
- fill out `CHANGES.md` with the architectural shift from v2 to v3, the correctness fixes, the scoped ILP design, and the residual solver behavior.
- provide a requirement matrix mapping each requested feature to implementation and test locations.
- run the full v3 suite plus the existing v2 suite to guard against regressions in shared helper semantics.
- leave explicit notes for any intentionally deferred enhancements rather than silently omitting them.
- finalize the `v2-improvement-notes` folder so a later session can immediately understand current status and next actions.

Phase exit criteria:
- all requested v3 tests pass within documented timeouts.
- full-suite validation is recorded.
- requirement matrix is complete enough to audit claims against code and tests.
- `v2-improvement-notes/progress.md` has a final summary entry.
- `v2-improvement-notes/next-steps.md` either becomes empty with a completion note or lists the exact deferred follow-ups.

## Relevant Files

- `/home/gagnier/Documents/Git/d4cubeoptim/d4cubeoptimv2-worker.js` — baseline worker orchestration, current exact-SSP logic, and message protocol to preserve.
- `/home/gagnier/Documents/Git/d4cubeoptim/d4cubeoptimv2.html` — baseline UI structure and worker wiring to parallel in v3.
- `/home/gagnier/Documents/Git/d4cubeoptim/d4cubeoptim-worker.js` — shared transition-helper and action-semantics source that v3 should continue loading via `require` or `importScripts`.
- `/home/gagnier/Documents/Git/d4cubeoptim/d4cubeoptimv2-worker.test.js` — baseline test style and current exact-solver regression coverage.
- `/home/gagnier/Documents/Git/d4cubeoptim/algorithm.md` — semantic reference where v3 needs to stay aligned with the documented optimization model.
- `/home/gagnier/Documents/Git/d4cubeoptim/v2-improvement-notes` — repo-local continuation notes used to survive session limits and support later handoff.

## Verification Strategy

### Unit-Level Verification

- F1 through F7 each need one minimal passing and one minimal failing test.
- Cases A through G each need oracle-based differential tests to `1e-9`.
- `ilp.js` needs standalone unit tests before worker integration.
- abstraction helpers and residual-trigger classification need direct tests so escalation behavior is not only exercised indirectly.

### Differential Verification

- closed-form formulas versus explicit transient-state oracle.
- ILP assignment-and-ordering result versus exhaustive enumeration.
- LAO* versus exact value iteration on small abstract graphs.

### Integration Verification

- one decomposition-only success case with `P(success) = 1`.
- one F2-tightening rejection that v2 would have accepted.
- one residual-required case due to non-unique Remove victims or cross-category orphan interactions.

### Timeout Policy

- small feasibility and oracle tests: around `1000 ms` each.
- ILP differential and enumeration tests: around `2000 ms` each.
- LAO* versus value-iteration tests: around `4000 ms` each.
- aggregate suite timeout should remain a modest multiple of the sum of per-test timeouts.
- the harness should document why these numbers were chosen and fail loudly on timeout.

## Risks and Mitigations

### ILP Scope Creep

Risk: the ILP module grows into a pseudo-general optimizer and delays the worker rewrite.

Mitigation: lock the ILP scope to exact small binary ILPs, document non-goals in `CHANGES.md`, and require direct unit tests before worker integration.

### Incorrect Closed-Form Classification

Risk: a candidate sub-plan is forced into a closed-form case whose assumptions do not actually hold.

Mitigation: make the classifier return residual-only whenever assumptions are ambiguous, and differential-test every formula independently of the worker.

### Residual Solver Overreach

Risk: LAO* becomes the default path because decomposition triggers are too broad or too narrow.

Mitigation: add explicit residual-trigger tests and keep the trigger reasons visible in diagnostics.

### Handoff Drift

Risk: work progresses but the repo-local markdown notes fall out of date, reducing their value for a resumed session.

Mitigation: make note maintenance part of every phase exit criterion, and require `next-steps.md` to be updated before pausing or ending a phase.

### Overclaiming Completion

Risk: the implementation claims full v3 completion while some solver components are only partial.

Mitigation: require a requirement matrix, phase-by-phase test evidence, and explicit partial-status notes in code comments, `CHANGES.md`, and `v2-improvement-notes/open-issues.md`.

## Phase Discipline Rules

- phases must be completed in order.
- no phase may be claimed complete without the tests specific to that phase passing.
- later phases must not silently compensate for incomplete earlier phases.
- if a phase is partial, the implementation must say so explicitly in code comments and in `CHANGES.md`.
- `v2-improvement-notes/progress.md` and `v2-improvement-notes/next-steps.md` must be updated at the end of every completed phase.
- the implementation agent should stop after each phase and summarize code changes, test evidence, and note updates before starting the next phase if human review is desired.

## Decisions

- The ILP solver is intentionally simplified to balance exactness, performance, and ease of implementation for the real problem sizes in this repository.
- Assignment and same-category ordering remain a joint optimization problem.
- Differential testing is the primary correctness mechanism for all mathematically-derived behavior.
- LAO* is a residual exact solver, not the default engine.
- Browser compatibility and no-build-step deployment remain non-negotiable.
- Repo-local markdown handoff notes are mandatory project artifacts, not optional documentation.
