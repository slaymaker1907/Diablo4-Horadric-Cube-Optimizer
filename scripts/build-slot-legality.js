#!/usr/bin/env node
/**
 * build-slot-legality.js
 *
 * Downloads the latest Diablo4Companion data and cross-validates our
 * SLOT_TO_AFFIX_NAMES table in gear-slot-legality.js.
 *
 * Usage:
 *   node scripts/build-slot-legality.js
 *
 * The script always fetches fresh data from Companion's GitHub before
 * processing.  The downloaded files are written to scripts/data/ and are
 * listed in .gitignore (do not commit them).
 *
 * Sources:
 *   https://github.com/josdemmers/Diablo4Companion (master branch)
 *   D4Companion/Data/Affixes.enUS.json    — affix catalog with slot labels
 *   D4Companion/Data/ItemTypes.enUS.json  — item type display names
 *
 * If the download fails (no network, Companion moved the file), the script
 * exits with a clear error rather than silently using stale data.
 *
 * ─── SNO code analysis (do NOT use AllowedItemLabels directly) ─────────────
 *
 * Companion's AllowedItemLabels are internal D4 game SNO IDs.  They do NOT
 * correspond to indices in ItemTypes.enUS.json (that array is ordered by the
 * tool's own display logic, not by SNO).  After an exhaustive seed-anchor
 * analysis the codes remain partially ambiguous:
 *
 *   Code 28 = Gloves    (exclusive: Attack Speed, Critical Strike Chance)
 *   Code 29 = Boots     (exclusive: Maximum Evade Charges, Evade CDR)
 *   Code 30 = Pants     (exclusive: Potion Capacity, dodge-close-only)
 *   Code 62 = Shield    (exclusive: Block Chance)
 *   Code 26 = Amulet    (exclusive: class-specific Resource Cost Reduction, Movement Speed)
 *   Code 16 = Helm      (exclusive: Maximum Fury/Mana/Spirit/Essence/Energy/Vigor)
 *   Code 17 = Chest     (inferred from Damage Reduction + Dexterity patterns)
 *   Code 15 = Shield*   (* Damage Reduction and CDR pattern; overlaps code-62 Shield)
 *   Code 23 = Offhand   (inferred from Cooldown Reduction = Helm+Amulet+Offhand+Shield)
 *   Code 19 = Ring      (Vulnerable Damage appears on Ring + weapons)
 *   Codes 0-13, 46, 47  = various weapon subtypes (Critical Strike Damage, etc.)
 *   Code 71 = boots (ancestral variant; overlaps code 29)
 *
 * Crucially, Maximum Fury/Mana/Spirit/Essence/Energy/Vigor only appear with
 * code 16 (Helm) in the Companion catalog.  This is INCOMPLETE: in D4 these
 * class-resource affixes also roll on 1H and 2H weapons.  We therefore apply
 * a manual correction documented below rather than blindly accepting the
 * Companion data.
 *
 * ─── Class data policy ──────────────────────────────────────────────────────
 *
 * AllowedForPlayerClass is intentionally IGNORED.  The 8-element index mapping
 * for D4's current roster (Barbarian, Sorcerer, Necromancer, Druid, Rogue,
 * Spiritborn, Paladin, Warlock) is not reliably documented and the earlier
 * probe surfaced stale D3 names.  Skill affixes carry their own `class` field
 * set by buildAdeptSkillEntries() and are filtered at runtime; we do not need
 * Companion's class flags.
 *
 * ─── Merge policy ──────────────────────────────────────────────────────────
 *
 * New table = UNION(current table, Companion-derived additions).
 * We NEVER auto-remove affixes from a slot; removals appear as warnings only.
 */

"use strict";

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ─── Download helpers ───────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const COMPANION_BASE =
  "https://raw.githubusercontent.com/josdemmers/Diablo4Companion/master/D4Companion/Data";

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "d4-horadric-cube-optimizer/build-script" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function downloadCompanionData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const files = [
    { name: "Affixes.enUS.json",   desc: "affix catalog" },
    { name: "ItemTypes.enUS.json", desc: "item type labels" },
  ];

  const results = {};
  for (const { name, desc } of files) {
    const url      = `${COMPANION_BASE}/${name}`;
    const dest     = path.join(DATA_DIR, name);
    console.log(`Downloading ${desc}: ${url}`);
    let body;
    try {
      body = await fetchUrl(url);
    } catch (err) {
      console.error(`\nFailed to download ${name}: ${err.message}`);
      console.error("Check your network connection and that Companion still hosts the file at:");
      console.error(`  ${url}`);
      process.exit(1);
    }
    fs.writeFileSync(dest, body, "utf8");
    console.log(`  → saved ${dest} (${body.length.toLocaleString()} bytes)`);
    results[name] = JSON.parse(body);
  }
  return results;
}

// ─── Main (async wrapper so we can await the download) ──────────────────────
async function main() {
  console.log("Fetching latest Diablo4Companion data…\n");
  const { "Affixes.enUS.json": companionAffixes } = await downloadCompanionData();
  console.log(`\nLoaded ${companionAffixes.length} affix entries from Companion.\n`);
  run(companionAffixes);
}

// ─── Class-resource name collapse ──────────────────────────────────────────
// Companion has per-class variants; we unify them to "Maximum Resource".
const CLASS_RESOURCE_NAMES = new Set([
  "Maximum Fury",
  "Maximum Mana",
  "Maximum Spirit",
  "Maximum Essence",
  "Maximum Energy",
  "Maximum Vigor",
  "Maximum Resource",
]);

// Similar collapse for class-specific resource cost reduction
const RESOURCE_COST_REDUCTION_NAMES = new Set([
  "Resource Cost Reduction",
  "Fury Cost Reduction",
  "Mana Cost Reduction",
  "Spirit Cost Reduction",
  "Essence Cost Reduction",
  "Energy Cost Reduction",
  "Vigor Cost Reduction",
]);

// ─── Companion → our canonical name map ────────────────────────────────────
// Only entries that diverge from a simple case-match are listed here.
// Anything not in this map is compared by normalized lower-case match.
const COMPANION_TO_CANONICAL = new Map([
  ["Total Armor",             "Armor"],
  ["Physical Resistance",     "Specific Resistance (Physical)"],
  ["Fire Resistance",         "Specific Resistance (Fire)"],
  ["Cold Resistance",         "Specific Resistance (Cold)"],
  ["Lightning Resistance",    "Specific Resistance (Lightning)"],
  ["Poison Resistance",       "Specific Resistance (Poison)"],
  ["Shadow Resistance",       "Specific Resistance (Shadow)"],
  ["Life On Hit",             "Life on Hit"],
  ["Attacks Reduce Evade's Cooldown by Seconds", "Attacks reduce Evade Cooldown"],
]);
// Add class-resource collapses
for (const name of CLASS_RESOURCE_NAMES) {
  COMPANION_TO_CANONICAL.set(name, "Maximum Resource");
}
// Add resource-cost-reduction collapses
for (const name of RESOURCE_COST_REDUCTION_NAMES) {
  COMPANION_TO_CANONICAL.set(name, "Resource Cost Reduction");
}

function toCanonical(companionName) {
  if (COMPANION_TO_CANONICAL.has(companionName)) {
    return COMPANION_TO_CANONICAL.get(companionName);
  }
  return companionName; // assume same name
}

// ─── Decoded SNO code → our slot(s) ────────────────────────────────────────
// Partial map from seed-anchor reverse-engineering.  Unmapped codes are listed
// at the end of the output for human review.
const SNO_TO_SLOTS = new Map([
  [16, ["Helm"]],
  [17, ["Chest"]],
  [28, ["Gloves"]],
  [29, ["Boots"]],
  [30, ["Pants"]],
  [26, ["Amulet"]],
  [23, ["Offhand"]],
  [15, ["Shield"]],
  [62, ["Shield"]],    // blocking-shield-specific (e.g. Block Chance)
  [19, ["Ring"]],
  // Weapon codes — grouped conservatively under both 1H and 2H since Companion
  // does not distinguish at this level reliably.
  //  0  All weapon catch-all (unique effects)
  //  1  1H weapons (Sword, Axe, etc.)
  //  2  1H weapons
  //  3  1H weapons
  //  6  1H weapons
  //  7  1H weapons
  //  8  all weapons (Weapon Damage)
  //  9  Ring or specific weapon
  // 10  2H weapons
  // 11  2H weapons
  // 12  2H weapons
  // 13  2H weapons
  // 46  2H weapons
  // 47  2H weapons
  // 31  Ring (Lucky Hit: Chance to Heal Life)
  // 54  weapon quality modifiers (Indestructible, Item Quality)
  // 59  weapon variant
  // 61  weapon variant
  // 71  Boots ancestral variant (treated same as code 29)
  [71, ["Boots"]],
]);

// ─── Core processing (called once data is downloaded) ──────────────────────
function run(companionAffixes) {

// ─── Build set: Companion name → set of our slot names ─────────────────────
const companionSlotMap = new Map(); // canonical name → Set<slot>

for (const affix of companionAffixes) {
  if (!affix.AllowedItemLabels || affix.AllowedItemLabels.length === 0) continue;
  const desc = affix.DescriptionClean;
  if (!desc) continue;

  const canonical = toCanonical(desc);
  if (!companionSlotMap.has(canonical)) {
    companionSlotMap.set(canonical, new Set());
  }

  for (const code of affix.AllowedItemLabels) {
    const slots = SNO_TO_SLOTS.get(code);
    if (slots) {
      for (const slot of slots) {
        companionSlotMap.get(canonical).add(slot);
      }
    }
  }
}

// ─── Current canonical table (from gear-slot-legality.js) ──────────────────
// This is the ground truth we're comparing against.  Skill rank names are
// excluded here for clarity (they're handled separately via ALL_SKILL_RANK_NAMES).
const CURRENT_SLOT_TO_NAMES = {
  Helm:         ["Mainstat","Maximum Life","Armor","Cooldown Reduction","Maximum Resource","Life on Hit","Life on Kill","Life Regeneration","Barrier Generation","Fortify Generation","Healing Received","Impairment Reduction","All Resistance","Specific Resistance (Physical)","Specific Resistance (Fire)","Specific Resistance (Cold)","Specific Resistance (Lightning)","Specific Resistance (Poison)","Specific Resistance (Shadow)"],
  Chest:        ["Mainstat","Maximum Life","Armor","Damage Reduction","Thorns","Life Regeneration","Barrier Generation","Fortify Generation","Healing Received","All Resistance","Specific Resistance (Physical)","Specific Resistance (Fire)","Specific Resistance (Cold)","Specific Resistance (Lightning)","Specific Resistance (Poison)","Specific Resistance (Shadow)"],
  Gloves:       ["Mainstat","Maximum Life","Armor","Attack Speed","Critical Strike Chance","Critical Strike Damage","Lucky Hit Chance","Lucky Hit Chance restore Resource","Life on Hit"],
  Pants:        ["Mainstat","Maximum Life","Armor","Damage Reduction","Dodge Chance","Thorns","Potion Capacity","Impairment Reduction","Life Regeneration","Barrier Generation","Fortify Generation","Healing Received","All Resistance","Specific Resistance (Physical)","Specific Resistance (Fire)","Specific Resistance (Cold)","Specific Resistance (Lightning)","Specific Resistance (Poison)","Specific Resistance (Shadow)"],
  Boots:        ["Mainstat","Maximum Life","Armor","Movement Speed","Dodge Chance","Impairment Reduction","Life Regeneration","Fortify Generation","Healing Received","Maximum Evade Charges","Attacks reduce Evade Cooldown","Evade grants Movement Speed","All Resistance","Specific Resistance (Physical)","Specific Resistance (Fire)","Specific Resistance (Cold)","Specific Resistance (Lightning)","Specific Resistance (Poison)","Specific Resistance (Shadow)"],
  Amulet:       ["Mainstat","Maximum Life","All Damage","Attack Speed","Critical Strike Chance","Cooldown Reduction","Movement Speed","Damage Reduction","Impairment Reduction","Resource Cost Reduction","Elemental Damage (Physical)","Elemental Damage (Fire)","Elemental Damage (Cold)","Elemental Damage (Lightning)","Elemental Damage (Poison)","Elemental Damage (Shadow)","All Resistance","Vulnerable Damage","Critical Strike Damage","DoT Damage","Lucky Hit Chance"],
  Ring:         ["Mainstat","Maximum Life","Attack Speed","Critical Strike Chance","Critical Strike Damage","Vulnerable Damage","DoT Damage","Lucky Hit Chance","Maximum Resource","Resource Regeneration","Life on Hit","All Resistance","Specific Resistance (Physical)","Specific Resistance (Fire)","Specific Resistance (Cold)","Specific Resistance (Lightning)","Specific Resistance (Poison)","Specific Resistance (Shadow)","Elemental Damage (Physical)","Elemental Damage (Fire)","Elemental Damage (Cold)","Elemental Damage (Lightning)","Elemental Damage (Poison)","Elemental Damage (Shadow)"],
  "1H Weapon":  ["Mainstat","Maximum Life","Weapon Damage","All Damage","Attack Speed","Critical Strike Damage","Vulnerable Damage","DoT Damage","Elemental Damage (Physical)","Elemental Damage (Fire)","Elemental Damage (Cold)","Elemental Damage (Lightning)","Elemental Damage (Poison)","Elemental Damage (Shadow)","Life on Hit","Life on Kill","Resource on Kill"],
  "2H Weapon":  ["Mainstat","Maximum Life","Weapon Damage","All Damage","Attack Speed","Critical Strike Damage","Vulnerable Damage","DoT Damage","Elemental Damage (Physical)","Elemental Damage (Fire)","Elemental Damage (Cold)","Elemental Damage (Lightning)","Elemental Damage (Poison)","Elemental Damage (Shadow)","Life on Hit","Life on Kill","Resource on Kill"],
  Offhand:      ["Mainstat","Maximum Life","Cooldown Reduction","Critical Strike Chance","Lucky Hit Chance","Lucky Hit Chance restore Resource","Maximum Resource","Resource Cost Reduction","Resource Regeneration"],
  Shield:       ["Mainstat","Maximum Life","Armor","Damage Reduction","Thorns","Cooldown Reduction","Critical Strike Chance","Lucky Hit Chance","Lucky Hit Chance restore Resource","Resource Cost Reduction","All Resistance"],
};

// ─── Manual corrections (known game-data gaps in Companion) ─────────────────
// Maximum Fury/Mana/Spirit/Essence/Energy can roll on 1H and 2H weapons in D4.
// Companion only records code 16 (Helm) for these affixes — the weapon entries
// are absent from the catalog.  We add them explicitly.
const MANUAL_ADDITIONS = {
  "1H Weapon": ["Maximum Resource"],
  "2H Weapon": ["Maximum Resource"],
  // Companion omits Amulet from these affix entries; all four genuinely roll on
  // Amulets in D4.
  Amulet: ["Vulnerable Damage", "Critical Strike Damage", "DoT Damage", "Lucky Hit Chance"],
  // Companion omits Ring from all six Elemental Damage subtypes.
  Ring: [
    "Elemental Damage (Physical)",
    "Elemental Damage (Fire)",
    "Elemental Damage (Cold)",
    "Elemental Damage (Lightning)",
    "Elemental Damage (Poison)",
    "Elemental Damage (Shadow)",
  ],
};

// ─── Compute union (current ∪ Companion-derived ∪ manual) ──────────────────
const ourSlots = Object.keys(CURRENT_SLOT_TO_NAMES);
const newTable = {};
const added    = {};
const warnings = [];

for (const slot of ourSlots) {
  const current  = new Set(CURRENT_SLOT_TO_NAMES[slot]);
  const manual   = new Set(MANUAL_ADDITIONS[slot] || []);
  const fromComp = companionSlotMap; // checked per-name below
  const union    = new Set([...current, ...manual]);

  // Add any Companion-derived names that map to this slot
  for (const [canonical, slots] of companionSlotMap.entries()) {
    if (slots.has(slot)) {
      union.add(canonical);
    }
  }

  newTable[slot] = [...union];

  // Track what's new
  const addedNames = [...union].filter(n => !current.has(n));
  if (addedNames.length > 0) {
    added[slot] = addedNames;
  }
}

// ─── Check for affix names in current table that Companion doesn't know ─────
for (const slot of ourSlots) {
  for (const name of CURRENT_SLOT_TO_NAMES[slot]) {
    const companionSlots = companionSlotMap.get(name);
    if (companionSlots && !companionSlots.has(slot)) {
      // Companion knows this affix but assigns it to different slots
      warnings.push(
        `[WARN] "${name}" in slot ${slot}: Companion assigns it to [${[...companionSlots].join(", ")}]`
      );
    }
  }
}

// ─── Build the proposed JS constant string ──────────────────────────────────
function buildJsTable(table) {
  const lines = ["  const SLOT_TO_AFFIX_NAMES = Object.freeze({"];
  const slots  = Object.keys(CURRENT_SLOT_TO_NAMES); // preserve order
  for (const slot of slots) {
    const names = table[slot];
    // Put manually-curated names first (in their current order), then new ones
    const current = CURRENT_SLOT_TO_NAMES[slot];
    const extra   = names.filter(n => !current.includes(n)).sort();
    const ordered = [...current, ...extra];

    lines.push(`    ${JSON.stringify(slot)}: Object.freeze([`);
    for (const name of ordered) {
      lines.push(`      ${JSON.stringify(name)},`);
    }
    lines.push(`      ...SKILL_MULTIPLIER_NAMES,`);
    lines.push(`      ...ALL_SKILL_RANK_NAMES,`);
    lines.push(`    ]),`);
  }
  lines.push("  });");
  return lines.join("\n");
}

// Note: The actual gear-slot-legality.js only uses SKILL_MULTIPLIER_NAMES on
// some slots and ALL_SKILL_RANK_NAMES on others.  The script output is for
// review only — apply changes carefully by slot.

// ─── Diff summary ──────────────────────────────────────────────────────────
const diffLines = [
  "# Gear-Slot Legality Diff",
  "",
  `Generated: ${new Date().toISOString()}`,
  "Data source: Diablo4Companion Affixes.enUS.json (josdemmers/Diablo4Companion)",
  "",
  "## Merge policy",
  "New table = UNION(current table, Companion-derived additions, manual corrections).",
  "Affixes are never auto-removed. Removals appear as warnings only.",
  "",
  "## SNO code mapping used",
  ...Array.from(SNO_TO_SLOTS.entries()).map(
    ([code, slots]) => `  Code ${code} → ${slots.join(", ")}`
  ),
  "",
  "## Known Companion data gaps (manual corrections applied)",
  "  Maximum Resource is absent from weapon AllowedItemLabels in Companion.",
  "  D4 game data: Maximum Fury (Barbarian) rolls on 1H Weapon and 2H Weapon.",
  "  Manual additions: 1H Weapon += Maximum Resource; 2H Weapon += Maximum Resource",
  "",
  "## Additions per slot",
  ...(Object.keys(added).length === 0
    ? ["  (none — table already matches Companion-derived + manual corrections)"]
    : Object.entries(added).flatMap(([slot, names]) =>
        [`  ${slot}:`, ...names.map(n => `    + ${n}`)]
      )),
  "",
  "## Warnings (potential false-positives in current table)",
  ...(warnings.length === 0 ? ["  (none)"] : warnings),
  "",
  "## Skipped Companion affixes (not in our canonical name set)",
];

// List Companion affixes with slot data that don't match any of our names
const ourAllNames = new Set(
  Object.values(CURRENT_SLOT_TO_NAMES).flat()
);
const skipped = [];
for (const affix of companionAffixes) {
  if (!affix.AllowedItemLabels || affix.AllowedItemLabels.length === 0) continue;
  const desc = affix.DescriptionClean;
  if (!desc) continue;
  const canonical = toCanonical(desc);
  if (!ourAllNames.has(canonical)) {
    skipped.push(`  ${canonical} (from Companion: "${desc}")`);
  }
}
diffLines.push(...[...new Set(skipped)].sort().slice(0, 80));
if ([...new Set(skipped)].length > 80) {
  diffLines.push(`  ... and ${[...new Set(skipped)].length - 80} more (skill-specific, seasonal, unique affixes)`);
}

const diffContent = diffLines.join("\n") + "\n";

// ─── Write outputs ──────────────────────────────────────────────────────────
const diffPath = path.join(DATA_DIR, "slot-legality.diff.md");
fs.writeFileSync(diffPath, diffContent, "utf8");
console.log(`Diff written to ${diffPath}`);

// Print summary to stdout
console.log("\n=== Additions ===");
if (Object.keys(added).length === 0) {
  console.log("  (none)");
} else {
  for (const [slot, names] of Object.entries(added)) {
    console.log(`  ${slot}: + ${names.join(", ")}`);
  }
}

console.log("\n=== Warnings ===");
if (warnings.length === 0) {
  console.log("  (none)");
} else {
  for (const w of warnings.slice(0, 20)) {
    console.log(" ", w);
  }
  if (warnings.length > 20) {
    console.log(`  ... and ${warnings.length - 20} more (see diff file)`);
  }
}

console.log(`\nSkipped Companion affixes (not in our catalog): ${[...new Set(skipped)].length}`);
console.log("Run complete. Review scripts/data/slot-legality.diff.md before committing.");

} // end run()

// ─── Entry point ────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
