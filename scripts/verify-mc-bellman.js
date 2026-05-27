#!/usr/bin/env node
/**
 * verify-mc-bellman.js
 *
 * Verifies that the gold-standard Monte Carlo verification machinery is
 * unbiased and obeys the Bellman equation. Three checks:
 *
 *   3.1 — Multi-seed convergence: 5 independent seeds at K=2000 on the
 *         user's Spiritborn-Amulet 3-affix and 4-affix scenarios. All
 *         seeds must agree within 3 × combined SE. Rules out
 *         non-determinism in rollout machinery.
 *
 *   3.2 — Bellman consistency: for a state where the recommended action
 *         is deterministic, MC[parent] = 1 + MC[successor] must hold
 *         within 2 × sqrt(SE[parent]^2 + SE[successor]^2).
 *
 *   3.3 — Analytical ground-truth: a tiny scenario where Part-1's
 *         E = 2 - 1/N formula applies and is exact. MC at K=5000 must
 *         match the analytical truth within 3 SE.
 *
 * Read-only. Does NOT modify any worker or test files. Opt-in: NOT part
 * of the default `node --test` suite. Runtime ~3-5 minutes.
 *
 *   node scripts/verify-mc-bellman.js
 *
 * Exit code 0 on all pass, non-zero on any failure.
 */

"use strict";

const worker = require("../d4cubeoptimv3-worker.js");
const config = require("../config.js");
const slotLegality = require("../gear-slot-legality.js");

// ─── Mulberry32 PRNG for seeded MC runs ─────────────────────────────────────
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
function withSeededRandom(seed, fn) {
  const original = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

// ─── Real-catalog setup ─────────────────────────────────────────────────────
function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function buildRealCatalog() {
  const DAMAGE_TYPES = config.DAMAGE_TYPES;
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
const aid = (n) => {
  if (!catalog.byName[n]) throw new Error(`Affix not found in catalog: ${n}`);
  return catalog.byName[n].id;
};

function buildSpiritbornAmuletPayload(affixSpecs, tightenStepsOverrides) {
  const data = {
    affixes: catalog.affixes,
    categories: catalog.categories,
    gearSlots: slotLegality.GEAR_SLOTS,
    classes: config.CLASSES,
    targetAffixIds: [],
    maxAffixSlots: 4,
  };
  const state = {
    gearSlot: "Amulet",
    class: "Spiritborn",
    isLegendary: false,
    affixes: affixSpecs.map((s) => ({
      affixId: aid(s.name), isGA: !!s.isGA, isEnchanted: !!s.isEnchanted,
    })),
  };
  const target = {
    affixes: [
      { affixId: aid("Movement Speed"), requireGA: false, needsImprovement: false },
      { affixId: aid("Attack Speed"), requireGA: false, needsImprovement: false },
      { affixId: aid("Vulnerable Damage"), requireGA: false, needsImprovement: false },
      { affixId: aid("Elemental Damage (Physical)"), requireGA: false, needsImprovement: false },
    ],
  };
  data.targetAffixIds = target.affixes.map((e) => e.affixId);
  return {
    state, target, data,
    gaConfig: { currentGAAffixes: [], unsatisfactoryAffixIds: [], strictMode: true, sacrificeAffixId: "" },
    timeMs: 30000,
    tightenStepsLevel: "heavy",
    tightenStepsOverrides,
  };
}

// ─── Test harness ───────────────────────────────────────────────────────────
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

function fmt(x, d = 3) { return Number.isFinite(x) ? x.toFixed(d) : "(n/a)"; }

async function runAll() {
  let failures = 0;
  for (const { name, fn } of checks) {
    process.stdout.write(`\n=== ${name} ===\n`);
    const t0 = Date.now();
    try {
      await fn();
      console.log(`PASS  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      failures++;
      console.log(`FAIL  (${((Date.now() - t0) / 1000).toFixed(1)}s): ${err.message}`);
    }
  }
  console.log(`\n${checks.length - failures} / ${checks.length} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

// ─── 3.1: Multi-seed convergence ────────────────────────────────────────────
check("3.1 Multi-seed convergence on Spiritborn 3-affix Amulet (K=2000, 5 seeds)", () => {
  const SEEDS = [1, 7, 42, 1337, 2024];
  const K = 2000;
  const results = [];
  for (const seed of SEEDS) {
    const payload = buildSpiritbornAmuletPayload(
      [
        { name: "Movement Speed" },
        { name: "Attack Speed" },
        { name: "Vulnerable Damage", isEnchanted: true },
      ],
      { heavyRollouts: K }
    );
    const intermediate = worker.optimizePayloadV3(payload);
    const final = withSeededRandom(seed, () => worker.runMCVerificationV3(payload, intermediate));
    const gs = final.diagnostics.goldStandard;
    results.push({ seed, mean: gs.mean, se: gs.ci95halfWidth / 1.96 });
    console.log(`  seed=${seed}  mean=${fmt(gs.mean, 2)}  SE=${fmt(gs.ci95halfWidth / 1.96, 3)}`);
  }
  // Check that all means agree within 3 × combined SE of each other.
  const meanOfMeans = results.reduce((s, r) => s + r.mean, 0) / results.length;
  const maxSE = Math.max(...results.map((r) => r.se));
  const maxDrift = Math.max(...results.map((r) => Math.abs(r.mean - meanOfMeans)));
  console.log(`  mean-of-means=${fmt(meanOfMeans, 2)}  maxSE=${fmt(maxSE, 3)}  maxDrift=${fmt(maxDrift, 3)}`);
  if (maxDrift > 3 * maxSE) {
    throw new Error(`Max drift ${maxDrift.toFixed(2)} exceeds 3×SE (${(3 * maxSE).toFixed(2)}) — seeds disagree`);
  }
});

// ─── 3.2: Bellman consistency on deterministic-Remove transition ────────────
check("3.2 Bellman consistency: MC[4-affix] = 1 + MC[3-affix] within 2 × combined SE", () => {
  const K = 2000;
  const payload4 = buildSpiritbornAmuletPayload(
    [
      { name: "Movement Speed" },
      { name: "Attack Speed" },
      { name: "Vulnerable Damage", isEnchanted: true },
      { name: "Mainstat" },
    ],
    { heavyRollouts: K }
  );
  const payload3 = buildSpiritbornAmuletPayload(
    [
      { name: "Movement Speed" },
      { name: "Attack Speed" },
      { name: "Vulnerable Damage", isEnchanted: true },
    ],
    { heavyRollouts: K }
  );

  const intermediate4 = worker.optimizePayloadV3(payload4);
  const final4 = withSeededRandom(42, () => worker.runMCVerificationV3(payload4, intermediate4));
  const gs4 = final4.diagnostics.goldStandard;

  const intermediate3 = worker.optimizePayloadV3(payload3);
  const final3 = withSeededRandom(43, () => worker.runMCVerificationV3(payload3, intermediate3));
  const gs3 = final3.diagnostics.goldStandard;

  console.log(`  MC[4-affix]  = ${fmt(gs4.mean, 2)} ± ${fmt(gs4.ci95halfWidth, 2)} (95% CI)`);
  console.log(`  MC[3-affix]  = ${fmt(gs3.mean, 2)} ± ${fmt(gs3.ci95halfWidth, 2)} (95% CI)`);
  console.log(`  Predicted MC[4] = 1 + MC[3]  = ${fmt(1 + gs3.mean, 2)}`);

  const se4 = gs4.ci95halfWidth / 1.96;
  const se3 = gs3.ci95halfWidth / 1.96;
  const combinedSE = Math.sqrt(se4 * se4 + se3 * se3);
  const expectedDelta = gs4.mean - (1 + gs3.mean);
  console.log(`  Δ = MC[4] - (1 + MC[3])     = ${fmt(expectedDelta, 3)}  (tolerance 2 × combined SE = ${fmt(2 * combinedSE, 3)})`);
  if (Math.abs(expectedDelta) > 2 * combinedSE) {
    throw new Error(`Bellman violation: Δ=${expectedDelta.toFixed(2)} exceeds 2×SE (${(2 * combinedSE).toFixed(2)})`);
  }
});

// ─── 3.3: Analytical ground-truth ───────────────────────────────────────────
check("3.3 Analytical ground-truth on Bug 1 scenario (E = 2 - 1/N), K=5000", () => {
  // Tiny scenario where Bug 1 fix applies (no slot enchanted, target needs
  // one more affix in Aggressive). We compare MC against the analytical
  // truth 2 - 1/N where N is the effective Aggressive add pool size.
  const K = 5000;
  // Use a stripped-down catalog that lets us know N exactly.
  const fixtureAffixes = [
    { id: "movement-speed", name: "Movement Speed", categories: ["Pragmatic"], rollWeight: 1, gearSlots: null },
    { id: "critical-strike-chance", name: "Critical Strike Chance", categories: ["Aggressive"], rollWeight: 1, gearSlots: null },
    { id: "critical-strike-damage", name: "Critical Strike Damage", categories: ["Aggressive"], rollWeight: 1, gearSlots: null },
    { id: "elemental-damage-physical", name: "Elemental Damage (Physical)", categories: ["Aggressive"], rollWeight: 1, family: "elemental-damage", gearSlots: null },
    { id: "elemental-damage-fire", name: "Elemental Damage (Fire)", categories: ["Aggressive"], rollWeight: 1, family: "elemental-damage", gearSlots: null },
    { id: "thorns", name: "Thorns", categories: ["Aggressive"], rollWeight: 1, gearSlots: null },
    { id: "armor", name: "Armor", categories: ["Protector"], rollWeight: 1, gearSlots: null },
  ];
  const data = {
    affixes: fixtureAffixes,
    categories: {
      Pragmatic: ["movement-speed"],
      Aggressive: ["critical-strike-chance", "critical-strike-damage", "elemental-damage-physical", "elemental-damage-fire", "thorns"],
      Protector: ["armor"],
    },
    targetAffixIds: [],
    maxAffixSlots: 4,
  };
  const state = {
    gearSlot: "Any", class: "Any", isLegendary: false,
    affixes: [{ affixId: "movement-speed", isGA: false, isEnchanted: false }],
  };
  const target = {
    affixes: [
      { affixId: "movement-speed", requireGA: false, needsImprovement: false },
      { affixId: "critical-strike-chance", requireGA: false, needsImprovement: false },
    ],
  };
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  // N = effective Aggressive add pool: CSC + CSD + 1 elemental-family-roll + Thorns = 4 unique + 1 family = 5.
  const N = 5;
  const analyticalE = 2 - 1 / N;
  console.log(`  Analytical truth: E = 2 - 1/${N} = ${fmt(analyticalE, 3)}`);

  const payload = {
    state, target, data,
    gaConfig: { currentGAAffixes: [], unsatisfactoryAffixIds: [], strictMode: true, sacrificeAffixId: "" },
    tightenStepsLevel: "heavy",
    tightenStepsOverrides: { heavyRollouts: K },
  };
  const intermediate = worker.optimizePayloadV3(payload);
  console.log(`  Optimizer headline: ${fmt(intermediate.expectedSteps, 3)} (should match analytical)`);

  const final = withSeededRandom(99, () => worker.runMCVerificationV3(payload, intermediate));
  const gs = final.diagnostics.goldStandard;
  console.log(`  MC mean: ${fmt(gs.mean, 3)} ± ${fmt(gs.ci95halfWidth, 3)} (95% CI)`);

  const drift = Math.abs(gs.mean - analyticalE);
  const se = gs.ci95halfWidth / 1.96;
  console.log(`  Drift = ${fmt(drift, 3)}; tolerance 3 SE = ${fmt(3 * se, 3)}`);
  if (drift > 3 * se) {
    throw new Error(`MC mean ${gs.mean.toFixed(3)} drifted ${drift.toFixed(3)} from analytical ${analyticalE.toFixed(3)} (exceeds 3 SE)`);
  }
});

runAll();
