/**
 * repro-ga-preserve-enchant.js
 *
 * Reproduces and verifies the fix for: optimizer recommending a suboptimal
 * (or outright dead-end) action instead of the GA-preserve enchant that
 * unlocks a blocked prism.
 *
 * Root cause: getValidActionsV2 filtered all same-affix enchant actions
 * (line ~2299 in d4cubeoptimv3-worker.js), including the valid fresh-enchant
 * GA-preserve mark.  When a protected GA affix shares a prism category with
 * missing targets, strictMode blocks cube ops on that category entirely
 * until the GA slot is locked via an enchant.  Without the enchant in the
 * action set, the solver cannot discover the optimal "enchant GA first, then
 * chaotic-reroll" sequence.
 *
 * Scenario (Protector-only catalog, Legendary item)
 * ─────────────────────────────────────────────────
 * All affixes are in the Protector category.  In strictMode this means that
 * ALL cube operations (chaotic / focused) are blocked as long as Maximum Life
 * (GA) appears in the eligible Protector pool.  The ONLY action that unblocks
 * the prism is the same-affix fresh enchant on Maximum Life.
 *
 * Current item (Legendary):
 *   Slot 0: Maximum Life    [GA]   (Protector)
 *   Slot 1: Damage Reduction       (Protector, non-target)
 *   Slot 2: Specific Resistance    (Protector, matched target)
 *   Slot 3: Max Block              (Protector, non-target)
 *
 * Target:
 *   Maximum Life         (GA must be preserved)
 *   Specific Resistance  (already present — matched target)
 *   Armor                (missing)
 *   All Resistance       (missing)
 *
 * Analysis:
 *   • All four current affixes are Protector.  With strictMode=true,
 *     getValidActions blocks the Protector chaotic/focused rerolls entirely
 *     (touchesGA=true) because Maximum Life (GA) is in the Protector eligible
 *     pool while it is un-enchanted.
 *
 *   • The prismUnblockEnchants block in getValidActionsV2 provides exactly
 *     two same-affix fresh-enchant actions:
 *       a) enchant MaxLife  → MaxLife  (GA-preserve; unlocks Protector prism)
 *       b) enchant SpecRes  → SpecRes  (non-GA matched-target; does NOT help
 *                                       because MaxLife-GA remains in the
 *                                       eligible pool → prism still blocked →
 *                                       sticky-slot used → dead end with
 *                                       P(success)=0)
 *
 *   • The solver must pick (a): after MaxLife gains isEnchanted=true it is
 *     excluded from getEligibleByCategory, making touchesGA=false, and the
 *     Protector chaotic/focused become available to roll Damage Reduction /
 *     Specific Resistance / Max Block into Armor + All Resistance.
 *
 * Expected result after the fix:
 *   result.action.type === "enchant"
 *   result.action.targetAffixId === "maximum-life"  (GA-preserve mark)
 *   result.successProb === 1  (guaranteed completion once prism is unlocked)
 */

"use strict";

const { optimizePayloadV3 } = require("../d4cubeoptimv3-worker.js");

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildCatalog() {
  const categoryToNames = {
    Protector: [
      "Maximum Life",
      "Armor",
      "Damage Reduction",
      "All Resistance",
      "Specific Resistance",
      "Max Block",
    ],
  };

  const byId = new Map();
  for (const [category, names] of Object.entries(categoryToNames)) {
    for (const name of names) {
      const id = normalizeName(name);
      if (!byId.has(id)) {
        byId.set(id, { id, name, categories: [], rollWeight: 1 });
      }
      byId.get(id).categories.push(category);
    }
  }

  const affixes = Array.from(byId.values());
  const byName = Object.fromEntries(affixes.map((a) => [a.name, a]));
  const categories = Object.fromEntries(
    Object.entries(categoryToNames).map(([cat, names]) => [
      cat,
      names.map((n) => byName[n].id),
    ])
  );

  return { affixes, byName, categories };
}

const { affixes, byName, categories } = buildCatalog();

const data = {
  affixes,
  categories,
  targetAffixIds: [],
  maxAffixSlots: 4,
};

// Current state: MaxLife (GA) + three non-GA Protector affixes.
// All are in Protector only, so strictMode blocks every cube operation
// until MaxLife is enchanted in place.
const state = {
  gearSlot: "Any",
  class: "Any",
  isLegendary: true,
  affixes: [
    { affixId: byName["Maximum Life"].id,       isGA: true,  isEnchanted: false },
    { affixId: byName["Damage Reduction"].id,   isGA: false, isEnchanted: false },
    { affixId: byName["Specific Resistance"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Max Block"].id,           isGA: false, isEnchanted: false },
  ],
};

// Target: MaxLife (GA preserved) + SpecResistance (already present) +
// Armor + AllResistance (both missing).
const target = {
  affixes: [
    { affixId: byName["Maximum Life"].id,        needsImprovement: false },
    { affixId: byName["Specific Resistance"].id,  needsImprovement: false },
    { affixId: byName["Armor"].id,               needsImprovement: false },
    { affixId: byName["All Resistance"].id,       needsImprovement: false },
  ],
};

const gaConfig = {
  currentGAAffixes: [byName["Maximum Life"].id],
  strictMode: true,
  rulesEnabled: true,
};

const payload = {
  state,
  target,
  data,
  gaConfig,
  timeMs: 5000,
};

console.log("Running optimizer for GA-preserve-enchant (Protector-only) scenario…");
console.log("Current affixes:", state.affixes.map((a) => `${a.affixId}${a.isGA ? " [GA]" : ""}`));
console.log("Target affixes: ", target.affixes.map((a) => a.affixId));
console.log();

const t0 = Date.now();
const result = optimizePayloadV3(payload);
const elapsed = Date.now() - t0;

console.log(`Elapsed: ${elapsed}ms`);
console.log(`Strategy: ${result.diagnostics && result.diagnostics.strategy}`);
console.log(`Success prob: ${(result.successProb * 100).toFixed(2)}%`);
console.log(`Expected steps: ${result.expectedSteps}`);
console.log(`Action: ${JSON.stringify(result.action)}`);
console.log();

if (!result.action) {
  console.error("FAIL: no action returned");
  process.exit(1);
}

if (result.action.type !== "enchant") {
  console.error(`FAIL: expected action.type "enchant", got "${result.action.type}"`);
  process.exit(1);
}

if (result.action.targetAffixId !== byName["Maximum Life"].id) {
  console.error(
    `FAIL: expected targetAffixId "${byName["Maximum Life"].id}", got "${result.action.targetAffixId}"`
  );
  process.exit(1);
}

if (result.successProb < 0.99) {
  console.error(
    `FAIL: expected P(success) ≈ 1 after GA-preserve enchant, got ${(result.successProb * 100).toFixed(2)}%`
  );
  process.exit(1);
}

console.log("PASS: solver correctly recommends GA-preserve enchant as first action");
console.log("      P(success):", (result.successProb * 100).toFixed(2) + "%");
