"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const wt = require("./weight-tracking.js");
const worker = require("./d4cubeoptimv3-worker.js");
const learnScript = require("./scripts/learn-weights-from-tracking.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

// Worker env / data for the REAL catalog (baseline weights, no overrides).
function buildWorkerData(catalog) {
  const affixes = catalog.affixes;
  const categories = Object.create(null);
  for (const affix of affixes) {
    for (const cat of affix.categories) {
      (categories[cat] || (categories[cat] = [])).push(affix.id);
    }
  }
  return {
    affixes,
    categories,
    gearSlots: worker && worker.GEAR_SLOTS ? worker.GEAR_SLOTS : undefined,
    classes: undefined,
    targetAffixIds: [],
    maxAffixSlots: 4,
  };
}

// Aggregate a {affixId: probability} distribution to {unitKey: probability}.
// `affixMap` resolves ids → affix entries; use env.affixMap for worker outputs
// since the worker canonicalizes elemental/resistance subtypes into family
// placeholder ids that are not in the plain catalog.
function aggregateByUnit(dist, affixMap) {
  const out = Object.create(null);
  for (const [affixId, p] of Object.entries(dist)) {
    const unit = wt.learningUnitForAffix(affixMap[affixId]);
    assert.ok(unit, `no unit for affix id ${affixId}`);
    out[unit.key] = (out[unit.key] || 0) + p;
  }
  return out;
}

// My predicted {unitKey: probability} for a draw from `contribution`.
function predictedUnitDist(contribution, index) {
  let total = 0;
  const weights = Object.create(null);
  for (const u of contribution.eligibleUnits) {
    const w = wt.unitPoolWeight(u, null, index);
    weights[u.key] = w;
    total += w;
  }
  const out = Object.create(null);
  for (const key of Object.keys(weights)) {
    out[key] = weights[key] / total;
  }
  return out;
}

// Worker's "add" outcome distribution as {addedAffixId: probability}.
function workerAddDist(state, prism, env) {
  const before = new Set(state.affixes.map((e) => e.affixId));
  const outcomes = worker.getActionOutcomes(state, { type: "add", prism }, env);
  const dist = Object.create(null);
  for (const o of outcomes) {
    const added = o.state.affixes.find((e) => !before.has(e.affixId));
    if (added) {
      dist[added.affixId] = (dist[added.affixId] || 0) + o.probability;
    }
  }
  return dist;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("eligible-pool parity: computeDrawContribution matches the worker (add)", () => {
  const catalog = learnScript.buildCatalog([]);
  const index = catalog.__wtIndex;
  const data = buildWorkerData(catalog);
  const env = worker.buildEnv(data, { currentGAAffixes: [], strictMode: true }, { affixes: [] });

  const scenarios = [
    { gearSlot: "Any", class: "Any", prism: "Aggressive", result: "critical-strike-chance" },
    { gearSlot: "Any", class: "Any", prism: "Protector", result: "maximum-life" },
    { gearSlot: "Amulet", class: "Sorceror", prism: "Adept", result: "mainstat" },
    { gearSlot: "Any", class: "Any", prism: "Resourceful", result: "maximum-resource" },
  ];

  for (const sc of scenarios) {
    const state = { gearSlot: sc.gearSlot, class: sc.class, isLegendary: false, affixes: [] };
    const workerDist = aggregateByUnit(workerAddDist(state, sc.prism, env), env.affixMap);

    const contrib = wt.computeDrawContribution(state, "add", sc.prism, sc.result, catalog);
    assert.ok(contrib.informative, `contribution should be informative for ${sc.prism}`);
    const myDist = predictedUnitDist(contrib, index);

    const keys = new Set([...Object.keys(workerDist), ...Object.keys(myDist)]);
    for (const key of keys) {
      const a = workerDist[key] || 0;
      const b = myDist[key] || 0;
      assert.ok(
        Math.abs(a - b) < 1e-9,
        `unit ${key} prob mismatch for ${sc.prism} (${sc.gearSlot}/${sc.class}): worker=${a} mine=${b}`
      );
    }
  }
});

test("eligible-pool parity: focused reroll matches the worker", () => {
  const catalog = learnScript.buildCatalog([]);
  const index = catalog.__wtIndex;
  const data = buildWorkerData(catalog);
  const env = worker.buildEnv(data, { currentGAAffixes: [], strictMode: true }, { affixes: [] });

  // Item with a single Aggressive-eligible source so the focused source is unique.
  const mainstatId = "mainstat";
  const lifeId = "maximum-life";
  const state = {
    gearSlot: "Any", class: "Any", isLegendary: false,
    affixes: [
      { affixId: mainstatId, isGA: false, isEnchanted: false },
      { affixId: lifeId, isGA: false, isEnchanted: false },
    ],
  };
  const prism = "Aggressive";
  const sourceIndex = 0; // mainstat is in Aggressive

  // Worker focused distribution for that single source → {resultAffixId: prob}.
  const outcomes = worker.getActionOutcomes(state, { type: "focused", prism }, env);
  // All outcomes come from source 0 (only mainstat is Aggressive-eligible & not enchanted).
  const dist = Object.create(null);
  for (const o of outcomes) {
    const changed = o.state.affixes[sourceIndex];
    dist[changed.affixId] = (dist[changed.affixId] || 0) + o.probability;
  }
  const workerDist = aggregateByUnit(dist, env.affixMap);

  const contrib = wt.computeDrawContribution(
    Object.assign({}, state, { sourceIndex }), "focused", prism, "critical-strike-chance", catalog
  );
  assert.ok(contrib.informative);
  const myDist = predictedUnitDist(contrib, index);

  const keys = new Set([...Object.keys(workerDist), ...Object.keys(myDist)]);
  for (const key of keys) {
    const a = workerDist[key] || 0;
    const b = myDist[key] || 0;
    assert.ok(Math.abs(a - b) < 1e-9, `focused unit ${key} mismatch: worker=${a} mine=${b}`);
  }
});

test("remove / enchant draws are non-informative", () => {
  const catalog = learnScript.buildCatalog([]);
  const r = wt.computeDrawContribution({ gearSlot: "Any", class: "Any", affixes: [] }, "remove", "Aggressive", "mainstat", catalog);
  assert.equal(r.informative, false);
  const e = wt.computeDrawContribution({ gearSlot: "Any", class: "Any", affixes: [] }, "enchant", "None", "mainstat", catalog);
  assert.equal(e.informative, false);
});

test("synthetic recovery: iterateWeights recovers known single-affix ratios", () => {
  // Minimal catalog: one category "C", four singleton affixes with true weights.
  const trueW = { a: 1, b: 2, c: 4, d: 1 };
  const affixes = Object.keys(trueW).map((id) => ({
    id, name: id, categories: ["C"], gearSlots: null, family: "", rollWeight: 1,
  }));
  const catalog = { affixes, __wtIndex: wt.indexCatalog(affixes) };
  const ids = Object.keys(trueW);
  const totalTrue = ids.reduce((s, id) => s + trueW[id], 0);

  const rng = mulberry32(12345);
  function sample() {
    let x = rng() * totalTrue;
    for (const id of ids) { x -= trueW[id]; if (x <= 0) return id; }
    return ids[ids.length - 1];
  }

  const contributions = [];
  const N = 40000;
  for (let i = 0; i < N; i++) {
    const winner = sample();
    contributions.push(wt.computeDrawContribution({ gearSlot: "Any", class: "Any", affixes: [] }, "add", "C", winner, catalog));
  }
  for (const c of contributions) { assert.ok(c.informative); }

  const res = wt.iterateWeights(contributions, catalog, { priorStrength: 0.5, maxIters: 500 });
  // Normalize both to ratios vs affix "a".
  const wa = res.unitWeights["affix:a"];
  for (const id of ids) {
    const got = res.unitWeights["affix:" + id] / wa;
    const want = trueW[id] / trueW.a;
    assert.ok(Math.abs(got - want) / want < 0.07, `affix ${id}: recovered ratio ${got.toFixed(3)} vs true ${want} (>7% off)`);
  }
});

test("mergeStats is additive: split == single-pass", () => {
  const affixes = ["a", "b", "c"].map((id) => ({ id, name: id, categories: ["C"], gearSlots: null, family: "", rollWeight: 1 }));
  const catalog = { affixes, __wtIndex: wt.indexCatalog(affixes) };
  const rng = mulberry32(99);
  const ids = ["a", "b", "c"];

  const all = Object.create(null);
  const s1 = Object.create(null);
  const s2 = Object.create(null);
  for (let i = 0; i < 500; i++) {
    const winner = ids[Math.floor(rng() * ids.length)];
    const c = wt.computeDrawContribution({ gearSlot: "Any", class: "Any", affixes: [] }, "add", "C", winner, catalog);
    wt.accumulateStats(all, c, catalog);
    wt.accumulateStats(i % 2 === 0 ? s1 : s2, c, catalog);
  }
  const merged = wt.mergeStats(s1, s2);
  for (const key of Object.keys(all)) {
    assert.ok(Math.abs(all[key].wins - merged[key].wins) < 1e-9, `wins ${key}`);
    assert.ok(Math.abs(all[key].exposure - merged[key].exposure) < 1e-9, `exposure ${key}`);
  }
});

test("one-shot deriveWeights agrees with a single iterate pass", () => {
  const affixes = ["a", "b", "c"].map((id) => ({ id, name: id, categories: ["C"], gearSlots: null, family: "", rollWeight: 1 }));
  const catalog = { affixes, __wtIndex: wt.indexCatalog(affixes) };
  const rng = mulberry32(7);
  const ids = ["a", "b", "c"];
  const trueW = { a: 1, b: 3, c: 2 };
  const total = 6;

  const stats = Object.create(null);
  const contributions = [];
  for (let i = 0; i < 3000; i++) {
    let x = rng() * total, winner = "c";
    for (const id of ids) { x -= trueW[id]; if (x <= 0) { winner = id; break; } }
    const c = wt.computeDrawContribution({ gearSlot: "Any", class: "Any", affixes: [] }, "add", "C", winner, catalog);
    wt.accumulateStats(stats, c, catalog);
    contributions.push(c);
  }
  const oneShot = wt.deriveWeights(stats, catalog, { priorStrength: 0.5 });
  const oneIter = wt.iterateWeights(contributions, catalog, { priorStrength: 0.5, maxIters: 1 });
  for (const id of ids) {
    const key = "affix:" + id;
    assert.ok(
      Math.abs(oneShot.unitWeights[key] - oneIter.unitWeights[key]) < 1e-9,
      `one-shot vs 1-iter mismatch for ${id}`
    );
  }
});
