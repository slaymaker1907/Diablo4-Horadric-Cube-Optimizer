# Parallel MC Verification — Investigation Notes

**Branch:** `parallel-mc` (not merged to `master`)
**Date:** May 2026
**Status:** Investigation complete. Current implementation achieves ~1.0× speedup (neutral, not a regression). True N× speedup requires deeper changes — deferred. This document is the reference if/when we want to come back to it.

---

## What was tried

A Node.js `worker_threads`-based parallel runner for `runMCVerificationV3`-style Monte Carlo rollout verification. Three iterations:

| # | Design | K=2000, 16t, Spiritborn 3-affix | Status |
|---|---|---|---|
| 1 | Naïve: split K across N threads, each with its own cold action cache | **0.6×** (61 s vs 32 s) | Regression |
| 2 | Two-phase: N parallel warmup threads → merge caches → N parallel main threads | **0.7×** (61 s vs 32 s) | Still regression |
| 3 | Sequential main-thread warmup → N parallel main threads with pre-warmed cache | **1.0×** (32 s vs 32 s) | Neutral — current |

All three were statistically valid (means within 3 × combined SE of single-threaded). Iteration 3 is what ships on this branch.

## Why parallelisation caps at ~1× on hard scenarios

I measured this directly: for the Spiritborn 3-affix scenario (`Movement Speed`, `Attack Speed`, `Vulnerable Damage` enchanted, targeting `Elemental Damage (Physical)`):

- Single-threaded K=2000: **32 s**
- 200-rollout warmup alone (single-threaded): **57 s**, builds an action cache of **230 unique states**
- 200 rollouts *with that cache pre-loaded*: **0.2 s** (264× speedup)
- 1800 rollouts with that cache pre-loaded: **2.1 s** (~1.2 ms/rollout vs ~285 ms/rollout cold)

So ~98 % of MC time is spent inside `optimizePayloadV3`, warming a per-process action cache. The 230 unique states cost between ~3 ms (simple 3-affix states) and ~800 ms each (the wrong 4-affix "stuck recovery" states where the optimal action is Focused Aggressive removal that may collateral-damage other target affixes). Average per-state cost is ~200 ms.

The warmup is *sequential within a process* because each `optimizePayloadV3` call builds a fresh `env` and discards it. There is no cross-call result cache, so calling the optimizer for the same state twice does the full work twice.

In the rollout loop, the local `actionCache` in `runMCRolloutsRawV3` masks this: the *second* visit to the same state within a single call is free. But every fresh call (= every worker thread) pays the full warmup cost again.

## Why iterations 1 and 2 were worse than single-threaded

**Iteration 1 (naïve split):** With K/16 ≈ 125 rollouts per thread, *every* thread independently encounters most of the 230 unique states, so each thread pays roughly the full ~30 s warmup cost. Wall time = max(thread time) ≈ 30 s on 16 cores… but in practice closer to 60 s due to:

- Limited physical-core count on the test machine (16 logical threads competing for ~8 cores).
- V8 JIT compiling per-thread (each isolate compiles its hot paths independently).
- Garbage-collection pressure: 16 threads each allocating heavily.

**Iteration 2 (parallel warmup → merged cache → parallel main):** The intent was to dilute the per-thread warmup cost. But empirically each warmup thread *still* discovers ~200 of the 230 states in its 25 warmup rollouts (random walks of 25 × ~80 = 2000 steps cover most of the state space). So the parallel warmup wasn't actually parallel work — it was 16× redundant work. Plus the structured-clone overhead of shipping a ~17 KB merged cache to each main-phase thread.

**Iteration 3 (sequential warmup → parallel main):** Main thread does the warmup once (cost ≈ single-threaded warmup cost ≈ ~30 s on this scenario). Workers then do the remaining rollouts with the pre-warmed cache, each finishing in ~150–2500 ms (essentially free). Total wall time ≈ warmup time. *This is the best possible result without changing the optimizer's architecture* — you cannot shrink the warmup phase by adding more threads, because it's a single sequential traversal.

## What would actually deliver N× speedup

The work the threads need to *share* is the per-unique-state `optimizePayloadV3` call. There are ~230 of them, each independent (given the payload). With 16 workers each computing ~15 of those calls, wall time drops to ~3 s + the rollout phase (~2 s) ≈ **5 s vs 32 s single-threaded → ~6× speedup** on this scenario.

The approach:

1. **Main thread enumerates reachable states via BFS.** Start with the root state and its known action. Run `getActionOutcomes(state, action, env)` to get successor states (cheap — no optimizer call). For each successor that isn't terminal or already in the action map, add it to a "needs action" queue.
2. **Dispatch the queue to a worker pool.** Each worker computes `optimizePayloadV3({ ...payload, state }, { refineDepth: 0 })` for its assigned states and returns `[stateKey, action]` pairs.
3. **Main thread receives results, advances the BFS frontier** by calling `getActionOutcomes` with the newly known actions to expand the next level of states.
4. **Iterate until no new states.** The action map now covers every reachable state under the optimal policy.
5. **Run the actual MC rollouts** with the fully warm cache. This phase can be single-threaded or parallel — it doesn't matter because it's now ~2 s for K=2000.

Implementation requirements:

- Export `getActionOutcomes`, `isTerminal`, `buildEnv`, `stateKey`, `filterValidMCOutcomesV3`, and `expandFamilyOtherInStateV3` from `d4cubeoptimv3-worker.js`. Currently all private.
- New worker-thread file `mc-state-worker-thread.js` that just runs `optimizePayloadV3` for a batch of states with a seeded PRNG (some optimizer paths call `Math.random` — though the action *should* be deterministic given a state, this needs verification).
- Rewrite `scripts/run-mc-parallel.js` around the BFS + worker-pool dispatch.

Estimated effort: 1–2 hours of focused work. Estimated payoff: 5–10× on hard scenarios, near-neutral on simple ones (where the warmup is already cheap).

### Subtleties to handle in the BFS approach

- **`expandFamilyOtherInStateV3` is stochastic** (uses `Math.random` to pick a family member when an affix is a "family other" placeholder). For most states this is a no-op. When it isn't, the BFS would need to enumerate all family members as separate successor states rather than picking one. Need to confirm whether any reachable state in typical scenarios actually triggers this — if not, BFS can ignore it.
- **State-space size for the worst case.** For the Spiritborn scenario it's 230 states; for harder scenarios with many enchanted/GA slots it could be in the thousands. The BFS would need a sanity cap (e.g. 50,000 states) with a fallback to single-threaded if exceeded. In practice, the unbounded case is also too slow for `runMCVerificationV3` to handle today, so this is no worse than the status quo.
- **`Math.random` in the worker thread.** Workers should still seed `Math.random` for reproducibility, even though `optimizePayloadV3` *should* be deterministic given a state. If any optimizer code path uses `Math.random` for tie-breaking, two workers computing the same state could disagree on the action. Worth checking whether the optimizer is truly deterministic.

## Files on this branch

- `d4cubeoptimv3-worker.js` — new `runMCRolloutsRawV3` (raw rollout executor for worker threads), with `options.initialCacheEntries` to pre-load a cache and `actionCacheEntries` in the return value.
- `scripts/run-mc-parallel.js` — `runMCParallelV3(payload, intermediateResult, options)` async runner. Sequential warmup in main thread, then parallel main phase with shared warm cache.
- `scripts/mc-worker-thread.js` — Node.js `worker_threads` entry point. Seeds `Math.random` from `workerData.seed`, then calls `runMCRolloutsRawV3` with the pre-warmed cache.
- `scripts/benchmark-mc-parallel.js` — measures single-threaded vs parallel wall times on the two Spiritborn Amulet scenarios, asserts statistical agreement within 3 SE.

## How to re-run the benchmark

```
git checkout parallel-mc
node scripts/benchmark-mc-parallel.js
```

Takes ~2 minutes. Exits 0 if both scenarios' means agree within 3 × combined SE, non-zero otherwise.

## Decision

Don't merge `parallel-mc` to `master` today. The infrastructure is fine and the implementation is clean, but the user-visible win on the scenarios that motivated this work is zero (~1.0× speedup). Keep this branch as a starting point for the BFS-based redesign described above if/when we want to pursue it.
