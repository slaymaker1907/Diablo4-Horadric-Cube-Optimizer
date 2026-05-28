# v4 Rust/WASM Rewrite Plan

## Goal

Speed up the Monte Carlo step estimator (`runMCVerificationV3`).
Profiling shows MC wall time is dominated by the ~50–200
`optimizePayloadV3(..., {refineDepth:0})` calls that trigger on cache
misses (~100 ms each = 5–20 s total), not by the MC loop itself (~1–2 s).
Porting only the inner MC loop would yield ~1.05–1.15×. To get real
speedup we must port the optimiser pipeline that backs each cache miss.

**Realistic end-to-end target: 5–6× faster MC** (browser WASM, no threads).

---

## Why the ILP Solver Stays in JavaScript

`ilp.js` (2256 lines, pure JS, zero external deps) does NOT need to
move to Rust for three independent reasons:

1. **It is not the bottleneck.** The per-cache-miss cost is dominated
   by the residual LAO\* solver and closed-form case analysis, not ILP.
   ILP is fast and accounts for only a small fraction of per-call wall time.

2. **Coupling is per-unique-state, not per-step.** In a 2000-rollout
   adaptive MC run, `solveILP` is called at most ~50–200 times total
   (once per unique state seen, then cached). The JS↔Rust callback
   overhead for ~200 JSON-serialisable calls is negligible (~50 ms
   total) compared with the seconds saved on the LAO\* path.

3. **The only WASM-viable Rust BILP crate (`microlp`) is not
   production-ready.** Its branch-and-bound for integer variables is
   documented as still in development and may lose precision on hard
   problems. Replacing 2256 lines of battle-tested, 78-test-covered JS
   with an immature library would trade a real speedup for substantial
   correctness risk. The ILP I/O is pure numeric data (JSON-serialisable),
   so Rust calls into `ilp.js` via a single `wasm-bindgen` callback
   closure — clean, zero correctness risk, and easy to swap later if a
   mature Rust BILP solver appears.

---

## Boundary Design

Three coarse FFI entry points (JSON in/out, no streaming objects):

1. `optimize(payloadJson, options) → resultJson`
2. `runMCVerification(payloadJson, intermediateJson, options, callbacks) → resultJson`
3. `buildEnv(dataJson, gaConfigJson, targetJson) → envHandle`
   — MC reuses one env across all rollouts; translation runs once, not 2000×

Callbacks passed per call:
`{ solveILP: js_sys::Function, onProgress: js_sys::Function?, stopBuffer: Int32Array }`

`stopBuffer` is a `SharedArrayBuffer`-backed `Int32Array` so Rust polls
the stop signal via `Atomic*` ops, preserving existing UX (worker.js:5838).

---

## State Representation

Packed `u64` per state. 57 bits suffice with 7 to spare:

| Field | Bits |
|---|---|
| `isLegendary` | 1 |
| `gearSlot` (12 values) | 4 |
| `class` (9 values) | 4 |
| 4 × token\_id (265 affixes + 10 trash sigs + 1 empty = 276 → 9 bits) | 36 |
| 4 × `isGA` | 4 |
| 4 × `isEnchanted` | 4 |
| 4 × `isUnsatisfactory` | 4 |
| **Total** | **57** (7 bits spare) |

Trash signatures (10 unique category-set combinations) are pre-computed
into an `affixId → trashSigId` lookup at env build time.

---

## Phasing

All phases ship behind a `D4_USE_RUST` flag (env var in Node, global in
browser). JS path stays green and unmodified throughout — deleted only
after cutover + telemetry in Phase 6.

### Phase 0 — Toolchain (1–2 days)
- Add `rust/` with `Cargo.toml` and `wasm-pack` config.
- Build targets: `pkg-node/` (`--target nodejs`) for tests,
  `pkg-web/` (`--target web`) for browser.
- Commit built `.wasm` and binding `.js` so the "no deploy build step"
  constraint (AGENTS.md) is preserved. Developers run
  `scripts/build-wasm.sh` when changing Rust.
- Worker loader at `d4cubeoptimv3-worker.js:31-40` learns to load the
  WASM module alongside `ilp.js` when `D4_USE_RUST` is set.
- Add `scripts/diff-test-rust-vs-js.js`: runs both implementations
  against the same payload, asserts equality to `1e-9` abs /
  `1e-6` rel (matching `RESIDUAL_PHASE2_EPSILON`, worker.js:71).

### Phase 1 — Pure leaves + shared env (2–3 days)
Port and verify in isolation:
- `stateKey` (line 636), `stateKeyV2` (1939), `cloneState` (654),
  `actionKey` (758)
- `isTerminal` (711), `breaksRequiredGA` (735), `getAffixCounts` (675)
- `buildEnv` (364) — returns a Rust struct with int-translation tables
  for affixIds, gear slots, classes, categories, families, and the 10
  trash signatures.

### Phase 2 — Feasibility + closed-form A–G (3–4 days)
Port `analyzeFeasibilityV3`, `buildDecompositionPlanInputV3`, and
closed-form cases A–G. Pure functions, no ILP, no recursion.
Easy differential testing. After this phase, easy cases bypass JS.

### Phase 3 — Residual LAO\* (5–8 days, biggest payoff)
Port the algorithm at `d4cubeoptimv3-worker.js:4276-4793`:
- `buildResidualReachableGraphV3` (4276) — BFS with packed-u64
  deduplication; flat `Vec<NodeData>` and contiguous transition arrays
  replace JS pointer-chased nested objects.
- `solveResidualLAOPhase1V3` (4624) — value iteration for P(success)
- `solveResidualLAOPhase2V3` (4687) — relative-tolerance iteration for
  E[steps]; preserve `RESIDUAL_PHASE2_EPSILON` semantics exactly.
- `buildResidualPhase2EligibleActionsV3`, `selectBestResidualPhase*`
- `solveResidualLAOStarV3` (4772), `solveResidualExactV3` (4766)

### Phase 4 — `optimizePayloadV3` + ILP callback (3–4 days)
Port `optimizePayloadV3` (5268), `computeOptimizationResultV3` (5291),
`refineRootActionV3`. Rust calls the registered JS `solveILP` closure
synchronously per ILP solve. Recursive `optimizePayloadV3` calls (from
refinement) stay inside Rust — no re-crossing the FFI.

### Phase 5 — MC verification (2–3 days)
Port `runMCVerificationV3` (5719) and helpers: `pickWeightedOutcomeV3`,
`filterValidMCOutcomesV3`, `expandFamilyOtherInStateV3`,
`computeMCStatsV3`. RNG seeded from a JS-provided seed so validation
runs produce bit-identical step-count histograms; decoupled afterward.
Progress callbacks throttled inside Rust (every N rollouts) to avoid
2000 FFI crossings per run.

### Phase 6 — Cutover (1–2 days)
Flip `D4_USE_RUST` default to true. Bump `WORKER_VERSION` in
`d4cubeoptimv3.html`. Keep JS path one release cycle. After two weeks
of clean telemetry, remove v3 JS bodies (~3500 lines) in a clean
commit; `ilp.js` stays forever.

---

## Key Files

| File | What changes |
|---|---|
| `d4cubeoptimv3-worker.js` | Loader shim + `D4_USE_RUST` dispatch only |
| `ilp.js` | Unchanged; invoked via callback |
| `d4cubeoptimv3.html` | Worker instantiation (line 1533) + WASM fetch |
| `scripts/sync-github-pages.js` | Add `pkg-web/` to sync targets |
| `rust/` (new) | Cargo workspace |
| `pkg-node/`, `pkg-web/` (new, committed) | Built WASM artifacts |
| `scripts/build-wasm.sh` (new) | Dev build helper |
| `scripts/diff-test-rust-vs-js.js` (new) | Differential test harness |

---

## Verification

**Each phase:**
```
D4_USE_RUST=false node --test d4cubeoptimv3-worker.test.js
D4_USE_RUST=true  node --test d4cubeoptimv3-worker.test.js
D4_USE_RUST=false node --test ilp.test.js
D4_USE_RUST=true  node --test ilp.test.js
cargo test
```

**Differential harness:** `scripts/diff-test-rust-vs-js.js` with random
and golden-corpus payloads; assert float equality to `1e-9` / `1e-6`.

**Phase 5 only (MC bit-equivalence):** Fixed RNG seed; assert Rust and
JS produce identical step-count histograms. Decouple after sign-off.

**Browser smoke:** Load `d4cubeoptimv3.html` with `D4_USE_RUST=true`;
run the amulet benchmark (Critical Strike + Mainstat + All Damage (GA)
+ Elemental Damage); verify headline within tolerance of JS result.

**CI matrix:** `{flag=js, flag=rust} × {node-test, browser-smoke}`.

---

## Honest Speedup Estimate

| Component | JS | Rust/WASM | Speedup |
|---|---|---|---|
| `optimizePayloadV3` cache-miss (LAO\* + closed-form) | 5–20 s | 0.7–3 s | ~7× |
| MC step iteration (cache hit) | 1–2 s | 0.15–0.3 s | ~7× |
| ILP solves (unchanged, JS callback) | ~0.5 s | ~0.5 s | 1× |
| FFI overhead | — | ~50 ms | — |
| **End-to-end MC** | **6.5–22.5 s** | **1.4–3.8 s** | **~5–6×** |

WASM (browser), no thread parallelism. A native Node addon with rayon
would add another 2–3× via parallel rollouts after cache warm-up.

---

## Risks

| Risk | Mitigation |
|---|---|
| "No build step" constraint (AGENTS.md) | Commit built `.wasm` to repo |
| `microlp` temptation later | Explicitly out of scope; JS callback is the answer |
| WASM bundle size | `wasm-opt -Oz` in release; target < 500 KB compressed |
| Float determinism JS↔Rust | Tolerance-based diff testing; WASM is strict IEEE-754 |
