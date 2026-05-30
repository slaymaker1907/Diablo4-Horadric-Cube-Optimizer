#!/usr/bin/env node
/**
 * learn-weights-from-tracking.js
 *
 * Turns one or more exported outcome-tracking JSON files (Settings → Developer →
 * Export Tracking Data) into updated baseline roll weights and patches them into
 * config.js.
 *
 * Usage:
 *   node scripts/learn-weights-from-tracking.js <export.json> [more.json ...] [flags]
 *
 * Flags:
 *   --prior-strength=<κ>   Gamma pseudo-exposure (default: weight-tracking's 0.5).
 *   --iterations=<n>       Max MM iterations for --mode=iterate (default 200).
 *   --mode=iterate|one-shot
 *                          iterate (default): re-run the MM update to convergence
 *                          over the raw rows. one-shot: use the additive `stats`
 *                          from the exports (matches the browser's live estimate).
 *   --dry-run              Write the review JSON only; do not touch config.js.
 *
 * On a real run it backs up config.js, writes a review JSON, patches the
 * LEARNED_WEIGHTS block, and bumps MODEL_VERSION (which invalidates stale browser
 * tracking on next load). Backups + review JSON go to the gitignored weight-runs/.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(REPO_ROOT, "config.js");
const RUNS_DIR = path.join(REPO_ROOT, "weight-runs");

const config = require("../config.js");
const wt = require("../weight-tracking.js");
const slotLegality = require("../gear-slot-legality.js");

const slugify = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// ── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const files = [];
  const opts = { priorStrength: wt.PRIOR_STRENGTH_DEFAULT, iterations: 200, mode: "iterate", dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") { opts.dryRun = true; }
    else if (arg.startsWith("--prior-strength=")) { opts.priorStrength = Number(arg.split("=")[1]); }
    else if (arg.startsWith("--iterations=")) { opts.iterations = Number(arg.split("=")[1]); }
    else if (arg.startsWith("--mode=")) { opts.mode = arg.split("=")[1]; }
    else if (arg.startsWith("--")) { throw new Error("Unknown flag: " + arg); }
    else { files.push(arg); }
  }
  if (files.length === 0) {
    throw new Error("No export JSON file(s) given. Usage: node scripts/learn-weights-from-tracking.js <export.json> [...] ");
  }
  if (!["iterate", "one-shot"].includes(opts.mode)) {
    throw new Error("--mode must be iterate or one-shot");
  }
  if (!Number.isFinite(opts.priorStrength) || opts.priorStrength <= 0) {
    throw new Error("--prior-strength must be a positive number");
  }
  return { files, opts };
}

// ── Catalog construction (mirrors the browser's buildAffixCatalog) ───────────
// `overrides` = [{ affixId, slot, class }] additive slot-legality allowances.
function buildCatalog(overrides) {
  const overridesByAffix = Object.create(null);
  for (const o of (overrides || [])) {
    if (!o || !o.affixId || !o.slot) { continue; }
    (overridesByAffix[o.affixId] || (overridesByAffix[o.affixId] = [])).push(o.slot);
  }

  const map = Object.create(null);
  function resolveSlots(name) {
    const builtIn = slotLegality.getLegalGearSlotsForAffixName(name);
    const arr = Array.isArray(builtIn) ? builtIn.slice() : [];
    const extra = overridesByAffix[slugify(name)] || [];
    const merged = Array.from(new Set([...arr, ...extra]));
    return merged.length > 0 ? merged : null;
  }

  function addEntry(categoryName, entry) {
    const name = typeof entry === "string" ? entry : entry.name;
    // The "Elemental Damage" / "Specific Resistance" sentinels expand into typed
    // subtypes that carry a family (mirrors the browser's ELEMENTAL_TYPED_AFFIXES /
    // SPECIFIC_RESISTANCE_TYPED_AFFIXES). Other string entries have no family.
    const sentinelFamily =
      name === "Elemental Damage" ? "elemental-damage"
        : name === "Specific Resistance" ? "specific-resistance" : "";
    const family = typeof entry === "string" ? sentinelFamily : String(entry.family || "");
    const familyRollWeight = typeof entry === "string" ? 0 : Number(entry.familyRollWeight) || 0;
    const className = typeof entry === "string" ? "" : String(entry.class || "");
    const expanded =
      name === "Elemental Damage" ? config.DAMAGE_TYPES.map((t) => `Elemental Damage (${t})`)
        : name === "Specific Resistance" ? config.DAMAGE_TYPES.map((t) => `Specific Resistance (${t})`)
          : [name];
    for (const affixName of expanded) {
      const id = slugify(affixName);
      if (!map[id]) {
        map[id] = { id, name: affixName, categories: [], gearSlots: resolveSlots(affixName), family, rollWeight: 1 };
        if (familyRollWeight > 0) { map[id].familyRollWeight = familyRollWeight; }
        if (className) { map[id].class = className; }
      }
      if (familyRollWeight > 0) { map[id].familyRollWeight = familyRollWeight; }
      if (className) { map[id].class = className; }
      if (family) { map[id].family = family; }
      if (!map[id].categories.includes(categoryName)) { map[id].categories.push(categoryName); }
    }
  }

  for (const [categoryName, entries] of Object.entries(config.CATEGORY_TO_AFFIX_NAMES)) {
    for (const entry of entries) { addEntry(categoryName, entry); }
  }
  for (const [affixName, ops] of Object.entries(config.OPERATION_CATEGORY_OVERRIDES || {})) {
    const id = slugify(affixName);
    if (map[id]) {
      map[id].operationCategories = Object.fromEntries(
        Object.entries(ops).map(([op, cats]) => [op, Array.isArray(cats) ? cats.slice() : []])
      );
    }
  }

  const affixes = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  // Overlay the current learned weights so the prior is anchored to the present
  // baseline (repeated runs refine on top of prior runs).
  wt.applyLearnedWeights(affixes, config.LEARNED_WEIGHTS || {});
  return { affixes, __wtIndex: wt.indexCatalog(affixes) };
}

// ── Load + validate exports ──────────────────────────────────────────────────
function loadExports(files) {
  const exports = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${file}: not a JSON object`);
    }
    if (parsed.modelVersion !== config.MODEL_VERSION) {
      throw new Error(
        `${file}: modelVersion "${parsed.modelVersion}" != current config.MODEL_VERSION "${config.MODEL_VERSION}". ` +
        `Data collected under a different baseline cannot be merged — re-export after bumping, or learn it separately.`
      );
    }
    exports.push({ file, data: parsed });
  }
  return exports;
}

// ── Weight computation ───────────────────────────────────────────────────────
function computeOneShot(exports, baseCatalog, opts) {
  let merged = Object.create(null);
  for (const { data } of exports) {
    merged = wt.mergeStats(merged, data.stats || {});
  }
  return wt.deriveWeights(merged, baseCatalog, { priorStrength: opts.priorStrength });
}

function computeIterate(exports, baseCatalog, opts) {
  // Group rows by their settings (overrides change the eligible pool) and build
  // a catalog per distinct override set, then collect contributions.
  const catalogCache = new Map();
  function catalogForSettings(settings) {
    const overrides = (settings && Array.isArray(settings.userOverrides)) ? settings.userOverrides : [];
    const key = JSON.stringify(overrides);
    if (!catalogCache.has(key)) {
      catalogCache.set(key, overrides.length === 0 ? baseCatalog : buildCatalog(overrides));
    }
    return catalogCache.get(key);
  }

  const contributions = [];
  let skipped = 0;
  for (const { data } of exports) {
    const settingsMap = data.settingsMap || {};
    for (const row of (data.rows || [])) {
      const settings = settingsMap[row.settingsId];
      const catalog = catalogForSettings(settings);
      const beforeItem = Object.assign({}, row.item, { sourceIndex: row.sourceIndex });
      const contrib = wt.computeDrawContribution(beforeItem, row.op, row.prism, row.resultAffixId, catalog);
      if (contrib.informative) {
        contributions.push(contrib);
      } else {
        skipped++;
      }
    }
  }
  const result = wt.iterateWeights(contributions, baseCatalog, { priorStrength: opts.priorStrength, maxIters: opts.iterations });
  result.skippedRows = skipped;
  result.usedRows = contributions.length;
  return result;
}

// Rescale so the geometric mean of the OBSERVED single-unit weights is 1. A
// global rescale leaves every pool's probabilities unchanged (the solver
// normalizes per pool), so this is purely cosmetic — it keeps the patched
// numbers near their ~1 scale and stable across repeated learning rounds.
// Only units with wins are used as the anchor so a handful of never-observed
// affixes (driven toward ~0 by a weak prior) don't skew the scale.
function normalizeUnitWeights(unitWeights, units) {
  const anchors = Object.keys(unitWeights).filter((k) =>
    k.startsWith("affix:") && unitWeights[k] > 0 && units && units[k] && units[k].wins > 0
  );
  const pool = anchors.length > 0
    ? anchors
    : Object.keys(unitWeights).filter((k) => k.startsWith("affix:") && unitWeights[k] > 0);
  if (pool.length === 0) { return Object.assign({}, unitWeights); }
  let logSum = 0;
  for (const k of pool) { logSum += Math.log(unitWeights[k]); }
  const geomean = Math.exp(logSum / pool.length);
  if (!(geomean > 0) || !Number.isFinite(geomean)) { return Object.assign({}, unitWeights); }
  const out = Object.create(null);
  for (const k of Object.keys(unitWeights)) { out[k] = unitWeights[k] / geomean; }
  return out;
}

// Round to keep the patched config readable.
function roundWeights(unitWeights, dp = 4) {
  const out = Object.create(null);
  const f = Math.pow(10, dp);
  for (const k of Object.keys(unitWeights)) {
    const v = Math.round(unitWeights[k] * f) / f;
    // Drop weights that round back to the structural baseline of 1 to keep the
    // block small; tied families baseline at their member count, not 1, so they
    // are always kept when present.
    out[k] = v;
  }
  return out;
}

function bumpModelVersion(current) {
  const today = new Date().toISOString().slice(0, 10);
  const m = String(current).match(/-m(\d+)$/);
  const n = m ? parseInt(m[1], 10) : 1;
  return `${today}-m${n + 1}`;
}

function patchConfig(configText, learnedWeights, newModelVersion) {
  // The regex match starts at `// BEGIN` (no leading indent) and ends at
  // `// END LEARNED_WEIGHTS` (its own 4-space indent is inside the match).
  const newBlock =
    "// BEGIN LEARNED_WEIGHTS\n" +
    "    LEARNED_WEIGHTS: " + JSON.stringify(learnedWeights, null, 2).replace(/\n/g, "\n    ") + ",\n" +
    "    // END LEARNED_WEIGHTS";
  let found = false;
  const out = configText.replace(
    /\/\/ BEGIN LEARNED_WEIGHTS[\s\S]*?\/\/ END LEARNED_WEIGHTS/,
    () => { found = true; return newBlock; }
  );
  if (!found) {
    throw new Error("Could not find the LEARNED_WEIGHTS marker block in config.js");
  }
  let verFound = false;
  const verPatched = out.replace(
    /MODEL_VERSION:\s*"[^"]*"/,
    () => { verFound = true; return `MODEL_VERSION: "${newModelVersion}"`; }
  );
  if (!verFound) {
    throw new Error("Could not find MODEL_VERSION in config.js");
  }
  return verPatched;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const { files, opts } = parseArgs(process.argv.slice(2));
  const baseCatalog = buildCatalog([]);
  const exports = loadExports(files);

  const result = opts.mode === "one-shot"
    ? computeOneShot(exports, baseCatalog, opts)
    : computeIterate(exports, baseCatalog, opts);

  const normalized = normalizeUnitWeights(result.unitWeights, result.units);
  const learnedWeights = roundWeights(normalized);

  // Review record: old vs new per unit.
  const review = {
    generatedAt: new Date().toISOString(),
    mode: opts.mode,
    priorStrength: opts.priorStrength,
    iterations: result.iterations != null ? result.iterations : 1,
    inputs: files,
    fromModelVersion: config.MODEL_VERSION,
    units: {},
  };
  for (const key of Object.keys(result.unitWeights)) {
    const old = wt.unitTotalWeightFromCatalog(baseCatalog, key);
    const u = (result.units && result.units[key]) || {};
    review.units[key] = {
      kind: u.kind,
      family: u.family,
      oldWeight: old,
      rawWeight: result.unitWeights[key],
      normalizedWeight: learnedWeights[key],
      wins: u.wins,
      exposure: u.exposure,
    };
  }
  if (result.usedRows != null) {
    review.usedRows = result.usedRows;
    review.skippedRows = result.skippedRows;
  }

  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const ts = timestamp();
  const reviewPath = path.join(RUNS_DIR, `learned-weights.${ts}.json`);
  fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2), "utf8");
  console.log(`Review JSON written: ${path.relative(REPO_ROOT, reviewPath)}`);
  console.log(`Learned ${Object.keys(learnedWeights).length} unit weight(s) from ${exports.length} export(s), mode=${opts.mode}.`);
  if (result.usedRows != null) {
    console.log(`  rows used: ${result.usedRows}, skipped (non-informative): ${result.skippedRows}`);
  }

  if (opts.dryRun) {
    console.log("--dry-run: config.js left unchanged.");
    return;
  }

  const configText = fs.readFileSync(CONFIG_PATH, "utf8");
  const backupPath = path.join(RUNS_DIR, `config.${ts}.bak.js`);
  fs.writeFileSync(backupPath, configText, "utf8");
  console.log(`Backed up config.js -> ${path.relative(REPO_ROOT, backupPath)}`);

  const newModelVersion = bumpModelVersion(config.MODEL_VERSION);
  const patched = patchConfig(configText, learnedWeights, newModelVersion);
  fs.writeFileSync(CONFIG_PATH, patched, "utf8");
  console.log(`Patched config.js: LEARNED_WEIGHTS updated, MODEL_VERSION ${config.MODEL_VERSION} -> ${newModelVersion}.`);
  console.log("Reload the app to apply; existing browser tracking data will invalidate (baseline changed).");
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

module.exports = {
  buildCatalog,
  computeOneShot,
  computeIterate,
  normalizeUnitWeights,
  roundWeights,
  bumpModelVersion,
  patchConfig,
};
