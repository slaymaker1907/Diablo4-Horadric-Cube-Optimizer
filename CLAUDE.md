# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-only tool that recommends the **single best next Horadric Cube affix-modification action** to move a Diablo IV item from its current state toward a desired target. It is an iterative assistant: the user enters the current item + target, gets one recommended action, applies the in-game result manually, updates state, and reruns. There is no backend, no build step for the JS path, and no bundler — `d4cubeoptimv3.html` runs directly off the checked-in JS.

Only **v3** exists. The standalone v1 (MCTS) and v2 (exact-SSP) workers have been deleted; the shared transition and residual-graph helpers v3 needs are now inlined in `d4cubeoptimv3-worker.js`. Some markdown under `docs/` still references the removed `d4cubeoptim-worker.js` / `d4cubeoptimv2-worker.js` files — trust the live code and `AGENTS.md` over those stale references.

## Read first

`AGENTS.md` is the authoritative, detailed guide and takes precedence over the `docs/` folder where they disagree. For game rules (prisms, cube operations, GA mechanics, the learned-weights model) read `docs/game-mechanics.md`. When code and markdown conflict, trust the live code and focused tests.

## Commands

No package manager or `package.json` — everything runs through `node --test`, `cargo`, and standalone scripts.

```bash
# Focused JS suites
node --test d4cubeoptimv3-worker.test.js      # v3 solver/orchestrator
node --test ilp.test.js                        # exact small ILP engine
node --test weight-tracking.test.js            # outcome-tracking / weight learning

# Full JS regression (run when shared helpers, legality, or routing change)
node --test ilp.test.js d4cubeoptimv3-worker.test.js weight-tracking.test.js

# Run a single test by name within a file
node --test --test-name-pattern="<substring>" d4cubeoptimv3-worker.test.js

# Rust
cargo test --manifest-path rust/Cargo.toml
bash scripts/build-wasm.sh                      # rebuild WASM after any Rust change

# JS vs Rust differential harness (run after any Rust change; phases 0–4)
node scripts/diff-test-rust-vs-js.js

# Browser smoke test
python3 -m http.server 8123                     # then open d4cubeoptimv3.html
```

## Files you edit for product work

`d4cubeoptimv3-worker.js`, `d4cubeoptimv3-worker.test.js`, `d4cubeoptimv3.html`, `ilp.js`, `ilp.test.js`, `gear-slot-legality.js`, `config.js`, `weight-tracking.js`, the docs under `docs/`, `CHANGES.md`, and the notes under `v2-improvement-notes/`.

- `d4cubeoptimv3-worker.js` — the entire solver stack: feasibility checks, closed-form case engine, decomposition model, residual abstraction, and the LAO*-style solver. Action generation, outcome distributions, strict-mode/GA handling, and legality-aware pools are inlined here.
- `d4cubeoptimv3.html` — browser UI, persisted state, worker wiring, result rendering, manual outcome application, the outcome-tracker UI, and the `WORKER_VERSION` cache-buster.
- `ilp.js` — exact small binary-ILP engine (probing + clique cuts). Stays in JS deliberately; see the WASM section.
- `gear-slot-legality.js` — hand-maintained legal-affix-by-slot table, sourced from `docs/verified-affixes.md` (unverified leftovers in `docs/maybe-affixes.md`). The UI and worker read it dynamically, so legality-only additions need no other changes.
- `config.js` — class/skill catalog, affix model, `MODEL_VERSION`, and the `LEARNED_WEIGHTS` overlay.
- `weight-tracking.js` — UMD module for outcome tracking and Bayesian roll-weight learning (Plackett–Luce MM update). Drives the browser tracker and `scripts/learn-weights-from-tracking.js`.

## Solver architecture (the big picture)

The v3 worker routes each query through a fixed pipeline — **preserve this order**:

1. **Feasibility** checks `F4`–`F7` (F1–F3 removed) — reject impossible targets explicitly instead of faking a success estimate.
2. **Closed-form cases** `A`–`G` (Case D removed) — fast exact answers for common shapes.
3. **Decomposition + ILP** — exact host assignment via `ilp.js`. A decomposition `INFEASIBLE` is **not** a terminal user result; it escalates to the residual solver.
4. **Residual LAO\*** — abstract-state solver for everything else.

The objective is **lexicographic**: maximize eventual `P(Success, GA Preserved)` first, then minimize expected cube steps among success-optimal policies.

The top-level **diagnostics contract is part of the product interface**: `diagnostics.feasibility`, `diagnostics.decomposition`, `diagnostics.ilp`, and `diagnostics.residual` must always exist with explicit statuses, and the HTML UI translates stable strategy IDs / status values into user-facing text. Don't casually rename strategy IDs or status values.

### GA (Greater Affix) preservation — always on

GA preservation is always enabled (`strictMode: true` is always sent from the UI; there is no toggle). Key invariant: **GAs can only be preserved, never acquired.** Enchanting to a *different* affix yields `isGA: false`; enchanting to the *same* affix preserves `isGA`. There is no `requireGA` field — implicit protection via the `gaRequiredCounts` map (populated from source GAs on target-aligned affixes in `buildEnv`) is the sole mechanism. Cases B/C/F/G skip any prism category touching a protected GA (`isCategoryFocusedBlockedByGAV3`) and escalate to the residual solver, which blocks the action via `touchesProtectedGA`.

Do **not** filter out the "same-affix fresh enchant" actions (`prismUnblockEnchants`) in `getValidActionsV2` — they let the solver discover "enchant first, then cube-reroll" sequences; removing them breaks correctness.

### Expected-steps semantics

`result.expectedSteps` is **E[steps until terminal state]** (success *or* GA-break failure), not E[steps until success]. When `P(Success) < 100%`, runs often end early via a GA-breaking failure, so a *lower* expected-steps value alongside a *lower* success probability is correct, not a contradiction.

### Residual budget

Thinking Time widens the residual search budget; it is **not** a wall-clock cutoff for exact routes. `timeMs <= 0` means "use the **largest** configured cap," not minimal search. Budget starts at 500 abstract states / 4096 iterations, ramps 50 states/s + 32768 iters/s, caps at 4096 states / 1048576 iterations. Benchmark **concrete** gear slots (not `Any`) and populate `gaConfig.currentGAAffixes` for GA-sensitive cases — `Any` hides slot-specific behavior.

## Rust / WASM extension

The hot inner loop (`optimizePayloadV3` + `runMCVerificationV3`) is mirrored in Rust (`rust/src/`, compiled via `wasm-bindgen`) and loaded alongside the JS path when available. **JS remains the primary, correctness-critical path.** Rust MC is ~7–8× faster for typical scenarios, contingent on the MC policy-table fast-path in `rust/src/mc.rs`.

- `ilp.js` deliberately stays in JS (not the bottleneck; called per-unique-state not per-step; no mature Rust BILP crate). Rust calls the registered JS `solveILP` closure synchronously via one `wasm-bindgen` callback.
- States pack into a `u64` (57/64 bits used). See the FFI/state-layout tables in `AGENTS.md` before touching `keys.rs` / `intern.rs` / `env.rs`.
- **Footgun:** MC sub-calls (`runMCVerificationV3` → `optimizePayloadV3`) must inherit `time_ms`, `tighten_steps_level`, and `tighten_steps_overrides` from the parent payload. Dropping `time_ms` makes the optimizer return `action=null` for large-graph states, truncating rollouts and producing wildly inflated estimates. Fixed in `rust/src/mc.rs` — do not revert.
- `rust/pkg-*/` build outputs are gitignored — **never commit them.** Deployment copies `pkg-web/` into `slaymaker1907.github.io` via `scripts/sync-github-pages.js`.

## Versioning gotchas (must-bump rules)

- Change `d4cubeoptimv3-worker.js` behavior → bump `WORKER_VERSION` in `d4cubeoptimv3.html`, or the browser keeps a stale cached worker.
- Change the roll model, solver, or affix weights → bump `config.MODEL_VERSION`. It is a **superset** of `WORKER_VERSION` (whenever `WORKER_VERSION` changes, `MODEL_VERSION` should too). The browser discards persisted outcome-tracking data when `MODEL_VERSION` changes; `scripts/learn-weights-from-tracking.js` bumps it automatically after patching weights.

## Shared-scope hazard

Browser worker scripts load via `importScripts(...)` into **one global scope**. Avoid top-level binding name collisions across worker files.

## Documentation update policy

When you change v3 architecture, diagnostics, validation status, or major tuning assumptions, update `CHANGES.md` **and** the relevant note under `v2-improvement-notes/` in the same change. Keep `AGENTS.md`, `docs/business-requirements.md`, and `docs/implementation-guide.md` in sync when the product contract or solver assumptions change.
