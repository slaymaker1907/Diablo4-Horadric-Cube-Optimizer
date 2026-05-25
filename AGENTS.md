# Project Guidelines

## Scope

- Start with [docs/README.md](docs/README.md), [docs/business-requirements.md](docs/business-requirements.md), and [docs/implementation-guide.md](docs/implementation-guide.md) before diving into the code.
- v3 is the only implementation. The standalone v1 (MCTS) and v2 (exact-SSP) workers have been removed; the shared transition helpers and residual-graph helpers that v3 needs are now inlined in `d4cubeoptimv3-worker.js`.
- The only files you should edit for solver/UI work are `d4cubeoptimv3-worker.js`, `d4cubeoptimv3-worker.test.js`, `d4cubeoptimv3.html`, `ilp.js`, `ilp.test.js`, `gear-slot-legality.js`, `config.js`, the docs under `docs/`, `CHANGES.md`, and the notes under `v2-improvement-notes/`.

## Architecture

- Preserve the v3 routing order: feasibility checks `F4` through `F7` (F1-F3 removed), then closed-form Cases `A` through `G` (Case D removed), then decomposition plus ILP, then the residual LAO* path.
- Target affixes no longer have a `requireGA` field. GAs can only be preserved (via implicit protection when an existing source GA is on a target-aligned affix), never acquired. The enchant outcome is `isGA: false` when changing affixes; `isGA: !!source.isGA` only when keeping the same affix. The `gaRequiredCounts` map (populated from `gaConfig.currentGAAffixes`) remains the sole mechanism for preserving GAs when `strictMode` is enabled.
- Preserve the lexicographic objective: maximize `P(success)` first, then minimize expected cube steps among success-optimal actions.
- Keep the top-level diagnostics contract stable. `diagnostics.feasibility`, `diagnostics.decomposition`, `diagnostics.ilp`, and `diagnostics.residual` should always exist with explicit statuses.
- Do not casually rename strategy IDs or status values. The browser UI in `d4cubeoptimv3.html` translates the stable worker contract into user-facing text.
- Gear-slot legality comes from `gear-slot-legality.js`. Concrete slots must narrow the legal affix pool; `Any` must preserve the unrestricted pool.
- Browser worker scripts share one global scope under `importScripts(...)`. Avoid top-level name collisions between `d4cubeoptimv3-worker.js` and imported worker files.
- If you change `d4cubeoptimv3-worker.js` behavior, bump `WORKER_VERSION` in `d4cubeoptimv3.html` so the browser does not keep a stale cached worker.
- GA preservation is always on in v3: `strictMode: true` is always sent from the v3 UI; the `Target GA Strict` toggle no longer exists. Source GAs on target-aligned affixes are implicitly added to `gaRequiredCounts` in `buildEnv`. The closed-form decomposition model now applies `isCategoryFocusedBlockedByGAV3` to Cases B, C, F, and G: if any protected GA affix (non-enchanted, in `gaRequiredCounts`) shares the prism category, that prism is skipped and the case escalates to the residual solver. The residual solver then blocks those actions via `touchesProtectedGA`. Do not add a toggle for this behavior.
- D4 GA mechanics: GAs can never be acquired through cube or enchant operations — they can only be preserved. Enchanting to a different affix always produces non-GA; enchanting to the same affix (keep) preserves GA. The `requireGA` field is removed from all code paths.

## Expected Steps Metric

The "Expected Cube Steps" value shown in the UI (and `result.expectedSteps` in the worker contract) is **E[steps until terminal state]**, not E[steps until success]. Terminal states are either success (all target affixes satisfied with GA preserved) or failure (a protected GA is broken, ending the run). When P(Success, GA Preserved) < 100%, a GA-breaking action terminates the run early, so the expected steps count will be *lower* than it would be for the unconstrained case — because most runs end fast via failure. This is correct and expected; do not treat a lower expected-steps value alongside a lower success probability as a contradiction.

## Residual And Performance Guidance

- Thinking Time is a residual-budget input, not a wall-clock cutoff for exact routes.
- The current residual budget starts at `500` abstract states and `4096` iterations, ramps by `50` states/second and `32768` iterations/second, and caps at `4096` states and `1048576` iterations.
- In the current budget policy, `timeMs <= 0` means "use the largest configured residual cap." Do not assume `0` means "minimum search."
- For residual-limit or performance tuning, benchmark concrete gear slots rather than `Any`.
- For GA-sensitive residual cases, populate `gaConfig.currentGAAffixes`. The v3 residual environment still inherits `sourceTotalGACount` semantics from `d4cubeoptimv2-worker.js`.
- Former hard benchmark: the concrete Amulet case `Maximum Life + Damage Reduction + All Damage (GA) + Attack Speed -> Critical Strike Chance + Mainstat + All Damage (Require GA) + Elemental Damage (Physical)` previously did not converge even at the cap. This was a convergence-condition bug (joint `maxDelta < epsilon AND policy-signature-match` requirement looped forever on tied actions). Fixed in the Phase 1 and Phase 2 solvers; the case now converges to `OPTIMAL` well within the default budget.

## Build And Test

- There is no build step, package manager, or bundler. Work directly in the checked-in HTML and JavaScript files.
- v3 worker validation: `node --test d4cubeoptimv3-worker.test.js`
- ILP validation: `node --test ilp.test.js`
- Full regression: `node --test ilp.test.js d4cubeoptimv3-worker.test.js`
- For browser smoke testing, run `python3 -m http.server 8123` from the repo root and load `d4cubeoptimv3.html`.

## Source Of Truth

- Start from current code and focused tests, then use [docs/README.md](docs/README.md), [docs/business-requirements.md](docs/business-requirements.md), [docs/implementation-guide.md](docs/implementation-guide.md), `CHANGES.md`, and `v2-improvement-notes/` for intent and handoff context.
- Some markdown notes can lag the current implementation. Re-check the live code before repeating older architectural claims.
- A current example: `ilp.js` and `ilp.test.js` now describe and test probing and clique-cut behavior, while some older handoff markdown still describes the ILP layer more narrowly.
- When you change v3 architecture, diagnostics, validation status, or major tuning assumptions, update `CHANGES.md` and the relevant file under `v2-improvement-notes/` in the same change.