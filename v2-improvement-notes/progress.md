# Progress Log

## 2026-05-23

### Completed

- Created [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).
- Implemented Phase 1 feasibility checks `F1` through `F7` with structured diagnostics.
- Implemented Phase 2 closed-form helpers for Cases `A` through `G` in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).
- Added residual-only explanations for target-slot pairs that cannot safely use a closed-form coefficient.
- Added [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js) oracle-based differential coverage for Cases `A` through `G`.
- Added a stable `buildClosedFormPlanTableV3` target-slot coefficient table builder for later ILP integration.
- Added [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js) covering the new feasibility slice and the temporary fallback path.
- Added [ilp.js](../ilp.js) as a Phase 0 public API scaffold.
- Implemented the Phase 3 exact small-problem ILP solver in [ilp.js](../ilp.js) with presolve, two-phase simplex relaxations, most-fractional branch-and-bound, and rounded-LP repair.
- Added [ilp.test.js](../ilp.test.js) with direct regression coverage for knapsack, assignment, set-cover, infeasible, unbounded LP-layer, and singleton-presolve cases.
- Implemented the Phase 4 decomposition-plus-ILP path in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) for decomposition-safe instances.
- Added decomposition-input construction, assignment-and-stage ILP modeling, and structured host/order diagnostics to [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).
- Added exhaustive-enumeration differential coverage for a same-category scheduling case in [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js).
- Implemented the Phase 5 residual abstraction, abstract-state graph builder, and LAO*-style policy-graph backups in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).
- Added exact abstract-oracle differentials, residual abstraction-key coverage, iteration-limit coverage, and residual-routing integration coverage in [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js).
- Implemented the Phase 6 top-level worker contract normalization in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) so feasibility, decomposition, ILP, and residual diagnostics are always present with explicit statuses.
- Added Phase 6 worker-integration tests in [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js) for infeasible, decomposition, residual, residual iteration-limit, and done-message paths.
- Created [d4cubeoptimv3.html](../d4cubeoptimv3.html) by cloning the v2 UI and rewiring it to the v3 worker.
- Implemented the Phase 7 UI diagnostics rendering in [d4cubeoptimv3.html](../d4cubeoptimv3.html), including strategy, feasibility, decomposition/ILP, and residual status summaries plus a dedicated solver-diagnostics panel.
- Fixed a browser-only worker bootstrap collision in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) by renaming the v3-local shared-helper binding so `importScripts("./d4cubeoptimv2-worker.js")` no longer redeclares `baseWorker` in the same worker global scope.
- Fixed a late Phase 7 routing bug in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js): when the decomposition ILP has no feasible exact host assignment, the worker now escalates into the residual solver instead of returning a terminal ILP failure.
- Added a focused regression in [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js) covering the reproduced four-affix case where decomposition options exist per target but the global ILP assignment is infeasible.
- Fixed the residual-budget policy in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) so `timeMs` scales the residual state and iteration caps; the reproduced browser case now stops at `STATE_LIMIT` only under the old base budget and returns an optimal residual recommendation under the default 10-second UI budget.
- Tuned the residual iteration budget in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) from concrete-slot benchmarks: the current cap is now `1048576` iterations with a steeper `32768` iterations/second ramp, while the `4096`-state cap stays unchanged because the reproduced Amulet benchmark remained iteration-bound at only `348` abstract states.
- Relaxed [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) decomposition option filtering so multi-category targets stay in decomposition when closed-form candidates already pin explicit prisms/actions, including deterministic enchant coverage with no prism token.
- Added solver-limit approximate fallbacks in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js): decomposition now returns a feasible ILP incumbent when status is `ITERATION_LIMIT`, and residual LAO* now returns a best-so-far policy estimate with explicit approximate diagnostics instead of a null-action limit failure.
- Added approximation arbitration in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js): wide-gap ILP approximations now trigger residual comparison, and final approximate results are selected by lexicographic objective with confidence tie-breaks.
- Updated [d4cubeoptimv3.html](../d4cubeoptimv3.html) so the Thinking Time control and solver-limit diagnostics describe the new residual-budget behavior accurately, and bumped `WORKER_VERSION` so the browser reloads the worker.
- Added [gear-slot-legality.js](../gear-slot-legality.js) from [gear_to_affix.md](../gear_to_affix.md), applied slot legality narrowing in [d4cubeoptim-worker.js](../d4cubeoptim-worker.js) and [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js), and updated [d4cubeoptim.html](../d4cubeoptim.html), [d4cubeoptimv2.html](../d4cubeoptimv2.html), and [d4cubeoptimv3.html](../d4cubeoptimv3.html) so a concrete gear slot prunes impossible affixes while `Any` preserves the unrestricted pool.
- Added [requirement-matrix.md](requirement-matrix.md) to map the requested v3 features to implementation files and validation evidence.
- Reviewed the public strategy and diagnostics labels exposed through [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) and [d4cubeoptimv3.html](../d4cubeoptimv3.html), and froze the current naming instead of landing a late Phase 8 rename.
- Added [CHANGES.md](../CHANGES.md).
- Created the repo-local handoff note set in `v2-improvement-notes`.
- Added focused regressions in [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js) for multi-category decomposition routing (explicit-prism add and deterministic-enchant paths).
- Added focused regressions in [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js) for approximate decomposition ILP-incumbent routing and approximate residual iteration-limit routing.
- Added a focused regression in [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js) proving wide-gap ILP approximations can be compared against residual and the strategy can prefer residual when warranted.

### Validation

- `node --test ilp.test.js` passed with 6 tests.
- `node --test d4cubeoptimv3-worker.test.js` passed with 34 tests.
- `node --test ilp.test.js d4cubeoptim-worker.test.js d4cubeoptimv2-worker.test.js d4cubeoptimv3-worker.test.js` passed with 73 tests.
- Browser smoke test over `python3 -m http.server 8123` passed for:
	- infeasible typed-family conflict -> `Feasibility Stop` with `F6`.
	- decomposition case -> `Decomposition + ILP` with selected-option detail lines.
	- residual full-item remove-ambiguity case -> `Residual LAO*` with explicit `State Limit` diagnostics.

### Notes

- The v3 worker now solves decomposition-safe cases directly and routes residual-only cases through the Phase 5 residual solver.
- Discretionary Case `E` enchant is now opt-in at the pairwise helper level so the future ILP layer can decide when to spend the shared one-shot enchant resource.
- The Phase 5 residual solver now derives its residual graph and iteration budget from Thinking Time: it still starts from the 500-state / 4096-iteration exact base, but the default browser budget widens that search and `0s` uses the largest configured residual cap.
- Concrete-slot benchmarking showed the hard reproduced Amulet case stayed iteration-bound even at `2097152` iterations, so this tuning deliberately raises the residual iteration ceiling without changing the abstract-state ceiling or pretending the current Phase 5 residual engine is unbounded.
- Gear-slot legality is now enforced across the shared worker, the v3 closed-form pool-size helpers, and all browser entry points; selecting a concrete slot narrows the legal affix catalog and usually reduces compute time by shrinking the roll pool.
- The Phase 6 worker contract now keeps `diagnostics.decomposition`, `diagnostics.ilp`, and `diagnostics.residual` present even when those layers are not run, so UI code can branch on explicit status values instead of missing fields.
- The browser smoke pass surfaced a worker-only bootstrap defect that Node tests missed: `importScripts("./d4cubeoptimv2-worker.js")` shared a global scope with `d4cubeoptimv3-worker.js`, so top-level binding names must stay distinct across imported worker scripts.
- The reproduced UI case with Protector hosts plus aggressive keeps confirmed a separate routing lesson: decomposition applicability is not the same as decomposition solvability, so an ILP `INFEASIBLE` result in the decomposition slice must escalate into the residual solver rather than stop the run.
- The note set in this folder must be updated at the end of each completed phase.

### Final Summary

- Phase 8 is complete. The repo now contains the requested v3 implementation, a requirement matrix, consolidated validation notes, and explicit deferred follow-ups.
- The public UI/worker contract was reviewed one final time and no late diagnostic rename was necessary; the current strategy IDs and status values are now the frozen Phase 8 baseline.
- Remaining follow-up work is explicit rather than implicit: sparse residual expansion, slot-specific roll weights or class refinements, and any later contract changes are deferred and tracked in [open-issues.md](open-issues.md).