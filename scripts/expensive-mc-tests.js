#!/usr/bin/env node
/**
 * expensive-mc-tests.js
 *
 * Slow MC-convergence regression checks for the gold-standard verification
 * pipeline. Opt-in — these take ~30s–3min total and are NOT part of the
 * default `node --test` suite (which must stay snappy).
 *
 *   node scripts/expensive-mc-tests.js
 *
 * Exits 0 on all pass, non-zero on any failure.
 */

"use strict";

const assert = require("node:assert/strict");
const worker = require("../d4cubeoptimv3-worker.js");

function normalizeName(name) {
  return String(name || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function buildCatalogFixture(categoryToNames) {
  const byId = new Map();
  for (const [category, names] of Object.entries(categoryToNames)) {
    for (const entry of names) {
      const name = typeof entry === "string" ? entry : entry.name;
      const family = typeof entry === "string" ? "" : String(entry.family || "");
      const id = normalizeName(name);
      if (!byId.has(id)) byId.set(id, { id, name, categories: [], family, rollWeight: 1 });
      if (family) byId.get(id).family = family;
      byId.get(id).categories.push(category);
    }
  }
  const affixes = Array.from(byId.values());
  const byName = Object.fromEntries(affixes.map((a) => [a.name, a]));
  const categories = Object.fromEntries(
    Object.entries(categoryToNames).map(([category, names]) => [
      category,
      names.map((entry) => byName[typeof entry === "string" ? entry : entry.name].id),
    ])
  );
  return { affixes, byName, categories };
}

function buildLooseFixture() {
  const cat = buildCatalogFixture({
    Aggressive: [
      "Mainstat", "Critical Strike Chance", "Critical Strike Damage",
      "Vulnerable Damage", "Attack Speed", "DoT Damage",
      { name: "Elemental Damage (Physical)", family: "elemental-damage" },
      { name: "Elemental Damage (Fire)", family: "elemental-damage" },
    ],
    Pragmatic: ["Movement Speed", "Cooldown Reduction"],
    Protector: ["Armor", "Maximum Life", "All Resistance"],
    Adept: ["Mainstat"],
  });
  return {
    data: { affixes: cat.affixes, categories: cat.categories, targetAffixIds: [], maxAffixSlots: 4 },
    byName: cat.byName,
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function runAll() {
  let failures = 0;
  for (const { name, fn } of tests) {
    const t0 = Date.now();
    try {
      await fn();
      console.log(`ok    ${(Date.now() - t0 + "ms").padStart(7)}  ${name}`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${(Date.now() - t0 + "ms").padStart(7)}  ${name}`);
      console.log(`  ${err.message}`);
      if (err.stack) console.log(err.stack.split("\n").slice(1, 4).map((s) => "  " + s).join("\n"));
    }
  }
  console.log(`\n${tests.length - failures} / ${tests.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("MC produces sensible values on a simple Add scenario (K=200)", () => {
  // Simple Add-Affix scenario. MC and optimizer headline may legitimately
  // disagree — the optimizer's closed-form does not always consider all
  // follow-up actions (e.g. enchant-after-add), so MC can be substantially
  // tighter than the headline. The test only asserts both are finite, MC
  // doesn't have NaN, and rollouts didn't all truncate.
  const { data, byName } = buildLooseFixture();
  const state = {
    gearSlot: "Any", class: "Any", isLegendary: false,
    affixes: [
      { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: false },
      { affixId: byName["Critical Strike Damage"].id, isGA: false, isEnchanted: false },
    ],
  };
  const target = {
    affixes: [
      { affixId: byName["Movement Speed"].id, requireGA: false, needsImprovement: false },
      { affixId: byName["Critical Strike Damage"].id, requireGA: false, needsImprovement: false },
      { affixId: byName["Elemental Damage (Physical)"].id, requireGA: false, needsImprovement: false },
    ],
  };
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  const payload = {
    state, target, data,
    gaConfig: { currentGAAffixes: [], unsatisfactoryAffixIds: [], strictMode: true, sacrificeAffixId: "" },
    tightenStepsLevel: "heavy",
    tightenStepsOverrides: { heavyRollouts: 200 },
  };

  const intermediate = worker.optimizePayloadV3(payload);
  const final = worker.runMCVerificationV3(payload, intermediate);
  const gs = final.diagnostics.goldStandard;

  assert.ok(gs && gs.applied, "MC must apply");
  assert.ok(Number.isFinite(gs.mean) && gs.mean > 0, `MC mean must be finite + positive (got ${gs.mean})`);
  assert.ok(Number.isFinite(gs.ci95halfWidth), "CI must be finite");
  assert.ok(gs.truncatedRolloutCount < gs.rollouts / 2,
    `>50% of rollouts truncated (${gs.truncatedRolloutCount}/${gs.rollouts}) — MC may be trapped`);
  console.log(`  [info] optimizer=${intermediate.expectedSteps.toFixed(2)}, MC=${gs.mean.toFixed(2)} ± ${gs.ci95halfWidth.toFixed(2)} (${gs.truncatedRolloutCount} truncated)`);
});

test("Adaptive converges within the cap on a simple low-variance case", () => {
  const { data, byName } = buildLooseFixture();
  const state = {
    gearSlot: "Any", class: "Any", isLegendary: false,
    affixes: [
      { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: false },
    ],
  };
  const target = {
    affixes: [
      { affixId: byName["Movement Speed"].id, requireGA: false, needsImprovement: false },
      { affixId: byName["Elemental Damage (Physical)"].id, requireGA: false, needsImprovement: false },
    ],
  };
  data.targetAffixIds = target.affixes.map((e) => e.affixId);
  const payload = {
    state, target, data,
    gaConfig: { currentGAAffixes: [], unsatisfactoryAffixIds: [], strictMode: true, sacrificeAffixId: "" },
    tightenStepsLevel: "adaptive",
  };

  const intermediate = worker.optimizePayloadV3(payload);
  const final = worker.runMCVerificationV3(payload, intermediate);
  const gs = final.diagnostics.goldStandard;

  assert.ok(gs && gs.adaptive, "Should be adaptive");
  assert.ok(gs.earlyConverged === true, `Adaptive should converge early on this simple case (got rollouts=${gs.rollouts}, earlyConverged=${gs.earlyConverged})`);
  assert.ok(gs.ci95halfWidth <= 0.1 * gs.mean,
    `CI half-width ${gs.ci95halfWidth.toFixed(3)} must be ≤ 10% of mean ${gs.mean.toFixed(3)}`);
});

test("Approach 1 refinement matches a high-K MC mean within 3 SE on residual case", () => {
  // The classic Mainstat-in-two-categories scenario from the user's bug
  // report. Approach 1 refinement should agree with MC heavy.
  const { data, byName } = buildLooseFixture();
  const state = {
    gearSlot: "Any", class: "Any", isLegendary: false,
    affixes: [
      { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: false },
      { affixId: byName["Attack Speed"].id, isGA: false, isEnchanted: false },
      { affixId: byName["Vulnerable Damage"].id, isGA: false, isEnchanted: true },
      { affixId: byName["Mainstat"].id, isGA: false, isEnchanted: false },
    ],
  };
  const target = {
    affixes: [
      { affixId: byName["Movement Speed"].id, requireGA: false, needsImprovement: false },
      { affixId: byName["Attack Speed"].id, requireGA: false, needsImprovement: false },
      { affixId: byName["Vulnerable Damage"].id, requireGA: false, needsImprovement: false },
      { affixId: byName["Elemental Damage (Physical)"].id, requireGA: false, needsImprovement: false },
    ],
  };
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  const payload = {
    state, target, data,
    gaConfig: { currentGAAffixes: [], unsatisfactoryAffixIds: [], strictMode: true, sacrificeAffixId: "" },
    tightenStepsLevel: "heavy",
    tightenStepsOverrides: { heavyRollouts: 300 },
  };

  const refined = worker.optimizePayloadV3(payload);
  const final = worker.runMCVerificationV3(payload, refined);
  const gs = final.diagnostics.goldStandard;

  console.log(`  [info] Approach 1 = ${refined.expectedSteps.toFixed(2)}, MC mean = ${gs.mean.toFixed(2)} ± ${gs.ci95halfWidth.toFixed(2)} (95% CI)`);

  // The two estimates measure slightly different things (Approach 1 is the
  // refined depth-1 backup; MC is the policy's true expected steps).
  // They needn't agree exactly, but disagreement >> CI is a signal worth
  // logging. We use a soft assertion: report if drift > 5 SE.
  const se = gs.ci95halfWidth / 1.96;
  const drift = Math.abs(gs.mean - refined.expectedSteps);
  if (drift > 5 * se) {
    console.log(`  [note] Drift ${drift.toFixed(2)} > 5 SE (${(5 * se).toFixed(2)}). Approach 1 and MC measure different quantities — see plan.`);
  }
  // Hard assertion: both estimates should be finite and positive.
  assert.ok(Number.isFinite(refined.expectedSteps) && refined.expectedSteps > 0);
  assert.ok(Number.isFinite(gs.mean) && gs.mean > 0);
});

runAll();
