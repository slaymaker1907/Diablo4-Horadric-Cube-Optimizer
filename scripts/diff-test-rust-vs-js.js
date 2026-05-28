#!/usr/bin/env node
// Differential testing harness: runs payloads through both the JS and Rust/WASM
// implementations of optimizePayloadV3 and asserts results agree within tolerance.
//
// Usage:
//   node scripts/diff-test-rust-vs-js.js          # run all registered cases
//   node scripts/diff-test-rust-vs-js.js --phase 0 # Phase 0: WASM smoke test only
//
// Tolerances match the worker's own convergence constants:
//   absolute: 1e-9  (RESIDUAL_EPSILON)
//   relative: 1e-6  (RESIDUAL_PHASE2_EPSILON)

"use strict";

const assert = require("node:assert/strict");

const ABS_TOL = 1e-9;
const REL_TOL = 1e-6;

function floatEq(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const diff = Math.abs(a - b);
  if (diff <= ABS_TOL) return true;
  return diff <= REL_TOL * Math.max(Math.abs(a), Math.abs(b));
}

function assertFloatEq(label, a, b) {
  if (!floatEq(a, b)) {
    throw new Error(`${label}: JS=${a} Rust=${b} diff=${Math.abs(a - b)}`);
  }
}

// ── Phase 0: WASM module smoke test ──────────────────────────────────────────

function runPhase0() {
  console.log("Phase 0: WASM smoke test");

  let rustMod;
  try {
    rustMod = require("../rust/pkg-node/d4optimizer.js");
  } catch (e) {
    throw new Error(`Failed to load rust/pkg-node/d4optimizer.js: ${e.message}\nRun scripts/build-wasm.sh first.`);
  }

  const version = rustMod.d4optimizer_version();
  assert.ok(typeof version === "string" && version.length > 0, "d4optimizer_version() returns non-empty string");
  assert.match(version, /^v4-rust-/, "version starts with v4-rust-");
  console.log(`  d4optimizer_version() = "${version}"  OK`);

  console.log("Phase 0: PASSED\n");
}

// ── Phase 1+: optimizePayloadV3 differential tests ───────────────────────────
// Populated incrementally as algorithm phases are ported.

const differentialCases = [
  // { name: "...", payload: {...}, options: {...} }
  // Will be added in Phase 1.
];

function runDifferential() {
  if (differentialCases.length === 0) {
    console.log("No differential cases registered yet (will be added in Phase 1).");
    return;
  }

  const jsWorker = (() => {
    const saved = process.env.D4_USE_RUST;
    process.env.D4_USE_RUST = "false";
    // Clear require cache so the env var is picked up.
    delete require.cache[require.resolve("../d4cubeoptimv3-worker.js")];
    const w = require("../d4cubeoptimv3-worker.js");
    process.env.D4_USE_RUST = saved;
    return w;
  })();

  const rustWorkerModule = (() => {
    process.env.D4_USE_RUST = "true";
    delete require.cache[require.resolve("../d4cubeoptimv3-worker.js")];
    const w = require("../d4cubeoptimv3-worker.js");
    return w;
  })();

  let passed = 0;
  let failed = 0;

  for (const tc of differentialCases) {
    try {
      const jsResult = jsWorker.optimizePayloadV3(tc.payload, tc.options || {});
      const rustResult = rustWorkerModule.optimizePayloadV3(tc.payload, tc.options || {});

      assertFloatEq(`${tc.name}.expectedSteps`, jsResult.expectedSteps, rustResult.expectedSteps);
      assert.equal(jsResult.action && jsResult.action.type, rustResult.action && rustResult.action.type,
        `${tc.name}: action.type mismatch`);

      console.log(`  PASS: ${tc.name}`);
      passed++;
    } catch (e) {
      console.error(`  FAIL: ${tc.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDifferential: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const phaseArg = args.indexOf("--phase");
const onlyPhase = phaseArg >= 0 ? Number(args[phaseArg + 1]) : null;

if (onlyPhase === null || onlyPhase === 0) runPhase0();
if (onlyPhase === null || onlyPhase >= 1) runDifferential();
