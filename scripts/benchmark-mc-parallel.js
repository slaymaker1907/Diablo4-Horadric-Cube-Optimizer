#!/usr/bin/env node
/**
 * benchmark-mc-parallel.js
 *
 * Measures the wall-time speedup from parallelising the gold-standard Monte
 * Carlo verification across 16 worker threads vs. single-threaded execution.
 *
 *   node scripts/benchmark-mc-parallel.js
 *
 * Runtime: ~3–6 minutes (dominated by the K=2000 single-threaded runs).
 * Exit code 0 on completion; non-zero if the two methods disagree statistically.
 */

"use strict";

const worker = require("../d4cubeoptimv3-worker.js");
const config = require("../config.js");
const slotLegality = require("../gear-slot-legality.js");
const { runMCParallelV3 } = require("./run-mc-parallel.js");

// ─── Mulberry32 PRNG ─────────────────────────────────────────────────────────
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
  const orig = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = orig; }
}

// ─── Real-catalog setup (mirrors verify-mc-bellman.js) ──────────────────────
function slugify(v) {
  return String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function buildRealCatalog() {
  const map = Object.create(null);
  function addEntry(cat, entry) {
    const baseName = typeof entry === "string" ? entry : entry.name;
    const family = typeof entry === "string" ? "" : String(entry.family || "");
    const familyRollWeight = typeof entry === "string" ? 0 : Number(entry.familyRollWeight) || 0;
    const className = typeof entry === "string" ? "" : String(entry.class || "");
    const expanded = baseName === "Elemental Damage"
      ? config.DAMAGE_TYPES.map((t) => `Elemental Damage (${t})`)
      : baseName === "Specific Resistance"
        ? config.DAMAGE_TYPES.map((t) => `Specific Resistance (${t})`)
        : [baseName];
    for (const name of expanded) {
      const id = slugify(name);
      if (!map[id]) {
        map[id] = { id, name, categories: [], gearSlots: slotLegality.getLegalGearSlotsForAffixName(name), family, rollWeight: 1 };
      }
      if (familyRollWeight > 0) map[id].familyRollWeight = familyRollWeight;
      if (className) map[id].class = className;
      if (family) map[id].family = family;
      if (!map[id].categories.includes(cat)) map[id].categories.push(cat);
    }
  }
  for (const [cat, entries] of Object.entries(config.CATEGORY_TO_AFFIX_NAMES)) {
    for (const e of entries) addEntry(cat, e);
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
  if (!catalog.byName[n]) throw new Error(`Affix not found: ${n}`);
  return catalog.byName[n].id;
};
function buildPayload(affixSpecs) {
  const data = {
    affixes: catalog.affixes,
    categories: catalog.categories,
    gearSlots: slotLegality.GEAR_SLOTS,
    classes: config.CLASSES,
    targetAffixIds: [],
    maxAffixSlots: 4,
  };
  const state = {
    gearSlot: "Amulet", class: "Spiritborn", isLegendary: false,
    affixes: affixSpecs.map((s) => ({ affixId: aid(s.name), isGA: !!s.isGA, isEnchanted: !!s.isEnchanted })),
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
  };
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "n/a");
function msToS(ms) { return (ms / 1000).toFixed(1) + "s"; }

// ─── Single-threaded MC runner ────────────────────────────────────────────────
function runSingleThreaded(payload, intermediate, K, seed) {
  const t0 = Date.now();
  const result = withSeededRandom(seed, () =>
    worker.runMCVerificationV3(
      { ...payload, tightenStepsLevel: "heavy", tightenStepsOverrides: { heavyRollouts: K } },
      intermediate
    )
  );
  const wallMs = Date.now() - t0;
  const gs = result.diagnostics.goldStandard;
  return { mean: gs.mean, ci: gs.ci95halfWidth, truncated: gs.truncatedRolloutCount, wallMs };
}

// ─── Benchmark runner ─────────────────────────────────────────────────────────
async function benchmarkScenario(label, affixSpecs, K, singleSeed, parallelMasterSeed) {
  console.log(`\n┌─ ${label} (K=${K}) `  + "─".repeat(Math.max(0, 60 - label.length - String(K).length - 6)) + "┐");

  const payload = buildPayload(affixSpecs);
  const intermediate = worker.optimizePayloadV3(payload);
  console.log(`│  Optimizer headline: ${f2(intermediate.expectedSteps)} steps`);

  // ── Single-threaded ──
  process.stdout.write(`│  Single-threaded  (seed=${singleSeed}): running... `);
  const st = runSingleThreaded(payload, intermediate, K, singleSeed);
  console.log(`done in ${msToS(st.wallMs)}`);
  console.log(`│    mean=${f2(st.mean)} ± ${f2(st.ci)} (95% CI), truncated=${st.truncated}/${K}`);

  // ── Parallel 16 threads ──
  process.stdout.write(`│  Parallel 16t     (seed=${parallelMasterSeed}): running... `);
  const t0p = Date.now();
  const parResult = await runMCParallelV3(payload, intermediate, {
    totalRollouts: K,
    numThreads: 16,
    masterSeed: parallelMasterSeed,
  });
  const par = parResult.diagnostics.goldStandard;
  const parWallMs = Date.now() - t0p;
  console.log(`done in ${msToS(parWallMs)}`);
  console.log(`│    mean=${f2(par.mean)} ± ${f2(par.ci95halfWidth)} (95% CI), truncated=${par.truncatedRolloutCount}/${K}`);
  console.log(`│    (max thread wall time: ${msToS(par.maxThreadWallMs)})`);

  // ── Speedup ──
  const speedup = st.wallMs / parWallMs;
  const combinedSE = Math.sqrt(
    (st.ci / 1.96) ** 2 + (par.ci95halfWidth / 1.96) ** 2
  );
  const delta = Math.abs(st.mean - par.mean);
  const tol = 3 * combinedSE;
  const agree = delta <= tol;
  console.log(`│  Speedup: ${f1(speedup)}×`);
  console.log(`│  Means agree within 3 SE: ${agree ? "YES" : "NO"} (|Δ|=${f2(delta)}, tol=${f2(tol)})`);
  console.log(`└${"─".repeat(66)}┘`);

  return { label, K, stWallMs: st.wallMs, parWallMs, speedup, agree };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const N_THREADS = 16;
  const K = 2000;

  console.log("=".repeat(68));
  console.log(" MC Parallelization Benchmark");
  console.log(`  Threads: ${N_THREADS}    K per scenario: ${K}`);
  console.log(`  Node.js ${process.version}`);
  console.log("=".repeat(68));

  // ── JIT warm-up: a quick single-threaded run so the optimizer's hot paths
  //    are compiled before we start timing. K=50 is cheap enough to not
  //    distort the results.
  console.log("\n[Warm-up] K=50 single-threaded...");
  const warmPayload = buildPayload([
    { name: "Movement Speed" },
    { name: "Attack Speed" },
    { name: "Vulnerable Damage", isEnchanted: true },
  ]);
  const warmIntermediate = worker.optimizePayloadV3(warmPayload);
  withSeededRandom(1, () =>
    worker.runMCVerificationV3(
      { ...warmPayload, tightenStepsLevel: "heavy", tightenStepsOverrides: { heavyRollouts: 50 } },
      warmIntermediate
    )
  );
  console.log("[Warm-up] done.\n");

  const results = [];

  // Scenario A: 3-affix (Bug 2 case — true cost ~48, optimizer says ~13)
  results.push(await benchmarkScenario(
    "Spiritborn Amulet 3-affix (VD enchanted)",
    [
      { name: "Movement Speed" },
      { name: "Attack Speed" },
      { name: "Vulnerable Damage", isEnchanted: true },
    ],
    K,
    /* singleSeed */ 42,
    /* parallelMasterSeed */ 99
  ));

  // Scenario B: 4-affix (Remove Mainstat first, then same chain)
  results.push(await benchmarkScenario(
    "Spiritborn Amulet 4-affix (Mainstat present)",
    [
      { name: "Movement Speed" },
      { name: "Attack Speed" },
      { name: "Vulnerable Damage", isEnchanted: true },
      { name: "Mainstat" },
    ],
    K,
    /* singleSeed */ 43,
    /* parallelMasterSeed */ 100
  ));

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(68));
  console.log(" Summary");
  console.log("=".repeat(68));
  const avgSpeedup = results.reduce((s, r) => s + r.speedup, 0) / results.length;
  const allAgree = results.every((r) => r.agree);
  console.log(`\n  Average speedup (${N_THREADS} threads, K=${K}): ${f1(avgSpeedup)}×`);
  console.log(`  Statistical consistency: ${allAgree ? "ALL PASS" : "SOME FAIL (means diverged > 3 SE)"}`);
  console.log(`\n  Theoretical max (Amdahl, 98% parallel): ~${f1(1 / (0.02 + 0.98 / N_THREADS))}×`);
  console.log(`  Why the gap is so large on these scenarios:`);
  console.log(`    • The MC cost is dominated by the optimizer warming a per-process`);
  console.log(`      action cache (~hundreds of unique reachable states, each ~5–800 ms`);
  console.log(`      to optimize). Once the cache is warm, the remaining rollouts are`);
  console.log(`      ~1000× cheaper.`);
  console.log(`    • This implementation warms the cache once in the main thread (phase 1)`);
  console.log(`      and then runs the remaining rollouts in parallel with the pre-warmed`);
  console.log(`      cache (phase 2). Phase 2 is ~free for hard scenarios, so the speedup`);
  console.log(`      is bounded by how big a fraction of K falls into phase 2.`);
  console.log(`    • True N× speedup would require parallelising the per-unique-state`);
  console.log(`      optimizer calls themselves (BFS over reachable states + worker-pool`);
  console.log(`      dispatch of optimizePayloadV3). That is deferred.`);
  console.log("");

  process.exit(allAgree ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
