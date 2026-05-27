/**
 * run-mc-parallel.js
 *
 * Parallel MC verification runner using Node.js worker_threads.
 * Drop-in complement to runMCVerificationV3 for script-side use.
 *
 *   const { runMCParallelV3 } = require("./run-mc-parallel");
 *   const result = await runMCParallelV3(payload, intermediateResult, {
 *     totalRollouts: 2000,
 *     numThreads: 16,
 *     masterSeed: 42,
 *   });
 *
 * ── Why two phases (sequential warmup + parallel main) ──────────────────────
 *
 * Empirically, ~100% of the wall time for a complex MC scenario is spent
 * inside the optimizer warming a per-process action cache. With 230 unique
 * reachable states each costing 5–800 ms to optimize, even on 16 cores the
 * total CPU work to discover them all is fixed.
 *
 * Naïve parallel (each thread runs K/N rollouts with its own cold cache)
 * forces every thread to independently re-discover ~all unique states, so
 * the wall time is dominated by max(per-thread warmup) and is actually
 * *slower* than single-threaded (each thread pays the full warmup cost).
 *
 * The pattern that actually works:
 *
 *   Phase 1 (main thread, sequential): run WARMUP_ROLLOUTS rollouts.
 *     Builds an action cache covering essentially all reachable states.
 *     Same cost as the warmup portion of a single-threaded K=N run.
 *
 *   Phase 2 (numThreads workers, parallel): each worker runs its share of
 *     the remaining rollouts, pre-loaded with the warm cache from phase 1.
 *     With the cache fully warm, post-warmup rollouts are ~1000× cheaper,
 *     so this phase is effectively free.
 *
 * Net effect for K=2000 on the Spiritborn benchmark:
 *   Single-threaded:          ~46 s  (warmup + 1900 free rollouts)
 *   Naïve parallel 16t:       ~88 s  (16× redundant warmup)
 *   Sequential warmup + 16t:  ~46 s  (warmup + parallel-free rollouts)
 *
 * For larger K, the parallel phase becomes a larger fraction of the total
 * and the speedup grows; but for typical K=2000 settings on hard scenarios,
 * the gain over single-threaded is negligible (parallelization can only
 * accelerate the part of the work that *is* parallel — the rollout sampling
 * — and that part is already <5 % of total time).
 *
 * True N× speedup would require parallelising the optimizer's per-unique-state
 * computation itself (e.g. BFS over reachable states with worker-pool dispatch
 * of optimizePayloadV3 calls). That is feasible but requires exposing several
 * private worker-module helpers and a meaningful redesign — deferred.
 */

"use strict";

const { Worker } = require("worker_threads");
const path = require("path");

const worker = require("../d4cubeoptimv3-worker.js");
const THREAD_FILE = path.join(__dirname, "mc-worker-thread.js");

// Spread `totalRollouts` across `numThreads` as evenly as possible.
function allocateRollouts(totalRollouts, numThreads) {
  if (numThreads <= 0) return [];
  const base = Math.floor(totalRollouts / numThreads);
  const remainder = totalRollouts % numThreads;
  return Array.from({ length: numThreads }, (_, i) => base + (i < remainder ? 1 : 0));
}

// Derive per-thread seeds from a master seed with good separation.
function deriveSeeds(masterSeed, numThreads) {
  const m = masterSeed >>> 0;
  return Array.from({ length: numThreads }, (_, i) => (m + i * 0x9E3779B9) >>> 0);
}

// Resolve how many warmup rollouts to run sequentially in the main thread.
// Defaults aim to cover essentially the full reachable state space for the
// scenario without doing significantly more work than necessary.
//   - At least 25 rollouts so cache coverage is good even for tiny K.
//   - At most ~10 % of K (a parallelisable bound) capped at 200 (enough to
//     fully warm even very deep scenarios in practice).
//   - Never more than totalRollouts itself.
function resolveWarmupCount(totalRollouts, override) {
  if (override != null && override >= 0) {
    return Math.min(override, totalRollouts);
  }
  const adaptive = Math.max(25, Math.ceil(totalRollouts * 0.05));
  return Math.min(adaptive, 200, totalRollouts);
}

// Spawn a single worker thread and return a Promise that resolves with its message.
function spawnThread(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(THREAD_FILE, { workerData });
    w.once("message", resolve);
    w.once("error", reject);
    w.once("exit", (code) => {
      if (code !== 0) reject(new Error(`MC worker thread exited with code ${code}`));
    });
  });
}

/**
 * @param {object} payload           — optimizer payload (must be JSON-serializable)
 * @param {object} intermediateResult — result from optimizePayloadV3
 * @param {object} [options]
 * @param {number} [options.totalRollouts]   default = worker.MC_HEAVY_ROLLOUTS
 * @param {number} [options.numThreads]      default = 16
 * @param {number} [options.masterSeed]      default = 42
 * @param {number} [options.warmupRollouts]  override the automatic warmup count
 * @returns {Promise<object>}         — same shape as runMCVerificationV3 return
 */
function runMCParallelV3(payload, intermediateResult, options = {}) {
  const totalRollouts = options.totalRollouts || worker.MC_HEAVY_ROLLOUTS;
  const numThreads = options.numThreads || 16;
  const masterSeed = options.masterSeed || 42;
  const warmupRollouts = resolveWarmupCount(totalRollouts, options.warmupRollouts);

  if (!intermediateResult || !intermediateResult.action) {
    return Promise.resolve(intermediateResult);
  }

  const t0 = Date.now();

  // ── Phase 1: sequential warmup in main thread ─────────────────────────────
  // Uses the same seeded PRNG approach as the workers; we seed Math.random
  // before calling so the warmup rollouts are statistically valid samples
  // and contribute to the final MC estimate.
  const warmupSeed = (masterSeed ^ 0xDEADBEEF) >>> 0;
  const originalRandom = Math.random;
  Math.random = (function () {
    let a = warmupSeed;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  let warmupResult;
  const warmupStart = Date.now();
  try {
    warmupResult = worker.runMCRolloutsRawV3(
      payload,
      intermediateResult.action,
      warmupRollouts
    );
  } finally {
    Math.random = originalRandom;
  }
  const warmupWallMs = Date.now() - warmupStart;
  const sharedCacheEntries = warmupResult.actionCacheEntries;

  // ── Phase 2: distribute remaining rollouts across worker threads ──────────
  const remainingRollouts = Math.max(0, totalRollouts - warmupRollouts);
  const allocation = allocateRollouts(remainingRollouts, numThreads);
  // Use a different seed offset so phase-2 paths differ from warmup.
  const mainSeeds = deriveSeeds((masterSeed + 0x5A827999) >>> 0, numThreads);

  const mainPromises = allocation.map((rolloutCount, i) => {
    if (rolloutCount === 0) {
      return Promise.resolve({ stepCounts: [], truncatedCount: 0, wallTimeMs: 0 });
    }
    return spawnThread({
      payload,
      rootAction: intermediateResult.action,
      rolloutCount,
      seed: mainSeeds[i],
      initialCacheEntries: sharedCacheEntries,
    });
  });

  return Promise.all(mainPromises).then((mainResults) => {
    const allStepCounts = [
      ...warmupResult.stepCounts,
      ...mainResults.flatMap((r) => r.stepCounts),
    ];
    const truncatedCount =
      warmupResult.truncatedCount +
      mainResults.reduce((s, r) => s + r.truncatedCount, 0);
    const maxThreadWallMs = Math.max(
      0,
      ...mainResults.map((r) => r.wallTimeMs || 0)
    );
    const wallTimeMs = Date.now() - t0;

    const stats = worker.computeMCStatsV3(allStepCounts);

    return {
      ...intermediateResult,
      expectedSteps: Number.isFinite(stats.mean) ? stats.mean : intermediateResult.expectedSteps,
      diagnostics: {
        ...intermediateResult.diagnostics,
        goldStandard: {
          applied: true,
          level: "parallel",
          rollouts: allStepCounts.length,
          mean: stats.mean,
          ci95halfWidth: stats.ci95halfWidth,
          stdev: stats.stdev,
          intermediateSteps: intermediateResult.expectedSteps,
          truncatedRolloutCount: truncatedCount,
          wallTimeMs,
          maxThreadWallMs,
          warmupWallMs,
          warmupRollouts,
          numThreads: allocation.filter((n) => n > 0).length,
          sharedCacheSize: sharedCacheEntries.length,
          aborted: false,
          earlyConverged: false,
          adaptive: false,
        },
      },
    };
  });
}

module.exports = { runMCParallelV3, allocateRollouts, deriveSeeds, resolveWarmupCount };
