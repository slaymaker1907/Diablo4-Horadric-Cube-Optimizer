#!/usr/bin/env node
// Differential testing harness: runs payloads through both the JS and Rust/WASM
// implementations and asserts results agree within tolerance.
//
// Usage:
//   node scripts/diff-test-rust-vs-js.js           # run all phases
//   node scripts/diff-test-rust-vs-js.js --phase 0  # smoke test only
//   node scripts/diff-test-rust-vs-js.js --phase 1  # Phase 1 leaf functions

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

function runPhase0(rustMod) {
  console.log("Phase 0: WASM smoke test");
  const version = rustMod.d4optimizer_version();
  assert.ok(typeof version === "string" && version.length > 0,
    "d4optimizer_version() returns non-empty string");
  assert.match(version, /^v4-rust-/, "version starts with v4-rust-");
  console.log(`  d4optimizer_version() = "${version}"  OK`);
  console.log("Phase 0: PASSED\n");
}

// ── Shared test fixtures ──────────────────────────────────────────────────────

function makeAffix(affixId, isGA = false, isEnchanted = false) {
  return { affixId, isGA, isEnchanted };
}

function makeState(gearSlot, cls, affixes, isLegendary = false) {
  return { isLegendary, gearSlot, class: cls, affixes };
}

// Minimal affix catalog with a handful of real-looking affixes across
// two categories. Sufficient to exercise buildEnv / isTerminal / breaksRequiredGA.
const CATALOG_DATA = {
  affixes: [
    { id: "maximum-life",            categories: ["Aggressive"], family: "" },
    { id: "attack-speed",            categories: ["Aggressive"], family: "" },
    { id: "critical-strike-chance",  categories: ["Aggressive"], family: "" },
    { id: "damage-reduction",        categories: ["Protector"],  family: "" },
    { id: "all-stats",               categories: ["Pragmatic"],  family: "" },
    { id: "elemental-damage-fire",   categories: ["Aggressive"], family: "elemental-damage" },
    { id: "elemental-damage-cold",   categories: ["Aggressive"], family: "elemental-damage" },
  ],
  categories: {
    Aggressive: ["maximum-life", "attack-speed", "critical-strike-chance",
                 "elemental-damage-fire", "elemental-damage-cold"],
    Protector:  ["damage-reduction"],
    Pragmatic:  ["all-stats"],
  },
  gearSlots: ["Any", "Amulet", "Ring", "Helm"],
  classes:   ["Any", "Barbarian"],
};

const EMPTY_GA_CONFIG  = { currentGAAffixes: [] };
const GA_MAX_LIFE      = { currentGAAffixes: ["maximum-life"] };
const GA_ATTACK_SPEED  = { currentGAAffixes: ["attack-speed"] };

// ── Phase 1: leaf function differential tests ─────────────────────────────────

function runPhase1(jsWorker, rustMod) {
  console.log("Phase 1: leaf function differential tests");
  let pass = 0;
  let fail = 0;

  function check(label, jsVal, rustVal) {
    try {
      assert.deepEqual(jsVal, rustVal, `${label}: mismatch`);
      console.log(`  PASS: ${label}`);
      pass++;
    } catch (e) {
      console.error(`  FAIL: ${label}`);
      console.error(`        JS:   ${JSON.stringify(jsVal)}`);
      console.error(`        Rust: ${JSON.stringify(rustVal)}`);
      fail++;
    }
  }

  // ── stateKey ────────────────────────────────────────────────────────────

  const stateKeyTests = [
    {
      label: "stateKey: empty affixes",
      state: makeState("Any", "Any", []),
    },
    {
      label: "stateKey: legendary flag",
      state: makeState("Any", "Any", [], true),
    },
    {
      label: "stateKey: single affix",
      state: makeState("Amulet", "Barbarian", [makeAffix("maximum-life")]),
    },
    {
      label: "stateKey: affixes sorted",
      // maximum-life sorts after attack-speed — Rust must output them sorted
      state: makeState("Helm", "Any", [
        makeAffix("maximum-life"),
        makeAffix("attack-speed"),
      ]),
    },
    {
      label: "stateKey: GA and enchanted flags",
      state: makeState("Ring", "Any", [
        makeAffix("maximum-life", true,  false),
        makeAffix("attack-speed", false, true),
      ]),
    },
    {
      label: "stateKey: four affixes",
      state: makeState("Amulet", "Barbarian", [
        makeAffix("damage-reduction"),
        makeAffix("maximum-life",   true, false),
        makeAffix("attack-speed",   false, true),
        makeAffix("all-stats"),
      ]),
    },
    {
      label: "stateKey: missing gearSlot defaults to 'any'",
      state: { isLegendary: false, affixes: [], class: "Any" },
    },
    {
      label: "stateKey: missing class defaults to 'Any'",
      state: { isLegendary: false, affixes: [], gearSlot: "Helm" },
    },
  ];

  for (const tc of stateKeyTests) {
    const jsVal  = jsWorker.stateKey(tc.state);
    const rustVal = rustMod.state_key(JSON.stringify(tc.state));
    check(tc.label, jsVal, rustVal);
  }

  // ── actionKey ────────────────────────────────────────────────────────────

  const actionKeyTests = [
    {
      label: "actionKey: add",
      action: { type: "add", prism: "Aggressive" },
    },
    {
      label: "actionKey: enchant with all fields",
      action: { type: "enchant", prism: "Protector", sourceIndex: 2,
                targetAffixId: "damage-reduction" },
    },
    {
      label: "actionKey: remove, no target",
      action: { type: "remove", prism: "Pragmatic", sourceIndex: 0 },
    },
    {
      label: "actionKey: all optional fields absent",
      action: { type: "add" },
    },
  ];

  for (const tc of actionKeyTests) {
    const jsVal  = jsWorker.actionKey(tc.action);
    const rustVal = rustMod.action_key(JSON.stringify(tc.action));
    check(tc.label, jsVal, rustVal);
  }

  // ── buildEnv + isTerminal + breaksRequiredGA ─────────────────────────────

  // Build one Rust env for the no-GA target cases.
  const TARGET_TWO = { affixes: [
    { affixId: "maximum-life" }, { affixId: "attack-speed" }
  ] };
  const jsEnvNoGA  = jsWorker.buildEnv(CATALOG_DATA, EMPTY_GA_CONFIG, TARGET_TWO);
  const envNoGA    = rustMod.build_env(
    JSON.stringify(CATALOG_DATA),
    JSON.stringify(EMPTY_GA_CONFIG),
    JSON.stringify(TARGET_TWO),
  );

  // Build one Rust env for the GA-required case.
  const TARGET_LIFE = { affixes: [{ affixId: "maximum-life" }] };
  const jsEnvGA    = jsWorker.buildEnv(CATALOG_DATA, GA_MAX_LIFE, TARGET_LIFE);
  const envGA      = rustMod.build_env(
    JSON.stringify(CATALOG_DATA),
    JSON.stringify(GA_MAX_LIFE),
    JSON.stringify(TARGET_LIFE),
  );

  const termTests = [
    {
      label: "isTerminal: not terminal — missing both targets",
      state: makeState("Any", "Any", [makeAffix("all-stats")]),
      target: TARGET_TWO, jsEnv: jsEnvNoGA, rustEnv: envNoGA,
    },
    {
      label: "isTerminal: not terminal — only one target met",
      state: makeState("Any", "Any", [makeAffix("maximum-life")]),
      target: TARGET_TWO, jsEnv: jsEnvNoGA, rustEnv: envNoGA,
    },
    {
      label: "isTerminal: success — both targets met",
      state: makeState("Any", "Any", [makeAffix("maximum-life"), makeAffix("attack-speed")]),
      target: TARGET_TWO, jsEnv: jsEnvNoGA, rustEnv: envNoGA,
    },
    {
      label: "isTerminal: failure — GA broken (non-GA present)",
      state: makeState("Any", "Any", [makeAffix("maximum-life", false, false)]),
      target: TARGET_LIFE, jsEnv: jsEnvGA, rustEnv: envGA,
    },
    {
      label: "isTerminal: success — GA preserved",
      state: makeState("Any", "Any", [makeAffix("maximum-life", true, false)]),
      target: TARGET_LIFE, jsEnv: jsEnvGA, rustEnv: envGA,
    },
  ];

  for (const tc of termTests) {
    const jsVal   = jsWorker.isTerminal(tc.state, tc.target, tc.jsEnv);
    const rustVal = JSON.parse(
      rustMod.is_terminal(JSON.stringify(tc.state), JSON.stringify(tc.target), tc.rustEnv)
    );
    check(tc.label, jsVal, rustVal);
  }

  const gaTests = [
    {
      label: "breaksRequiredGA: no GA config — never breaks",
      state: makeState("Any", "Any", [makeAffix("maximum-life")]),
      jsEnv: jsEnvNoGA, rustEnv: envNoGA,
    },
    {
      label: "breaksRequiredGA: GA present — no break",
      state: makeState("Any", "Any", [makeAffix("maximum-life", true, false)]),
      jsEnv: jsEnvGA, rustEnv: envGA,
    },
    {
      label: "breaksRequiredGA: GA absent — breaks",
      state: makeState("Any", "Any", [makeAffix("maximum-life", false, false)]),
      jsEnv: jsEnvGA, rustEnv: envGA,
    },
    {
      label: "breaksRequiredGA: affix missing entirely — breaks",
      state: makeState("Any", "Any", [makeAffix("attack-speed")]),
      jsEnv: jsEnvGA, rustEnv: envGA,
    },
  ];

  for (const tc of gaTests) {
    const jsVal   = jsWorker.breaksRequiredGA(tc.state, tc.jsEnv);
    const rustVal = rustMod.breaks_required_ga(JSON.stringify(tc.state), tc.rustEnv);
    check(tc.label, jsVal, rustVal);
  }

  // Cleanup Rust env handles.
  rustMod.free_env(envNoGA);
  rustMod.free_env(envGA);

  console.log(`Phase 1: ${pass} passed, ${fail} failed\n`);
  return fail;
}

// ── Phase 2+: additional differential cases (added incrementally) ─────────────

function runPhase2Plus() {
  console.log("Phase 2+: no cases registered yet (added in Phase 2).");
  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const phaseArg   = args.indexOf("--phase");
const onlyPhase  = phaseArg >= 0 ? Number(args[phaseArg + 1]) : null;

let rustMod;
try {
  rustMod = require("../rust/pkg-node/d4optimizer.js");
} catch (e) {
  console.error(`Failed to load rust/pkg-node/d4optimizer.js: ${e.message}`);
  console.error("Run scripts/build-wasm.sh first.");
  process.exit(1);
}

const jsWorker = require("../d4cubeoptimv3-worker.js");

let totalFail = 0;

if (onlyPhase === null || onlyPhase === 0) runPhase0(rustMod);
if (onlyPhase === null || onlyPhase === 1) totalFail += runPhase1(jsWorker, rustMod);
if (onlyPhase === null || onlyPhase >= 2)  totalFail += runPhase2Plus();

if (totalFail > 0) {
  console.error(`${totalFail} test(s) failed.`);
  process.exit(1);
}
console.log("All diff-tests passed.");
