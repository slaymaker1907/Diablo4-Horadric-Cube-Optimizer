#!/usr/bin/env node
/**
 * Diagnostic for the Spiritborn Amulet "Elemental Damage (Physical)" scenario.
 *
 * Scenario:
 *   Class:    Spiritborn
 *   Slot:     Amulet
 *   Current:  Movement Speed, Attack Speed, Vulnerable Damage [Enchanted], Mainstat
 *   Target:   Movement Speed, Attack Speed, Vulnerable Damage, Elemental Damage (Physical)
 *
 * The optimizer recommends `Remove Affix (Adept prism)` with 39.61 expected cube
 * steps and 100% success.  The user is asking why this beats "just keep doing
 * Focused Reroll with Aggressive prism until Mainstat lands on Elemental Damage
 * (Physical)".
 *
 * This script reproduces the category bookkeeping by hand so the reader can
 * see WHY the Adept-Remove path is preferred.  It does NOT call the optimizer
 * — we are reasoning, not fixing.
 *
 *   node scripts/diagnose-amulet-elem-physical.js
 */

"use strict";

const config = require("../config.js");
const slotLegality = require("../gear-slot-legality.js");

const CLASS_NAME = "Spiritborn";
const SLOT = "Amulet";
const DAMAGE_TYPES = config.DAMAGE_TYPES;

const currentNames = [
  "Movement Speed",                    // slot 0
  "Attack Speed",                      // slot 1
  "Vulnerable Damage [Enchanted]",     // slot 2 — locked
  "Mainstat",                          // slot 3
];

const targetNames = [
  "Movement Speed",
  "Attack Speed",
  "Vulnerable Damage",
  "Elemental Damage (Physical)",
];

// ─── Expand Elemental Damage / Specific Resistance sentinels into typed names ─
function expandEntry(entry) {
  const name = typeof entry === "string" ? entry : entry.name;
  if (name === "Elemental Damage") {
    return DAMAGE_TYPES.map((t) => ({ name: `Elemental Damage (${t})`, weight: 1, family: "" }));
  }
  if (name === "Specific Resistance") {
    return DAMAGE_TYPES.map((t) => ({ name: `Specific Resistance (${t})`, weight: 1, family: "" }));
  }
  const family = typeof entry === "object" && entry.family ? entry.family : "";
  const familyRollWeight =
    typeof entry === "object" && Number(entry.familyRollWeight) > 0
      ? Number(entry.familyRollWeight)
      : 0;
  const cls = typeof entry === "object" && entry.class ? entry.class : "";
  return [{ name, weight: 1, family, familyRollWeight, class: cls }];
}

function buildCategory(catName) {
  const raw = config.CATEGORY_TO_AFFIX_NAMES[catName] || [];
  const expanded = raw.flatMap(expandEntry);
  // Apply per-operation overrides (we will look these up later).
  return expanded;
}

const SLOT_LEGAL_NAMES = new Set(slotLegality.SLOT_TO_AFFIX_NAMES[SLOT]);
// Expand sentinels from gear-slot-legality (already enumerated there).

function isLegalForSlotClass(entry) {
  if (!SLOT_LEGAL_NAMES.has(entry.name)) {
    return false;
  }
  if (entry.class && entry.class !== CLASS_NAME) {
    return false;
  }
  return true;
}

function applyOverridesForOp(catName, opType) {
  // Some affix names get re-routed per op-type (e.g. Thorns, "to All Skills").
  // We respect those for filtering: if `opType in OVERRIDES[name]` and
  // `catName not in OVERRIDES[name][opType]`, the affix is excluded from this
  // pool for this operation.
  const overrides = config.OPERATION_CATEGORY_OVERRIDES;
  return (entry) => {
    const ov = overrides[entry.name];
    if (ov && Array.isArray(ov[opType])) {
      return ov[opType].includes(catName);
    }
    return true;
  };
}

function poolFor(catName, opType, excludeNames = new Set()) {
  return buildCategory(catName)
    .filter(isLegalForSlotClass)
    .filter(applyOverridesForOp(catName, opType))
    .filter((e) => !excludeNames.has(e.name));
}

// Weighted effective size respecting family rolling.
function effectiveWeight(pool) {
  let weight = 0;
  const familyCounts = new Map();
  for (const e of pool) {
    if (e.familyRollWeight && e.familyRollWeight > 0) {
      familyCounts.set(e.family, (familyCounts.get(e.family) || 0) + 1);
    } else {
      weight += 1;
    }
  }
  for (const [family, count] of familyCounts) {
    // Family contributes familyRollWeight collectively; per-member effective
    // weight = familyRollWeight / count. So the family contributes exactly
    // familyRollWeight (we look up rollWeight from any one member).
    const sample = pool.find((e) => e.family === family);
    weight += sample.familyRollWeight;
  }
  return weight;
}

function pName(p) { return (p * 100).toFixed(2) + "%"; }
function fmtSteps(n) { return n.toFixed(2); }

// ─── Print scenario ──────────────────────────────────────────────────────────
console.log("=".repeat(78));
console.log("Scenario");
console.log("=".repeat(78));
console.log(`  Class:    ${CLASS_NAME}`);
console.log(`  Slot:     ${SLOT}`);
console.log("  Current:");
currentNames.forEach((n, i) => console.log(`    [${i}] ${n}`));
console.log("  Target:");
targetNames.forEach((n, i) => console.log(`    [${i}] ${n}`));
console.log();

// ─── Categorize each current affix ───────────────────────────────────────────
console.log("=".repeat(78));
console.log("Which categories does each current affix belong to?");
console.log("=".repeat(78));

const focusedOpCategories = (name) => {
  const cats = [];
  for (const cat of Object.keys(config.CATEGORY_TO_AFFIX_NAMES)) {
    const pool = buildCategory(cat).filter(applyOverridesForOp(cat, "focused"));
    if (pool.some((e) => e.name === name)) cats.push(cat);
  }
  return cats;
};
const removeOpCategories = (name) => {
  const cats = [];
  for (const cat of Object.keys(config.CATEGORY_TO_AFFIX_NAMES)) {
    const pool = buildCategory(cat).filter(applyOverridesForOp(cat, "remove"));
    if (pool.some((e) => e.name === name)) cats.push(cat);
  }
  return cats;
};

console.log("  (categories for the 'focused' operation type)");
console.log(`    Movement Speed       → ${focusedOpCategories("Movement Speed").join(", ")}`);
console.log(`    Attack Speed         → ${focusedOpCategories("Attack Speed").join(", ")}`);
console.log(`    Vulnerable Damage    → ${focusedOpCategories("Vulnerable Damage").join(", ")}`);
console.log(`    Mainstat             → ${focusedOpCategories("Mainstat").join(", ")}`);
console.log();
console.log("  (categories for the 'remove' operation type — same as focused for these)");
console.log(`    Mainstat (remove)    → ${removeOpCategories("Mainstat").join(", ")}`);
console.log();

// ─── Now answer: who would be eligible if we picked Aggressive prism? ────────
console.log("=".repeat(78));
console.log("Q1: If we Focused Reroll with Aggressive prism, who is the SOURCE?");
console.log("=".repeat(78));
console.log("  D4's Focused Reroll picks the source RANDOMLY from current affixes");
console.log("  that match the prism category. Enchanted slots are excluded.");
console.log();
console.log("  Current affixes in Aggressive category:");
const aggrEligible = [];
for (let i = 0; i < currentNames.length; i++) {
  const nm = currentNames[i].replace(" [Enchanted]", "");
  const cats = focusedOpCategories(nm);
  const enchanted = currentNames[i].includes("[Enchanted]");
  const inAggr = cats.includes("Aggressive");
  if (inAggr && !enchanted) {
    aggrEligible.push({ index: i, name: nm });
  }
  if (inAggr) {
    console.log(
      `    [${i}] ${nm.padEnd(20)} ${enchanted ? "(excluded — enchanted)" : "ELIGIBLE as source"}`
    );
  }
}
console.log();
console.log(`  ➜ ${aggrEligible.length} eligible sources, each picked with probability 1/${aggrEligible.length}:`);
for (const { index, name } of aggrEligible) {
  console.log(`      P(source = ${name}) = ${pName(1 / aggrEligible.length)}`);
}
console.log();
console.log("  Attack Speed is a MATCHED TARGET. Half the time, a Focused/Chaotic");
console.log("  Reroll with Aggressive prism would destroy Attack Speed instead of");
console.log("  Mainstat. The optimizer's matched-target guard (worker.js line 2906");
console.log("  isCategoryFocusedBlockedByMatchedTargetV3) correctly skips Aggressive");
console.log("  for closed-form Cases B, C, F, G — those reroll formulas assume");
console.log("  deterministic source selection, which is false here.");
console.log();

// ─── Q2: Can we remove Mainstat without risking Attack Speed? ────────────────
console.log("=".repeat(78));
console.log("Q2: Can we remove Mainstat without risking Attack Speed?");
console.log("=".repeat(78));
console.log("  Mainstat belongs to BOTH Aggressive AND Adept (config.js lines 186");
console.log("  and 236). Look at which OTHER current affixes live in Adept:");
console.log();
for (let i = 0; i < currentNames.length; i++) {
  const nm = currentNames[i].replace(" [Enchanted]", "");
  const cats = removeOpCategories(nm);
  const inAdept = cats.includes("Adept");
  console.log(`    [${i}] ${nm.padEnd(20)} Adept? ${inAdept ? "YES" : "no"}`);
}
console.log();
console.log("  Only Mainstat is in Adept among the current affixes. So:");
console.log("    Remove(Adept) DETERMINISTICALLY removes Mainstat.");
console.log("    Remove(Aggressive) would 50% remove Attack Speed (target!).");
console.log();
console.log("  This is why the optimizer prefers Adept for the removal step.");
console.log();

// ─── Q3: After remove, what's the Add(Aggressive) pool? ──────────────────────
console.log("=".repeat(78));
console.log("Q3: After Remove(Adept), what is the Add(Aggressive) destination pool?");
console.log("=".repeat(78));
const existingAfterRemove = new Set(["Movement Speed", "Attack Speed", "Vulnerable Damage"]);
const addAggrPool = poolFor("Aggressive", "add", existingAfterRemove);
const addAggrWeight = effectiveWeight(addAggrPool);
console.log(`  Pool size (raw): ${addAggrPool.length}`);
console.log(`  Effective weight (with family rolling): ${addAggrWeight}`);
console.log();
console.log("  Members:");
const families = new Set();
for (const e of addAggrPool) {
  const fam = e.familyRollWeight > 0 ? ` (family=${e.family}, w=${e.familyRollWeight}/family-size)` : "";
  if (e.familyRollWeight > 0 && families.has(e.family)) {
    console.log(`      • ${e.name.padEnd(35)} ${fam}  (member of pre-listed family)`);
  } else {
    console.log(`      • ${e.name.padEnd(35)} ${fam}`);
    if (e.familyRollWeight > 0) families.add(e.family);
  }
}
console.log();

// Compute P(Elemental Damage (Physical))
const target = addAggrPool.find((e) => e.name === "Elemental Damage (Physical)");
if (!target) {
  console.log("  Elemental Damage (Physical) is NOT in Aggressive add pool. ERROR.");
} else {
  const pTarget = 1 / addAggrWeight;
  console.log(`  P(Add → Elemental Damage (Physical)) per attempt = 1/${addAggrWeight} = ${pName(pTarget)}`);
}
console.log();

// ─── Q4: Chain expected steps for the Remove(Adept) + Add(Aggressive) loop ───
console.log("=".repeat(78));
console.log("Q4: Lower-bound expected cube steps for the Remove(Adept) + Add(Aggressive) loop");
console.log("=".repeat(78));
const N = addAggrWeight;
const pSuccess = 1 / N;
const pMainstat = 1 / N;
const pStuck = (N - 2) / N;
console.log(`  Per Remove+Add cycle (2 steps):`);
console.log(`    P(land on Elem Damage Physical) = 1/${N} = ${pName(pSuccess)} — DONE`);
console.log(`    P(land on Mainstat back)        = 1/${N} = ${pName(pMainstat)} — clean restart`);
console.log(`    P(land on other Aggressive)     = ${N - 2}/${N} = ${pName(pStuck)} — "stuck"`);
console.log();
console.log("  In 'stuck', the new affix is in Aggressive ONLY (Mainstat is the only");
console.log("  Aggressive affix that's also in Adept). So the only ways out are:");
console.log("    • Remove(Aggressive)  — 50% destroys Attack Speed");
console.log("    • Focused(Aggressive) — 50% destroys Attack Speed");
console.log("    • Chaotic(Aggressive) — 50% destroys Attack Speed");
console.log("  All three risk a matched target, so the residual solver must navigate");
console.log("  a probabilistic recovery sub-tree to climb back out.");
console.log();
console.log("  Naive lower bound IGNORING stuck recovery cost:");
console.log("    Treat 'stuck' as if it cycles back instantly: expected cycles to");
console.log("    success when only success/Mainstat-restart count would be N. Cycle");
console.log("    cost = 2 steps. Lower bound ≈ 2N = " + (2 * N).toFixed(2));
console.log();
console.log("  Reality: 'stuck' recovery is non-trivial. Each stuck cycle requires");
console.log("  a risky Remove(Aggressive) (~2 expected attempts to evict the");
console.log("  unwanted Aggressive non-Mainstat), and Attack Speed losses also need");
console.log("  recovery via Add(Aggressive) (another ~N attempts). The optimizer's");
console.log("  reported 39.61 is consistent with this recovery overhead being");
console.log("  bookkept by the residual LAO* solver — it's roughly 2N + extra.");
console.log();

// ─── Q5: User's proposal — "just Focused Reroll Aggressive over and over" ────
console.log("=".repeat(78));
console.log("Q5: Why NOT just 'Focused Reroll Aggressive until we get Elem Damage Phys'?");
console.log("=".repeat(78));
console.log("  Because Focused Aggressive doesn't let you pick the source. With");
console.log("  Mainstat AND Attack Speed both Aggressive on the item, half of all");
console.log("  Focused Aggressive rolls would reroll Attack Speed — which IS a");
console.log("  matched target. That destroys progress.");
console.log();
console.log("  The intuitive plan 'reroll the Mainstat slot' is not how Focused Reroll");
console.log("  works in D4. The user picks the prism category, not the slot. The");
console.log("  game randomly selects which in-category slot to reroll.");
console.log();
console.log("  This is the central reason the optimizer's recommendation looks");
console.log("  surprising but is mechanically correct: it identifies Adept as the");
console.log("  unique 'clean-removal' prism for Mainstat that protects Attack Speed.");
console.log();
