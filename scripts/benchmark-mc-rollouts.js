#!/usr/bin/env node
/**
 * benchmark-mc-rollouts.js
 *
 * Measures wall-time + CI half-width of MC verification at different
 * rollout counts across a few representative scenarios. The output table
 * is used to fill in the "Tighten Steps Estimate" info-modal copy.
 *
 *   node scripts/benchmark-mc-rollouts.js
 *
 * Reports per scenario:
 *   K=count, wallMs, mean, ci95half, uniqueStates
 *
 * Does NOT touch any project files — pure read-only measurement.
 */

"use strict";

const worker = require("../d4cubeoptimv3-worker.js");
const config = require("../config.js");
const slotLegality = require("../gear-slot-legality.js");

const DAMAGE_TYPES = config.DAMAGE_TYPES;

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildRealCatalog() {
  const map = Object.create(null);
  function addEntry(categoryName, entry) {
    const baseName = typeof entry === "string" ? entry : entry.name;
    const family = typeof entry === "string" ? "" : String(entry.family || "");
    const familyRollWeight = typeof entry === "string" ? 0 : Number(entry.familyRollWeight) || 0;
    const className = typeof entry === "string" ? "" : String(entry.class || "");
    const expandedNames =
      baseName === "Elemental Damage" ? DAMAGE_TYPES.map((t) => `Elemental Damage (${t})`)
        : baseName === "Specific Resistance" ? DAMAGE_TYPES.map((t) => `Specific Resistance (${t})`)
        : [baseName];
    for (const name of expandedNames) {
      const id = slugify(name);
      if (!map[id]) {
        map[id] = {
          id, name, categories: [],
          gearSlots: slotLegality.getLegalGearSlotsForAffixName(name),
          family, rollWeight: 1,
        };
        if (familyRollWeight > 0) map[id].familyRollWeight = familyRollWeight;
        if (className) map[id].class = className;
      }
      if (familyRollWeight > 0) map[id].familyRollWeight = familyRollWeight;
      if (className) map[id].class = className;
      if (family) map[id].family = family;
      if (!map[id].categories.includes(categoryName)) map[id].categories.push(categoryName);
    }
  }
  for (const [categoryName, entries] of Object.entries(config.CATEGORY_TO_AFFIX_NAMES)) {
    for (const entry of entries) addEntry(categoryName, entry);
  }
  for (const [affixName, ops] of Object.entries(config.OPERATION_CATEGORY_OVERRIDES)) {
    const id = slugify(affixName);
    if (map[id]) {
      map[id].operationCategories = Object.fromEntries(
        Object.entries(ops).map(([op, cats]) => [op, cats.slice()])
      );
    }
  }
  const affixes = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  return {
    affixes,
    byName: Object.fromEntries(affixes.map((a) => [a.name, a])),
    categories: Object.fromEntries(Object.keys(config.CATEGORY_TO_AFFIX_NAMES).map((cat) =>
      [cat, affixes.filter((a) => a.categories.includes(cat)).map((a) => a.id)])),
  };
}

const catalog = buildRealCatalog();
const affixId = (name) => {
  const a = catalog.byName[name];
  if (!a) throw new Error(`Affix not found: ${name}`);
  return a.id;
};

function commonData() {
  return {
    affixes: catalog.affixes,
    categories: catalog.categories,
    gearSlots: slotLegality.GEAR_SLOTS,
    classes: config.CLASSES,
    targetAffixIds: [],
    maxAffixSlots: 4,
  };
}

function makePayload(scenario) {
  const data = commonData();
  const state = {
    gearSlot: scenario.gearSlot,
    class: scenario.class,
    isLegendary: !!scenario.isLegendary,
    affixes: scenario.current.map((s) => ({
      affixId: affixId(s.name), isGA: !!s.isGA, isEnchanted: !!s.isEnchanted,
    })),
  };
  const target = {
    affixes: scenario.target.map((name) => ({
      affixId: affixId(name), requireGA: false, needsImprovement: false,
    })),
  };
  data.targetAffixIds = target.affixes.map((e) => e.affixId);
  return {
    state, target, data,
    gaConfig: { currentGAAffixes: [], unsatisfactoryAffixIds: [], strictMode: true, sacrificeAffixId: "" },
    timeMs: 30000,
  };
}

const SCENARIOS = [
  {
    name: "Spiritborn Amulet (user's repro, 4 affixes)",
    gearSlot: "Amulet", class: "Spiritborn",
    current: [
      { name: "Movement Speed" },
      { name: "Attack Speed" },
      { name: "Vulnerable Damage", isEnchanted: true },
      { name: "Mainstat" },
    ],
    target: ["Movement Speed", "Attack Speed", "Vulnerable Damage", "Elemental Damage (Physical)"],
  },
  {
    name: "Spiritborn Amulet (3 affixes, post-Remove)",
    gearSlot: "Amulet", class: "Spiritborn",
    current: [
      { name: "Movement Speed" },
      { name: "Attack Speed" },
      { name: "Vulnerable Damage", isEnchanted: true },
    ],
    target: ["Movement Speed", "Attack Speed", "Vulnerable Damage", "Elemental Damage (Physical)"],
  },
  {
    name: "Sorcerer Helm (cooldown setup)",
    gearSlot: "Helm", class: "Sorceror",
    current: [
      { name: "Maximum Life" },
      { name: "Armor" },
      { name: "All Resistance" },
      { name: "Mainstat" },
    ],
    target: ["Maximum Life", "Cooldown Reduction", "Maximum Resource", "All Resistance"],
  },
  {
    name: "Necromancer Amulet (Macabre skill target, residual-heavy)",
    gearSlot: "Amulet", class: "Necromancer",
    current: [
      { name: "All Resistance" },
      { name: "Maximum Life" },
      { name: "Mainstat", isEnchanted: true },
    ],
    target: ["All Resistance", "Maximum Life", "Maximum Resource", "to Macabre Skills"],
  },
];

const COUNTS = [50, 100, 200, 500];

function fmtNum(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return "(n/a)";
  return n.toFixed(d);
}

function runBenchmark() {
  for (const scenario of SCENARIOS) {
    console.log("=".repeat(80));
    console.log(scenario.name);
    console.log("=".repeat(80));

    const payload = makePayload(scenario);
    const intermediate = worker.optimizePayloadV3(payload);
    console.log(`  initial: strategy=${intermediate.diagnostics.strategy}, action=${JSON.stringify(intermediate.action)}, expectedSteps=${fmtNum(intermediate.expectedSteps)}`);
    if (intermediate.diagnostics.refinement) {
      console.log(`  refinement applied: ${fmtNum(intermediate.diagnostics.refinement.originalSteps)} → ${fmtNum(intermediate.diagnostics.refinement.refinedSteps)}`);
    }

    console.log("");
    console.log("    K       wallMs     mean     stdev    ci95half     ratioCI/mean");
    console.log("  -----  ----------  -------  --------  ----------  --------------");
    for (const K of COUNTS) {
      const mcPayload = {
        ...payload,
        tightenStepsLevel: "heavy",
        tightenStepsOverrides: { heavyRollouts: K },
      };
      const t0 = Date.now();
      const result = worker.runMCVerificationV3(mcPayload, intermediate);
      const wall = Date.now() - t0;
      const gs = result.diagnostics.goldStandard;
      if (!gs) { console.log(`  ${String(K).padStart(5)}  (no MC result — initial action was infeasible)`); continue; }
      const ratio = gs.mean > 0 ? gs.ci95halfWidth / gs.mean : 0;
      console.log(
        `  ${String(K).padStart(5)}  ${String(wall).padStart(10)}  ${fmtNum(gs.mean).padStart(7)}  ${fmtNum(gs.stdev).padStart(8)}  ${fmtNum(gs.ci95halfWidth).padStart(10)}  ${fmtNum(ratio * 100, 2).padStart(12)}%  truncated=${gs.truncatedRolloutCount}/${gs.rollouts}`
      );
    }
    console.log("");

    // Adaptive run.
    const adaptivePayload = { ...payload, tightenStepsLevel: "adaptive" };
    const tA = Date.now();
    const adaptiveResult = worker.runMCVerificationV3(adaptivePayload, intermediate);
    const wallA = Date.now() - tA;
    const gsA = adaptiveResult.diagnostics.goldStandard;
    console.log(
      `  Adaptive: wallMs=${wallA}, rollouts=${gsA.rollouts}, mean=${fmtNum(gsA.mean)}, ci95half=${fmtNum(gsA.ci95halfWidth)}, earlyConverged=${gsA.earlyConverged}`
    );
    console.log("");
  }
}

runBenchmark();
