/**
 * repro-ga-preserve-enchant.js
 *
 * Reproduces and verifies the fix for: optimizer recommending a chaotic
 * reroll (~31% success) instead of a same-affix GA-preserve enchant (which
 * unlocks blocked cube operations and improves P(success)).
 *
 * Root cause: getValidActionsV2 filtered all same-affix enchant actions
 * (line ~2299 in d4cubeoptimv3-worker.js), including the valid fresh-enchant
 * GA-preserve mark.  When a protected GA affix shares a prism category with
 * missing targets, strictMode blocks cube ops on that category entirely
 * until the GA slot is locked via an enchant.  Without the enchant in the
 * action set, the solver cannot discover the optimal "enchant GA first, then
 * chaotic-reroll" sequence.
 *
 * Scenario
 * ─────────
 * Current item (Legendary, Necromancer):
 *   Slot 0: Maximum Life  [GA]   (Protector category)
 *   Slot 1: Movement Speed       (Pragmatic category)
 *   Slot 2: Maximum Evade Charges (Pragmatic category)
 *   Slot 3: Maximum Resource     (Resourceful category)
 *
 * Target:
 *   Maximum Life   (GA must be preserved — in gaRequiredCounts)
 *   Armor          (Protector — currently missing)
 *   Critical Strike Chance (Aggressive — currently missing)
 *   Maximum Resource (Resourceful — already present)
 *
 * Analysis:
 *   • Maximum Life (GA) is in the Protector category.  With strictMode=true,
 *     getValidActions blocks the Protector chaotic reroll entirely
 *     (touchesGA=true) because Maximum Life appears in the Protector eligible
 *     pool while it is un-enchanted.
 *   • After the GA-preserve enchant (same-affix, fresh), Maximum Life gains
 *     isEnchanted=true and is excluded from getEligibleByCategory, so
 *     Protector chaotic becomes available.  The solver can then replace
 *     Movement Speed/Maximum Evade Charges/Maximum Resource with Armor +
 *     Critical Strike Chance + Maximum Resource via cube ops.
 *   • The optimal first action should be the enchant-same-affix on slot 0,
 *     giving P(success) > P(success from any chaotic/focused first).
 *
 * Expected result after the fix:
 *   result.action.type === "enchant"
 *   result.action.targetAffixId === "maximum-life" (same affix, GA-preserve)
 *   result.successProb === 1  (or materially higher than without the enchant)
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
    Aggressive: ["Critical Strike Chance", "Critical Strike Damage", "All Damage"],
    Pragmatic:  ["Movement Speed", "Maximum Evade Charges"],
    Protector:  ["Armor", "Maximum Life"],
    Resourceful:["Maximum Resource"],
    Adept:      ["Mainstat"],
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

// Current state: Maximum Life (GA, Protector) + two Pragmatic + one Resourceful
const state = {
  gearSlot: "Any",
  class: "Necromancer",
  isLegendary: true,
  affixes: [
    { affixId: byName["Maximum Life"].id,           isGA: true,  isEnchanted: false },
    { affixId: byName["Movement Speed"].id,          isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Evade Charges"].id,   isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Resource"].id,         isGA: false, isEnchanted: false },
  ],
};

// Target: same GA affix + two missing targets
const target = {
  affixes: [
    { affixId: byName["Maximum Life"].id,           needsImprovement: false },
    { affixId: byName["Armor"].id,                  needsImprovement: false },
    { affixId: byName["Critical Strike Chance"].id, needsImprovement: false },
    { affixId: byName["Maximum Resource"].id,        needsImprovement: false },
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
  timeMs: 5000,  // generous budget
};

console.log("Running optimizer for GA-preserve-enchant scenario…");
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
