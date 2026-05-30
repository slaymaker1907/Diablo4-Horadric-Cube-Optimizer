#!/usr/bin/env node
/**
 * diag-boots-spiritborn-skill.js  (temporary diagnostic, not for commit)
 *
 * Reproduces the slow Boots/Spiritborn/Legendary scenario the user reported
 * (~1 min in JS optimize, no MC) and times JS vs Rust optimize, printing
 * solver strategy + expandedStates/deadStates so we can locate the cost.
 */
"use strict";

const worker = require("../d4cubeoptimv3-worker.js");
const config = require("../config.js");
const slotLegality = require("../gear-slot-legality.js");

let rustMod = null;
try { rustMod = require("../rust/pkg-node/d4optimizer.js"); }
catch (e) { console.error("load rust failed:", e.message); process.exit(1); }

const DAMAGE_TYPES = config.DAMAGE_TYPES;
const slugify = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

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
        map[id] = { id, name, categories: [], gearSlots: slotLegality.getLegalGearSlotsForAffixName(name), family, rollWeight: 1 };
        if (familyRollWeight > 0) map[id].familyRollWeight = familyRollWeight;
        if (className) map[id].class = className;
      }
      if (familyRollWeight > 0) map[id].familyRollWeight = familyRollWeight;
      if (className) map[id].class = className;
      if (family) map[id].family = family;
      if (!map[id].categories.includes(categoryName)) map[id].categories.push(categoryName);
    }
  }
  for (const [categoryName, entries] of Object.entries(config.CATEGORY_TO_AFFIX_NAMES))
    for (const entry of entries) addEntry(categoryName, entry);
  for (const [affixName, ops] of Object.entries(config.OPERATION_CATEGORY_OVERRIDES)) {
    const id = slugify(affixName);
    if (map[id]) map[id].operationCategories = Object.fromEntries(Object.entries(ops).map(([op, cats]) => [op, cats.slice()]));
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
const affixId = (name) => { const a = catalog.byName[name]; if (!a) throw new Error("missing " + name); return a.id; };

function poolSizes(gearSlot, className) {
  const out = {};
  for (const [cat, ids] of Object.entries(catalog.categories)) {
    let n = 0;
    for (const id of ids) {
      const a = catalog.affixes.find((x) => x.id === id);
      const slotOk = !a.gearSlots || a.gearSlots.length === 0 || a.gearSlots.includes("Any") || a.gearSlots.includes(gearSlot);
      const classOk = !a.class || a.class === "Any" || a.class === className;
      if (slotOk && classOk) n++;
    }
    out[cat] = n;
  }
  return out;
}

const ilpStats = { calls: 0, jsMs: 0, jsonBytes: 0 };
function makeIlpCallback() {
  return (planInputJson) => {
    ilpStats.calls++;
    ilpStats.jsonBytes += planInputJson.length;
    const t0 = Date.now();
    try {
      const planInput = JSON.parse(planInputJson);
      if (Array.isArray(planInput.options) && Array.isArray(planInput.targets)) {
        const byId = Object.create(null);
        for (const o of planInput.options) if (o && o.id) byId[o.id] = o;
        for (const row of planInput.targets) if (Array.isArray(row.options)) row.options = row.options.map((o) => (o && o.id && byId[o.id]) ? byId[o.id] : o);
      }
      const out = JSON.stringify(worker.solveDecompositionPlanV3(planInput));
      ilpStats.jsMs += Date.now() - t0;
      return out;
    } catch (_) { ilpStats.jsMs += Date.now() - t0; return null; }
  };
}
const solveIlp = makeIlpCallback();

const scenario = {
  gearSlot: "Boots", class: "Spiritborn", isLegendary: true,
  current: [
    { name: "Mainstat" },
    { name: "Maximum Life" },
    { name: "Barrier Generation", isEnchanted: true },
    { name: "Attacks reduce Evade Cooldown" },
  ],
  target: ["Mainstat", "to Ravager", "Maximum Life", "Barrier Generation"],
};

const data = {
  affixes: catalog.affixes, categories: catalog.categories,
  gearSlots: slotLegality.GEAR_SLOTS, classes: config.CLASSES,
  targetAffixIds: scenario.target.map(affixId), maxAffixSlots: 4,
};
const state = {
  gearSlot: scenario.gearSlot, class: scenario.class, isLegendary: scenario.isLegendary,
  affixes: scenario.current.map((s) => ({ affixId: affixId(s.name), isGA: !!s.isGA, isEnchanted: !!s.isEnchanted })),
};
const target = { affixes: scenario.target.map((name) => ({ affixId: affixId(name), needsImprovement: false })) };
const payload = {
  state, target, data,
  gaConfig: { currentGAAffixes: [], unsatisfactoryAffixIds: [], strictMode: true, sacrificeAffixId: "" },
  timeMs: 0,
};

const pools = poolSizes(scenario.gearSlot, scenario.class);
console.log(`pool sizes (Boots/Spiritborn): ` + Object.entries(pools).map(([c, n]) => `${c}=${n}`).join("  ") +
  `  total=${Object.values(pools).reduce((a, b) => a + b, 0)}`);

function diag(label, res) {
  const d = res.diagnostics || {};
  console.log(`  ${label}: strategy=${res.strategy || d.strategy} action=${res.action && res.action.type} ` +
    `expectedSteps=${res.expectedSteps} expandedStates=${d.expandedStates} deadStates=${d.deadStates} ` +
    `reason=${JSON.stringify(d.reason || "").slice(0, 80)}`);
}

// Match the browser worker's run handler (d4cubeoptimv3-worker.js:6016) and
// Rust's optimize_payload (lib.rs:229), both of which use refineDepth=2,
// refineTopK=6. The previous bare optimizePayloadV3(payload) call defaulted to
// refineDepth=1/refineTopK=1, so JS was doing far less work than Rust/browser.
let t = Date.now();
const jsOpt = worker.optimizePayloadV3(payload, { refineDepth: 2, refineTopK: 6 });
const jsMs = Date.now() - t;
console.log(`JS optimize = ${jsMs}ms`);
diag("JS", jsOpt);

ilpStats.calls = 0; ilpStats.jsMs = 0; ilpStats.jsonBytes = 0;
t = Date.now();
const rustOpt = JSON.parse(rustMod.optimize_payload(JSON.stringify(payload), solveIlp));
const rustMs = Date.now() - t;
console.log(`Rust optimize = ${rustMs}ms`);
console.log(`  ILP callbacks: calls=${ilpStats.calls} jsTimeInIlp=${ilpStats.jsMs}ms ` +
  `totalJsonMB=${(ilpStats.jsonBytes / 1e6).toFixed(1)} ` +
  `=> rustOnlyTime=${rustMs - ilpStats.jsMs}ms`);
diag("Rust", rustOpt);

console.log("\n--- JS full diagnostics ---");
console.log(JSON.stringify(jsOpt.diagnostics, null, 1));
console.log("\n--- Rust full diagnostics ---");
console.log(JSON.stringify(rustOpt.diagnostics, null, 1));
console.log("\nJS approximate=", jsOpt.approximate, " Rust approximate=", rustOpt.approximate);
console.log("JS action=", JSON.stringify(jsOpt.action), "\nRust action=", JSON.stringify(rustOpt.action));
