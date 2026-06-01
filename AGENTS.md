# Project Guidelines

## Scope

- Start with [docs/README.md](docs/README.md), [docs/business-requirements.md](docs/business-requirements.md), and [docs/implementation-guide.md](docs/implementation-guide.md) before diving into the code.
- v3 is the only implementation. The standalone v1 (MCTS) and v2 (exact-SSP) workers have been removed; the shared transition helpers and residual-graph helpers that v3 needs are now inlined in `d4cubeoptimv3-worker.js`.
- The only files you should edit for solver/UI work are `d4cubeoptimv3-worker.js`, `d4cubeoptimv3-worker.test.js`, `d4cubeoptimv3.html`, `ilp.js`, `ilp.test.js`, `gear-slot-legality.js`, `config.js`, `weight-tracking.js`, the docs under `docs/`, `CHANGES.md`, and the notes under `v2-improvement-notes/`.
- `weight-tracking.js` — UMD module for outcome tracking and Bayesian roll-weight learning (Plackett–Luce MM update). Drives the browser tracker and `scripts/learn-weights-from-tracking.js`.

## Architecture

- Preserve the v3 routing order: feasibility checks `F4` through `F7` (F1-F3 removed), then closed-form Cases `A` through `G` (Case D removed), then decomposition plus ILP, then the residual LAO* path.
- Target affixes no longer have a `requireGA` field. GAs can only be preserved (via implicit protection when an existing source GA is on a target-aligned affix), never acquired. The enchant outcome is `isGA: false` when changing affixes; `isGA: !!source.isGA` only when keeping the same affix. The `gaRequiredCounts` map (populated from `gaConfig.currentGAAffixes`) remains the sole mechanism for preserving GAs when `strictMode` is enabled.
- Preserve the lexicographic objective: maximize `P(success)` first, then minimize expected cube steps among success-optimal actions.
- Keep the top-level diagnostics contract stable. `diagnostics.feasibility`, `diagnostics.decomposition`, `diagnostics.ilp`, and `diagnostics.residual` should always exist with explicit statuses.
- Do not casually rename strategy IDs or status values. The browser UI in `d4cubeoptimv3.html` translates the stable worker contract into user-facing text.
- Gear-slot legality comes from `gear-slot-legality.js`. Concrete slots must narrow the legal affix pool; `Any` must preserve the unrestricted pool. The legality table is hand-maintained against `docs/verified-affixes.md`; unverified entries that remain for safety are documented in `docs/maybe-affixes.md`.
- `getValidActionsV2` includes "same-affix fresh enchant" (`prismUnblockEnchants`) for two cases when no slot is yet enchanted: (a) a protected GA affix sharing a prism with missing targets — enchanting it in place sets `isEnchanted: true`, removes it from `getEligibleByCategory`, and makes `touchesProtectedGA` false so cube ops on that prism become available; (b) a non-GA matched-target affix sharing a prism with missing targets — enchanting it in place prevents `isCategoryFocusedBlockedByMatchedTargetV3` from blocking Cases B/C/F/G and prevents accidental cube-reroll of the locked slot. Do not filter out these same-affix enchants; removing them breaks the solver's ability to discover "enchant first, then cube-reroll" sequences.
- Browser worker scripts share one global scope under `importScripts(...)`. Avoid top-level name collisions between `d4cubeoptimv3-worker.js` and imported worker files.
- If you change `d4cubeoptimv3-worker.js` behavior, bump `WORKER_VERSION` in `d4cubeoptimv3.html` so the browser does not keep a stale cached worker.
- `config.MODEL_VERSION` is a separate, broader signal: bump it on ANY change to the roll model, the solver, or the affix weights (so it is a superset — whenever `WORKER_VERSION` changes, `MODEL_VERSION` should change too). The browser discards persisted outcome-tracking data when `MODEL_VERSION` changes, and `scripts/learn-weights-from-tracking.js` bumps it automatically after patching weights. The affix-roll weight model and the learning pipeline (`weight-tracking.js`, the `LEARNED_WEIGHTS` overlay in `buildAffixCatalog`, and the tracker UI) are documented in `docs/game-mechanics.md`.
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

- There is no build step, package manager, or bundler for the JavaScript path. Work directly in the checked-in HTML and JavaScript files.
- v3 worker validation: `node --test d4cubeoptimv3-worker.test.js`
- ILP validation: `node --test ilp.test.js`
- Weight-tracking validation: `node --test weight-tracking.test.js`
- Full JS regression: `node --test ilp.test.js d4cubeoptimv3-worker.test.js weight-tracking.test.js`
- Run a single test by name: `node --test --test-name-pattern="<substring>" <file>.test.js`
- Rust unit tests: `cargo test --manifest-path rust/Cargo.toml`
- JS vs Rust differential harness: `node scripts/diff-test-rust-vs-js.js` (phases 0–4; run after any Rust change)
- MC performance benchmark: `node scripts/benchmark-mc-rollouts.js`
- For browser smoke testing, run `python3 -m http.server 8123` from the repo root and load `d4cubeoptimv3.html`.

## Rust/WASM Extension

The optimizer's inner loop (`optimizePayloadV3` + `runMCVerificationV3`) is also implemented in Rust and compiled to WASM via `wasm-bindgen`. The JS path remains the primary path; the Rust path is loaded alongside it when the WASM module is available.

### Why the ILP solver stays in JavaScript

`ilp.js` does not move to Rust for three reasons:

1. **Not the bottleneck.** Per-cache-miss cost is dominated by the residual LAO\* solver and closed-form case analysis, not ILP.
2. **Coupling is per-unique-state, not per-step.** `solveILP` is called at most ~50–200 times per MC run (once per unique state, then cached). JSON-serialisable FFI overhead is negligible (~50 ms) compared with seconds saved on the LAO\* path.
3. **No mature Rust BILP crate.** The only viable option (`microlp`) documents its branch-and-bound as still in development. Replacing 2256 lines of battle-tested, 78-test-covered JS would trade speedup for correctness risk. Rust calls the registered JS `solveILP` closure synchronously via a single `wasm-bindgen` callback — clean, zero correctness risk, easy to swap if a mature solver appears.

### State representation

States are packed into a `u64` (57 bits used, 7 spare):

| Field | Bits |
|---|---|
| `isLegendary` | 1 |
| `gearSlot` (12 values) | 4 |
| `class` (9 values) | 4 |
| 4 × token\_id (265 affixes + 10 trash sigs + 1 empty = 276 → 9 bits) | 36 |
| 4 × `isGA` | 4 |
| 4 × `isEnchanted` | 4 |
| 4 × `isUnsatisfactory` | 4 |

Trash signatures (10 unique category-set combos) are pre-computed into an `affixId → trashSigId` lookup at env build time.

### FFI boundary

Three coarse entry points (JSON in/out):

1. `optimize(payloadJson, ilpCallback) → resultJson`
2. `runMCVerification(payloadJson, intermediateJson, ilpCallback) → resultJson`
3. `debug_residual_graph(stateJson, targetJson, dataJson, gaConfigJson) → debugJson` — permanent diagnostic/regression export

Callbacks: `{ solveILP: js_sys::Function, onProgress?: js_sys::Function, stopBuffer?: Int32Array }`.

### Build

Run `bash scripts/build-wasm.sh` after any Rust change. This produces `rust/pkg-node/` (for Node tests) and `rust/pkg-web/` (for the browser). The `rust/pkg-*/` directories are gitignored in this repo — **do not commit them here**. Deployment copies `pkg-web/` into `slaymaker1907.github.io` via `scripts/sync-github-pages.js`.

### Key footgun: `time_ms` inheritance in MC sub-calls

`runMCVerificationV3` calls `optimizePayloadV3` for each cache-miss state encountered during rollouts. These sub-calls **must inherit `time_ms` from the parent payload** so they use the same residual state-limit budget (e.g. `timeMs=30000` boosts the limit from 500 to ~2000 states). In JS this happens naturally via `{ ...payload, state }`. In Rust the sub-payload must explicitly copy `time_ms`, `tighten_steps_level`, and `tighten_steps_overrides`. Dropping `time_ms` causes the optimizer to return `action=null` for states that need a large graph, which truncates MC rollouts at `MC_ROLLOUT_STEP_CAP=1000` and produces wildly inflated mean estimates (~920 vs ~55 correct). This was fixed in `rust/src/mc.rs`; do not revert it.

### Current performance

Rust MC is approximately **7–8× faster** than JS MC for typical Spiritborn amulet scenarios (JS ~35 s, Rust ~4.5 s per 500 rollouts). This requires the **MC policy table fast-path** in `rust/src/mc.rs::build_policy_table`: at MC start, the residual graph is built once from the root state and LAO\* phase 1 + phase 2 are run to extract a `residual_abstract_state_key → best_action` map. Rollouts consult this table in O(1) per state instead of recomputing the optimizer per cache-miss state. Without the policy table, Rust MC is ~5× slower than JS because every cache miss re-runs `build_residual_reachable_graph_v3` from scratch.

The policy table covers the entire reachable abstract state space from the root (size ~625 for typical 4-affix scenarios, 0 misses observed). For states whose abstract key isn't in the table (graph state-limit exceeded, or the root didn't go through the residual layer cleanly), MC falls back to a full `optimize_payload_v3` sub-call — same path as before. The fallback path is also the only correctness-critical path; the policy table is pure optimization. See `extract_residual_policy_indices` in `rust/src/residual.rs` for the policy extraction and `lookup_policy_action` in `mc.rs` for the per-state lookup (which abstracts the MC concrete state and rewrites the action's `sourceIndex` to match the matching slot in the concrete state).

## Source Of Truth

- Start from current code and focused tests, then use [docs/README.md](docs/README.md), [docs/business-requirements.md](docs/business-requirements.md), [docs/implementation-guide.md](docs/implementation-guide.md), `CHANGES.md`, and `v2-improvement-notes/` for intent and handoff context.
- Some markdown notes can lag the current implementation. Re-check the live code before repeating older architectural claims.
- A current example: `ilp.js` and `ilp.test.js` now describe and test probing and clique-cut behavior, while some older handoff markdown still describes the ILP layer more narrowly.
- When you change v3 architecture, diagnostics, validation status, or major tuning assumptions, update `CHANGES.md` and the relevant file under `v2-improvement-notes/` in the same change.