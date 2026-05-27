#!/usr/bin/env node
/**
 * mc-worker-thread.js
 *
 * Node.js worker_threads entry point for a single MC rollout batch.
 * Spawned by run-mc-parallel.js; not intended to be run directly.
 *
 * workerData: {
 *   payload              — full optimizer payload (JSON-serializable)
 *   rootAction           — pre-computed action for payload.state (cache warm-up)
 *   rolloutCount         — number of rollouts this thread should run
 *   seed                 — uint32 seed for the Mulberry32 PRNG
 *   initialCacheEntries  — optional Array<[key, action]> to pre-populate the
 *                          action cache, avoiding redundant optimizer calls for
 *                          already-discovered states
 *   returnCache          — if true, include actionCacheEntries in the response
 *                          (used by warmup threads; omit to save bandwidth)
 * }
 *
 * Posts one message:
 *   { stepCounts, truncatedCount, wallTimeMs[, actionCacheEntries] }
 */

"use strict";

const { workerData, parentPort } = require("worker_threads");

// ── Mulberry32 PRNG — install BEFORE requiring the worker module so any
//    module-level init also uses the seeded generator. ───────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(workerData.seed);

// ── Load the optimizer ───────────────────────────────────────────────────────
const worker = require("../d4cubeoptimv3-worker.js");

// ── Run the rollout batch ────────────────────────────────────────────────────
const t0 = Date.now();
const result = worker.runMCRolloutsRawV3(
  workerData.payload,
  workerData.rootAction,
  workerData.rolloutCount,
  { initialCacheEntries: workerData.initialCacheEntries || null }
);
const wallTimeMs = Date.now() - t0;

// Return the action cache only when requested (warmup threads).
// Omitting it for main-phase threads avoids transferring hundreds of KB
// of structured-clone data that the caller won't use.
const msg = { stepCounts: result.stepCounts, truncatedCount: result.truncatedCount, wallTimeMs };
if (workerData.returnCache) {
  msg.actionCacheEntries = result.actionCacheEntries;
}

parentPort.postMessage(msg);
