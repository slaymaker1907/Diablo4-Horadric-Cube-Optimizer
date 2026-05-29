#!/usr/bin/env node
/**
 * benchmark-chest-spiritborn-skill.js
 *
 * Times the JS vs Rust/WASM solver on the slow Chest/Spiritborn skill-target
 * scenario (and a couple of controls), to confirm the outcome-enumeration
 * hotspot and prove the Tier-1 Rust optimizations.
 *
 *   bash scripts/build-wasm.sh            # build rust/pkg-node first
 *   node scripts/benchmark-chest-spiritborn-skill.js
 *
 * Per scenario it prints, for both JS and Rust:
 *   optimize wall-ms, MC wall-ms (K=500, timeMs=30000), MC mean / ci95half,
 *   policyTable entries / misses, truncatedRolloutCount.
 * It also prints the per-category affix pool size for the scenario's
 * (gearSlot, class), which is the driver of the enumeration cost.
 *
 * Does NOT modify any project files — pure read-only measurement.
 */

"use strict";

const worker = require("../d4cubeoptimv3-worker.js");
const config = require("../config.js");
const slotLegality = require("../gear-slot-legality.js");

let rustMod = null;
try {
  rustMod = require("../rust/pkg-node/d4optimizer.js");
} catch (e) {
  console.error(`Failed to load rust/pkg-node/d4optimizer.js: ${e.message}`);
  console.error("Run `bash scripts/build-wasm.sh` first.");
  process.exit(1);
}

const DAMAGE_TYPES = config.DAMAGE_TYPES;

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Mirrors scripts/benchmark-mc-rollouts.js buildRealCatalog().
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
      affixId: affixId(name), needsImprovement: false,
    })),
  };
  data.targetAffixIds = target.affixes.map((e) => e.affixId);
  return {
    state, target, data,
    gaConfig: { currentGAAffixes: [], unsatisfactoryAffixIds: [], strictMode: true, sacrificeAffixId: "" },
    // timeMs:0 means "use the largest configured residual cap" (4096 states).
    // This is what the UI default sends; timeMs=30000 caps at 2000 states and
    // truncates the slow Chest/Spiritborn scenario to action=null before MC.
    timeMs: 0,
  };
}

// ILP callback for Rust — mirrors scripts/diff-test-rust-vs-js.js makeIlpCallback.
function makeIlpCallback() {
  return (planInputJson) => {
    try {
      const planInput = JSON.parse(planInputJson);
      if (Array.isArray(planInput.options) && Array.isArray(planInput.targets)) {
        const byId = Object.create(null);
        for (const o of planInput.options) { if (o && o.id) byId[o.id] = o; }
        for (const row of planInput.targets) {
          if (Array.isArray(row.options)) {
            row.options = row.options.map((o) => (o && o.id && byId[o.id]) ? byId[o.id] : o);
          }
        }
      }
      return JSON.stringify(worker.solveDecompositionPlanV3(planInput));
    } catch (_) { return null; }
  };
}
const solveIlp = makeIlpCallback();

// Count the eligible affix pool per category for a (gearSlot, class), the way
// the solver would: catalog membership ∩ gear-slot legality ∩ class legality.
function poolSizesByCategory(gearSlot, className) {
  const out = {};
  for (const [cat, ids] of Object.entries(catalog.categories)) {
    let n = 0;
    for (const id of ids) {
      const a = catalog.affixes.find((x) => x.id === id);
      if (!a) continue;
      const slotOk = !a.gearSlots || a.gearSlots.length === 0
        || a.gearSlots.includes("Any") || a.gearSlots.includes(gearSlot);
      const classOk = !a.class || a.class === "Any" || a.class === className;
      if (slotOk && classOk) n++;
    }
    out[cat] = n;
  }
  return out;
}

const K = 500;

function fmt(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return "(n/a)";
  return n.toFixed(d);
}

function gsLine(label, wallOpt, wallMc, gs) {
  if (!gs) {
    console.log(`    ${label.padEnd(5)}  optimize=${String(wallOpt).padStart(6)}ms  MC=${String(wallMc).padStart(7)}ms  (no goldStandard)`);
    return;
  }
  const pt = gs.policyTable || {};
  console.log(
    `    ${label.padEnd(5)}  optimize=${String(wallOpt).padStart(6)}ms  MC=${String(wallMc).padStart(7)}ms  ` +
    `mean=${fmt(gs.mean).padStart(7)}  ci95half=${fmt(gs.ci95halfWidth).padStart(6)}  ` +
    `policyEntries=${String(pt.entries ?? "-").padStart(5)}  misses=${String(pt.misses ?? "-").padStart(4)}  ` +
    `trunc=${gs.truncatedRolloutCount}/${gs.rollouts}`
  );
}

const SCENARIOS = [
  {
    name: "Chest / Spiritborn — skill target 'to Counterattack' (SLOW REPRO)",
    gearSlot: "Chest", class: "Spiritborn",
    current: [
      { name: "Life on Kill" }, { name: "Armor" },
      { name: "Thorns" }, { name: "Healing Received" },
    ],
    target: ["Mainstat", "to Counterattack", "Maximum Life", "Armor"],
  },
  {
    name: "Chest / Spiritborn — non-skill control (same current)",
    gearSlot: "Chest", class: "Spiritborn",
    current: [
      { name: "Life on Kill" }, { name: "Armor" },
      { name: "Thorns" }, { name: "Healing Received" },
    ],
    target: ["Mainstat", "Maximum Resource", "Maximum Life", "Armor"],
  },
  {
    name: "Spiritborn Amulet — control (from benchmark-mc-rollouts)",
    gearSlot: "Amulet", class: "Spiritborn",
    current: [
      { name: "Movement Speed" }, { name: "Attack Speed" },
      { name: "Vulnerable Damage", isEnchanted: true }, { name: "Mainstat" },
    ],
    target: ["Movement Speed", "Attack Speed", "Vulnerable Damage", "Elemental Damage (Physical)"],
  },
];

function run() {
  for (const scenario of SCENARIOS) {
    console.log("=".repeat(90));
    console.log(scenario.name);
    console.log("=".repeat(90));

    const pools = poolSizesByCategory(scenario.gearSlot, scenario.class);
    console.log(`  pool sizes (${scenario.gearSlot}/${scenario.class}): ` +
      Object.entries(pools).map(([c, n]) => `${c}=${n}`).join("  ") +
      `   total=${Object.values(pools).reduce((a, b) => a + b, 0)}`);

    const payload = makePayload(scenario);
    const mcPayload = { ...payload, tightenStepsLevel: "heavy", tightenStepsOverrides: { heavyRollouts: K } };

    // ── JS ──
    let t = Date.now();
    const jsOpt = worker.optimizePayloadV3(payload);
    const jsOptMs = Date.now() - t;
    t = Date.now();
    const jsMc = worker.runMCVerificationV3(mcPayload, jsOpt);
    const jsMcMs = Date.now() - t;

    // ── Rust ──
    t = Date.now();
    const rustOpt = JSON.parse(rustMod.optimize_payload(JSON.stringify(payload), solveIlp));
    const rustOptMs = Date.now() - t;
    t = Date.now();
    const rustMc = JSON.parse(
      rustMod.run_mc_verification(JSON.stringify(mcPayload), JSON.stringify(rustOpt), solveIlp, null)
    );
    const rustMcMs = Date.now() - t;

    console.log(`  initial action: JS=${JSON.stringify(jsOpt.action && jsOpt.action.type)} ` +
      `Rust=${JSON.stringify(rustOpt.action && rustOpt.action.type)}  ` +
      `expectedSteps JS=${fmt(jsOpt.expectedSteps)} Rust=${fmt(rustOpt.expectedSteps)}`);
    {
      const je = jsOpt.expectedSteps, re = rustOpt.expectedSteps;
      const rel = Math.abs(je - re) / Math.max(1e-12, Math.abs(je));
      console.log(`  expectedSteps full precision: JS=${je} Rust=${re}  ` +
        `${je === re ? "EXACT" : `relDiff=${rel.toExponential(3)}`}`);
    }
    gsLine("JS", jsOptMs, jsMcMs, jsMc.diagnostics && jsMc.diagnostics.goldStandard);
    gsLine("Rust", rustOptMs, rustMcMs, rustMc.diagnostics && rustMc.diagnostics.goldStandard);
    console.log("");
  }
}

run();
