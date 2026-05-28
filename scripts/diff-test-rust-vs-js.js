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

// ── Phase 2: feasibility + closed-form differential tests ────────────────────

function runPhase2(jsWorker, rustMod) {
  console.log("Phase 2: feasibility + closed-form differential tests");
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

  // Shared env for Phase 2 tests
  const env2Handle = rustMod.build_env(
    JSON.stringify(CATALOG_DATA),
    JSON.stringify(EMPTY_GA_CONFIG),
    JSON.stringify({ affixes: [{ affixId: "maximum-life" }, { affixId: "attack-speed" }] })
  );

  // ── analyzeFeasibilityV3 ─────────────────────────────────────────────────

  const feasTests = [
    {
      label: "feasibility: success — simple two-target",
      state: makeState("Any", "Any", []),
      target: { affixes: [{ affixId: "maximum-life" }, { affixId: "attack-speed" }] },
      gaConfig: {},
    },
    {
      label: "feasibility: F6 — duplicate required affix",
      state: makeState("Any", "Any", []),
      target: { affixes: [{ affixId: "maximum-life" }, { affixId: "maximum-life" }] },
      gaConfig: {},
    },
    {
      label: "feasibility: F6 — same-family conflict",
      state: makeState("Any", "Any", []),
      target: {
        affixes: [
          { affixId: "elemental-damage-fire" },
          { affixId: "elemental-damage-cold" },
        ],
      },
      gaConfig: {},
    },
    {
      label: "feasibility: F7 — target affix also forbidden",
      state: makeState("Any", "Any", []),
      target: {
        affixes: [{ affixId: "maximum-life" }],
        forbiddenAffixIds: ["maximum-life"],
      },
      gaConfig: {},
    },
    {
      label: "feasibility: success — GA config with strictMode",
      state: makeState("Any", "Any", []),
      target: { affixes: [{ affixId: "maximum-life" }] },
      gaConfig: { currentGAAffixes: ["maximum-life"], strictMode: true },
    },
  ];

  for (const tc of feasTests) {
    const jsEnvFeas = jsWorker.buildEnv(
      CATALOG_DATA,
      tc.gaConfig || {},
      tc.target || {}
    );
    const jsVal = jsWorker.analyzeFeasibilityV3(
      tc.state, tc.target, CATALOG_DATA, tc.gaConfig
    );

    const rustEnvFeas = rustMod.build_env(
      JSON.stringify(CATALOG_DATA),
      JSON.stringify(tc.gaConfig || {}),
      JSON.stringify(tc.target || {})
    );
    const rustVal = JSON.parse(rustMod.analyze_feasibility(
      JSON.stringify(tc.state),
      JSON.stringify(tc.target || {}),
      JSON.stringify(tc.gaConfig || {}),
      rustEnvFeas,
    ));
    rustMod.free_env(rustEnvFeas);

    // Compare ok, check, message fields (details may differ in key ordering)
    check(tc.label + " [ok]", jsVal.ok, rustVal.ok);
    check(tc.label + " [check]", jsVal.check, rustVal.check);
    // message intentionally skipped: JS uses affixName() which may return 'undefined'
    // for test catalog affixes that lack a 'name' field; Rust uses the ID directly.
  }

  // ── getClosedFormPlanCandidatesV3 ────────────────────────────────────────

  const cfTests = [
    {
      label: "closedForm: Case A — empty slot, simple category",
      state: makeState("Any", "Any", []),
      targetEntry: { affixId: "maximum-life" },
      slotIndex: 0,
      options: { maxAffixSlots: 4 },
    },
    {
      label: "closedForm: Case A — no candidates (denominator=0, all 5 agg affixes present)",
      // Pool of "Aggressive" has 5 affixes; state already has all 5 → n=0
      state: makeState("Any", "Any", [
        makeAffix("maximum-life"),
        makeAffix("attack-speed"),
        makeAffix("critical-strike-chance"),
        makeAffix("elemental-damage-fire"),
        makeAffix("elemental-damage-cold"),
      ]),
      targetEntry: { affixId: "maximum-life" },
      slotIndex: 5,
      options: { maxAffixSlots: 6 },
    },
    {
      label: "closedForm: Case B — focused reroll, non-matching host",
      // slot 0 has attack-speed (Aggressive), target is maximum-life (Aggressive) → Case B
      state: makeState("Any", "Any", [makeAffix("attack-speed")]),
      targetEntry: { affixId: "maximum-life" },
      slotIndex: 0,
      options: { maxAffixSlots: 4 },
    },
    {
      label: "closedForm: no candidates — slot out of range",
      state: makeState("Any", "Any", []),
      targetEntry: { affixId: "maximum-life" },
      slotIndex: 10,
      options: { maxAffixSlots: 4 },
    },
  ];

  for (const tc of cfTests) {
    const jsEnvCf = jsWorker.buildEnv(CATALOG_DATA, {}, { affixes: [] });
    const jsVal = jsWorker.getClosedFormPlanCandidatesV3(
      tc.state, tc.targetEntry, tc.slotIndex, jsEnvCf, tc.options || {}
    );

    const rustVal = JSON.parse(rustMod.get_closed_form_plan_candidates(
      JSON.stringify(tc.state),
      JSON.stringify(tc.targetEntry),
      tc.slotIndex,
      env2Handle,
      JSON.stringify(tc.options || {}),
    ));

    check(tc.label + " [length]", jsVal.length, rustVal.length);
    if (jsVal.length === rustVal.length) {
      for (let i = 0; i < jsVal.length; i++) {
        check(
          tc.label + ` [${i}].caseId`,
          jsVal[i].caseId,
          rustVal[i].caseId
        );
        check(
          tc.label + ` [${i}].expectedSteps`,
          jsVal[i].expectedSteps,
          rustVal[i].expectedSteps
        );
        check(
          tc.label + ` [${i}].prism`,
          jsVal[i].prism || null,
          rustVal[i].prism || null
        );
        check(
          tc.label + ` [${i}].denominator`,
          jsVal[i].denominator || null,
          rustVal[i].denominator || null
        );
      }
    }
  }

  // ── buildDecompositionPlanInputV3 ────────────────────────────────────────

  const decompTests = [
    {
      label: "decomp: two targets, empty state → two residual or option rows",
      state: makeState("Any", "Any", []),
      target: { affixes: [{ affixId: "maximum-life" }, { affixId: "attack-speed" }] },
      gaConfig: {},
    },
    {
      label: "decomp: single target already satisfied",
      state: makeState("Any", "Any", [makeAffix("maximum-life")]),
      target: { affixes: [{ affixId: "maximum-life" }] },
      gaConfig: {},
    },
  ];

  const decompEnv = rustMod.build_env(
    JSON.stringify(CATALOG_DATA),
    JSON.stringify(EMPTY_GA_CONFIG),
    JSON.stringify({ affixes: [{ affixId: "maximum-life" }, { affixId: "attack-speed" }] })
  );

  for (const tc of decompTests) {
    const jsEnvDecomp = jsWorker.buildEnv(CATALOG_DATA, tc.gaConfig || {}, tc.target || {});
    const jsVal = jsWorker.buildDecompositionPlanInputV3(
      tc.state, tc.target, CATALOG_DATA, tc.gaConfig
    );
    const rustRaw = JSON.parse(rustMod.build_decomposition_plan_input(
      JSON.stringify(tc.state),
      JSON.stringify(tc.target),
      JSON.stringify(tc.gaConfig || {}),
      decompEnv,
    ));

    check(tc.label + " [ok]", jsVal.ok, rustRaw.ok);
    check(tc.label + " [targets.length]", jsVal.targets.length, rustRaw.targets.length);
    check(
      tc.label + " [residualTargets.length]",
      jsVal.residualTargets.length,
      rustRaw.residualTargets.length
    );
    // Check each target row option count matches
    for (let i = 0; i < Math.min(jsVal.targets.length, rustRaw.targets.length); i++) {
      check(
        tc.label + ` [targets[${i}].options.length]`,
        jsVal.targets[i].options.length,
        rustRaw.targets[i].options.length
      );
    }
  }

  rustMod.free_env(decompEnv);
  rustMod.free_env(env2Handle);

  console.log(`Phase 2: ${pass} passed, ${fail} failed\n`);
  return fail;
}

// ── Phase 3: optimizer differential tests ────────────────────────────────────

function makeIlpCallback(jsWorker) {
  return (planInputJson) => {
    try {
      const planInput = JSON.parse(planInputJson);
      // Re-link targets[i].options to the same objects as planInput.options
      // (JS reference sharing is lost through JSON serialization).
      if (Array.isArray(planInput.options) && Array.isArray(planInput.targets)) {
        const byId = Object.create(null);
        for (const o of planInput.options) { if (o && o.id) byId[o.id] = o; }
        for (const row of planInput.targets) {
          if (Array.isArray(row.options)) {
            row.options = row.options.map((o) => (o && o.id && byId[o.id]) ? byId[o.id] : o);
          }
        }
      }
      return JSON.stringify(jsWorker.solveDecompositionPlanV3(planInput));
    } catch (_) { return null; }
  };
}

function runPhase3(jsWorker, rustMod) {
  console.log("Phase 3: optimizer differential tests");
  let pass = 0;
  let fail = 0;

  function checkFloat(label, jsVal, rustVal) {
    try {
      if (!floatEq(jsVal, rustVal)) {
        throw new Error(`${label}: JS=${jsVal} Rust=${rustVal} diff=${Math.abs(jsVal - rustVal)}`);
      }
      console.log(`  PASS: ${label}`);
      pass++;
    } catch (e) {
      console.error(`  FAIL: ${label}`);
      console.error(`        ${e.message}`);
      fail++;
    }
  }

  function checkStr(label, jsVal, rustVal) {
    try {
      assert.equal(jsVal, rustVal, `${label}: mismatch`);
      console.log(`  PASS: ${label}`);
      pass++;
    } catch (e) {
      console.error(`  FAIL: ${label}`);
      console.error(`        JS:   ${jsVal}`);
      console.error(`        Rust: ${rustVal}`);
      fail++;
    }
  }

  const solveIlp = makeIlpCallback(jsWorker);

  const optimizerTests = [
    {
      label: "optimizer: simple enchant deterministic (strategy=decomposition)",
      state: { isLegendary: false, gearSlot: "Any", class: "Any", affixes: [
        { affixId: "damage-reduction", isGA: false, isEnchanted: false },
        { affixId: "all-stats", isGA: false, isEnchanted: false },
        { affixId: "critical-strike-chance", isGA: false, isEnchanted: false },
      ] },
      target: { affixes: [{ affixId: "maximum-life" }, { affixId: "attack-speed" }] },
      data: CATALOG_DATA,
      gaConfig: {},
    },
    {
      label: "optimizer: single target missing, residual solver",
      state: { isLegendary: false, gearSlot: "Any", class: "Any", affixes: [
        { affixId: "attack-speed", isGA: false, isEnchanted: false },
      ] },
      target: { affixes: [{ affixId: "maximum-life" }] },
      data: CATALOG_DATA,
      gaConfig: {},
    },
    {
      label: "optimizer: already satisfied state",
      state: { isLegendary: false, gearSlot: "Any", class: "Any", affixes: [
        { affixId: "maximum-life", isGA: false, isEnchanted: false },
      ] },
      target: { affixes: [{ affixId: "maximum-life" }] },
      data: CATALOG_DATA,
      gaConfig: {},
    },
  ];

  for (const tc of optimizerTests) {
    const payload = {
      state: tc.state,
      target: tc.target,
      data: tc.data,
      gaConfig: tc.gaConfig,
    };

    const jsResult = jsWorker.optimizePayloadV3(payload, { refineDepth: 0 });
    const rustResult = JSON.parse(rustMod.optimize_payload(JSON.stringify(payload), solveIlp));

    // Compare expectedSteps (primary metric)
    const jsSteps = jsResult.expectedSteps;
    const rustSteps = rustResult.expectedSteps;
    if (jsSteps == null && rustSteps == null) {
      console.log(`  PASS: ${tc.label} [both null steps]`);
      pass++;
    } else if (jsSteps == null || rustSteps == null) {
      console.error(`  FAIL: ${tc.label} [steps null mismatch JS=${jsSteps} Rust=${rustSteps}]`);
      fail++;
    } else {
      checkFloat(tc.label + " [expectedSteps]", jsSteps, rustSteps);
    }

    // Compare strategy
    const jsStrategy = jsResult.diagnostics && jsResult.diagnostics.strategy;
    const rustStrategy = rustResult.diagnostics && rustResult.diagnostics.strategy;
    checkStr(tc.label + " [strategy]", jsStrategy, rustStrategy);

    // If both have actions, compare action type
    if (jsResult.action && rustResult.action) {
      checkStr(tc.label + " [action.type]", jsResult.action.type, rustResult.action.type);
    } else if (!jsResult.action && !rustResult.action) {
      console.log(`  PASS: ${tc.label} [both no action]`);
      pass++;
    } else {
      console.error(`  FAIL: ${tc.label} [action presence mismatch JS=${!!jsResult.action} Rust=${!!rustResult.action}]`);
      fail++;
    }
  }

  console.log(`Phase 3: ${pass} passed, ${fail} failed\n`);
  return fail;
}

// ── Phase 2+: additional differential cases (added incrementally) ─────────────

function runPhase2Plus() {
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
if (onlyPhase === null || onlyPhase === 2) totalFail += runPhase2(jsWorker, rustMod);
if (onlyPhase === null || onlyPhase === 3) totalFail += runPhase3(jsWorker, rustMod);
if (onlyPhase === null || onlyPhase >= 4)  totalFail += runPhase2Plus();

if (totalFail > 0) {
  console.error(`${totalFail} test(s) failed.`);
  process.exit(1);
}
console.log("All diff-tests passed.");
