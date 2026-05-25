/**
 * d4cubeoptim-worker.js
 *
 * Monte Carlo Tree Search (MCTS) optimizer for Horadric Cube affix planning
 * in Diablo 4.  Runs as both a Web Worker (browser) and a synchronous
 * Node.js module.
 *
 * Architecture
 * ────────────
 * - MCTS with UCB1 exploration drives the search loop.
 * - Short random rollouts bootstrap nodes before sufficient visit data
 *   accumulates; once a node has ≥2 visits it is expanded recursively.
 * - Rule-based shortcuts (`resolveRuleAction`) fire for provably-optimal
 *   moves, bypassing MCTS entirely for those decisions.
 * - A pluggable `scorer` (e.g. a trained Random Forest from random-forest.js)
 *   can replace the built-in heuristics at depth-limit leaves and rollout
 *   terminals.  Pass it via `options.scorer` in the Node.js API.
 *
 * Worker message protocol (browser)
 * ──────────────────────────────────
 * Incoming:
 *   { type: "run",  ...payload }  — begin optimization
 *   { type: "stop" }              — request early termination
 *
 * Outgoing:
 *   { type: "progress", runId, ...snapshot }  — throttled progress events
 *   { type: "done",     runId, ...result  }   — final answer
 *   { type: "error",    runId, message    }   — unhandled exception
 *
 * Node.js API
 * ───────────
 * ```js
 * const worker = require('./d4cubeoptim-worker.js');
 * const rf     = require('./random-forest.js');
 * const model  = rf.loadModel('./model.json');
 *
 * const result = worker.optimizeScenario(payload, {
 *   scorer: (state, target) => rf.scoreState(model, state, target),
 * });
 * ```
 */

let gearSlotLegality = null;

if (typeof module !== "undefined" && module.exports) {
  gearSlotLegality = require("./gear-slot-legality.js");
}

// Load worker-side helper modules when running as a browser Web Worker.
// Functions become worker-scope globals; gracefully degrade if unavailable.
if (typeof importScripts !== "undefined") {
  try { importScripts("./random-forest.js"); } catch (_) { /* scorer unavailable */ }
  try { importScripts("./gear-slot-legality.js"); } catch (_) { /* slot legality unavailable */ }
  if (typeof d4cubeoptimGearSlotLegality !== "undefined") {
    gearSlotLegality = d4cubeoptimGearSlotLegality;
  }
}

/** Cached browser-side RF model, set once per worker lifetime. */
let workerScorerModel = null;

/** Global stop flag set by worker "stop" messages. */
let stopRequested = false;

/**
 * Fraction of root-level decisions taken randomly (ε-greedy).
 * Keeps low-visit actions alive so the root does not over-commit early.
 */
const ROOT_EXPLORE_EPSILON = 0.14;

/** Minimum visit count every root action must receive before UCB takes over. */
const ROOT_MIN_VISITS_BASE = 6;

/**
 * Scales the minimum-visit threshold at the root with log(totalVisits).
 * Higher values force more exhaustive early exploration.
 */
const ROOT_MIN_VISITS_LOG_SCALE = 2;

/** Maximum missing target-affix instances for the exact small-state solver. */
const EXACT_SMALL_STATE_MAX_MISSING = 1;

/** Hard cap on reachable states before the exact solver bails out. */
const EXACT_SMALL_STATE_LIMIT = 4096;

/** Iteration cap for exact small-state value iteration. */
const EXACT_SMALL_STATE_MAX_ITERATIONS = 2048;

/** Convergence epsilon for exact small-state value iteration. */
const EXACT_SMALL_STATE_EPSILON = 1e-9;

/**
 * Probability of choosing a random action during rollouts.
 * 0 = fully greedy rollouts (recommended for this domain).
 */
const ROLLOUT_EPSILON = 0;

/**
 * Probability floor for treating a rule-selected action as "guaranteed".
 * Set just below 1.0 to tolerate floating-point rounding.
 */
const RULE_SUCCESS_THRESHOLD = 1 - 1e-9;

/** Affix-family tag for elemental damage subtypes. */
const ELEMENTAL_DAMAGE_FAMILY = "elemental-damage";

/** Affix-family tag for specific resistance subtypes. */
const SPECIFIC_RESISTANCE_FAMILY = "specific-resistance";

/**
 * Canonical placeholder IDs used to represent "any member of a family"
 * when the specific subtype is not wanted by the target.
 */
const FAMILY_OTHER_IDS = {
  [ELEMENTAL_DAMAGE_FAMILY]: `${ELEMENTAL_DAMAGE_FAMILY}-other`,
  [SPECIFIC_RESISTANCE_FAMILY]: `${SPECIFIC_RESISTANCE_FAMILY}-other`,
};

const DEFAULT_GEAR_SLOT = "Any";
const DEFAULT_CLASS = "Any";

if (typeof self !== "undefined") {
  self.onmessage = (event) => {
    const payload = event.data || {};

    if (payload.type === "set-scorer-model") {
      workerScorerModel = payload.model || null;
      return;
    }

    if (payload.type === "stop") {
      stopRequested = true;
      return;
    }

    if (payload.type === "run") {
      stopRequested = false;
      const runId = Number(payload.runId) || 0;
      try {
        runOptimization(payload, runId);
      } catch (error) {
        self.postMessage({
          type: "error",
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}

/**
 * Internal entry point for the Web Worker "run" message.
 * Wraps `optimizePayload`, posts progress/done messages, and surfaces errors.
 *
 * @param {Object} payload - Deserialized worker message payload.
 * @param {number} runId   - Monotonic run identifier echoed in all messages.
 */
function runOptimization(payload, runId) {
  const stopBuffer = payload.stopBuffer || null;
  const stopView = stopBuffer ? new Int32Array(stopBuffer) : null;
  const scorerModel = payload.scorerModel || workerScorerModel;

  // Reconstruct RF scorer from the serialised model passed in the payload.
  // scoreState is available as a global after importScripts('./random-forest.js').
  let scorer = null;
  if (scorerModel && typeof scoreState === "function") {
    scorer = (state, target) => scoreState(scorerModel, state, target);
  }

  const result = optimizePayload(payload, {
    stopView,
    scorer,
    onProgress: (snapshot) => {
      self.postMessage({
        type: "progress",
        runId,
        ...snapshot,
      });
    },
  });

  self.postMessage({
    type: "done",
    runId,
    ...result,
  });
}

/**
 * Core optimization driver.  Builds the environment, initialises the MCTS
 * tree, and runs the search loop until the time budget is exhausted or a
 * stop signal is received.
 *
 * @param {Object}   payload                         - Scenario description.
 * @param {Object}   payload.state                   - Starting item state.
 * @param {Object}   payload.target                  - Target affix requirements.
 * @param {Object}   payload.data                    - Affix/category catalogue.
 * @param {number}   [payload.timeMs]                - Wall-clock budget (ms). Unlimited if ≤0.
 * @param {Object}   [payload.tree]                  - Warm-start MCTS tree from a prior run.
 * @param {number}   [payload.depthLimit=26]         - Maximum recursive expansion depth.
 * @param {number}   [payload.rolloutDepthLimit=26]  - Maximum rollout simulation depth.
 * @param {number}   [payload.rolloutCount=5]        - Rollout episodes per node visit.
 * @param {Object}   [payload.gaConfig]              - GA sacrifice / required-GA configuration.
 * @param {boolean}  [payload.includeTree=true]      - Whether to include the tree in the result.
 * @param {Object}   options
 * @param {Int32Array|null} [options.stopView]       - Atomics-backed stop flag (browser).
 * @param {Function|null}   [options.onProgress]     - Called with progress snapshots every ~500 ms.
 * @param {Function|null}   [options.scorer]         - Optional `(state, target) => {successProb, expectedSteps}`
 *   scoring function.  When provided, replaces heuristic estimates at depth-limit
 *   leaves and rollout terminals.  Typically `rf.scoreState.bind(null, model)`
 *   from random-forest.js.
 * @returns {Object} Optimization result — action, successProb, expectedSteps, diagnostics, tree, …
 */
function optimizePayload(payload, options = {}) {
  const {
    state,
    target,
    data,
    timeMs,
    tree,
    depthLimit = 26,
    rolloutDepthLimit = 26,
    rolloutCount = 5,
    gaConfig,
    includeTree = true,
  } = payload;

  const stopView = options.stopView || null;
  const onProgress = typeof options.onProgress === "function"
    ? options.onProgress
    : null;

  if (stopView && typeof Atomics !== "undefined") {
    Atomics.store(stopView, 0, 0);
  }

  const env = buildEnv(data, gaConfig, target);
  const scorerCache = new Map();

  // Attach the optional scorer so heuristic call-sites throughout the MCTS
  // can delegate to it.  Binding `target` here keeps call-sites clean.
  if (typeof options.scorer === "function") {
    env.scorer = (state) => {
      const key = stateKey(state);
      if (scorerCache.has(key)) {
        return scorerCache.get(key);
      }

      const score = options.scorer(state, target);
      scorerCache.set(key, score);
      return score;
    };
  }

  const maxTime = Number(timeMs);
  const unlimited = !Number.isFinite(maxTime) || maxTime <= 0;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;

  const mctsTree = normalizeTree(tree);
  const normalizedRootState = canonicalizeStateForEnv(state, env);
  const rootKey = stateKey(normalizedRootState);

  if (!mctsTree.nodes[rootKey]) {
    mctsTree.nodes[rootKey] = createNode(normalizedRootState);
  } else {
    mctsTree.nodes[rootKey].state = cloneState(normalizedRootState);
  }
  mctsTree.rootKey = rootKey;

  const initialTerminal = isTerminal(mctsTree.nodes[rootKey].state, target, env);
  if (initialTerminal.terminal) {
    const result = terminalSummary(initialTerminal, env);
    return {
      iterations: 0,
      ...result,
      tree: includeTree ? shrinkTree(mctsTree, rootKey, 0) : null,
      stoppedByUser: false,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const exactSummary = getExactSmallStateSummary(mctsTree.nodes[rootKey].state, target, env);
  if (exactSummary) {
    return {
      iterations: 0,
      ...exactSummary,
      tree: includeTree ? shrinkTree(mctsTree, rootKey, 0) : null,
      stoppedByUser: false,
      elapsedMs: Date.now() - startedAt,
    };
  }

  let iterations = 0;
  while (true) {
    if (shouldStop(stopView)) {
      break;
    }

    if (!unlimited && Date.now() - startedAt >= maxTime) {
      break;
    }

    iterations += 1;
    simulateFromNode(
      mctsTree,
      mctsTree.rootKey,
      env,
      target,
      depthLimit,
      rolloutDepthLimit,
      rolloutCount
    );

    if ((iterations & 255) === 0 && shouldStop(stopView)) {
      break;
    }

    const now = Date.now();
    if (onProgress && now - lastProgressAt >= 500) {
      lastProgressAt = now;
      onProgress({
        iterations,
        ...summarizeRoot(mctsTree, rootKey, env, target),
      });
    }
  }

  const result = summarizeRoot(mctsTree, rootKey, env, target);
  return {
    iterations,
    ...result,
    tree: includeTree ? shrinkTree(mctsTree, rootKey, 3) : null,
    stoppedByUser: shouldStop(stopView),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Convenience wrapper for Node.js callers.
 * Runs the optimization synchronously (no Web Worker) and returns the result.
 *
 * @param {Object}   payload          - Same shape as `optimizePayload` payload.
 * @param {Object}   [options={}]
 * @param {Function} [options.scorer] - Optional `(state, target) => {successProb, expectedSteps}`
 *   scorer.  Pass a bound `rf.scoreState` to enable Random Forest guidance.
 * @returns {Object} Optimization result.
 */
function optimizeScenario(payload, options = {}) {
  stopRequested = false;
  return optimizePayload(payload, {
    stopView: null,
    onProgress: null,
    scorer: options.scorer || null,
  });
}

/**
 * Returns true if the search loop should terminate.
 * Checks both the module-level `stopRequested` flag (set by worker "stop"
 * messages) and the Atomics-backed shared-memory flag for low-latency
 * cross-thread signalling.
 *
 * @param {Int32Array|null} stopView - Shared memory view, or null.
 * @returns {boolean}
 */
function shouldStop(stopView) {
  if (stopRequested) {
    return true;
  }
  if (stopView && typeof Atomics !== "undefined") {
    return Atomics.load(stopView, 0) === 1;
  }
  return false;
}

/**
 * Infer the family tag ("elemental-damage" | "specific-resistance" | "")
 * for an affix ID by prefix-matching.  Used when the affix is not in the
 * catalogue (e.g. synthetic placeholder IDs).
 *
 * @param {string} affixId
 * @returns {string} Family tag, or "" if none.
 */
function inferAffixFamily(affixId) {
  if (!affixId) {
    return "";
  }

  if (affixId === FAMILY_OTHER_IDS[ELEMENTAL_DAMAGE_FAMILY] || affixId.startsWith(`${ELEMENTAL_DAMAGE_FAMILY}-`)) {
    return ELEMENTAL_DAMAGE_FAMILY;
  }

  if (affixId === FAMILY_OTHER_IDS[SPECIFIC_RESISTANCE_FAMILY] || affixId.startsWith(`${SPECIFIC_RESISTANCE_FAMILY}-`)) {
    return SPECIFIC_RESISTANCE_FAMILY;
  }

  return "";
}

/**
 * Return the family tag for an affix, preferring the catalogue entry's
 * `family` field and falling back to `inferAffixFamily`.
 *
 * @param {string} affixId
 * @param {Object} affixMap - Map of affixId → affix object.
 * @returns {string}
 */
function getAffixFamily(affixId, affixMap) {
  const affix = affixMap[affixId];
  if (affix && affix.family) {
    return affix.family;
  }
  return inferAffixFamily(affixId);
}

/**
 * Collapse unwanted family subtypes to a shared placeholder ID so that
 * distinct subtypes of the same family (e.g. fire vs. cold elemental damage)
 * are treated as the same state when neither matches the target.
 *
 * @param {string} affixId
 * @param {Object} env - Built environment (needs `affixMap`, `wantedByFamily`, `familyOtherId`).
 * @returns {string} Canonical affix ID.
 */
function canonicalizeAffixIdForState(affixId, env) {
  if (!affixId) {
    return affixId;
  }

  const family = getAffixFamily(affixId, env.affixMap);
  if (!family) {
    return affixId;
  }

  const wanted = env.wantedByFamily[family] || "";
  if (wanted && affixId === wanted) {
    return affixId;
  }

  return env.familyOtherId[family] || affixId;
}

/**
 * Apply `canonicalizeAffixIdForState` to every affix in `state.affixes`
 * and return a new state object.
 *
 * @param {Object} state
 * @param {Object} env
 * @returns {Object} Canonicalized state.
 */
function canonicalizeStateForEnv(state, env) {
  const next = cloneState(state);
  next.affixes = next.affixes.map((entry) => ({
    affixId: canonicalizeAffixIdForState(entry.affixId, env),
    isGA: !!entry.isGA,
    isEnchanted: !!entry.isEnchanted,
  }));
  return next;
}

/**
 * Returns true if `state` already has more than one affix from the same
 * family (elemental-damage or specific-resistance).
 * Illegal states of this kind are prevented by the action model but this
 * guard is retained as a safety check.
 *
 * @param {Object} state
 * @param {Object} env
 * @returns {boolean}
 */
function violatesFamilyUniqueness(state, env) {
  const counts = Object.create(null);
  for (const entry of state.affixes) {
    const family = getAffixFamily(entry.affixId, env.affixMap);
    if (!family) {
      continue;
    }

    counts[family] = (counts[family] || 0) + 1;
    if (counts[family] > 1) {
      return true;
    }
  }

  return false;
}

/**
 * Check whether the target specification is structurally impossible due to
 * family-uniqueness constraints (e.g. two elemental-damage subtypes).
 *
 * @param {Object} targetCounts - Map of affixId → required count.
 * @param {Object} affixMap
 * @returns {string} Non-empty reason string if impossible, otherwise "".
 */
function getImpossibleTargetFamilyReason(targetCounts, affixMap) {
  const familyCounts = Object.create(null);

  for (const [affixId, count] of Object.entries(targetCounts)) {
    const family = getAffixFamily(affixId, affixMap);
    if (!family) {
      continue;
    }

    familyCounts[family] = (familyCounts[family] || 0) + count;
  }

  if ((familyCounts[ELEMENTAL_DAMAGE_FAMILY] || 0) > 1) {
    return "Impossible target: only one Elemental Damage type can exist on an item.";
  }

  if ((familyCounts[SPECIFIC_RESISTANCE_FAMILY] || 0) > 1) {
    return "Impossible target: only one Specific Resistance type can exist on an item.";
  }

  return "";
}

/**
 * Build the immutable runtime environment for one optimization run.
 * Pre-computes all derived data (affix maps, category lists, GA constraints,
 * target counts, family placeholder IDs, impossibility checks) so that the
 * hot MCTS loop never has to repeat this work.
 *
 * Also serves as the carrier for the optional `scorer` function — see
 * `optimizePayload` for how it is attached after `buildEnv` returns.
 *
 * @param {Object}      data      - Affix/category catalogue from the UI payload.
 * @param {Object|null} gaConfig  - { sacrificeAffixId, currentGAAffixes, strictMode, rulesEnabled }
 * @param {Object}      target    - Target spec { affixes: [{affixId, requireGA}] }.
 * @returns {Object} env
 */
function buildEnv(data, gaConfig, target) {
  const categories = data.categories || {};
  const categoryNames = Object.keys(categories);
  const affixes = data.affixes || [];
  const affixMap = Object.create(null);
  const categoryAffixes = Object.create(null);
  const categoryAffixesBySlot = Object.create(null);
  const categoryWeightTotals = Object.create(null);
  const categoryWeightTotalsBySlot = Object.create(null);

  for (const affix of affixes) {
    const derivedGearSlots = Array.isArray(affix && affix.gearSlots)
      ? affix.gearSlots.slice()
      : (gearSlotLegality && typeof gearSlotLegality.getLegalGearSlotsForAffixName === "function"
        ? gearSlotLegality.getLegalGearSlotsForAffixName(affix && affix.name)
        : null);

    affixMap[affix.id] = {
      ...affix,
      gearSlots: Array.isArray(derivedGearSlots) && derivedGearSlots.length > 0
        ? derivedGearSlots
        : null,
    };
  }

  for (const categoryName of categoryNames) {
    categoryAffixes[categoryName] = (categories[categoryName] || [])
      .map((id) => affixMap[id])
      .filter(Boolean);
    categoryWeightTotals[categoryName] = sumEffectiveWeights(categoryAffixes[categoryName]);
  }

  const knownGearSlots = Array.isArray(data && data.gearSlots) && data.gearSlots.length > 0
    ? data.gearSlots.filter((slot) => typeof slot === "string" && slot)
    : (gearSlotLegality && Array.isArray(gearSlotLegality.GEAR_SLOTS)
      ? gearSlotLegality.GEAR_SLOTS
      : [DEFAULT_GEAR_SLOT]);
  const gearSlots = Array.from(new Set([DEFAULT_GEAR_SLOT].concat(knownGearSlots)));

  const knownClasses = Array.isArray(data && data.classes) && data.classes.length > 0
    ? data.classes.filter((cls) => typeof cls === "string" && cls)
    : [DEFAULT_CLASS];
  const classes = Array.from(new Set([DEFAULT_CLASS].concat(knownClasses)));

  categoryAffixesBySlot[DEFAULT_GEAR_SLOT] = categoryAffixes;
  categoryWeightTotalsBySlot[DEFAULT_GEAR_SLOT] = categoryWeightTotals;

  for (const gearSlot of gearSlots) {
    if (gearSlot === DEFAULT_GEAR_SLOT) {
      continue;
    }

    categoryAffixesBySlot[gearSlot] = Object.create(null);
    categoryWeightTotalsBySlot[gearSlot] = Object.create(null);
    for (const categoryName of categoryNames) {
      const filtered = categoryAffixes[categoryName].filter((affix) => affixSupportsGearSlot(affix, gearSlot));
      categoryAffixesBySlot[gearSlot][categoryName] = filtered;
      categoryWeightTotalsBySlot[gearSlot][categoryName] = sumEffectiveWeights(filtered);
    }
  }

  // Per-(slot, class) caches.  Class narrowing is independent of slot legality,
  // so we filter the per-slot list by `affixSupportsClass` and recompute the
  // effective weight totals (which depend on class-narrowed family sizes).
  const categoryAffixesBySlotByClass = Object.create(null);
  const categoryWeightTotalsBySlotByClass = Object.create(null);

  for (const gearSlot of gearSlots) {
    categoryAffixesBySlotByClass[gearSlot] = Object.create(null);
    categoryWeightTotalsBySlotByClass[gearSlot] = Object.create(null);

    const slotAffixes = categoryAffixesBySlot[gearSlot] || categoryAffixes;
    const slotTotals = categoryWeightTotalsBySlot[gearSlot] || categoryWeightTotals;

    for (const className of classes) {
      categoryAffixesBySlotByClass[gearSlot][className] = Object.create(null);
      categoryWeightTotalsBySlotByClass[gearSlot][className] = Object.create(null);

      for (const categoryName of categoryNames) {
        const base = slotAffixes[categoryName] || [];
        if (className === DEFAULT_CLASS) {
          categoryAffixesBySlotByClass[gearSlot][className][categoryName] = base;
          categoryWeightTotalsBySlotByClass[gearSlot][className][categoryName] = Number.isFinite(slotTotals[categoryName])
            ? slotTotals[categoryName]
            : sumEffectiveWeights(base);
        } else {
          const filtered = base.filter((affix) => affixSupportsClass(affix, className));
          categoryAffixesBySlotByClass[gearSlot][className][categoryName] = filtered;
          categoryWeightTotalsBySlotByClass[gearSlot][className][categoryName] = sumEffectiveWeights(filtered);
        }
      }
    }
  }

  const wantedByFamily = Object.create(null);

  const gaRequiredCounts = Object.create(null);
  const currentGAList = (gaConfig && Array.isArray(gaConfig.currentGAAffixes))
    ? gaConfig.currentGAAffixes
    : [];
  const sourceGACounts = Object.create(null);

  for (const gaId of currentGAList) {
    if (!gaId) {
      continue;
    }
    sourceGACounts[gaId] = (sourceGACounts[gaId] || 0) + 1;
  }

  const targetCounts = Object.create(null);
  const targetAffixes = (target && Array.isArray(target.affixes)) ? target.affixes : [];

  for (const req of targetAffixes) {
    if (!req || !req.affixId) {
      continue;
    }

    targetCounts[req.affixId] = (targetCounts[req.affixId] || 0) + 1;

    const family = getAffixFamily(req.affixId, affixMap);
    if (family && !wantedByFamily[family]) {
      wantedByFamily[family] = req.affixId;
    }
  }

  // Implicit GA protection: any affix that is both a source GA and a target
  // requirement is implicitly protected. This preserves GAs that already exist
  // on the item and are needed, without requiring an explicit requireGA flag.
  for (const [affixId, sourceCount] of Object.entries(sourceGACounts)) {
    const targetCount = targetCounts[affixId] || 0;
    if (targetCount > 0) {
      gaRequiredCounts[affixId] = Math.min(sourceCount, targetCount);
    }
  }

  const familyOtherId = {
    [ELEMENTAL_DAMAGE_FAMILY]: FAMILY_OTHER_IDS[ELEMENTAL_DAMAGE_FAMILY],
    [SPECIFIC_RESISTANCE_FAMILY]: FAMILY_OTHER_IDS[SPECIFIC_RESISTANCE_FAMILY],
  };

  for (const [family, otherId] of Object.entries(familyOtherId)) {
    if (affixMap[otherId]) {
      continue;
    }

    const seedAffix = Object.values(affixMap).find((entry) => getAffixFamily(entry.id, affixMap) === family);
    if (!seedAffix) {
      continue;
    }

    affixMap[otherId] = {
      id: otherId,
      name: family === ELEMENTAL_DAMAGE_FAMILY ? "Elemental Damage (Other)" : "Specific Resistance (Other)",
      categories: Array.isArray(seedAffix.categories) ? [...seedAffix.categories] : [],
      gearSlots: Array.isArray(seedAffix.gearSlots) ? [...seedAffix.gearSlots] : null,
      family,
      rollWeight: 1,
    };
  }

  const impossibleTargetFamilyReason = getImpossibleTargetFamilyReason(targetCounts, affixMap);

  return {
    affixMap,
    gearSlots,
    classes,
    categoryNames,
    categoryAffixes,
    categoryAffixesBySlot,
    categoryAffixesBySlotByClass,
    categoryWeightTotals,
    categoryWeightTotalsBySlot,
    categoryWeightTotalsBySlotByClass,
    targetAffixSet: new Set(data.targetAffixIds || []),
    gaRequiredCounts,
    sourceGACounts,
    impossibleTargetGAReason: impossibleTargetFamilyReason,
    validActionsCache: new Map(),
    eligibleByCategoryCache: new Map(),
    actionOutcomeCache: new Map(),
    actionHintCache: new Map(),
    analyticalStateEstimateCache: new Map(),
    rolloutStateScoreCache: new Map(),
    rolloutActionCache: new Map(),
    exactStateSummaryCache: new Map(),
    wantedByFamily,
    familyOtherId,
    strictMode: !!(gaConfig && gaConfig.strictMode),
    rulesEnabled: !gaConfig || gaConfig.rulesEnabled !== false,
    targetCounts,
  };
}

function getStateGearSlot(state) {
  return (state && state.gearSlot) || DEFAULT_GEAR_SLOT;
}

function getStateClass(state) {
  return (state && state.class) || DEFAULT_CLASS;
}

function affixSupportsGearSlot(affix, gearSlot) {
  if (!affix) {
    return false;
  }

  if (!gearSlot || gearSlot === DEFAULT_GEAR_SLOT) {
    return true;
  }

  const legalSlots = Array.isArray(affix.gearSlots) ? affix.gearSlots : null;
  if (!legalSlots || legalSlots.length === 0) {
    return true;
  }

  return legalSlots.includes(DEFAULT_GEAR_SLOT) || legalSlots.includes(gearSlot);
}

function affixSupportsClass(affix, className) {
  if (!affix) {
    return false;
  }
  if (!className || className === DEFAULT_CLASS) {
    return true;
  }
  const affixClass = affix.class;
  if (!affixClass || affixClass === DEFAULT_CLASS) {
    return true;
  }
  return affixClass === className;
}

function getCategoryAffixesForState(state, env, categoryName, operationType) {
  const gearSlot = getStateGearSlot(state);
  const className = getStateClass(state);

  let base = null;

  const bySlotByClass = env.categoryAffixesBySlotByClass
    && env.categoryAffixesBySlotByClass[gearSlot]
    && env.categoryAffixesBySlotByClass[gearSlot][className];
  if (bySlotByClass && Array.isArray(bySlotByClass[categoryName])) {
    base = bySlotByClass[categoryName];
  } else if (gearSlot === DEFAULT_GEAR_SLOT && className === DEFAULT_CLASS) {
    base = env.categoryAffixes[categoryName] || [];
  } else {
    const bySlot = env.categoryAffixesBySlot && env.categoryAffixesBySlot[gearSlot];
    const slotBase = bySlot && Array.isArray(bySlot[categoryName])
      ? bySlot[categoryName]
      : (env.categoryAffixes[categoryName] || []).filter((affix) => affixSupportsGearSlot(affix, gearSlot));
    base = slotBase.filter((affix) => affixSupportsClass(affix, className));
  }

  if (!operationType) {
    return base;
  }
  return base.filter((affix) => getAffixCategoriesForOp(affix, operationType).includes(categoryName));
}

/**
 * Deserialize and normalise a previously-serialized MCTS tree (e.g. from a
 * prior run's `result.tree`).  All numeric fields are coerced; missing fields
 * are filled with defaults.  Returns an empty tree if input is falsy.
 *
 * @param {Object|null} tree - Serialized tree, or null.
 * @returns {{ rootKey: string|null, nodes: Object }}
 */
function normalizeTree(tree) {
  if (!tree || typeof tree !== "object") {
    return { rootKey: null, nodes: Object.create(null) };
  }

  const nodes = Object.create(null);
  if (tree.nodes && typeof tree.nodes === "object") {
    for (const [key, node] of Object.entries(tree.nodes)) {
      nodes[key] = {
        state: node.state ? cloneState(node.state) : null,
        visits: Number(node.visits) || 0,
        actions: node.actions && typeof node.actions === "object" ? node.actions : Object.create(null),
      };
      for (const [actionKey, actionStats] of Object.entries(nodes[key].actions)) {
        nodes[key].actions[actionKey] = normalizeActionStats(actionStats);
      }
    }
  }

  return {
    rootKey: tree.rootKey || null,
    nodes,
  };
}

/**
 * Normalise a single action-stats object, handling both the current schema
 * and the legacy schema (pre-`successMass`/`weightedSteps` fields).
 *
 * @param {Object} stats - Raw action stats from a serialized tree.
 * @returns {Object} Normalised stats.
 */
function normalizeActionStats(stats) {
  const legacySuccesses = Number(stats.successes) || 0;
  return {
    action: stats.action || null,
    visits: Number(stats.visits) || 0,
    totalScore: Number(stats.totalScore) || 0,
    totalCubeStepsAll: Number(stats.totalCubeStepsAll) || 0,
    successMass: Number.isFinite(Number(stats.successMass))
      ? Number(stats.successMass)
      : legacySuccesses,
    weightedSteps: Number.isFinite(Number(stats.weightedSteps))
      ? Number(stats.weightedSteps)
      : (Number(stats.totalCubeStepsOnSuccess) || 0),
    weightedStepsSq: Number.isFinite(Number(stats.weightedStepsSq))
      ? Number(stats.weightedStepsSq)
      : (Number(stats.totalCubeStepsSqOnSuccess) || 0),
    outcomeVisits: stats.outcomeVisits && typeof stats.outcomeVisits === "object"
      ? stats.outcomeVisits
      : Object.create(null),
  };
}

/**
 * Allocate a fresh MCTS tree node for the given state.
 *
 * @param {Object} state - Item state.
 * @returns {{ state: Object, visits: number, actions: Object }}
 */
function createNode(state) {
  return {
    state: cloneState(state),
    visits: 0,
    actions: Object.create(null),
  };
}

/**
 * Compute a canonical string key for a state, used as the MCTS node ID.
 * Two states that are equivalent in every meaningful way produce the same key.
 *
 * @param {Object} state
 * @returns {string}
 */
function stateKey(state) {
  const tokens = state.affixes
    .map((entry) => `${entry.affixId}|${entry.isGA ? 1 : 0}|${entry.isEnchanted ? 1 : 0}`);
  return [
    `L${state.isLegendary ? 1 : 0}`,
    `S${state.gearSlot || "any"}`,
    `C${state.class || DEFAULT_CLASS}`,
    tokens.join(","),
  ].join("#");
}

/**
 * Deep-clone a state object (shallow-clone the affixes array entries).
 *
 * @param {Object} state
 * @returns {Object} Cloned state.
 */
function cloneState(state) {
  return {
    isLegendary: !!state.isLegendary,
    gearSlot: state.gearSlot || "Any",
    class: state.class || DEFAULT_CLASS,
    affixes: (state.affixes || []).map((entry) => ({
      affixId: entry.affixId,
      isGA: !!entry.isGA,
      isEnchanted: !!entry.isEnchanted,
    })),
  };
}

/**
 * Count occurrences of each affixId in an affixes array, with an optional
 * predicate filter.
 *
 * @param {Array}    affixes
 * @param {Function} [filterFn] - If provided, only matching entries are counted.
 * @returns {Object} Map of affixId → count.
 */
function getAffixCounts(affixes, filterFn) {
  const counts = Object.create(null);
  for (const affix of affixes) {
    if (filterFn && !filterFn(affix)) {
      continue;
    }
    counts[affix.affixId] = (counts[affix.affixId] || 0) + 1;
  }
  return counts;
}

/**
 * Returns true if `entry` is a GA slot that the target explicitly requires.
 * In strict mode these entries cannot be targeted by risky actions.
 *
 * @param {Object} entry - Affix entry { affixId, isGA, isEnchanted }.
 * @param {Object} env
 * @returns {boolean}
 */
function isProtectedGA(entry, env) {
  if (!entry || !entry.isGA) {
    return false;
  }
  return (env.gaRequiredCounts[entry.affixId] || 0) > 0;
}

/**
 * Determine whether the search has reached a terminal state.
 * A state is terminal if all target affixes are present (and GA-satisfied)
 * **or** if it has permanently broken a required GA constraint.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {{ terminal: boolean, success: boolean }}
 */
function isTerminal(state, target, env) {
  if (breaksRequiredGA(state, env)) {
    return { terminal: true, success: false };
  }

  const stateCounts = getAffixCounts(state.affixes);
  for (const requirement of target.affixes) {
    if (!stateCounts[requirement.affixId]) {
      return { terminal: false, success: false };
    }
  }

  return { terminal: true, success: true };
}

/**
 * Returns true if `state` has lost a GA that was required by the target.
 * This is a permanent failure condition — once a required GA is gone, the
 * scenario is unsolvable (without sacrificing a new item).
 *
 * @param {Object} state
 * @param {Object} env
 * @returns {boolean}
 */
function breaksRequiredGA(state, env) {
  if (!env.gaRequiredCounts || Object.keys(env.gaRequiredCounts).length === 0) {
    return false;
  }

  const stateGACounts = getAffixCounts(state.affixes, (entry) => entry.isGA);
  for (const [affixId, required] of Object.entries(env.gaRequiredCounts)) {
    const hasCount = stateGACounts[affixId] || 0;
    if (hasCount < required) {
      return true;
    }
  }

  return false;
}

/**
 * Produce a deterministic string key for an action object.
 * Used as a map key for per-action MCTS statistics.
 *
 * @param {{ type: string, prism?: string, sourceIndex?: number, targetAffixId?: string }} action
 * @returns {string}
 */
function actionKey(action) {
  const source = Number.isInteger(action.sourceIndex) ? action.sourceIndex : "_";
  const target = action.targetAffixId || "_";
  const prism = action.prism || "_";
  return `${action.type}|${prism}|${source}|${target}`;
}

/**
 * Return all legal Horadric Cube actions from `state` toward `target`.
 * The list is pruned to exclude dominated moves (e.g. re-adding an affix
 * that is already present at the required count) to keep the branching
 * factor tractable.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {Array<Object>} Array of action objects.
 */
function getValidActions(state, target, env) {
  const cacheKey = stateKey(state);
  if (env.validActionsCache && env.validActionsCache.has(cacheKey)) {
    return env.validActionsCache.get(cacheKey);
  }

  const actions = [];

  for (const categoryName of env.categoryNames) {
    if (state.affixes.length < 4) {
      actions.push({ type: "add", prism: categoryName });
    }

    const eligibleRemove = getEligibleByCategory(state, env, categoryName, "remove");
    if (!state.isLegendary && eligibleRemove.length > 0) {
      const touchesGA = env.strictMode && eligibleRemove.some(({ entry }) => isProtectedGA(entry, env));
      if (!touchesGA) {
        actions.push({ type: "remove", prism: categoryName });
      }
    }

    const eligibleChaotic = getEligibleByCategory(state, env, categoryName, "chaotic");
    if (eligibleChaotic.length > 0) {
      const touchesGA = env.strictMode && eligibleChaotic.some(({ entry }) => isProtectedGA(entry, env));
      if (!touchesGA) {
        actions.push({ type: "chaotic", prism: categoryName });
      }
    }

    const eligibleFocused = getEligibleByCategory(state, env, categoryName, "focused");
    if (eligibleFocused.length > 0) {
      const touchesGA = env.strictMode && eligibleFocused.some(({ entry }) => isProtectedGA(entry, env));
      if (!touchesGA) {
        actions.push({ type: "focused", prism: categoryName });
      }
    }
  }

  // Enchant action generation.
  //
  // Rules (see docs/game-mechanics.md):
  //   * Each item has at most one "enchanted" slot, sticky for its lifetime.
  //   * If a slot is already enchanted: the only legal enchant source is that
  //     same slot, and only when it is not GA (changing a GA slot's affix
  //     would destroy the GA; keeping it the same would be a no-op).
  //   * If no slot is enchanted yet: any non-empty slot can be the source.
  //     Enchanting to the same affix preserves GA (Phase-1 mark only);
  //     enchanting to a different affix loses GA (combined Phase 1+2).
  //   * The new affix can never duplicate another slot's affixId.
  //
  // We further prune the enchant target candidates down to "useful" ones:
  // currently-missing target affixes, plus the source's own affix when that
  // source slot is unsatisfactory (a re-enchant to the same affix wipes the
  // unsatisfactory marker). For fresh enchant, the source's own affix is
  // also included as the GA-preserve "Phase-1 mark" move. Enchanting from
  // one already-satisfied target affix to another already-satisfied target
  // affix would just shuffle coverage between slots and is never strictly
  // useful in this lexicographic objective — pruning these candidates
  // prevents otherwise-explosive enchant cycles in the value iteration
  // without losing any optimal policy.
  const targetIds = new Set(target.affixes.map((entry) => entry.affixId).filter(Boolean));
  const currentAffixIds = new Set();
  for (const entry of state.affixes) {
    if (entry && entry.affixId) {
      currentAffixIds.add(entry.affixId);
    }
  }
  const unsatisfactoryIds = new Set(
    Array.isArray(state.unsatisfactoryAffixIds) ? state.unsatisfactoryAffixIds : []
  );
  const enchantedIndex = state.affixes.findIndex((entry) => entry.isEnchanted);

  function buildEnchantTargetCandidates(sourceEntry, includeSameAffix) {
    const candidates = new Set();
    for (const tid of targetIds) {
      if (!currentAffixIds.has(tid) || unsatisfactoryIds.has(tid)) {
        candidates.add(tid);
      }
    }
    if (includeSameAffix && sourceEntry.affixId) {
      candidates.add(sourceEntry.affixId);
    }
    return candidates;
  }

  function pushEnchantActionsForSlot(sourceIndex, sourceEntry, includeSameAffix) {
    const otherAffixIds = new Set();
    state.affixes.forEach((other, idx) => {
      if (idx !== sourceIndex && other.affixId) {
        otherAffixIds.add(other.affixId);
      }
    });
    // If the source already holds a target affix that is satisfactorily
    // present, enchant-changing it would only swap one missing target for
    // another (the source target becomes missing, the destination satisfied)
    // — never net progress in this lexicographic objective. Drop the
    // change-action class entirely for such sources, keeping only the
    // same-affix Phase-1 mark when allowed.
    const sourceInTarget = sourceEntry && sourceEntry.affixId && targetIds.has(sourceEntry.affixId);
    const sourceUnsatisfactory = sourceEntry && unsatisfactoryIds.has(sourceEntry.affixId);
    const allowChangeFromThisSource = !sourceInTarget || sourceUnsatisfactory;
    for (const targetAffixId of buildEnchantTargetCandidates(sourceEntry, includeSameAffix)) {
      if (otherAffixIds.has(targetAffixId)) {
        continue;
      }
      if (!allowChangeFromThisSource && targetAffixId !== sourceEntry.affixId) {
        continue;
      }
      if (env.strictMode && isProtectedGA(sourceEntry, env) && targetAffixId !== sourceEntry.affixId) {
        continue;
      }
      actions.push({
        type: "enchant",
        sourceIndex,
        targetAffixId,
      });
    }
  }

  if (enchantedIndex >= 0) {
    const enchantedEntry = state.affixes[enchantedIndex];
    if (enchantedEntry.affixId && !enchantedEntry.isGA) {
      // Re-enchant: same-affix is a no-op unless this slot is unsatisfactory
      // (in which case the same-affix re-enchant clears the unsatisfactory
      // marker). buildEnchantTargetCandidates handles that case.
      const includeSame = unsatisfactoryIds.has(enchantedEntry.affixId);
      pushEnchantActionsForSlot(enchantedIndex, enchantedEntry, includeSame);
    }
  } else {
    state.affixes.forEach((entry, index) => {
      if (!entry.affixId) {
        return;
      }
      // Fresh enchant: include same-affix as a legitimate Phase-1-only mark
      // (preserves GA, locks the slot from cube ops).
      pushEnchantActionsForSlot(index, entry, true);
    });
  }

  if (env.validActionsCache) {
    env.validActionsCache.set(cacheKey, actions);
  }

  return actions;
}

/**
 * Explain why the current state has no available actions.
 * In strict mode we distinguish "no safe action" from a truly actionless state.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {string}
 */
function getNoValidActionReason(state, target, env) {
  if (env && env.impossibleTargetGAReason) {
    return env.impossibleTargetGAReason;
  }

  if (env && env.strictMode) {
    const flexibleActions = getValidActions(state, target, {
      ...env,
      strictMode: false,
      validActionsCache: null,
    });
    if (Array.isArray(flexibleActions) && flexibleActions.length > 0) {
      return "No safe action preserves all required GAs from the current state. Disable Target GA Strict to inspect risky alternatives.";
    }
  }

  return "No actions from current state";
}

/**
 * Return an array of affix IDs that appear in `targetCounts` but are missing
 * (or under-counted) in `state`.  Duplicates are included — one entry per
 * missing instance.
 *
 * @param {Object} state
 * @param {Object} targetCounts - Map of affixId → required count.
 * @returns {string[]}
 */
function getMissingTargetAffixIds(state, targetCounts) {
  const stateCounts = getAffixCounts(state.affixes);
  const missing = [];

  for (const [affixId, requiredCount] of Object.entries(targetCounts || {})) {
    const have = stateCounts[affixId] || 0;
    const missingCount = Math.max(0, requiredCount - have);
    for (let i = 0; i < missingCount; i += 1) {
      missing.push(affixId);
    }
  }

  return missing;
}

/**
 * Find the best action in `validActions` that can add `affixId` to `state`.
 * "Best" means highest direct hit probability; ties broken alphabetically by
 * action key to ensure determinism.
 *
 * @param {Object}        state
 * @param {Array<Object>} validActions
 * @param {Object}        env
 * @param {string}        affixId - Target affix to add.
 * @returns {{ action: Object, hitProbability: number }|null}
 */
function getBestAddActionForAffix(state, validActions, env, affixId) {
  let best = null;

  for (const action of validActions) {
    if (!action || action.type !== "add") {
      continue;
    }

    const outcomes = getActionOutcomes(state, action, env);

    if (outcomes.length === 0) {
      continue;
    }

    let hitProbability = 0;
    for (const outcome of outcomes) {
      const diff = diffAffixCounts(state, outcome.state);
      if (diff.added.includes(affixId)) {
        hitProbability += outcome.probability;
      }
    }

    if (hitProbability <= 0) {
      continue;
    }

    if (!best || hitProbability > best.hitProbability + 1e-12) {
      best = { action, hitProbability };
      continue;
    }

    if (best && Math.abs(hitProbability - best.hitProbability) <= 1e-12) {
      if (actionKey(action).localeCompare(actionKey(best.action)) < 0) {
        best = { action, hitProbability };
      }
    }
  }

  return best;
}

/**
 * Rule-based shortcut that bypasses MCTS for provably-optimal decisions.
 * When a rule fires with `successProb >= RULE_SUCCESS_THRESHOLD` the caller
 * should take that action without running further search.
 *
 * Covers: single remaining action, guaranteed-add, guaranteed success chain.
 *
 * @param {Object}        state
 * @param {Object}        target
 * @param {Object}        env
 * @param {Array<Object>} validActions - Pre-computed valid actions for `state`.
 * @returns {{ action: Object, rule: string, reason: string }|null}
 */
function resolveRuleAction(state, target, env, validActions) {
  if (!env || env.rulesEnabled === false) {
    return null;
  }

  if (!Array.isArray(validActions) || validActions.length === 0) {
    return null;
  }

  const terminal = isTerminal(state, target, env);
  if (terminal.terminal) {
    return null;
  }

  if (validActions.length === 1) {
    return {
      action: validActions[0],
      rule: "single-action",
      reason: "Only one valid action is available.",
    };
  }

  const targetCounts = env.targetCounts || getTargetCountsFromTarget(target);
  const missingIds = getMissingTargetAffixIds(state, targetCounts);
  if (missingIds.length === 1) {
    const missingAffixId = missingIds[0];
    const bestAdd = getBestAddActionForAffix(state, validActions, env, missingAffixId);
    if (bestAdd && bestAdd.hitProbability >= RULE_SUCCESS_THRESHOLD) {
      return {
        action: bestAdd.action,
        rule: "direct-add-guaranteed",
        reason: `Guaranteed add path for ${affixName(missingAffixId, env)}.`,
      };
    }

    if (bestAdd) {
      return {
        action: bestAdd.action,
        rule: "single-missing-add",
        reason: `Single missing target affix: maximize hit chance for ${affixName(missingAffixId, env)}.`,
      };
    }
  }

  const guaranteed = [];
  for (const action of validActions) {
    const successHint = immediateSuccessHint(state, action, env, target);
    if (successHint < RULE_SUCCESS_THRESHOLD) {
      continue;
    }

    guaranteed.push({
      action,
      expectedSteps: immediateStepHint(state, action, env, target),
    });
  }

  if (guaranteed.length > 0) {
    guaranteed.sort((left, right) => {
      const leftSteps = Number.isFinite(left.expectedSteps) ? left.expectedSteps : Infinity;
      const rightSteps = Number.isFinite(right.expectedSteps) ? right.expectedSteps : Infinity;
      if (Math.abs(leftSteps - rightSteps) > 1e-9) {
        return leftSteps - rightSteps;
      }
      return actionKey(left.action).localeCompare(actionKey(right.action));
    });

    const chosen = guaranteed[0];
    return {
      action: chosen.action,
      rule: "guaranteed-success-chain",
      reason: `Guaranteed success chain with estimated ${chosen.expectedSteps.toFixed(2)} steps.`,
    };
  }

  return null;
}

/**
 * Return the operation-appropriate category list for an affix.
 * When the affix has `operationCategories[operationType]`, that list is returned.
 * Otherwise falls back to `affix.categories` so fixtures without overrides are unaffected.
 *
 * @param {Object|null} affix - Catalogue entry.
 * @param {string|null} operationType - "add" | "focused" | "chaotic" | "remove" | null.
 * @returns {string[]}
 */
function getAffixCategoriesForOp(affix, operationType) {
  if (
    affix
    && operationType
    && affix.operationCategories
    && Array.isArray(affix.operationCategories[operationType])
  ) {
    return affix.operationCategories[operationType];
  }
  return affix && Array.isArray(affix.categories) ? affix.categories : [];
}

/**
 * Return affix entries from `state` that are eligible for
 * enchant/remove and belong to `categoryName`.
 * Enchanted slots are excluded (they cannot be re-enchanted).
 *
 * @param {Object} state
 * @param {Object} env
 * @param {string} categoryName
 * @param {string|null} [operationType] - "add" | "focused" | "chaotic" | "remove" | null.
 * @returns {Array<{ entry: Object, index: number }>}
 */
function getEligibleByCategory(state, env, categoryName, operationType) {
  const cacheKey = `${stateKey(state)}|${categoryName}|${operationType || ""}`;
  if (env.eligibleByCategoryCache && env.eligibleByCategoryCache.has(cacheKey)) {
    return env.eligibleByCategoryCache.get(cacheKey);
  }

  const eligible = state.affixes
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (entry.isEnchanted) {
        return false;
      }
      const affix = env.affixMap[entry.affixId];
      return affix && getAffixCategoriesForOp(affix, operationType).includes(categoryName);
    });

  if (env.eligibleByCategoryCache) {
    env.eligibleByCategoryCache.set(cacheKey, eligible);
  }

  return eligible;
}

/**
 * Return the roll weight for an affix catalogue entry.
 * Defaults to 1 if the weight is missing, non-finite, or ≤0.
 *
 * @param {Object} affix - Catalogue entry with optional `rollWeight` field.
 * @returns {number}
 */
function getAffixRollWeight(affix) {
  const weight = Number(affix && affix.rollWeight);
  if (!Number.isFinite(weight) || weight <= 0) {
    return 1;
  }
  return weight;
}

/**
 * Count family members in a pool (affixes that carry a non-empty `family`).
 * Returns Map<family, count>.
 */
function buildFamilyCountsForPool(pool) {
  const counts = new Map();
  for (const affix of pool) {
    const family = affix && affix.family ? affix.family : "";
    if (!family) {
      continue;
    }
    counts.set(family, (counts.get(family) || 0) + 1);
  }
  return counts;
}

/**
 * Effective roll weight for `affix` within the given pool.
 *
 * Family-level rolling: when an affix carries `familyRollWeight`, the family
 * contributes a single normalized weight (familyRollWeight) regardless of how
 * many members are present, and each member is equally likely within the
 * family.  Per-member effective weight = familyRollWeight / count-in-pool.
 *
 * Affixes without `familyRollWeight` fall back to their static `rollWeight`,
 * preserving the existing per-subtype weighting used by Elemental Damage and
 * Specific Resistance families.
 */
function getEffectiveAffixRollWeight(affix, familyCounts) {
  const familyRollWeight = Number(affix && affix.familyRollWeight);
  if (Number.isFinite(familyRollWeight) && familyRollWeight > 0 && affix.family) {
    const count = familyCounts ? (familyCounts.get(affix.family) || 0) : 0;
    if (count > 0) {
      return familyRollWeight / count;
    }
  }
  return getAffixRollWeight(affix);
}

/**
 * Sum effective roll weights of all affixes in a pool, accounting for
 * family-level normalization.
 */
function sumEffectiveWeights(pool) {
  const familyCounts = buildFamilyCountsForPool(pool);
  let total = 0;
  for (const affix of pool) {
    total += getEffectiveAffixRollWeight(affix, familyCounts);
  }
  return total;
}

/**
 * Sum the roll weights of all affixes in `categoryName`.
 *
 * @param {Object} env
 * @param {string} categoryName
 * @returns {number}
 */
function getCategoryWeightTotal(state, env, categoryName, operationType) {
  if (!operationType) {
    const gearSlot = getStateGearSlot(state);
    const className = getStateClass(state);

    const bySlotByClass = env.categoryWeightTotalsBySlotByClass
      && env.categoryWeightTotalsBySlotByClass[gearSlot]
      && env.categoryWeightTotalsBySlotByClass[gearSlot][className];
    if (bySlotByClass && Number.isFinite(bySlotByClass[categoryName])) {
      return bySlotByClass[categoryName];
    }

    if (gearSlot === DEFAULT_GEAR_SLOT && className === DEFAULT_CLASS) {
      return env.categoryWeightTotals[categoryName] || 0;
    }

    const bySlot = env.categoryWeightTotalsBySlot && env.categoryWeightTotalsBySlot[gearSlot];
    if (bySlot && Number.isFinite(bySlot[categoryName]) && className === DEFAULT_CLASS) {
      return bySlot[categoryName];
    }
  }

  return sumEffectiveWeights(
    getCategoryAffixesForState(state, env, categoryName, operationType)
  );
}

/**
 * Compute the probability-weighted outcome distribution for `action` from
 * `state`.  Each outcome is `{ state, probability }`.
 * Outcomes with the same resulting state are merged.
 *
 * @param {Object} state
 * @param {Object} action
 * @param {Object} env
 * @returns {Array<{ state: Object, probability: number }>}
 */
function getActionOutcomes(state, action, env) {
  const cacheKey = `${stateKey(state)}|${actionKey(action)}`;
  if (env.actionOutcomeCache && env.actionOutcomeCache.has(cacheKey)) {
    return env.actionOutcomeCache.get(cacheKey);
  }

  const outcomes = [];

  if (action.type === "add") {
    const list = getCategoryAffixesForState(state, env, action.prism, "add");
    if (list.length === 0 || state.affixes.length >= 4) {
      return [];
    }

    const totalWeight = getCategoryWeightTotal(state, env, action.prism, "add");
    if (totalWeight <= 0) {
      return [];
    }

    const familyCounts = buildFamilyCountsForPool(list);
    for (const affix of list) {
      const p = getEffectiveAffixRollWeight(affix, familyCounts) / totalWeight;
      const next = cloneState(state);
      next.affixes.push({
        affixId: canonicalizeAffixIdForState(affix.id, env),
        isGA: false,
        isEnchanted: false,
      });
      if (violatesFamilyUniqueness(next, env)) {
        continue;
      }
      outcomes.push({ probability: p, state: next });
    }
    const merged = mergeOutcomes(outcomes);
    if (env.actionOutcomeCache) {
      env.actionOutcomeCache.set(cacheKey, merged);
    }
    return merged;
  }

  if (action.type === "remove") {
    if (state.isLegendary) {
      return [];
    }
    const eligible = getEligibleByCategory(state, env, action.prism, "remove");
    if (eligible.length === 0) {
      return [];
    }

    const p = 1 / eligible.length;
    for (const { index } of eligible) {
      const next = cloneState(state);
      next.affixes.splice(index, 1);
      outcomes.push({ probability: p, state: next });
    }
    const merged = mergeOutcomes(outcomes);
    if (env.actionOutcomeCache) {
      env.actionOutcomeCache.set(cacheKey, merged);
    }
    return merged;
  }

  if (action.type === "focused") {
    const eligible = getEligibleByCategory(state, env, action.prism, "focused");
    if (eligible.length === 0) {
      return [];
    }

    const list = getCategoryAffixesForState(state, env, action.prism, "focused");
    if (list.length === 0) {
      return [];
    }

    const sourceP = 1 / eligible.length;
    const totalWeight = getCategoryWeightTotal(state, env, action.prism, "focused");
    if (totalWeight <= 0) {
      return [];
    }

    const familyCounts = buildFamilyCountsForPool(list);
    for (const { index } of eligible) {
      for (const affix of list) {
        const affixP = getEffectiveAffixRollWeight(affix, familyCounts) / totalWeight;
        const next = cloneState(state);
        next.affixes[index] = {
          affixId: canonicalizeAffixIdForState(affix.id, env),
          isGA: false,
          isEnchanted: false,
        };
        if (violatesFamilyUniqueness(next, env)) {
          continue;
        }
        outcomes.push({ probability: sourceP * affixP, state: next });
      }
    }
    const merged = mergeOutcomes(outcomes);
    if (env.actionOutcomeCache) {
      env.actionOutcomeCache.set(cacheKey, merged);
    }
    return merged;
  }

  if (action.type === "chaotic") {
    const eligible = getEligibleByCategory(state, env, action.prism, "chaotic");
    if (eligible.length === 0) {
      return [];
    }

    const sourceP = 1 / eligible.length;
    const categoryP = env.categoryNames.length > 0 ? (1 / env.categoryNames.length) : 0;
    if (categoryP === 0) {
      return [];
    }

    for (const { index } of eligible) {
      for (const categoryName of env.categoryNames) {
        const list = getCategoryAffixesForState(state, env, categoryName, "chaotic");
        if (list.length === 0) {
          continue;
        }

        const totalWeight = getCategoryWeightTotal(state, env, categoryName, "chaotic");
        if (totalWeight <= 0) {
          continue;
        }

        const familyCounts = buildFamilyCountsForPool(list);
        for (const affix of list) {
          const affixP = getEffectiveAffixRollWeight(affix, familyCounts) / totalWeight;
          const next = cloneState(state);
          next.affixes[index] = {
            affixId: canonicalizeAffixIdForState(affix.id, env),
            isGA: false,
            isEnchanted: false,
          };
          if (violatesFamilyUniqueness(next, env)) {
            continue;
          }
          outcomes.push({ probability: sourceP * categoryP * affixP, state: next });
        }
      }
    }

    const merged = mergeOutcomes(outcomes);
    if (env.actionOutcomeCache) {
      env.actionOutcomeCache.set(cacheKey, merged);
    }
    return merged;
  }

  if (action.type === "enchant") {
    if (!Number.isInteger(action.sourceIndex) || action.sourceIndex < 0 || action.sourceIndex >= state.affixes.length) {
      return [];
    }
    if (!action.targetAffixId || !env.affixMap[action.targetAffixId]) {
      return [];
    }

    const source = state.affixes[action.sourceIndex];
    if (!source || !source.affixId) {
      return [];
    }

    // Sticky enchanted-slot constraint: if another slot is already enchanted,
    // the source must be that slot. Re-enchant on an enchanted+GA slot is
    // disallowed (different-affix would destroy the GA; same-affix is a no-op).
    const enchantedIndex = state.affixes.findIndex((entry) => entry.isEnchanted);
    if (enchantedIndex >= 0 && enchantedIndex !== action.sourceIndex) {
      return [];
    }
    if (source.isEnchanted && source.isGA) {
      return [];
    }

    // No-duplicate-affix constraint: only enforced when the affix actually changes.
    if (action.targetAffixId !== source.affixId) {
      const dupe = state.affixes.some((entry, idx) => (
        idx !== action.sourceIndex && entry.affixId === action.targetAffixId
      ));
      if (dupe) {
        return [];
      }
    }

    const next = cloneState(state);
    next.affixes[action.sourceIndex] = {
      affixId: canonicalizeAffixIdForState(action.targetAffixId, env),
      isGA: action.targetAffixId === source.affixId ? !!source.isGA : false,
      isEnchanted: true,
    };

    if (violatesFamilyUniqueness(next, env)) {
      return [];
    }

    const direct = [{ probability: 1, state: next }];
    if (env.actionOutcomeCache) {
      env.actionOutcomeCache.set(cacheKey, direct);
    }
    return direct;
  }

  return [];
}

/**
 * Merge outcomes that share the same state key by summing their probabilities.
 *
 * @param {Array<{ state: Object, probability: number }>} outcomes
 * @returns {Array<{ state: Object, probability: number }>}
 */
function mergeOutcomes(outcomes) {
  const merged = Object.create(null);
  let total = 0;

  for (const outcome of outcomes) {
    if (!outcome || !Number.isFinite(outcome.probability) || outcome.probability <= 0) {
      continue;
    }

    const key = stateKey(outcome.state);
    if (!merged[key]) {
      merged[key] = { probability: 0, state: outcome.state };
    }
    merged[key].probability += outcome.probability;
    total += outcome.probability;
  }

  if (total <= 0) {
    return [];
  }

  return Object.values(merged).map((entry) => ({
    probability: entry.probability / total,
    state: entry.state,
  }));
}

/**
 * Returns true if `action` is a Cube (transmute) action that costs one step.
 * Non-cube actions (e.g. enchant via Occultist) cost no steps in this model.
 *
 * @param {{ type: string }} action
 * @returns {boolean}
 */
function isCubeAction(action) {
  return action.type === "add" || action.type === "remove" || action.type === "chaotic" || action.type === "focused";
}

// Tie-break cost charged to re-enchant actions (enchanting a slot that is
// already enchanted) in the SSP value iteration. Fresh enchants cost 0 per
// the game model. Re-enchant introduces the possibility of 0-cost cycles
// (enchant slot to affix A, then back to B, then back to A, forever) which
// trap Bellman value iteration at a degenerate fixed point with apparent
// expected steps = 0. A small positive cost per re-enchant guarantees the
// optimal policy terminates, while staying small enough to be invisible in
// the UI's two-decimal display for any plausible number of re-enchants.
const RE_ENCHANT_TIE_BREAK_COST = 0.5;

function actionCost(action, state) {
  if (isCubeAction(action)) {
    return 1;
  }
  if (action && action.type === "enchant" && state && Array.isArray(state.affixes)) {
    const source = state.affixes[action.sourceIndex];
    if (source && source.isEnchanted) {
      return RE_ENCHANT_TIE_BREAK_COST;
    }
  }
  return 0;
}

/**
 * Core MCTS traversal.  Descends the tree with UCB1 selection until a leaf
 * node is reached, then expands it with rollouts, and back-propagates.
 *
 * At `depthLimit <= 0` the function is a leaf estimator: it calls
 * `env.scorer` if available, otherwise falls back to the built-in heuristics.
 *
 * @param {Object} tree         - MCTS tree { rootKey, nodes }.
 * @param {string} nodeKey      - Key of the node to start from.
 * @param {Object} env          - Runtime environment (may have `env.scorer`).
 * @param {Object} target
 * @param {number} depthLimit   - Remaining recursive depth budget.
 * @param {number} rolloutDepthLimit
 * @param {number} rolloutCount - Number of rollout episodes per leaf.
 * @returns {{ cubeSteps: number, successProb: number }}
 */
function simulateFromNode(tree, nodeKey, env, target, depthLimit, rolloutDepthLimit, rolloutCount) {
  const node = tree.nodes[nodeKey];
  if (!node) {
    return { cubeSteps: 35, successProb: 0 };
  }

  const terminal = isTerminal(node.state, target, env);
  if (terminal.terminal) {
    return {
      cubeSteps: 0,
      successProb: terminal.success ? 1 : 0,
    };
  }

  if (depthLimit <= 0) {
    if (env.scorer) {
      const s = env.scorer(node.state);
      return {
        cubeSteps: (s.expectedSteps != null && Number.isFinite(s.expectedSteps))
          ? s.expectedSteps
          : heuristicRemainingSteps(node.state, target, env),
        successProb: s.successProb,
      };
    }
    const estimate = getAnalyticalStateEstimate(node.state, target, env);
    return {
      cubeSteps: estimate.expectedSteps,
      successProb: estimate.successProb,
    };
  }

  node.visits += 1;

  const validActions = getValidActions(node.state, target, env);
  if (validActions.length === 0) {
    return {
      cubeSteps: 35,
      successProb: 0,
    };
  }

  const validKeys = new Set(validActions.map((action) => actionKey(action)));
  for (const existingKey of Object.keys(node.actions)) {
    if (!validKeys.has(existingKey)) {
      delete node.actions[existingKey];
    }
  }

  for (const action of validActions) {
    const key = actionKey(action);
    if (!node.actions[key]) {
      node.actions[key] = {
        action,
        visits: 0,
        totalScore: 0,
        totalCubeStepsAll: 0,
        successMass: 0,
        weightedSteps: 0,
        weightedStepsSq: 0,
        outcomeVisits: Object.create(null),
      };
    }
  }

  const ruleDecision = resolveRuleAction(node.state, target, env, validActions);
  let chosenActionStats = null;
  if (ruleDecision && ruleDecision.action) {
    chosenActionStats = node.actions[actionKey(ruleDecision.action)] || null;
  }

  if (!chosenActionStats) {
    chosenActionStats = chooseAction(node, nodeKey === tree.rootKey, env, target);
  }

  const chosenAction = chosenActionStats.action;
  const outcomes = getActionOutcomes(node.state, chosenAction, env);

  if (outcomes.length === 0) {
    chosenActionStats.visits += 1;
    chosenActionStats.totalCubeStepsAll += 35;
    chosenActionStats.totalScore -= 35;
    return { cubeSteps: 35, successProb: 0 };
  }

  const sampled = sampleOutcome(outcomes);
  const childKey = stateKey(sampled.state);

  if (!tree.nodes[childKey]) {
    tree.nodes[childKey] = createNode(sampled.state);
  }

  let downstream;
  if ((chosenActionStats.visits || 0) < 2) {
    downstream = rollout(tree.nodes[childKey].state, env, target, rolloutDepthLimit, rolloutCount);
  } else {
    downstream = simulateFromNode(tree, childKey, env, target, depthLimit - 1, rolloutDepthLimit, rolloutCount);
  }

  const cubeCost = isCubeAction(chosenAction) ? 1 : 0;
  const totalCubeSteps = cubeCost + downstream.cubeSteps;
  const successProb = clampProb(downstream.successProb);
  const score = scoreEpisode(totalCubeSteps, successProb);

  chosenActionStats.visits += 1;
  chosenActionStats.totalCubeStepsAll += totalCubeSteps;
  chosenActionStats.totalScore += score;
  chosenActionStats.successMass += successProb;
  chosenActionStats.weightedSteps += totalCubeSteps * successProb;
  chosenActionStats.weightedStepsSq += totalCubeSteps * totalCubeSteps * successProb;
  chosenActionStats.outcomeVisits[childKey] = (chosenActionStats.outcomeVisits[childKey] || 0) + 1;

  return {
    cubeSteps: totalCubeSteps,
    successProb,
  };
}

/**
 * Run `rolloutCount` random rollouts from `state` and return the mean
 * (cubeSteps, successProb) across all episodes.
 *
 * At the end of each rollout the function calls `env.scorer` if available;
 * otherwise it falls back to the built-in heuristic estimates.
 *
 * @param {Object} state
 * @param {Object} env             - Runtime environment (may have `env.scorer`).
 * @param {Object} target
 * @param {number} depthLimit      - Maximum simulation depth per rollout.
 * @param {number} rolloutCount
 * @returns {{ cubeSteps: number, successProb: number }}
 */
function rollout(state, env, target, depthLimit, rolloutCount) {
  let successProbSum = 0;
  let cubeStepsSum = 0;

  for (let i = 0; i < rolloutCount; i += 1) {
    let cur = cloneState(state);
    let steps = 0;

    for (let depth = 0; depth < depthLimit; depth += 1) {
      const term = isTerminal(cur, target, env);
      if (term.terminal) {
        break;
      }

      const actions = getValidActions(cur, target, env);
      if (actions.length === 0) {
        break;
      }

      const picked = chooseRolloutAction(cur, actions, env, target);
      const outcomes = getActionOutcomes(cur, picked, env);
      if (outcomes.length === 0) {
        break;
      }

      const sampled = sampleOutcome(outcomes);
      if (isCubeAction(picked)) {
        steps += 1;
      }
      cur = sampled.state;
    }

    const finalTerm = isTerminal(cur, target, env);
    let successProb;
    let stepEstimate;

    if (finalTerm.terminal && finalTerm.success) {
      successProb = 1;
      stepEstimate = steps;
    } else if (finalTerm.terminal && !finalTerm.success) {
      successProb = 0;
      stepEstimate = steps + 12;
    } else if (env.scorer) {
      const s = env.scorer(cur);
      successProb = s.successProb;
      stepEstimate = steps + ((s.expectedSteps != null && Number.isFinite(s.expectedSteps))
        ? s.expectedSteps
        : heuristicRemainingSteps(cur, target, env));
    } else {
      const estimate = getAnalyticalStateEstimate(cur, target, env);
      successProb = estimate.successProb;
      stepEstimate = steps + estimate.expectedSteps;
    }

    successProbSum += successProb;
    cubeStepsSum += stepEstimate;
  }

  return {
    cubeSteps: cubeStepsSum / Math.max(1, rolloutCount),
    successProb: successProbSum / Math.max(1, rolloutCount),
  };
}

/**
 * Choose an action for rollout simulation.  With probability `ROLLOUT_EPSILON`
 * picks uniformly at random; otherwise picks the action with the highest
 * expected `rolloutStateScore` across its outcomes.
 *
 * @param {Object}       state
 * @param {Array<Object>} actions
 * @param {Object}       env
 * @param {Object}       target
 * @returns {Object} Chosen action.
 */
function chooseRolloutAction(state, actions, env, target) {
  if (Math.random() < ROLLOUT_EPSILON) {
    return actions[Math.floor(Math.random() * actions.length)];
  }

  const cacheKey = (ROLLOUT_EPSILON <= 0 && env.rolloutActionCache)
    ? stateKey(state)
    : "";
  if (cacheKey && env.rolloutActionCache.has(cacheKey)) {
    return env.rolloutActionCache.get(cacheKey);
  }

  let bestAction = actions[0];
  let bestScore = -Infinity;

  for (const action of actions) {
    const outcomes = getActionOutcomes(state, action, env);
    if (outcomes.length === 0) {
      continue;
    }

    let expected = 0;
    for (const outcome of outcomes) {
      expected += outcome.probability * rolloutStateScore(outcome.state, target, env);
    }

    const actionBias = isCubeAction(action) ? -1 : 0;
    const score = expected + actionBias;
    if (score > bestScore) {
      bestScore = score;
      bestAction = action;
    }
  }

  if (cacheKey) {
    env.rolloutActionCache.set(cacheKey, bestAction);
  }

  return bestAction;
}

/**
 * Composite score combining success probability and expected step count.
 * Used to rank completed MCTS episodes (not direct action selection).
 *
 * @param {number} cubeSteps  - Estimated remaining cube uses.
 * @param {number} successProb - Probability [0,1].
 * @returns {number} Scalar score (higher is better).
 */
function scoreEpisode(cubeSteps, successProb) {
  return (successProb * 130) - ((1 - successProb) * 45) - cubeSteps;
}

/**
 * Clamp a probability value to [0, 1], returning 0 for non-finite inputs.
 *
 * @param {number} value
 * @returns {number}
 */
function clampProb(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Compute both immediate action hints in one pass over the action outcomes.
 * Results are cached per (state, action) for the duration of one run.
 *
 * @param {Object} state
 * @param {Object} action
 * @param {Object} env
 * @param {Object} target
 * @returns {{ successProb: number, expectedSteps: number }}
 */
function getActionHintSummary(state, action, env, target) {
  const cacheKey = `${stateKey(state)}|${actionKey(action)}`;
  if (env.actionHintCache && env.actionHintCache.has(cacheKey)) {
    return env.actionHintCache.get(cacheKey);
  }

  const outcomes = getActionOutcomes(state, action, env);
  if (outcomes.length === 0) {
    const empty = { successProb: 0, expectedSteps: 35 };
    if (env.actionHintCache) {
      env.actionHintCache.set(cacheKey, empty);
    }
    return empty;
  }

  const cubeCost = isCubeAction(action) ? 1 : 0;
  let successProb = 0;
  let successMass = 0;
  let weightedSteps = 0;

  for (const outcome of outcomes) {
    const term = isTerminal(outcome.state, target, env);
    let outcomeSuccessProb;
    let remainingSteps;

    if (term.terminal) {
      outcomeSuccessProb = term.success ? 1 : 0;
      remainingSteps = 0;
    } else if (env.scorer) {
      const s = env.scorer(outcome.state);
      outcomeSuccessProb = s.successProb;
      remainingSteps = (s.expectedSteps != null && Number.isFinite(s.expectedSteps))
        ? s.expectedSteps
        : heuristicRemainingSteps(outcome.state, target, env);
    } else {
      const estimate = getAnalyticalStateEstimate(outcome.state, target, env);
      outcomeSuccessProb = estimate.successProb;
      remainingSteps = estimate.expectedSteps;
    }

    successProb += outcome.probability * outcomeSuccessProb;
    successMass += outcome.probability * outcomeSuccessProb;
    weightedSteps += outcome.probability * outcomeSuccessProb * (cubeCost + remainingSteps);
  }

  let expectedSteps;
  if (successMass > 1e-7) {
    expectedSteps = weightedSteps / successMass;
  } else if (env.scorer) {
    const s = env.scorer(state);
    const fallback = (s.expectedSteps != null && Number.isFinite(s.expectedSteps))
      ? s.expectedSteps
      : heuristicRemainingSteps(state, target, env);
    expectedSteps = cubeCost + fallback;
  } else {
    expectedSteps = cubeCost + getAnalyticalStateEstimate(state, target, env).expectedSteps;
  }

  const summary = {
    successProb: clampProb(successProb),
    expectedSteps,
  };

  if (env.actionHintCache) {
    env.actionHintCache.set(cacheKey, summary);
  }

  return summary;
}

/**
 * Estimate the expected remaining cube steps to reach `target` from `state`
 * via `action`, averaged over `action`’s outcome distribution.
 *
 * Delegates to `env.scorer` when present; otherwise uses built-in heuristics.
 * Falls back to a fixed default (35) when no outcome distribution is available.
 *
 * @param {Object} state
 * @param {Object} action
 * @param {Object} env  - Runtime environment (may have `env.scorer`).
 * @param {Object} target
 * @returns {number} Estimated cube steps.
 */
function immediateStepHint(state, action, env, target) {
  return getActionHintSummary(state, action, env, target).expectedSteps;
}

/**
 * Select the best action for `node` using UCB1 (for visited actions) or
 * heuristic priors (for unvisited actions).  At the root applies ε-greedy
 * exploration and a minimum-visit floor before switching to UCB.
 *
 * @param {Object}      node         - MCTS node with `state` and `actions` map.
 * @param {boolean}     [isRoot]     - Enable root-specific exploration policy.
 * @param {Object|null} [env]        - If provided, enables heuristic priors.
 * @param {Object|null} [target]
 * @returns {Object} Chosen action-stats entry.
 */
function chooseAction(node, isRoot = false, env = null, target = null) {
  const actionEntries = Object.values(node.actions);
  const totalVisits = Math.max(1, node.visits);
  const priorWeight = (env && target) ? 8 : 0;

  const unvisited = actionEntries.filter((actionStats) => actionStats.visits === 0);
  if (unvisited.length > 0) {
    if (!env || !target) {
      return unvisited[Math.floor(Math.random() * unvisited.length)];
    }

    let bestUnvisited = unvisited[0];
    let bestUnvisitedScore = -Infinity;

    for (const actionStats of unvisited) {
      const successHint = immediateSuccessHint(node.state, actionStats.action, env, target);
      const stepHint = immediateStepHint(node.state, actionStats.action, env, target);
      const hintScore = (successHint * 200) - stepHint;

      if (hintScore > bestUnvisitedScore) {
        bestUnvisitedScore = hintScore;
        bestUnvisited = actionStats;
      }
    }

    return bestUnvisited;
  }

  if (isRoot) {
    const minVisits = Math.max(
      ROOT_MIN_VISITS_BASE,
      Math.floor(Math.log(totalVisits + 1) * ROOT_MIN_VISITS_LOG_SCALE)
    );

    const underExplored = actionEntries.filter((actionStats) => actionStats.visits < minVisits);
    if (underExplored.length > 0) {
      return underExplored[Math.floor(Math.random() * underExplored.length)];
    }

    if (Math.random() < ROOT_EXPLORE_EPSILON) {
      return sampleByInverseVisits(actionEntries);
    }
  }

  let best = actionEntries[0];
  let bestScore = -Infinity;

  for (const actionStats of actionEntries) {
    let visits = actionStats.visits;
    let totalScore = actionStats.totalScore;
    let successMass = actionStats.successMass;

    if (priorWeight > 0) {
      const successHint = immediateSuccessHint(node.state, actionStats.action, env, target);
      const stepHint = immediateStepHint(node.state, actionStats.action, env, target);
      visits += priorWeight;
      totalScore += scoreEpisode(stepHint, successHint) * priorWeight;
      successMass += successHint * priorWeight;
    }

    const meanScore = totalScore / visits;
    const successRate = successMass / visits;
    const exploration = 1.35 * Math.sqrt(Math.log(totalVisits + priorWeight) / visits);
    const score = meanScore + (successRate * 6) + exploration;

    if (score > bestScore) {
      bestScore = score;
      best = actionStats;
    }
  }

  return best;
}

/**
 * Sample an action entry with probability inversely proportional to its
 * visit count, biasing selection towards under-explored actions.
 *
 * @param {Array<Object>} actions - Action-stats entries with a `visits` field.
 * @returns {Object}
 */
function sampleByInverseVisits(actions) {
  let totalWeight = 0;
  const weights = actions.map((actionStats) => {
    const w = 1 / (1 + actionStats.visits);
    totalWeight += w;
    return w;
  });

  let pick = Math.random() * totalWeight;
  for (let i = 0; i < actions.length; i += 1) {
    pick -= weights[i];
    if (pick <= 0) {
      return actions[i];
    }
  }

  return actions[actions.length - 1];
}

/**
 * Sample a single outcome from `outcomes` proportionally to their
 * probabilities using the roulette-wheel method.
 *
 * @param {Array<{ state: Object, probability: number }>} outcomes
 * @returns {{ state: Object, probability: number }}
 */
function sampleOutcome(outcomes) {
  const r = Math.random();
  let acc = 0;
  for (const outcome of outcomes) {
    acc += outcome.probability;
    if (r <= acc) {
      return outcome;
    }
  }
  return outcomes[outcomes.length - 1];
}

/**
 * Comparator for sorting scored action summary candidates.
 * Primary key: `successProb` descending; secondary: `expectedSteps` ascending;
 * tertiary: `visits` descending; quaternary: action key lexicographic.
 *
 * @param {Object} left
 * @param {Object} right
 * @returns {number}
 */
function compareSummaryCandidates(left, right) {
  const successDiff = right.successProb - left.successProb;
  if (Math.abs(successDiff) > 1e-9) {
    return successDiff;
  }

  const leftSteps = Number.isFinite(left.expectedSteps) ? left.expectedSteps : Infinity;
  const rightSteps = Number.isFinite(right.expectedSteps) ? right.expectedSteps : Infinity;
  const stepDiff = leftSteps - rightSteps;
  if (Math.abs(stepDiff) > 1e-9) {
    return stepDiff;
  }

  const visitDiff = (right.visits || 0) - (left.visits || 0);
  if (visitDiff !== 0) {
    return visitDiff;
  }

  return actionKey(left.action).localeCompare(actionKey(right.action));
}

/**
 * Compute the exact one-step probability that each currently satisfied target
 * affix requirement becomes unsatisfied after taking `action` from `state`.
 *
 * @param {Object} state
 * @param {Object|null} action
 * @param {Object} env
 * @param {Object} target
 * @returns {Array<{ name: string, risk: number, requireGA: boolean }>}
 */
function getOneStepTargetLossRisk(state, action, env, target) {
  if (!action) {
    return [];
  }

  const outcomes = getActionOutcomes(state, action, env);
  if (outcomes.length === 0) {
    return [];
  }

  const targetCounts = env.targetCounts || getTargetCountsFromTarget(target);
  const currentCounts = getAffixCounts(state.affixes);
  const currentGACounts = getAffixCounts(state.affixes, (entry) => entry.isGA);
  const risks = [];

  for (const [affixId, requiredCount] of Object.entries(targetCounts)) {
    if ((currentCounts[affixId] || 0) < requiredCount) {
      continue;
    }

    let risk = 0;
    for (const outcome of outcomes) {
      const nextCounts = getAffixCounts(outcome.state.affixes);
      if ((nextCounts[affixId] || 0) < requiredCount) {
        risk += outcome.probability;
      }
    }

    if (risk > 1e-12) {
      risks.push({
        name: affixName(affixId, env),
        risk,
        requireGA: false,
      });
    }
  }

  risks.sort((left, right) => {
    if (Math.abs(right.risk - left.risk) > 1e-12) {
      return right.risk - left.risk;
    }
    return left.name.localeCompare(right.name);
  });

  return risks;
}

/**
 * Extract a human-readable summary from the MCTS tree root.
 * Scores each action by its visit statistics, falls back to heuristic
 * priors for unvisited actions, and applies rule-based overrides.
 *
 * @param {Object} tree    - MCTS tree.
 * @param {string} rootKey - Key of the root node.
 * @param {Object} env
 * @param {Object} target
 * @returns {Object} { action, successProb, expectedSteps, diagnostics }
 */
function summarizeRoot(tree, rootKey, env, target) {
  if (env.impossibleTargetGAReason) {
    return emptySummary(env.impossibleTargetGAReason);
  }

  const root = tree.nodes[rootKey];
  if (!root) {
    return emptySummary("No root node");
  }

  const validActions = getValidActions(root.state, target, env);
  const ruleDecision = resolveRuleAction(root.state, target, env, validActions);

  const actionStatsList = Object.values(root.actions);
  if (actionStatsList.length === 0) {
    if (ruleDecision && ruleDecision.action) {
      return {
        action: ruleDecision.action,
        expectedSteps: immediateStepHint(root.state, ruleDecision.action, env, target),
        variance: null,
        stdDev: null,
        successProb: immediateSuccessHint(root.state, ruleDecision.action, env, target),
        oneStepRisk: getOneStepTargetLossRisk(root.state, ruleDecision.action, env, target),
        diagnostics: {
          reason: ruleDecision.reason,
          rootVisits: root.visits,
          strategy: "rules-first",
          rule: ruleDecision,
          candidateActions: [],
        },
      };
    }

    return emptySummary(getNoValidActionReason(root.state, target, env));
  }

  const scored = actionStatsList.map((entry) => {
    const successProb = entry.visits > 0
      ? clampProb(entry.successMass / entry.visits)
      : clampProb(immediateSuccessHint(root.state, entry.action, env, target));

    let expectedSteps = null;
    if (entry.successMass > 1e-7) {
      expectedSteps = entry.weightedSteps / entry.successMass;
    } else if (entry.visits > 0) {
      expectedSteps = entry.totalCubeStepsAll / entry.visits;
    }

    if (!Number.isFinite(expectedSteps)) {
      let baseSteps;
      if (env.scorer) {
        const s = env.scorer(root.state);
        baseSteps = (s.expectedSteps != null && Number.isFinite(s.expectedSteps))
          ? s.expectedSteps
          : heuristicRemainingSteps(root.state, target, env);
      } else {
        baseSteps = heuristicRemainingSteps(root.state, target, env);
      }
      expectedSteps = baseSteps + (isCubeAction(entry.action) ? 1 : 0);
    }

    const rank = successProb;

    return {
      action: entry.action,
      visits: entry.visits,
      successProb,
      expectedSteps,
      rank,
      raw: entry,
    };
  });

  scored.sort(compareSummaryCandidates);
  let best = scored[0];
  if (ruleDecision && ruleDecision.action) {
    const forcedKey = actionKey(ruleDecision.action);
    const forced = scored.find((entry) => actionKey(entry.action) === forcedKey);
    if (forced) {
      best = forced;
    }
  }

  let variance = null;
  let stdDev = null;
  if (best.raw.successMass > 1e-7) {
    const mean = best.raw.weightedSteps / best.raw.successMass;
    const meanSq = best.raw.weightedStepsSq / best.raw.successMass;
    variance = Math.max(0, meanSq - (mean * mean));
    stdDev = Math.sqrt(variance);
  }

  const actionsTop = scored.slice(0, 6).map((entry) => {
    const breakdown = getActionProbabilityBreakdown(root.state, entry.action, env);
    return {
      action: entry.action,
      visits: entry.visits,
      successProb: entry.successProb,
      expectedSteps: entry.expectedSteps,
      rank: entry.rank,
      probabilityBreakdown: breakdown.outcomes,
      sourceBreakdown: breakdown.sources,
    };
  });

  return {
    action: best.action,
    expectedSteps: best.expectedSteps,
    variance,
    stdDev,
    successProb: best.successProb,
    oneStepRisk: getOneStepTargetLossRisk(root.state, best.action, env, target),
    diagnostics: {
      rootVisits: root.visits,
      strategy: ruleDecision && ruleDecision.action ? "rules-first" : "mcts",
      rule: ruleDecision || null,
      candidateActions: actionsTop,
    },
  };
}

/**
 * Estimate the probability of eventually reaching `target` from `state`.
 * Delegates to `env.scorer` when present; otherwise uses the built-in
 * analytical heuristic.
 *
 * @param {Object} state
 * @param {Object} action
 * @param {Object} env  - Runtime environment (may have `env.scorer`).
 * @param {Object} target
 * @returns {number} Success probability in [0, 1].
 */
function immediateSuccessHint(state, action, env, target) {
  return getActionHintSummary(state, action, env, target).successProb;
}

/**
 * Return a map of affixId → count for `state.affixes`.
 *
 * @param {Object} state
 * @returns {Object}
 */
function getAffixIdCountsFromState(state) {
  return getAffixCounts((state && state.affixes) || []);
}

/**
 * Compute the added/removed affix IDs between two states.
 *
 * @param {Object} beforeState
 * @param {Object} afterState
 * @returns {{ added: string[], removed: string[] }}
 */
function diffAffixCounts(beforeState, afterState) {
  const beforeCounts = getAffixIdCountsFromState(beforeState);
  const afterCounts = getAffixIdCountsFromState(afterState);
  const ids = new Set([...Object.keys(beforeCounts), ...Object.keys(afterCounts)]);
  const added = [];
  const removed = [];

  for (const id of ids) {
    const delta = (afterCounts[id] || 0) - (beforeCounts[id] || 0);
    if (delta > 0) {
      for (let i = 0; i < delta; i += 1) {
        added.push(id);
      }
    } else if (delta < 0) {
      for (let i = 0; i < -delta; i += 1) {
        removed.push(id);
      }
    }
  }

  return { added, removed };
}

/**
 * Produce a human-readable label describing what changed between two states
 * as a result of `action`.
 *
 * @param {Object} beforeState
 * @param {Object} afterState
 * @param {Object} action
 * @param {Object} env
 * @returns {string}
 */
function outcomeLabelFromStates(beforeState, afterState, action, env) {
  const diff = diffAffixCounts(beforeState, afterState);

  if (action.type === "remove") {
    if (diff.removed.length > 0) {
      return `Remove ${affixName(diff.removed[0], env)}`;
    }
    return "Remove selected affix";
  }

  if (action.type === "add") {
    if (diff.added.length > 0) {
      return affixName(diff.added[0], env);
    }
    return "No change";
  }

  if (action.type === "focused" || action.type === "chaotic" || action.type === "enchant") {
    if (diff.added.length > 0) {
      return affixName(diff.added[0], env);
    }

    if (Number.isInteger(action.sourceIndex)
      && action.sourceIndex >= 0
      && action.sourceIndex < afterState.affixes.length) {
      return affixName(afterState.affixes[action.sourceIndex].affixId, env);
    }

    return "No change";
  }

  return "Outcome";
}

/**
 * Build a probability breakdown (outcomes + sources) suitable for the UI
 * for a given `action` from `state`.  Only the top 6 outcomes/sources are
 * returned (by probability).
 *
 * @param {Object} state
 * @param {Object} action
 * @param {Object} env
 * @returns {{ outcomes: Array, sources: Array }}
 */
function getActionProbabilityBreakdown(state, action, env) {
  if (!action) {
    return { outcomes: [], sources: [] };
  }

  const outcomesFromAction = getActionOutcomes(state, action, env);
  const outcomeMap = Object.create(null);
  for (const outcome of outcomesFromAction) {
    const label = outcomeLabelFromStates(state, outcome.state, action, env);
    outcomeMap[label] = (outcomeMap[label] || 0) + outcome.probability;
  }
  const computedOutcomes = Object.entries(outcomeMap).map(([label, probability]) => ({ label, probability }));

  if (action.type === "add" || action.type === "focused") {
    if (computedOutcomes.length === 0) {
      return { outcomes: [], sources: [] };
    }

    if (action.type === "add") {
      return {
        outcomes: topBreakdown(computedOutcomes),
        sources: [],
      };
    }

    const eligible = getEligibleByCategory(state, env, action.prism, "focused");
    const sources = [];
    if (eligible.length > 0) {
      const sourceMap = Object.create(null);
      const sourceP = 1 / eligible.length;
      for (const { entry } of eligible) {
        const name = affixName(entry.affixId, env);
        sourceMap[name] = (sourceMap[name] || 0) + sourceP;
      }
      for (const [label, probability] of Object.entries(sourceMap)) {
        sources.push({ label, probability });
      }
    }

    return {
      outcomes: topBreakdown(computedOutcomes),
      sources: topBreakdown(sources),
    };
  }

  if (action.type === "remove") {
    if (computedOutcomes.length === 0) {
      return { outcomes: [], sources: [] };
    }
    return { outcomes: topBreakdown(computedOutcomes), sources: [] };
  }

  if (action.type === "chaotic") {
    const eligible = getEligibleByCategory(state, env, action.prism, "chaotic");
    const sources = [];

    if (eligible.length > 0) {
      const sourceMap = Object.create(null);
      const p = 1 / eligible.length;
      for (const { entry } of eligible) {
        const name = affixName(entry.affixId, env);
        sourceMap[name] = (sourceMap[name] || 0) + p;
      }
      for (const [label, probability] of Object.entries(sourceMap)) {
        sources.push({ label, probability });
      }
    }

    return {
      outcomes: topBreakdown(computedOutcomes),
      sources: topBreakdown(sources),
    };
  }

  if (action.type === "enchant") {
    return {
      outcomes: [{
        label: affixName(action.targetAffixId, env),
        probability: 1,
      }],
      sources: [{
        label: sourceLabel(state, action.sourceIndex, env),
        probability: 1,
      }],
    };
  }

  return { outcomes: [], sources: [] };
}

/**
 * Filter, sort descending by probability, and take the top 6 entries.
 *
 * @param {Array<{ label: string, probability: number }>} list
 * @returns {Array}
 */
function topBreakdown(list) {
  return list
    .filter((entry) => Number.isFinite(entry.probability) && entry.probability > 0)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 6);
}

/**
 * Return a display name for the affix at position `index` in `state.affixes`.
 *
 * @param {Object} state
 * @param {number} index
 * @param {Object} env
 * @returns {string}
 */
function sourceLabel(state, index, env) {
  if (!Number.isInteger(index) || index < 0 || index >= state.affixes.length) {
    return "Selected affix";
  }
  return affixName(state.affixes[index].affixId, env);
}

/**
 * Look up the human-readable name for `affixId` in the catalogue.
 * Returns the raw ID string as a fallback.
 *
 * @param {string} affixId
 * @param {Object} env
 * @returns {string}
 */
function affixName(affixId, env) {
  const affix = env.affixMap[affixId];
  return affix ? affix.name : affixId;
}

/**
 * Scalar score for a state used during rollout action selection.
 * Terminal success → 100, failure → −120.
 * Non-terminal: `(successProb × 200) − remainingSteps`.
 * Uses `env.scorer` when present, otherwise the built-in heuristics.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env  - Runtime environment (may have `env.scorer`).
 * @returns {number}
 */
function rolloutStateScore(state, target, env) {
  const terminal = isTerminal(state, target, env);
  if (terminal.terminal) {
    return terminal.success ? 100 : -120;
  }

  const cacheKey = env.rolloutStateScoreCache ? stateKey(state) : "";
  if (cacheKey && env.rolloutStateScoreCache.has(cacheKey)) {
    return env.rolloutStateScoreCache.get(cacheKey);
  }

  let score;

  if (env.scorer) {
    const s = env.scorer(state);
    const steps = (s.expectedSteps != null && Number.isFinite(s.expectedSteps))
      ? s.expectedSteps
      : heuristicRemainingSteps(state, target, env);
    score = (s.successProb * 200) - steps;
  } else {
    const estimate = getAnalyticalStateEstimate(state, target, env);
    score = (estimate.successProb * 200) - estimate.expectedSteps;
  }

  if (cacheKey) {
    env.rolloutStateScoreCache.set(cacheKey, score);
  }

  return score;
}

/**
 * Build a map of affixId → required count from a target spec.
 *
 * @param {Object} target - { affixes: [{affixId, requireGA}] }
 * @returns {Object}
 */
function getTargetCountsFromTarget(target) {
  const counts = Object.create(null);
  const requirements = (target && Array.isArray(target.affixes)) ? target.affixes : [];

  for (const requirement of requirements) {
    if (!requirement || !requirement.affixId) {
      continue;
    }
    counts[requirement.affixId] = (counts[requirement.affixId] || 0) + 1;
  }

  return counts;
}

/**
 * Return a boolean array parallel to `state.affixes` indicating which slots
 * satisfy a target affix requirement.  Respects required counts (e.g. two
 * copies of the same affix).
 *
 * @param {Object} state
 * @param {Object} targetCounts - Map of affixId → required count.
 * @returns {boolean[]}
 */
function markMatchedTargetAffixes(state, targetCounts) {
  const seenCounts = Object.create(null);

  return state.affixes.map((entry) => {
    if (!entry || !entry.affixId || !(targetCounts[entry.affixId] || 0)) {
      return false;
    }

    const nextSeen = (seenCounts[entry.affixId] || 0) + 1;
    seenCounts[entry.affixId] = nextSeen;
    return nextSeen <= targetCounts[entry.affixId];
  });
}

/**
 * Count how many matched (target-satisfying) affixes in `state` fall into
 * `categoryName` and are not enchanted.  Used to estimate clean-up cost
 * after a failed roll.
 *
 * @param {Object}   state
 * @param {Object}   env
 * @param {string}   categoryName
 * @param {boolean[]} matchedFlags - Output of `markMatchedTargetAffixes`.
 * @returns {number}
 */
function countKeptEligibleAffixes(state, env, categoryName, matchedFlags) {
  let count = 0;

  for (let index = 0; index < state.affixes.length; index += 1) {
    if (!matchedFlags[index]) {
      continue;
    }

    const entry = state.affixes[index];
    if (!entry || entry.isEnchanted) {
      continue;
    }

    const affix = env.affixMap[entry.affixId];
    if (affix && affix.categories.includes(categoryName)) {
      count += 1;
    }
  }

  return count;
}

/**
 * Returns true if affix slot `entry` at `index` can serve as the source
 * for a focused transmute bridge operation.
 * A slot is ineligible if it is enchanted, GA-protected, or already matched.
 *
 * @param {Object}   entry        - Affix entry { affixId, isGA, isEnchanted }.
 * @param {Object}   env
 * @param {boolean[]} matchedFlags
 * @param {number}   index
 * @returns {boolean}
 */
function canUseFocusedBridgeSource(entry, env, matchedFlags, index) {
  if (!entry || !entry.affixId || entry.isEnchanted) {
    return false;
  }
  if (matchedFlags[index]) {
    return false;
  }
  return !isProtectedGA(entry, env);
}

/**
 * Returns true if the affix at `sourceIndex` is the sole affix in
 * `categoryName` on the item (excluding `sourceIndex` itself).
 * When true, a focused transmute on it will not hit any other category affix.
 *
 * @param {Object} state
 * @param {Object} env
 * @param {number} sourceIndex
 * @param {string} categoryName
 * @returns {boolean}
 */
function isGuaranteedFocusedSourceForCategory(state, env, sourceIndex, categoryName) {
  for (let index = 0; index < state.affixes.length; index += 1) {
    if (index === sourceIndex) {
      continue;
    }

    const entry = state.affixes[index];
    if (!entry || entry.isEnchanted) {
      continue;
    }

    const affix = env.affixMap[entry.affixId];
    if (affix && affix.categories.includes(categoryName)) {
      return false;
    }
  }

  return true;
}

/**
 * Estimate the expected transmute cost (in cube uses) to land `targetAffixId`
 * via a focused bridge from a source that is the sole member of its category.
 * Returns Infinity when no path exists.
 *
 * @param {Object} env
 * @param {string} categoryName  - The category to bridge through.
 * @param {string} targetAffixId
 * @returns {number}
 */
function getFocusedCategoryHitCost(state, env, categoryName, targetAffixId) {
  const list = getCategoryAffixesForState(state, env, categoryName);
  let hitWeight = 0;
  let totalWeight = 0;

  for (const candidate of list) {
    const weight = getAffixRollWeight(candidate);
    totalWeight += weight;
    if (candidate.id === targetAffixId) {
      hitWeight += weight;
    }
  }

  if (hitWeight <= 0 || totalWeight <= 0) {
    return Infinity;
  }

  return totalWeight / hitWeight;
}

/**
 * Shortest-path cost to transmute the affix at `sourceIndex` into
 * `targetAffixId` via a chain of guaranteed focused bridge hops.
 * Uses Dijkstra over the category graph.  Returns Infinity if unreachable.
 *
 * @param {Object} state
 * @param {Object} env
 * @param {number} sourceIndex
 * @param {string} targetAffixId
 * @returns {number}
 */
function estimateSourceFocusedBridgeSteps(state, env, sourceIndex, targetAffixId) {
  const source = state.affixes[sourceIndex];
  if (!source || !source.affixId || source.isEnchanted) {
    return Infinity;
  }

  const bestCost = Object.create(null);
  const queue = [{ affixId: source.affixId, cost: 0 }];
  bestCost[source.affixId] = 0;

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift();
    if (!current || current.cost !== bestCost[current.affixId]) {
      continue;
    }

    if (current.affixId === targetAffixId) {
      return current.cost;
    }

    const affix = env.affixMap[current.affixId];
    if (!affix) {
      continue;
    }

    for (const categoryName of affix.categories) {
      if (!isGuaranteedFocusedSourceForCategory(state, env, sourceIndex, categoryName)) {
        continue;
      }

      const list = getCategoryAffixesForState(state, env, categoryName);
      const seenNextIds = new Set();
      for (const candidate of list) {
        if (seenNextIds.has(candidate.id)) {
          continue;
        }
        seenNextIds.add(candidate.id);

        const hitCost = getFocusedCategoryHitCost(state, env, categoryName, candidate.id);
        if (!Number.isFinite(hitCost)) {
          continue;
        }

        const nextCost = current.cost + hitCost;
        if (!Number.isFinite(bestCost[candidate.id]) || nextCost < bestCost[candidate.id] - 1e-9) {
          bestCost[candidate.id] = nextCost;
          queue.push({ affixId: candidate.id, cost: nextCost });
        }
      }
    }
  }

  return Infinity;
}

/**
 * If exactly one target affix is missing and a guaranteed focused-bridge path
 * exists, return `{ successProb: 1, expectedSteps }`.  Otherwise return null.
 * Used as a fast-path in both heuristics to avoid the general estimator.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {{ successProb: number, expectedSteps: number }|null}
 */
function getGuaranteedFocusedBridgeEstimate(state, target, env) {
  const targetCounts = env.targetCounts || getTargetCountsFromTarget(target);
  const stateCounts = getAffixCounts(state.affixes);
  const stateGACounts = getAffixCounts(state.affixes, (entry) => entry.isGA);
  const matchedFlags = markMatchedTargetAffixes(state, targetCounts);
  const missingAffixIds = [];

  for (const [affixId, requiredCount] of Object.entries(targetCounts)) {
    const currentCount = stateCounts[affixId] || 0;
    const missingCount = Math.max(0, requiredCount - currentCount);
    for (let index = 0; index < missingCount; index += 1) {
      missingAffixIds.push(affixId);
    }

  }

  if (missingAffixIds.length !== 1) {
    return null;
  }

  const targetAffixId = missingAffixIds[0];
  let best = Infinity;

  for (let index = 0; index < state.affixes.length; index += 1) {
    const entry = state.affixes[index];
    if (!canUseFocusedBridgeSource(entry, env, matchedFlags, index)) {
      continue;
    }

    best = Math.min(best, estimateSourceFocusedBridgeSteps(state, env, index, targetAffixId));
  }

  if (!Number.isFinite(best)) {
    return null;
  }

  return {
    successProb: 1,
    expectedSteps: best,
  };
}

/**
 * Estimate the expected cube steps needed to add a specific missing `affixId`
 * to the current item, accounting for open slots, extra (non-target) affixes
 * that need removing, and the roll-weight distribution within each category.
 *
 * @param {Object}   state
 * @param {Object}   env
 * @param {string}   affixId
 * @param {number}   openSlots   - Empty affix slots on the item.
 * @param {number}   extraCount  - Non-target affixes that can be replaced.
 * @param {boolean[]} matchedFlags - Output of `markMatchedTargetAffixes`.
 * @returns {number} Estimated steps (≥35 as a safe default).
 */
function estimateMissingAffixSteps(state, env, affixId, openSlots, extraCount, matchedFlags) {
  const affix = env.affixMap[affixId];
  if (!affix || !Array.isArray(affix.categories) || affix.categories.length === 0) {
    return 35;
  }

  let best = Infinity;

  for (const categoryName of affix.categories) {
    const list = getCategoryAffixesForState(state, env, categoryName);
    if (list.length === 0) {
      continue;
    }

    let hitWeight = 0;
    let totalWeight = 0;
    for (const candidate of list) {
      const weight = getAffixRollWeight(candidate);
      totalWeight += weight;
      if (candidate.id === affixId) {
        hitWeight += weight;
      }
    }
    if (hitWeight <= 0 || totalWeight <= 0) {
      continue;
    }

    const hitProbability = hitWeight / totalWeight;
    const keptEligible = countKeptEligibleAffixes(state, env, categoryName, matchedFlags);
    const prepCost = openSlots > 0 ? 0 : (extraCount > 0 ? 1 : 3.5);
    const missCleanup = 1 + keptEligible;
    const loopCost = (1 + ((1 - hitProbability) * missCleanup)) / hitProbability;
    best = Math.min(best, prepCost + loopCost);
  }

  return Number.isFinite(best) ? best : 35;
}

/**
 * Compute a scalar quality score for `state` relative to `target`.
 * Awards points for target affixes present/GA-satisfied; penalises for
 * missing affixes, unwanted affixes, and broken GA requirements.
 *
 * Used as input to the logistic function in `heuristicSuccessProbability`.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {number}
 */
function evaluateState(state, target, env) {
  if (breaksRequiredGA(state, env)) {
    return -220;
  }

  const stateCounts = getAffixCounts(state.affixes);

  let score = 0;
  let missing = 0;

  for (const requirement of target.affixes) {
    if (stateCounts[requirement.affixId] > 0) {
      score += 24;
    } else {
      score -= 20;
      missing += 1;
    }

  }

  const targetSet = new Set(target.affixes.map((entry) => entry.affixId));
  for (const entry of state.affixes) {
    if (!targetSet.has(entry.affixId)) {
      score -= 4;
    } else {
      score += 1;
    }

    if (entry.isEnchanted) {
      score += targetSet.has(entry.affixId) ? 4 : -2;
    }
  }

  score -= missing * 2;
  return score;
}

/**
 * Return true when the state is small enough that an exact local solve is
 * cheaper and more reliable than the analytical heuristic.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {boolean}
 */
function shouldUseExactSmallStateSolver(state, target, env) {
  if (env.impossibleTargetGAReason || breaksRequiredGA(state, env)) {
    return false;
  }

  const terminal = isTerminal(state, target, env);
  if (terminal.terminal) {
    return false;
  }

  const targetCounts = env.targetCounts || getTargetCountsFromTarget(target);
  return getMissingTargetAffixIds(state, targetCounts).length <= EXACT_SMALL_STATE_MAX_MISSING;
}

/**
 * Solve a compact reachable subgraph exactly using value iteration.
 * Returns null when the reachable graph is too large to solve cheaply.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {{ action: Object|null, successProb: number, expectedSteps: number|null, variance: null, stdDev: null, diagnostics: Object }|null}
 */
function getExactSmallStateSummary(state, target, env) {
  const rootKey = stateKey(state);
  if (env.exactStateSummaryCache && env.exactStateSummaryCache.has(rootKey)) {
    return env.exactStateSummaryCache.get(rootKey);
  }

  if (!shouldUseExactSmallStateSolver(state, target, env)) {
    if (env.exactStateSummaryCache) {
      env.exactStateSummaryCache.set(rootKey, null);
    }
    return null;
  }

  const stateList = [cloneState(state)];
  const keyToIndex = new Map([[rootKey, 0]]);
  const terminalByIndex = [];
  const actionsByIndex = [];

  for (let queueIndex = 0; queueIndex < stateList.length; queueIndex += 1) {
    const current = stateList[queueIndex];
    const terminal = isTerminal(current, target, env);
    terminalByIndex[queueIndex] = terminal;
    if (terminal.terminal) {
      actionsByIndex[queueIndex] = [];
      continue;
    }

    const actionEntries = [];
    for (const action of getValidActions(current, target, env)) {
      const outcomes = getActionOutcomes(current, action, env);
      const transitions = [];

      for (const outcome of outcomes) {
        const childKey = stateKey(outcome.state);
        let childIndex = keyToIndex.get(childKey);
        if (childIndex === undefined) {
          childIndex = stateList.length;
          keyToIndex.set(childKey, childIndex);
          stateList.push(outcome.state);
          if (stateList.length > EXACT_SMALL_STATE_LIMIT) {
            if (env.exactStateSummaryCache) {
              env.exactStateSummaryCache.set(rootKey, null);
            }
            return null;
          }
        }

        transitions.push({
          probability: outcome.probability,
          childIndex,
        });
      }

      actionEntries.push({
        action,
        cubeCost: actionCost(action, current),
        transitions,
      });
    }

    actionsByIndex[queueIndex] = actionEntries;
  }

  const successProbByIndex = new Float64Array(stateList.length);
  const weightedStepsByIndex = new Float64Array(stateList.length);

  for (let index = 0; index < stateList.length; index += 1) {
    const terminal = terminalByIndex[index];
    if (terminal && terminal.terminal) {
      successProbByIndex[index] = terminal.success ? 1 : 0;
    }
  }

  for (let iteration = 0; iteration < EXACT_SMALL_STATE_MAX_ITERATIONS; iteration += 1) {
    let maxDelta = 0;

    for (let index = 0; index < stateList.length; index += 1) {
      const terminal = terminalByIndex[index];
      if (terminal && terminal.terminal) {
        continue;
      }

      const actions = actionsByIndex[index] || [];
      let bestSuccess = 0;
      for (const entry of actions) {
        let successMass = 0;
        for (const transition of entry.transitions) {
          successMass += transition.probability * successProbByIndex[transition.childIndex];
        }
        if (successMass > bestSuccess) {
          bestSuccess = successMass;
        }
      }

      maxDelta = Math.max(maxDelta, Math.abs(bestSuccess - successProbByIndex[index]));
      successProbByIndex[index] = bestSuccess;
    }

    if (maxDelta < EXACT_SMALL_STATE_EPSILON) {
      break;
    }
  }

  for (let iteration = 0; iteration < EXACT_SMALL_STATE_MAX_ITERATIONS; iteration += 1) {
    let maxDelta = 0;

    for (let index = 0; index < stateList.length; index += 1) {
      const terminal = terminalByIndex[index];
      if (terminal && terminal.terminal) {
        continue;
      }

      const actions = actionsByIndex[index] || [];
      const optimalSuccess = successProbByIndex[index];
      let bestWeighted = Infinity;

      for (const entry of actions) {
        let successMass = 0;
        let weighted = 0;
        for (const transition of entry.transitions) {
          successMass += transition.probability * successProbByIndex[transition.childIndex];
          weighted += transition.probability * weightedStepsByIndex[transition.childIndex];
        }

        if (successMass <= EXACT_SMALL_STATE_EPSILON) {
          continue;
        }
        if (Math.abs(successMass - optimalSuccess) > 1e-8) {
          continue;
        }

        const candidate = entry.cubeCost * successMass + weighted;
        if (candidate < bestWeighted) {
          bestWeighted = candidate;
        }
      }

      if (!Number.isFinite(bestWeighted)) {
        bestWeighted = 0;
      }

      maxDelta = Math.max(maxDelta, Math.abs(bestWeighted - weightedStepsByIndex[index]));
      weightedStepsByIndex[index] = bestWeighted;
    }

    if (maxDelta < EXACT_SMALL_STATE_EPSILON) {
      break;
    }
  }

  const rootActions = (actionsByIndex[0] || []).map((entry) => {
    let successMass = 0;
    let weighted = 0;
    for (const transition of entry.transitions) {
      successMass += transition.probability * successProbByIndex[transition.childIndex];
      weighted += transition.probability * weightedStepsByIndex[transition.childIndex];
    }

    const expectedSteps = successMass > EXACT_SMALL_STATE_EPSILON
      ? (entry.cubeCost * successMass + weighted) / successMass
      : null;
    const breakdown = getActionProbabilityBreakdown(state, entry.action, env);

    return {
      action: entry.action,
      visits: 0,
      successProb: successMass,
      expectedSteps,
      rank: successMass,
      probabilityBreakdown: breakdown.outcomes,
      sourceBreakdown: breakdown.sources,
    };
  }).sort(compareSummaryCandidates);

  const result = {
    action: rootActions.length > 0 ? rootActions[0].action : null,
    successProb: successProbByIndex[0],
    expectedSteps: successProbByIndex[0] > EXACT_SMALL_STATE_EPSILON
      ? weightedStepsByIndex[0] / successProbByIndex[0]
      : null,
    variance: null,
    stdDev: null,
    oneStepRisk: rootActions.length > 0
      ? getOneStepTargetLossRisk(state, rootActions[0].action, env, target)
      : [],
    diagnostics: {
      reason: rootActions.length === 0 ? getNoValidActionReason(state, target, env) : null,
      rootVisits: 0,
      strategy: "exact-small-state",
      solvedStates: stateList.length,
      candidateActions: rootActions.slice(0, 6),
    },
  };

  if (env.exactStateSummaryCache) {
    env.exactStateSummaryCache.set(rootKey, result);
  }

  return result;
}

/**
 * Compute the heuristic-only state estimate once and cache it for the run.
 * This preserves existing heuristic behavior while avoiding repeated exact/
 * bridge/step computations across rollout scoring and leaf evaluation.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {{ successProb: number, expectedSteps: number }}
 */
function getAnalyticalStateEstimate(state, target, env) {
  const cacheKey = stateKey(state);
  if (env.analyticalStateEstimateCache && env.analyticalStateEstimateCache.has(cacheKey)) {
    return env.analyticalStateEstimateCache.get(cacheKey);
  }

  const exactSummary = getExactSmallStateSummary(state, target, env);
  let summary = null;
  let exactSuccessProb = null;

  if (exactSummary) {
    exactSuccessProb = exactSummary.successProb;
    if (Number.isFinite(exactSummary.expectedSteps)) {
      summary = {
        successProb: exactSummary.successProb,
        expectedSteps: exactSummary.expectedSteps,
      };
    }
  }

  if (!summary) {
    const guaranteedFocusedBridge = getGuaranteedFocusedBridgeEstimate(state, target, env);
    if (guaranteedFocusedBridge) {
      summary = {
        successProb: exactSuccessProb != null ? exactSuccessProb : guaranteedFocusedBridge.successProb,
        expectedSteps: guaranteedFocusedBridge.expectedSteps,
      };
    } else {
      const remainingSteps = computeHeuristicRemainingSteps(state, target, env);
      const score = evaluateState(state, target, env);
      const logistic = 1 / (1 + Math.exp(-((score - 4) / 16)));
      const reachability = Math.exp(-(remainingSteps / 24));
      summary = {
        successProb: exactSuccessProb != null ? exactSuccessProb : clampProb(logistic * reachability),
        expectedSteps: remainingSteps,
      };
    }
  }

  if (env.analyticalStateEstimateCache) {
    env.analyticalStateEstimateCache.set(cacheKey, summary);
  }

  return summary;
}

/**
 * Shared body for the heuristic remaining-step estimator once impossible /
 * terminal / exact / guaranteed-bridge short-circuits have been handled.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {number}
 */
function computeHeuristicRemainingSteps(state, target, env) {
  const stateCounts = getAffixCounts(state.affixes);
  const targetCounts = env.targetCounts || getTargetCountsFromTarget(target);
  const matchedFlags = markMatchedTargetAffixes(state, targetCounts);

  let openSlots = Math.max(0, 4 - state.affixes.length);
  let extraCount = matchedFlags.reduce((count, matched) => count + (matched ? 0 : 1), 0);
  let total = 0;

  for (const [affixId, requiredCount] of Object.entries(targetCounts)) {
    const currentCount = stateCounts[affixId] || 0;
    const missingCount = Math.max(0, requiredCount - currentCount);

    for (let index = 0; index < missingCount; index += 1) {
      total += estimateMissingAffixSteps(state, env, affixId, openSlots, extraCount, matchedFlags);

      if (openSlots > 0) {
        openSlots -= 1;
      } else if (extraCount > 0) {
        extraCount -= 1;
      }
    }

  }

  return Math.max(1, total);
}

/**
 * Estimate the probability of eventually reaching `target` from `state`
 * using the built-in analytical heuristic (not the RF scorer).
 *
 * Returns 0 for permanently impossible states; 1 for guaranteed success
 * (focused-bridge path); otherwise combines a logistic on `evaluateState`
 * with an exponential reachability decay on `heuristicRemainingSteps`.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {number} Success probability in [0, 1].
 */
function heuristicSuccessProbability(state, target, env) {
  if (env.impossibleTargetGAReason) {
    return 0;
  }

  if (breaksRequiredGA(state, env)) {
    return 0;
  }

  const terminal = isTerminal(state, target, env);
  if (terminal.terminal) {
    return terminal.success ? 1 : 0;
  }

  return getAnalyticalStateEstimate(state, target, env).successProb;
}

/**
 * Estimate the expected remaining cube steps to complete `target` from
 * `state` using the built-in analytical heuristic (not the RF scorer).
 *
 * Uses the focused-bridge fast path when applicable; otherwise sums per-affix
 * step estimates from `estimateMissingAffixSteps`, adding a GA sacrifice
 * penalty for any missing GA requirements.
 *
 * @param {Object} state
 * @param {Object} target
 * @param {Object} env
 * @returns {number} Estimated remaining steps (≥1).
 */
function heuristicRemainingSteps(state, target, env) {
  if (env.impossibleTargetGAReason) {
    return 35;
  }

  const terminal = isTerminal(state, target, env);
  if (terminal.terminal) {
    return 0;
  }

  return getAnalyticalStateEstimate(state, target, env).expectedSteps;
}

/**
 * Return an "impossible / no result" summary with `reason` as the
 * human-readable explanation.
 *
 * @param {string} reason
 * @returns {Object}
 */
function emptySummary(reason) {
  return {
    action: null,
    expectedSteps: null,
    variance: null,
    stdDev: null,
    successProb: 0,
    oneStepRisk: [],
    diagnostics: {
      reason,
      rootVisits: 0,
      candidateActions: [],
    },
  };
}

/**
 * Return a summary for a state that is already terminal.
 * On success returns zero-step result; on failure delegates to `emptySummary`.
 *
 * @param {{ terminal: boolean, success: boolean }} terminal
 * @param {Object} env
 * @returns {Object}
 */
function terminalSummary(terminal, env) {
  if (terminal.success) {
    return {
      action: null,
      expectedSteps: 0,
      variance: 0,
      stdDev: 0,
      successProb: 1,
      oneStepRisk: [],
      diagnostics: {
        reason: "Current state already satisfies the target.",
        rootVisits: 0,
        candidateActions: [],
      },
    };
  }

  return emptySummary(env.impossibleTargetGAReason || "Target requirements cannot be satisfied from the current state.");
}

/**
 * Prune and serialise the MCTS tree to `depthLimit` levels below the root.
 * Nodes beyond the depth limit are omitted, keeping the payload small for
 * transmission back to the UI or for storage as a warm-start tree.
 *
 * @param {{ rootKey: string, nodes: Object }} tree
 * @param {string} rootKey
 * @param {number} depthLimit - 0 = root only, 3 = typical warm-start.
 * @returns {{ rootKey: string, nodes: Object }}
 */
function shrinkTree(tree, rootKey, depthLimit) {
  const out = {
    rootKey,
    nodes: Object.create(null),
  };

  const visited = new Set();
  const queue = [{ key: rootKey, depth: 0 }];

  while (queue.length > 0) {
    const { key, depth } = queue.shift();
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    const node = tree.nodes[key];
    if (!node) {
      continue;
    }

    out.nodes[key] = {
      state: cloneState(node.state),
      visits: node.visits,
      actions: Object.create(null),
    };

    for (const [actKey, actStats] of Object.entries(node.actions)) {
      out.nodes[key].actions[actKey] = normalizeActionStats(actStats);

      if (depth >= depthLimit) {
        continue;
      }

      const topOutcomes = Object.entries(actStats.outcomeVisits || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);

      for (const [childKey] of topOutcomes) {
        queue.push({ key: childKey, depth: depth + 1 });
      }
    }
  }

  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ROOT_EXPLORE_EPSILON,
    ROOT_MIN_VISITS_BASE,
    ROOT_MIN_VISITS_LOG_SCALE,
    ROLLOUT_EPSILON,
    RULE_SUCCESS_THRESHOLD,
    runOptimization,
    optimizePayload,
    optimizeScenario,
    shouldStop,
    buildEnv,
    normalizeTree,
    normalizeActionStats,
    createNode,
    stateKey,
    cloneState,
    getAffixCounts,
    isProtectedGA,
    isTerminal,
    breaksRequiredGA,
    actionKey,
    getValidActions,
    getMissingTargetAffixIds,
    getBestAddActionForAffix,
    resolveRuleAction,
    affixSupportsGearSlot,
    affixSupportsClass,
    getStateClass,
    getEffectiveAffixRollWeight,
    buildFamilyCountsForPool,
    sumEffectiveWeights,
    getAffixCategoriesForOp,
    getCategoryAffixesForState,
    getCategoryWeightTotal,
    getEligibleByCategory,
    getActionOutcomes,
    mergeOutcomes,
    isCubeAction,
    actionCost,
    RE_ENCHANT_TIE_BREAK_COST,
    simulateFromNode,
    rollout,
    chooseRolloutAction,
    scoreEpisode,
    clampProb,
    chooseAction,
    immediateStepHint,
    sampleByInverseVisits,
    sampleOutcome,
    summarizeRoot,
    immediateSuccessHint,
    getOneStepTargetLossRisk,
    getActionProbabilityBreakdown,
    topBreakdown,
    sourceLabel,
    affixName,
    rolloutStateScore,
    getTargetCountsFromTarget,
    markMatchedTargetAffixes,
    countKeptEligibleAffixes,
    canUseFocusedBridgeSource,
    isGuaranteedFocusedSourceForCategory,
    getFocusedCategoryHitCost,
    estimateSourceFocusedBridgeSteps,
    getGuaranteedFocusedBridgeEstimate,
    estimateMissingAffixSteps,
    evaluateState,
    shouldUseExactSmallStateSolver,
    getExactSmallStateSummary,
    heuristicSuccessProbability,
    heuristicRemainingSteps,
    emptySummary,
    shrinkTree,
  };
}
