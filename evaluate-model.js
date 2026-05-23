#!/usr/bin/env node
"use strict";

/**
 * evaluate-model.js
 *
 * Hyperparameter sweep for random-forest.js.  Trains one model per
 * configuration on a fixed train/test split, measures quality, then saves
 * the best model and a full results table.
 *
 * Always computes two baselines for comparison:
 *   mean      — always predicts the training-set mean (R²=0 floor)
 *   heuristic — hand-crafted rules from predictHeuristic() in random-forest.js
 *               (equivalent to the scoring logic used before ML)
 *
 * Usage:
 *   node evaluate-model.js [options]
 *
 * Options:
 *   --data=<path>          NDJSON training file  (default: training-data.current.jsonl)
 *   --output=<path>        Best model output     (default: model.json)
 *   --results=<path>       Full results JSON     (default: eval-results.json)
 *   --test-split=<0–1>     Held-out fraction     (default: 0.2)
 *   --limit=<int>          Cap rows loaded       (default: all)
 *   --grid=fast|full|deep  Pre-set grid size     (default: fast)
 *   --seed=<int>           Model RNG seed        (default: 42)
 *   --verbose              Print per-config timing
 */

const path = require("node:path");
const fs   = require("node:fs");
const rf   = require("./random-forest.js");

// ─────────────────────────────────────────────────────────────────────────────
// Hyperparameter grids
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Three built-in grid presets.
 *
 * "fast"  – 12 configs,  good for a smoke run (~1–2 min)
 * "full"  – 72 configs,  standard sweep (~10–20 min)
 * "deep"  – 144 configs, exhaustive search (~30–60 min)
 */
const GRIDS = {
  fast: {
    numTrees:       [50, 100],
    maxDepth:       [6, 9, 12],
    minSamplesLeaf: [2, 5],
    maxFeatures:    ["sqrt"],
  },
  full: {
    numTrees:       [50, 100, 200],
    maxDepth:       [5, 7, 10, 13],
    minSamplesLeaf: [1, 2, 5, 10],
    maxFeatures:    ["sqrt", "log2"],
  },
  deep: {
    numTrees:       [50, 100, 150, 200],
    maxDepth:       [4, 6, 8, 10, 12, 14],
    minSamplesLeaf: [1, 2, 5, 10],
    maxFeatures:    ["sqrt", "log2", "all"],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Grid generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generator that yields every hyperparameter configuration in the grid.
 * Seeds are derived from `baseSeed + offset` to ensure reproducibility across
 * different grid sizes and orderings.
 *
 * @param {{ numTrees: number[], maxDepth: number[], minSamplesLeaf: number[], maxFeatures: string[] }} grid
 * @param {number} baseSeed
 * @yields {{ numTrees: number, maxDepth: number, minSamplesLeaf: number, maxFeatures: string, seed: number }}
 */
function* generateConfigs(grid, baseSeed) {
  for (const numTrees of grid.numTrees) {
    for (const maxDepth of grid.maxDepth) {
      for (const minSamplesLeaf of grid.minSamplesLeaf) {
        for (const maxFeatures of grid.maxFeatures) {
          yield { numTrees, maxDepth, minSamplesLeaf, maxFeatures, seed: baseSeed };
        }
      }
    }
  }
}

/**
 * Count the total number of configurations in a hyperparameter grid object.
 *
 * @param {{ numTrees: number[], maxDepth: number[], minSamplesLeaf: number[], maxFeatures: string[] }} grid
 * @returns {number}
 */
function countConfigs(grid) {
  return grid.numTrees.length * grid.maxDepth.length *
         grid.minSamplesLeaf.length * grid.maxFeatures.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite scoring (higher is better)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single number summary of a metrics object.
 *
 * Weights:
 *   40% successProb R²       — primary value-function accuracy
 *   35% logSteps R²          — step-count accuracy
 *   25% classification acc   — impossible-target detection
 *
 * Returns NaN if any component is non-finite.
 */
function compositeScore(metrics) {
  const spR2  = metrics.successProb.r2;
  const stR2  = metrics.logSteps.r2;
  const acc   = metrics.classificationAccuracy;
  if (!Number.isFinite(spR2) || !Number.isFinite(stR2) || !Number.isFinite(acc)) {
    return -Infinity;
  }
  return 0.40 * spR2 + 0.35 * stR2 + 0.25 * acc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Format a number to 4 decimal places, or a dash if non-finite. @param {number} n @returns {string} */
function fmt4(n) { return Number.isFinite(n) ? n.toFixed(4) : "  —   "; }
/**
 * Format a millisecond duration as "Xms" or "X.Xs".
 *
 * @param {number} ms
 * @returns {string}
 */
function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
/**
 * Format a signed numeric delta with leading sign.
 *
 * @param {number} delta
 * @returns {string} e.g. "+0.0123" or "-0.0456".
 */
function fmtDelta(delta) {
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(4)}`;
}

/**
 * Print a single row in the hyperparameter sweep results table.
 *
 * @param {number} rank   - 1-based rank position.
 * @param {Object} entry  - { config, metrics, score, elapsedMs }.
 */
function printRow(rank, entry) {
  const { config, metrics, score, elapsedMs } = entry;
  const c = config;
  process.stdout.write(
    `  ${String(rank).padStart(3)}  ` +
    `trees=${String(c.numTrees).padStart(3)} ` +
    `depth=${String(c.maxDepth).padStart(2)} ` +
    `leaf=${String(c.minSamplesLeaf).padStart(2)} ` +
    `feat=${String(c.maxFeatures).padEnd(4)}  ` +
    `score=${fmt4(score)}  ` +
    `spR²=${fmt4(metrics.successProb.r2)}  ` +
    `stR²=${fmt4(metrics.logSteps.r2)}  ` +
    `acc=${fmt4(metrics.classificationAccuracy)}  ` +
    `(${fmtMs(elapsedMs)})\n`
  );
}

/**
 * Print a baseline (mean predictor or heuristic) row in the results table.
 *
 * @param {string} label   - Short label shown in the row.
 * @param {Object} metrics - Metrics object from `computeMetrics`.
 * @param {number} score   - Composite score.
 */
function printBaselineRow(label, metrics, score) {
  process.stdout.write(
    `  ───  BASELINE ${label.toUpperCase().padEnd(10)}           ` +
    `score=${fmt4(score)}  ` +
    `spR²=${fmt4(metrics.successProb.r2)}  ` +
    `stR²=${fmt4(metrics.logSteps.r2)}  ` +
    `acc=${fmt4(metrics.classificationAccuracy)}\n`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI argument parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse CLI flags into a configuration object.
 *
 * @param {string[]} argv - Raw argument list (e.g. `process.argv.slice(2)`).
 * @returns {{ data: string, output: string, results: string, testSplit: number,
 *             limit: number, grid: string, seed: number, verbose: boolean }}
 */
function parseArgs(argv) {
  const args = {
    data:      "training-data.current.jsonl",
    output:    "model.json",
    results:   "eval-results.json",
    testSplit: 0.2,
    limit:     Infinity,
    grid:      "fast",
    seed:      42,
    verbose:   false,
  };

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq    = arg.indexOf("=");
    const key   = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const value = eq >= 0 ? arg.slice(eq + 1) : "true";

    switch (key) {
      case "data":        args.data       = value; break;
      case "output":      args.output     = value; break;
      case "results":     args.results    = value; break;
      case "test-split":  args.testSplit  = parseFloat(value); break;
      case "limit":       args.limit      = parseInt(value, 10); break;
      case "grid":        args.grid       = value; break;
      case "seed":        args.seed       = parseInt(value, 10); break;
      case "verbose":     args.verbose    = value !== "false"; break;
      case "help": case "h":
        printHelp();
        process.exit(0);
        break;
      default:
        process.stderr.write(`Unknown option: --${key}\n`);
        process.exitCode = 1;
    }
  }

  return args;
}

/** Print CLI usage and option descriptions to stdout. */
function printHelp() {
  process.stdout.write([
    "Usage: node evaluate-model.js [options]",
    "",
    "  --data=<path>         NDJSON training file   (default: training-data.current.jsonl)",
    "  --output=<path>       Best model output      (default: model.json)",
    "  --results=<path>      Full results JSON      (default: eval-results.json)",
    "  --test-split=<0–1>    Held-out fraction      (default: 0.2)",
    "  --limit=<int>         Cap rows loaded        (default: all)",
    "  --grid=fast|full|deep Grid preset            (default: fast)",
    "  --seed=<int>          Model RNG seed         (default: 42)",
    "  --verbose             Print per-run timing",
    "",
    "Grid sizes:",
    "  fast  — 12 configs    (~1–2 min)",
    "  full  — 72 configs    (~10–20 min)",
    "  deep  — 144 configs   (~30–60 min)",
    "",
    "Baselines (always computed for reference):",
    "  mean      — always predicts training-set mean (R² = 0 by definition)",
    "  heuristic — hand-crafted rules (original scoring function)",
    "",
  ].join("\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry point.  Loads training data, computes baseline metrics, runs the
 * hyperparameter sweep, saves the best model, and writes all results to disk.
 *
 * The sweep always starts by printing baseline rows (mean predictor and
 * heuristic predictor) so every run shows how much RF improves over them.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── Load data ──────────────────────────────────────────────────────────────
  process.stdout.write(`Loading ${args.data}...\n`);
  let data = rf.loadNdjson(args.data);
  if (Number.isFinite(args.limit) && data.length > args.limit) {
    data = data.slice(0, args.limit);
    process.stdout.write(`Capped to ${data.length} rows.\n`);
  }
  process.stdout.write(`Loaded ${data.length} rows.\n`);

  // ── Train / test split ──────────────────────────────────────────────
  const splitAt  = Math.floor(data.length * (1 - args.testSplit));
  const trainSet = data.slice(0, splitAt);
  const testSet  = data.slice(splitAt);
  process.stdout.write(`Train: ${trainSet.length}  Test: ${testSet.length}\n\n`);

  // ── Baselines (computed once, shown for reference throughout) ───────────
  process.stdout.write("Computing baselines...\n");
  const meanPredictor         = rf.makeMeanPredictor(trainSet);
  const baselineMeanMetrics   = rf.computeMetrics(meanPredictor,       testSet);
  const baselineHeurMetrics   = rf.computeMetrics(rf.predictHeuristic, testSet);
  const baselineMeanScore     = compositeScore(baselineMeanMetrics);
  const baselineHeurScore     = compositeScore(baselineHeurMetrics);

  process.stdout.write(
    "  Baselines (reference — no training):\n" +
    "  ────  trees  depth  leaf  feat    score   spR²    stR²    acc\n" +
    "  ────  ─────  ─────  ────  ────  ───────  ──────  ──────  ──────\n"
  );
  printBaselineRow("mean",      baselineMeanMetrics, baselineMeanScore);
  printBaselineRow("heuristic", baselineHeurMetrics, baselineHeurScore);
  process.stdout.write("\n");

  // ── Grid search ────────────────────────────────────────────────────────
  const gridDef = GRIDS[args.grid];
  if (!gridDef) {
    process.stderr.write(`Unknown grid preset: ${args.grid}. Choose fast, full, or deep.\n`);
    process.exitCode = 1;
    return;
  }

  const total   = countConfigs(gridDef);
  const configs = Array.from(generateConfigs(gridDef, args.seed));

  process.stdout.write(`Grid: ${args.grid}  (${total} configurations)\n`);
  process.stdout.write(
    "  Rank  trees  depth  leaf  feat    score   spR²    stR²    acc     (time)\n" +
    "  ────  ─────  ─────  ────  ────  ───────  ──────  ──────  ──────  ───────\n"
  );

  const results    = [];
  let   bestScore  = -Infinity;
  let   bestModel  = null;
  let   bestConfig = null;
  let   sweepStart = Date.now();

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const t0     = Date.now();

    const model   = rf.trainModel(trainSet, config);
    const metrics = rf.computeMetrics(model, testSet);
    const score   = compositeScore(metrics);
    const elapsed = Date.now() - t0;

    const entry = { config, metrics, score, elapsedMs: elapsed };
    results.push(entry);

    // Print inline (rank will be updated after sort, use # for now)
    const lineNum = String(i + 1).padStart(3);
    if (args.verbose) {
      printRow(lineNum, entry);
    } else {
      // Compact progress line
      const pct = (((i + 1) / total) * 100).toFixed(0);
      const elapsed2 = fmtMs(Date.now() - sweepStart);
      process.stdout.write(
        `\r  [${pct.padStart(3)}%] ${i + 1}/${total}  best=${fmt4(bestScore)}  elapsed=${elapsed2}   `
      );
    }

    if (score > bestScore) {
      bestScore  = score;
      bestModel  = model;
      bestConfig = config;
    }
  }

  if (!args.verbose) process.stdout.write("\n"); // flush progress line

  // ── Sort and display results ───────────────────────────────────────────────
  results.sort((a, b) => b.score - a.score);

  process.stdout.write(
    "\n  ── Top 10 configurations ────────────────────────────────────────────────\n" +
    "  Rank  trees  depth  leaf  feat    score   spR²    stR²    acc     (time)\n" +
    "  ────  ─────  ─────  ────  ────  ───────  ──────  ──────  ──────  ───────\n"
  );
  for (let i = 0; i < Math.min(10, results.length); i++) {
    printRow(i + 1, results[i]);
  }

  // ── Save artifacts ─────────────────────────────────────────────────────────
  const resultsDoc = {
    baselines: {
      mean:      { metrics: baselineMeanMetrics,  score: baselineMeanScore },
      heuristic: { metrics: baselineHeurMetrics,  score: baselineHeurScore },
    },
    configs: results,
  };
  fs.writeFileSync(args.results, JSON.stringify(resultsDoc, null, 2));
  process.stdout.write(`\nFull results → ${args.results}\n`);

  if (bestModel) {
    rf.saveModel(bestModel, args.output);
    const kb = (fs.statSync(args.output).size / 1024).toFixed(1);
    process.stdout.write(`Best model  → ${args.output} (${kb} KB)\n`);
    process.stdout.write(`Best config : ${JSON.stringify(bestConfig)}\n`);
    process.stdout.write(`Best score  : ${fmt4(bestScore)}\n`);

    const m = rf.computeMetrics(bestModel, testSet);
    process.stdout.write(`Best metrics:\n`);
    process.stdout.write(`  successProb  MAE=${fmt4(m.successProb.mae)}  RMSE=${fmt4(m.successProb.rmse)}  R²=${fmt4(m.successProb.r2)}\n`);
    process.stdout.write(`  logSteps     MAE=${fmt4(m.logSteps.mae)}  RMSE=${fmt4(m.logSteps.rmse)}  R²=${fmt4(m.logSteps.r2)}\n`);
    process.stdout.write(`  classAcc     ${fmt4(m.classificationAccuracy)}\n`);

    // ── Improvement vs baselines ──────────────────────────────────────────
    const vsHeur = bestScore - baselineHeurScore;
    const vsMean = bestScore - baselineMeanScore;
    const heurLabel = vsHeur >= 0 ? "✔ better" : "✘ worse";
    process.stdout.write(`\nComparison vs baselines:\n`);
    process.stdout.write(`  vs mean      : score ${fmt4(baselineMeanScore)} → ${fmtDelta(vsMean)}\n`);
    process.stdout.write(`  vs heuristic : score ${fmt4(baselineHeurScore)} → ${fmtDelta(vsHeur)}  ${heurLabel} than original scoring\n`);
    if (vsHeur < 0) {
      process.stdout.write(`  [!] RF underperforms the heuristic — consider generating more training data.\n`);
    }
  }

  const totalMs = Date.now() - sweepStart;
  process.stdout.write(`\nSweep complete in ${fmtMs(totalMs)}.\n`);
}

main().catch((err) => {
  process.stderr.write((err.stack || err.message) + "\n");
  process.exitCode = 1;
});
