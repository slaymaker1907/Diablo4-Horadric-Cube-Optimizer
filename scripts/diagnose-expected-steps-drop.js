#!/usr/bin/env node
/**
 * Runs the v3 worker against both states from the two screenshots and prints
 * the optimizer's expected-step estimate plus diagnostics for each.
 *
 * State A (first screenshot, 4 affixes):
 *   Movement Speed, Attack Speed, Vulnerable Damage [Enchanted], Mainstat
 *   → optimizer recommended: Remove Affix (Adept prism), 39.61 expected steps
 *
 * State B (second screenshot, 3 affixes after Mainstat was removed):
 *   Movement Speed, Attack Speed, Vulnerable Damage [Enchanted]
 *   → optimizer recommended: Add Affix (Aggressive prism), 13.07 expected steps
 *
 * Since Remove(Adept) is DETERMINISTIC (Mainstat is the only Adept-category
 * affix on the item), the MDP relation says E[A] = 1 + E[B]. So we'd expect
 * E[A] ≈ 1 + 13.07 ≈ 14.07, NOT 39.61.
 *
 * This script confirms or refutes that the 39.61 figure is over-estimated,
 * and shows the solver diagnostics (strategy, approximate flag, etc.) for
 * each state so we can pinpoint why the two estimates disagree.
 *
 *   node scripts/diagnose-expected-steps-drop.js
 */

"use strict";

const worker = require("../d4cubeoptimv3-worker.js");
const config = require("../config.js");
const slotLegality = require("../gear-slot-legality.js");

const GEAR_SLOT = "Amulet";
const CLASS_NAME = "Spiritborn";
const DAMAGE_TYPES = config.DAMAGE_TYPES;

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Replicates the HTML's buildAffixCatalog + sentinel expansion for Elemental
// Damage / Specific Resistance.
function buildAffixes() {
  const map = Object.create(null);

  function addEntry(categoryName, entry) {
    const baseName = typeof entry === "string" ? entry : entry.name;
    const family = typeof entry === "string" ? "" : String(entry.family || "");
    const familyRollWeight =
      typeof entry === "string" ? 0 : Number(entry.familyRollWeight) || 0;
    const className = typeof entry === "string" ? "" : String(entry.class || "");

    // Expand sentinels into typed subtypes.
    const expandedNames =
      baseName === "Elemental Damage"
        ? DAMAGE_TYPES.map((t) => `Elemental Damage (${t})`)
        : baseName === "Specific Resistance"
        ? DAMAGE_TYPES.map((t) => `Specific Resistance (${t})`)
        : [baseName];

    for (const name of expandedNames) {
      const id = slugify(name);
      if (!map[id]) {
        map[id] = {
          id,
          name,
          categories: [],
          gearSlots: slotLegality.getLegalGearSlotsForAffixName(name),
          family,
          rollWeight: 1,
        };
        if (familyRollWeight > 0) map[id].familyRollWeight = familyRollWeight;
        if (className) map[id].class = className;
      }
      if (familyRollWeight > 0) map[id].familyRollWeight = familyRollWeight;
      if (className) map[id].class = className;
      if (family) map[id].family = family;
      if (!map[id].categories.includes(categoryName)) {
        map[id].categories.push(categoryName);
      }
    }
  }

  for (const [categoryName, entries] of Object.entries(config.CATEGORY_TO_AFFIX_NAMES)) {
    for (const entry of entries) addEntry(categoryName, entry);
  }

  // Apply per-operation category overrides.
  for (const [affixName, ops] of Object.entries(config.OPERATION_CATEGORY_OVERRIDES)) {
    const id = slugify(affixName);
    if (map[id]) {
      map[id].operationCategories = Object.fromEntries(
        Object.entries(ops).map(([op, cats]) => [op, cats.slice()])
      );
    }
  }

  return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
}

const AFFIXES = buildAffixes();
const AFFIX_BY_NAME = Object.fromEntries(AFFIXES.map((a) => [a.name, a]));
const CATEGORY_TO_AFFIX_IDS = Object.fromEntries(
  Object.keys(config.CATEGORY_TO_AFFIX_NAMES).map((cat) => [
    cat,
    AFFIXES.filter((a) => a.categories.includes(cat)).map((a) => a.id),
  ])
);

function affixId(name) {
  const a = AFFIX_BY_NAME[name];
  if (!a) throw new Error(`Affix not found: ${name}`);
  return a.id;
}

function buildState(affixSpecs) {
  return {
    gearSlot: GEAR_SLOT,
    class: CLASS_NAME,
    isLegendary: false,
    affixes: affixSpecs.map((s) => ({
      affixId: affixId(s.name),
      isGA: !!s.isGA,
      isEnchanted: !!s.isEnchanted,
    })),
  };
}

function buildTarget() {
  return {
    affixes: [
      { affixId: affixId("Movement Speed"), requireGA: false, needsImprovement: false },
      { affixId: affixId("Attack Speed"), requireGA: false, needsImprovement: false },
      { affixId: affixId("Vulnerable Damage"), requireGA: false, needsImprovement: false },
      { affixId: affixId("Elemental Damage (Physical)"), requireGA: false, needsImprovement: false },
    ],
  };
}

function commonPayload(state) {
  const target = buildTarget();
  return {
    state,
    target,
    data: {
      affixes: AFFIXES,
      categories: CATEGORY_TO_AFFIX_IDS,
      gearSlots: slotLegality.GEAR_SLOTS,
      classes: config.CLASSES,
      targetAffixIds: target.affixes.map((e) => e.affixId),
      maxAffixSlots: 4,
    },
    gaConfig: {
      currentGAAffixes: [],
      unsatisfactoryAffixIds: [],
      strictMode: true,
      sacrificeAffixId: "",
    },
    timeMs: 30000, // wide budget so the residual solver can converge
  };
}

function pad(label, w) { return String(label).padEnd(w); }
function fmtNum(n) { return n == null || !Number.isFinite(n) ? "(n/a)" : n.toFixed(4); }

function runAndReport(label, state) {
  console.log("=".repeat(78));
  console.log(label);
  console.log("=".repeat(78));
  console.log("State affixes:");
  for (const a of state.affixes) {
    const aff = AFFIXES.find((x) => x.id === a.affixId);
    const tag = (a.isGA ? " [GA]" : "") + (a.isEnchanted ? " [Enchanted]" : "");
    console.log(`  • ${aff.name}${tag}  (categories: ${aff.categories.join(", ")})`);
  }
  console.log();

  const t0 = Date.now();
  const result = worker.optimizeScenarioV3(commonPayload(state));
  const elapsed = Date.now() - t0;

  console.log("Optimizer result:");
  console.log(`  strategy:          ${result.diagnostics && result.diagnostics.strategy}`);
  console.log(`  successProb:       ${fmtNum(result.successProb)}`);
  console.log(`  expectedSteps:     ${fmtNum(result.expectedSteps)}`);
  console.log(`  approximate?:      ${result.approximate === true}`);
  console.log(`  action:            ${result.action ? JSON.stringify(result.action) : "(none)"}`);
  console.log(`  elapsed:           ${elapsed} ms`);
  if (result.diagnostics) {
    const d = result.diagnostics;
    console.log("  diagnostics:");
    console.log(`    feasibility.ok:        ${d.feasibility && d.feasibility.ok}`);
    if (d.decomposition) {
      console.log(`    decomposition.status:  ${d.decomposition.status}`);
      if (d.decomposition.ilp) {
        console.log(`    decomposition.ilp:     ${d.decomposition.ilp.status}`);
      }
    }
    if (d.residual) {
      console.log(`    residual.status:       ${d.residual.status}`);
      console.log(`    residual.iterations:   ${d.residual.iterations || "(n/a)"}`);
      console.log(`    residual.stateCount:   ${d.residual.stateCount || d.residual.statesExpanded || "(n/a)"}`);
    }
    if (d.reason) {
      console.log(`    reason:                ${d.reason}`);
    }
  }
  console.log();

  return result;
}

// ─── State A: original (4 affixes incl Mainstat) ─────────────────────────────
const stateA = buildState([
  { name: "Movement Speed" },
  { name: "Attack Speed" },
  { name: "Vulnerable Damage", isEnchanted: true },
  { name: "Mainstat" },
]);

// ─── State B: after Remove(Adept) (3 affixes, slot 4 empty) ──────────────────
const stateB = buildState([
  { name: "Movement Speed" },
  { name: "Attack Speed" },
  { name: "Vulnerable Damage", isEnchanted: true },
]);

const resultA = runAndReport("STATE A — original 4-affix state (browser said 39.61)", stateA);
const resultB = runAndReport("STATE B — post-Remove 3-affix state (browser said 13.07)", stateB);

// ─── MDP consistency check ───────────────────────────────────────────────────
console.log("=".repeat(78));
console.log("MDP CONSISTENCY CHECK");
console.log("=".repeat(78));
console.log("If Remove(Adept) is the optimal first action from State A, AND it");
console.log("deterministically lands in State B (Mainstat is the only Adept-category");
console.log("affix on the item), THEN by the Bellman equation:");
console.log();
console.log("    E[A] = 1 + E[B]");
console.log();
console.log(`  Observed E[A] from optimizer: ${fmtNum(resultA.expectedSteps)}`);
console.log(`  Observed E[B] from optimizer: ${fmtNum(resultB.expectedSteps)}`);
console.log(`  Predicted E[A] from 1 + E[B]: ${fmtNum(1 + (resultB.expectedSteps || 0))}`);
console.log(`  Gap (observed - predicted):   ${fmtNum((resultA.expectedSteps || 0) - 1 - (resultB.expectedSteps || 0))}`);
console.log();
console.log("If the gap is ~0, both estimates are mutually consistent (one or both");
console.log("could still be wrong, but they agree). If the gap is large (>1), then");
console.log("at least one of the two estimates is incorrect, and the larger value");
console.log("is almost certainly an over-estimate from a solver hitting an internal");
console.log("budget cap or relying on an upper-bound approximation.");
