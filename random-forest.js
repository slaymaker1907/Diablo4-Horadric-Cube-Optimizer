#!/usr/bin/env node
"use strict";

/**
 * random-forest.js
 *
 * Trains and runs a random forest scoring function for the D4 Horadric Cube
 * optimizer.  The model predicts two targets from a (source, target) scenario:
 *
 *   successProb  — probability (0–1) the target is achievable
 *   logSteps     — log1p(expectedSteps) for achievable scenarios
 *
 * Each forest is stored as an array of compact tree nodes:
 *   leaf  : number
 *   branch: [featureIndex, threshold, left, right]
 *
 * CLI:
 *   node random-forest.js train   [--data=…] [--output=…] [--num-trees=…] …
 *   node random-forest.js predict [--model=…] [--input=…]
 *   node random-forest.js eval    [--model=…] [--data=…]
 */

const fs = (typeof require !== "undefined") ? require("node:fs") : null;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const VERSION = "1.0.0";
const ELEMENTAL_DAMAGE_PREFIX = "elemental-damage-";
const SPECIFIC_RESISTANCE_PREFIX = "specific-resistance-";

/**
 * Feature vector layout (20 features, all numeric).
 * Indices must stay stable — they are baked into the serialized tree nodes.
 */
const FEATURE_NAMES = [
  "sourceCount",           //  0  number of source affixes (0–4)
  "targetCount",           //  1  number of target affixes (0–4)
  "isLegendary",           //  2  0/1
  "enchantressAvailable",  //  3  0/1
  "hasEnchanted",          //  4  0/1 — any source slot is enchanted
  "sourceGACount",         //  5  total GA count across all source affixes
  "targetGACount",         //  6  number of target affixes requiring GA
  "gaUnsatisfied",         //  7  GA requirements not covered by source GAs
  "matchCount",            //  8  source affixIds that appear in target
  "missingCount",          //  9  target affixIds absent from source
  "enchantedInTarget",     // 10  0/1 — enchanted source slot maps to a target affix
  "sourceElDmgCount",      // 11  elemental-damage affixes in source (0/1)
  "targetElDmgCount",      // 12  elemental-damage affixes in target (0/1)
  "elDmgFamilyMatch",      // 13  0/1 — source el-dmg type equals target el-dmg type
  "sourceResistCount",     // 14  specific-resistance affixes in source (0/1)
  "targetResistCount",     // 15  specific-resistance affixes in target (0/1)
  "resistFamilyMatch",     // 16  0/1 — source resist type equals target resist type
  "fractionMatched",       // 17  matchCount / targetCount ∈ [0,1]
  "targetIsImpossible",    // 18  0/1 — target contains family conflicts
  "nonMatchedGACount",     // 19  GA source affixes not needed by target
];

const NUM_FEATURES = FEATURE_NAMES.length;

// ─────────────────────────────────────────────────────────────────────────────
// Feature Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Infer the affix family tag ("elemental-damage" | "specific-resistance" | "")
 * by prefix-matching the ID.  Used when the full catalogue is not available.
 *
 * @param {string} affixId
 * @returns {string}
 */
function inferAffixFamily(affixId) {
  if (!affixId) return "";
  if (affixId.startsWith(ELEMENTAL_DAMAGE_PREFIX)) return "elemental-damage";
  if (affixId.startsWith(SPECIFIC_RESISTANCE_PREFIX)) return "specific-resistance";
  return "";
}

/**
 * Extract a numeric feature vector from a training row or a live scenario.
 *
 * Accepts two calling conventions:
 *   extractFeatures(row)             — row.source / row.state, row.target
 *   extractFeatures({ source, target })
 */
function extractFeatures(row) {
  const source = row.source || row.state || {};
  const target = row.target || {};
  const sourceAffixes = source.affixes || [];
  const targetAffixes = target.affixes || [];

  const sourceIdSet = new Set(sourceAffixes.map((a) => a.affixId));
  const targetIdSet = new Set(targetAffixes.map((a) => a.affixId));

  // ── GA counts in source ──────────────────────────────────────────────────
  const sourceGACounts = Object.create(null);
  for (const a of sourceAffixes) {
    if (a.isGA) sourceGACounts[a.affixId] = (sourceGACounts[a.affixId] || 0) + 1;
  }

  // How many GA requirements are unmet?
  let gaUnsatisfied = 0;
  const available = { ...sourceGACounts };
  for (const t of targetAffixes) {
    if (t.requireGA) {
      if ((available[t.affixId] || 0) > 0) {
        available[t.affixId]--;
      } else {
        gaUnsatisfied++;
      }
    }
  }

  // ── Enchantment state ────────────────────────────────────────────────────
  const enchantedEntry = sourceAffixes.find((a) => a.isEnchanted);
  const hasEnchanted = enchantedEntry ? 1 : 0;
  const enchantedInTarget = enchantedEntry && targetIdSet.has(enchantedEntry.affixId) ? 1 : 0;

  // ── Family analysis ──────────────────────────────────────────────────────
  let sourceElDmgCount = 0, targetElDmgCount = 0;
  let sourceResistCount = 0, targetResistCount = 0;
  let sourceElDmgId = null, targetElDmgId = null;
  let sourceResistId = null, targetResistId = null;

  for (const a of sourceAffixes) {
    const fam = inferAffixFamily(a.affixId);
    if (fam === "elemental-damage") { sourceElDmgCount++; sourceElDmgId = a.affixId; }
    else if (fam === "specific-resistance") { sourceResistCount++; sourceResistId = a.affixId; }
  }

  for (const a of targetAffixes) {
    const fam = inferAffixFamily(a.affixId);
    if (fam === "elemental-damage") { targetElDmgCount++; targetElDmgId = a.affixId; }
    else if (fam === "specific-resistance") { targetResistCount++; targetResistId = a.affixId; }
  }

  const elDmgFamilyMatch = (sourceElDmgId && targetElDmgId && sourceElDmgId === targetElDmgId) ? 1 : 0;
  const resistFamilyMatch = (sourceResistId && targetResistId && sourceResistId === targetResistId) ? 1 : 0;

  // Is the target itself impossible (family conflict)?
  const targetFamilyCounts = Object.create(null);
  for (const a of targetAffixes) {
    const fam = inferAffixFamily(a.affixId);
    if (fam) targetFamilyCounts[fam] = (targetFamilyCounts[fam] || 0) + 1;
  }
  const targetIsImpossible = Object.values(targetFamilyCounts).some((c) => c > 1) ? 1 : 0;

  // ── Aggregate stats ──────────────────────────────────────────────────────
  const sourceGACount = Object.values(sourceGACounts).reduce((s, v) => s + v, 0);
  const targetGACount = targetAffixes.filter((a) => a.requireGA).length;

  let matchCount = 0;
  for (const id of sourceIdSet) {
    if (targetIdSet.has(id)) matchCount++;
  }

  const missingCount = targetAffixes.filter((a) => !sourceIdSet.has(a.affixId)).length;
  const nonMatchedGACount = Object.entries(sourceGACounts)
    .reduce((sum, [id, count]) => sum + (targetIdSet.has(id) ? 0 : count), 0);
  const fractionMatched = targetAffixes.length > 0 ? matchCount / targetAffixes.length : 0;

  return [
    sourceAffixes.length,                    //  0 sourceCount
    targetAffixes.length,                    //  1 targetCount
    source.isLegendary ? 1 : 0,              //  2 isLegendary
    source.enchantressAvailable ? 1 : 0,     //  3 enchantressAvailable
    hasEnchanted,                            //  4
    sourceGACount,                           //  5
    targetGACount,                           //  6
    gaUnsatisfied,                           //  7
    matchCount,                              //  8
    missingCount,                            //  9
    enchantedInTarget,                       // 10
    sourceElDmgCount,                        // 11
    targetElDmgCount,                        // 12
    elDmgFamilyMatch,                        // 13
    sourceResistCount,                       // 14
    targetResistCount,                       // 15
    resistFamilyMatch,                       // 16
    fractionMatched,                         // 17
    targetIsImpossible,                      // 18
    nonMatchedGACount,                       // 19
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeded RNG (XorShift32 — same algorithm as generate_training_data.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a deterministic XorShift32 pseudo-random number generator.
 * Returns values uniformly in [0, 1).  Uses the same algorithm as
 * generate_training_data.js for reproducible splits.
 *
 * @param {number} seed - 32-bit unsigned integer seed.
 * @returns {() => number}
 */
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5;  s >>>= 0;
    return s / 0x100000000;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CART — compact recursive tree builder
// ─────────────────────────────────────────────────────────────────────────────

/** Determine how many features to sample per split. */
function resolveMaxFeatures(maxFeatures, numFeat) {
  if (maxFeatures === "sqrt")  return Math.max(1, Math.ceil(Math.sqrt(numFeat)));
  if (maxFeatures === "log2")  return Math.max(1, Math.ceil(Math.log2(numFeat + 1)));
  if (maxFeatures === "all")   return numFeat;
  const n = Number(maxFeatures);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), numFeat) : Math.ceil(Math.sqrt(numFeat));
}

/** Partial Fisher-Yates: draw k distinct indices from [0, n). */
function sampleSubset(n, k, rng) {
  const arr = Array.from({ length: n }, (_, i) => i);
  const end = Math.min(k, n);
  for (let i = 0; i < end; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr.slice(0, end);
}

/** Bootstrap sample: n draws with replacement from [0, n). */
function bootstrapSample(n, rng) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * n);
  return out;
}

/**
 * Build one CART regression tree.
 *
 * Node encoding (compact, JSON-friendly):
 *   leaf   : number
 *   branch : [featureIndex, threshold, leftChild, rightChild]
 */
function buildTree(features, labels, config, depth) {
  const n = labels.length;
  if (n === 0) return 0;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += labels[i];
  const mean = sum / n;

  if (depth >= config.maxDepth || n < 2 * config.minSamplesLeaf) {
    return mean; // leaf node
  }

  // Total sum-of-squares (used to compute variance reduction gain)
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += labels[i] * labels[i];
  const totalSSQ = sumSq - (sum * sum) / n;
  if (totalSSQ === 0) return mean;

  const numFeat = features[0].length;
  const k = resolveMaxFeatures(config.maxFeatures, numFeat);
  const featSubset = sampleSubset(numFeat, k, config.rng);

  let bestGain = 0, bestFi = -1, bestThresh = 0;

  // Temporary parallel arrays for sorting (reused across features)
  const fvals = new Float64Array(n);
  const order = new Int32Array(n);

  for (const fi of featSubset) {
    for (let i = 0; i < n; i++) { fvals[i] = features[i][fi]; order[i] = i; }
    // Sort order by feature value
    order.sort((a, b) => fvals[a] - fvals[b]);

    let leftSum = 0, leftSumSq = 0;
    let rightSum = sum, rightSumSq = sumSq;

    for (let split = 0; split < n - 1; split++) {
      const idx = order[split];
      const v = labels[idx];
      leftSum += v; leftSumSq += v * v;
      rightSum -= v; rightSumSq -= v * v;

      // Skip if next element has identical feature value
      if (fvals[order[split]] === fvals[order[split + 1]]) continue;

      const lc = split + 1;
      const rc = n - lc;
      if (lc < config.minSamplesLeaf || rc < config.minSamplesLeaf) continue;

      const leftVar  = leftSumSq  - (leftSum  * leftSum)  / lc;
      const rightVar = rightSumSq - (rightSum * rightSum) / rc;
      const gain = totalSSQ - leftVar - rightVar;

      if (gain > bestGain) {
        bestGain  = gain;
        bestFi    = fi;
        bestThresh = (fvals[order[split]] + fvals[order[split + 1]]) / 2;
      }
    }
  }

  if (bestFi < 0) return mean; // no useful split

  // Partition samples
  const leftFeatures = [], leftLabels = [];
  const rightFeatures = [], rightLabels = [];
  for (let i = 0; i < n; i++) {
    if (features[i][bestFi] <= bestThresh) {
      leftFeatures.push(features[i]); leftLabels.push(labels[i]);
    } else {
      rightFeatures.push(features[i]); rightLabels.push(labels[i]);
    }
  }

  return [
    bestFi,
    bestThresh,
    buildTree(leftFeatures, leftLabels, config, depth + 1),
    buildTree(rightFeatures, rightLabels, config, depth + 1),
  ];
}

/** Predict a single tree node. */
function predictTree(node, features) {
  if (typeof node === "number") return node;
  return predictTree(features[node[0]] <= node[1] ? node[2] : node[3], features);
}

// ─────────────────────────────────────────────────────────────────────────────
// Random Forest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Train a single forest for one regression target.
 *
 * @param {Array}    samples   — training rows
 * @param {Function} getLabel  — fn(row) => number | null  (null rows skipped)
 * @param {Object}   config    — { numTrees, maxDepth, minSamplesLeaf, maxFeatures, seed }
 * @returns {{ trees, featureNames, config }}
 */
function trainForest(samples, getLabel, config) {
  const {
    numTrees      = 100,
    maxDepth      = 10,
    minSamplesLeaf = 2,
    maxFeatures   = "sqrt",
    seed          = 42,
  } = config;

  const rng = makeRng(seed);

  // Extract features and labels, skipping null labels
  const features = [];
  const labels   = [];
  for (const s of samples) {
    const label = getLabel(s);
    if (label === null || label === undefined || !Number.isFinite(label)) continue;
    features.push(extractFeatures(s));
    labels.push(label);
  }

  const n = features.length;
  const treeConfig = { maxDepth, minSamplesLeaf, maxFeatures, rng };
  const trees = [];

  for (let t = 0; t < numTrees; t++) {
    const indices   = bootstrapSample(n, rng);
    const bootFeat  = indices.map((i) => features[i]);
    const bootLabel = indices.map((i) => labels[i]);
    trees.push(buildTree(bootFeat, bootLabel, treeConfig, 0));
  }

  return {
    trees,
    featureNames: FEATURE_NAMES,
    config: { numTrees, maxDepth, minSamplesLeaf, maxFeatures },
  };
}

/** Predict the ensemble mean for one sample. */
function predictForest(forest, features) {
  const { trees } = forest;
  let sum = 0;
  for (const tree of trees) sum += predictTree(tree, features);
  return sum / trees.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined Model  (successProb + logSteps)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Train a combined model with two internal forests.
 *
 * @param {Array}  data    — array of NDJSON rows
 * @param {Object} config  — hyperparameters (see trainForest)
 * @returns {Object} model ready for saveModel / predict / scoreState
 */
function trainModel(data, config) {
  const startedAt = Date.now();
  const baseSeed  = config.seed || 42;

  const successProbForest = trainForest(
    data,
    (s) => s.result.successProb,
    { ...config, seed: baseSeed }
  );

  const logStepsForest = trainForest(
    data,
    (s) => {
      const steps = s.result.expectedSteps;
      if (steps === null || steps === undefined) return null;
      return Math.log1p(steps);
    },
    { ...config, seed: baseSeed + 1 }
  );

  return {
    version: VERSION,
    trainedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    config,
    successProbForest,
    logStepsForest,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prediction
// ─────────────────────────────────────────────────────────────────────────────

/** Threshold below which a scenario is considered impossible. */
const IMPOSSIBLE_THRESHOLD = 0.05;

/** Clamp `v` to [lo, hi]. @param {number} v @param {number} lo @param {number} hi @returns {number} */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Predict for one row / live scenario.
 *
 * Accepts any object that extractFeatures understands:
 *   { source, target } or { state, target }
 *
 * @returns {{ successProb: number, expectedSteps: number|null, isImpossible: boolean }}
 */
function predict(model, row) {
  const features    = extractFeatures(row);
  const successProb = clamp(predictForest(model.successProbForest, features), 0, 1);
  const rawLogSteps = predictForest(model.logStepsForest, features);
  const expectedSteps = Math.expm1(Math.max(0, rawLogSteps));
  const isImpossible  = successProb < IMPOSSIBLE_THRESHOLD;

  return {
    successProb,
    expectedSteps: isImpossible ? null : expectedSteps,
    isImpossible,
  };
}

/**
 * Score a live MCTS (state, target) pair.
 * `state` is the worker game state object; `target` is the target spec.
 *
 * @returns {{ successProb, expectedSteps, isImpossible }}
 */
function scoreState(model, state, target) {
  return predict(model, { source: state, target });
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline Predictors  (no training required)
// ─────────────────────────────────────────────────────────────────────────────

// Named indices for extractFeatures output — keeps baseline code readable.
const FI = {
  sourceCount: 0, targetCount: 1, isLegendary: 2, enchantressAvailable: 3,
  hasEnchanted: 4, sourceGACount: 5, targetGACount: 6, gaUnsatisfied: 7,
  matchCount: 8, missingCount: 9, enchantedInTarget: 10,
  sourceElDmgCount: 11, targetElDmgCount: 12, elDmgFamilyMatch: 13,
  sourceResistCount: 14, targetResistCount: 15, resistFamilyMatch: 16,
  fractionMatched: 17, targetIsImpossible: 18, nonMatchedGACount: 19,
};

/**
 * Heuristic baseline predictor — mirrors the logic the MCTS step-estimator
 * uses before training data is available.  No model required.
 *
 * Rules:
 *   - Family conflict in target → always impossible
 *   - Unsatisfied GA requirements → very low success probability
 *   - Otherwise → successProb ≈ fractionMatched, steps ≈ missingCount × baseRate
 *
 * @returns {{ successProb, expectedSteps, isImpossible }}
 */
function predictHeuristic(row) {
  const f = extractFeatures(row);

  if (f[FI.targetIsImpossible]) {
    return { successProb: 0, expectedSteps: null, isImpossible: true };
  }

  const gaUnsatisfied = f[FI.gaUnsatisfied];

  // When GA requirements cannot be met, success drops sharply.
  const successProb = gaUnsatisfied > 0
    ? clamp(f[FI.fractionMatched] * 0.5, 0, 0.8)
    : clamp(f[FI.fractionMatched], 0, 1);

  // Step estimate: Legendary items roll faster (~12 attempts/affix vs ~22).
  const baseRate   = f[FI.isLegendary] ? 12 : 22;
  const enchantAdd = (f[FI.hasEnchanted] && !f[FI.enchantedInTarget]) ? baseRate : 0;
  const gaAdd      = gaUnsatisfied * 35;
  const expectedSteps = f[FI.missingCount] * baseRate + enchantAdd + gaAdd;

  const isImpossible = successProb < IMPOSSIBLE_THRESHOLD;
  return {
    successProb,
    expectedSteps: isImpossible ? null : expectedSteps,
    isImpossible,
  };
}

/**
 * Mean baseline predictor — always returns the training-set mean.
 * R² for this predictor is 0 by definition (useful as a floor check).
 *
 * @param {Array} trainData  — training rows used to compute means
 * @returns {Function}        predictFn(row) => { successProb, expectedSteps, isImpossible }
 */
function makeMeanPredictor(trainData) {
  let spSum = 0, stSum = 0, stCount = 0;
  for (const row of trainData) {
    spSum += row.result.successProb;
    const steps = row.result.expectedSteps;
    if (steps !== null && steps !== undefined) { stSum += steps; stCount++; }
  }
  const spMean = spSum / trainData.length;
  const stMean = stCount > 0 ? stSum / stCount : 0;
  return function predictMean(/* row */) {
    return {
      successProb:   spMean,
      expectedSteps: stMean,
      isImpossible:  spMean < IMPOSSIBLE_THRESHOLD,
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute hold-out metrics for both prediction targets.
 *
 * @param {Object|Function} modelOrFn
 *   Either a trained model (from trainModel) or a raw predict function
 *   with signature  fn(row) => { successProb, expectedSteps, isImpossible }.
 *   Passing a function lets you evaluate baselines without a model object.
 * @returns {{
 *   successProb: { mae, rmse, r2 },
 *   logSteps:    { mae, rmse, r2 },
 *   classificationAccuracy: number,
 *   n: number
 * }}
 */
function computeMetrics(modelOrFn, testData) {
  const predictFn = typeof modelOrFn === "function"
    ? modelOrFn
    : (row) => predict(modelOrFn, row);

  let spSumAbs = 0, spSumSq = 0, spSSRes = 0, spSSTot = 0;
  let stSumAbs = 0, stSumSq = 0, stSSRes = 0, stSSTot = 0;
  let stCount  = 0, classCorrect = 0;

  // First pass: compute means for R² denominator
  let spMean = 0, stMean = 0;
  for (const row of testData) spMean += row.result.successProb;
  spMean /= testData.length;

  let validStepCount = 0;
  for (const row of testData) {
    const steps = row.result.expectedSteps;
    if (steps !== null && steps !== undefined) {
      stMean += Math.log1p(steps);
      validStepCount++;
    }
  }
  if (validStepCount > 0) stMean /= validStepCount;

  // Second pass: accumulate errors
  for (const row of testData) {
    const pred      = predictFn(row);
    const actualSP  = row.result.successProb;
    const actualSteps = row.result.expectedSteps;

    const spErr = pred.successProb - actualSP;
    spSumAbs += Math.abs(spErr);
    spSumSq  += spErr * spErr;
    spSSRes  += spErr * spErr;
    spSSTot  += (actualSP - spMean) ** 2;

    const actualIsImpossible = actualSP < 0.01;
    if (actualIsImpossible === pred.isImpossible) classCorrect++;

    if (actualSteps !== null && actualSteps !== undefined) {
      const actualLog = Math.log1p(actualSteps);
      const predLog   = Math.log1p(Math.max(0, pred.expectedSteps || 0));
      const stErr = predLog - actualLog;
      stSumAbs += Math.abs(stErr);
      stSumSq  += stErr * stErr;
      stSSRes  += stErr * stErr;
      stSSTot  += (actualLog - stMean) ** 2;
      stCount++;
    }
  }

  const n = testData.length;
  return {
    successProb: {
      mae:  spSumAbs / n,
      rmse: Math.sqrt(spSumSq / n),
      r2:   spSSTot > 0 ? 1 - spSSRes / spSSTot : 0,
    },
    logSteps: {
      mae:  stCount > 0 ? stSumAbs / stCount : 0,
      rmse: stCount > 0 ? Math.sqrt(stSumSq / stCount) : 0,
      r2:   stSSTot > 0 ? 1 - stSSRes / stSSTot : 0,
    },
    classificationAccuracy: classCorrect / n,
    n,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialise `model` to a JSON file at `filePath`.
 *
 * @param {Object} model
 * @param {string} filePath
 */
function saveModel(model, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(model));
}

/**
 * Load a serialised model from a JSON file.
 *
 * @param {string} filePath
 * @returns {Object} model
 */
function loadModel(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Read an NDJSON file and parse each line as a JSON object.
 * Blank lines and parse errors are silently skipped.
 *
 * @param {string} filePath
 * @returns {Object[]}
 */
function loadNdjson(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse CLI flags (`--key=value`) into a config object.
 *
 * @param {string[]} argv - `process.argv.slice(2)` or equivalent.
 * @returns {Object}
 */
function parseCliArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) { args._command = arg; continue; }
    const eq  = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    args[key] = eq >= 0 ? arg.slice(eq + 1) : "true";
  }
  return args;
}

/** Print CLI usage information to stdout. */
function printHelp() {
  process.stdout.write([
    "Usage: node random-forest.js <command> [options]",
    "",
    "Commands:",
    "  train    Train a new model from NDJSON training data",
    "  predict  Run inference on NDJSON input rows",
    "  eval     Evaluate a saved model against a data file",
    "",
    "Train options:",
    "  --data=<path>             Input NDJSON file  (default: training-data.current.jsonl)",
    "  --output=<path>           Output model JSON  (default: model.json)",
    "  --test-split=<0–1>        Held-out fraction  (default: 0.2)",
    "  --num-trees=<int>         Trees per forest   (default: 100)",
    "  --max-depth=<int>         Max tree depth     (default: 10)",
    "  --min-samples-leaf=<int>  Min leaf size      (default: 2)",
    "  --max-features=<str>      sqrt|log2|all|int  (default: sqrt)",
    "  --seed=<int>              RNG seed           (default: 42)",
    "",
    "Predict options:",
    "  --model=<path>            Model JSON file    (default: model.json)",
    "  --input=<path>            NDJSON input       (default: -, read stdin)",
    "",
    "Eval options:",
    "  --model=<path>            Model JSON file",
    "  --data=<path>             NDJSON data file",
    "  --test-split=<0–1>        Eval on last N%    (default: 0.2)",
    "",
  ].join("\n"));
}

async function cliTrain(args) {
  const dataPath   = args.data   || "training-data.current.jsonl";
  const outputPath = args.output || "model.json";
  const testSplit  = Number(args["test-split"] || "0.2");
  const config = {
    numTrees:       Number(args["num-trees"]          || "100"),
    maxDepth:       Number(args["max-depth"]           || "10"),
    minSamplesLeaf: Number(args["min-samples-leaf"]    || "2"),
    maxFeatures:    args["max-features"]               || "sqrt",
    seed:           Number(args.seed                   || "42"),
  };

  process.stdout.write(`Loading ${dataPath}...\n`);
  const data = loadNdjson(dataPath);
  process.stdout.write(`Loaded ${data.length} rows.\n`);

  const splitAt  = Math.floor(data.length * (1 - testSplit));
  const trainSet = data.slice(0, splitAt);
  const testSet  = data.slice(splitAt);

  process.stdout.write(`Train: ${trainSet.length}  Test: ${testSet.length}\n`);
  process.stdout.write(`Config: ${JSON.stringify(config)}\n`);

  const model = trainModel(trainSet, config);
  process.stdout.write(`Trained in ${model.elapsedMs} ms.\n`);

  if (testSet.length > 0) {
    const metrics = computeMetrics(model, testSet);
    process.stdout.write(`\nMetrics (test set):\n${JSON.stringify(metrics, null, 2)}\n`);
  }

  saveModel(model, outputPath);
  const kb = (fs.statSync(outputPath).size / 1024).toFixed(1);
  process.stdout.write(`\nModel saved → ${outputPath} (${kb} KB)\n`);
}

async function cliPredict(args) {
  const modelPath = args.model || "model.json";
  const inputPath = args.input || "-";

  const model = loadModel(modelPath);
  process.stdout.write(`# Model trained ${model.trainedAt}  config=${JSON.stringify(model.config)}\n`);

  let rows;
  if (inputPath === "-") {
    const raw = fs.readFileSync("/dev/stdin", "utf8");
    rows = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } else {
    rows = loadNdjson(inputPath);
  }

  for (const row of rows) {
    process.stdout.write(JSON.stringify(predict(model, row)) + "\n");
  }
}

async function cliEval(args) {
  const modelPath = args.model     || "model.json";
  const dataPath  = args.data      || "training-data.current.jsonl";
  const testSplit = Number(args["test-split"] || "0.2");

  const model   = loadModel(modelPath);
  const data    = loadNdjson(dataPath);
  const splitAt = Math.floor(data.length * (1 - testSplit));
  const testSet = data.slice(splitAt);

  process.stdout.write(`Evaluating on ${testSet.length} rows (last ${(testSplit * 100).toFixed(0)}%)...\n`);
  const metrics = computeMetrics(model, testSet);
  process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
}

async function main() {
  const args    = parseCliArgs(process.argv.slice(2));
  const command = args._command || "train";

  if (args.help || args.h) { printHelp(); return; }

  switch (command) {
    case "train":   return cliTrain(args);
    case "predict": return cliPredict(args);
    case "eval":    return cliEval(args);
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((err) => {
    process.stderr.write((err.stack || err.message) + "\n");
    process.exitCode = 1;
  });
}

if (typeof module !== "undefined") module.exports = {
  VERSION,
  FEATURE_NAMES,
  FI,
  NUM_FEATURES,
  extractFeatures,
  trainModel,
  trainForest,
  predict,
  predictHeuristic,
  makeMeanPredictor,
  scoreState,
  computeMetrics,
  saveModel,
  loadModel,
  loadNdjson,
};
