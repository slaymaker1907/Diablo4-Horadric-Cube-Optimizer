// ====================================================================
// d4cubeoptimv3-worker.js — self-contained Horadric Cube optimizer.
// Originally three files (v1 base worker, v2 exact-SSP, v3 hybrid); the
// v1 and v2 helpers required by v3 are inlined here in order:
//   1. v1 base helpers (state, env, action generation).
//   2. v2 residual abstraction helpers.
//   3. v3 feasibility / decomposition-ILP / residual-LAO* logic.
// ====================================================================

/**
 * d4cubeoptimv3-worker.js
 *
 * Lexicographic objective:
 * 1. Maximize P(success).
 * 2. Among policies optimal for P(success), minimize E[N | success].
 *
 * When the restricted action class achieves P(success) = 1, the second
 * objective reduces to unconditional expected cube steps.
 *
 * Current implementation status:
 * - Phase 0: worker protocol, diagnostics contract, and module scaffolding.
 * - Phase 1: feasibility checks F4-F7 with structured diagnostics (F1-F3 removed: requireGA no longer applies).
 * - Phase 2: closed-form common-case subplan classification and expected-step
 *   formulas for Cases A-G.
 * - Phase 3: scoped exact ILP solver for the assignment and scheduling layer.
 * - Phase 4: decomposition-plus-ILP integration for decomposition-safe cases.
 * - Phase 5: residual LAO*-style solving on an abstract state graph for cases
 *   the decomposition layer refuses to linearize exactly.
 */

let ilpWorker = null;

if (typeof module !== "undefined" && module.exports) {
  ilpWorker = require("./ilp.js");
} else if (typeof importScripts !== "undefined") {
  importScripts("./ilp.js");
  ilpWorker = {
    solveILP: typeof solveILP === "function" ? solveILP : null,
  };
}

// D4_USE_RUST=true enables the Rust/WASM optimiser path (v4) for Node tests.
// In the browser, pass `useRust: true` in each "run" message instead.
const D4_USE_RUST =
  (typeof process !== "undefined" && process.env && process.env.D4_USE_RUST === "true") ||
  (typeof self !== "undefined" && self.D4_USE_RUST === true);

let rustWorker = null;
let _rustWorkerLoading = null; // in-flight Promise for browser lazy WASM init
let _rustWorkerFailed = false; // true after a failed load; skip Rust thereafter

if (D4_USE_RUST && typeof module !== "undefined" && module.exports) {
  try {
    rustWorker = require("./rust/pkg-node/d4optimizer.js");
  } catch (_) {
    // Built artifacts not present; fall back to JS path silently.
  }
}

// Cache-busting version for the WASM artifacts, read from this worker's own
// `?v=` query string (set by d4cubeoptimv3.html's WORKER_VERSION). The worker
// loads the Rust loader JS and the `.wasm` binary via unversioned relative URLs,
// so without this the browser can keep serving a stale `.wasm` after a deploy
// even when the worker JS itself was refreshed. Appending the same version to
// those URLs makes a WORKER_VERSION bump reliably re-fetch the new WASM.
const _WASM_CACHE_VERSION = (() => {
  try {
    if (typeof self !== "undefined" && self.location && self.location.href) {
      return new URL(self.location.href).searchParams.get("v") || "";
    }
  } catch (_) { /* location/URL unavailable */ }
  return "";
})();
function _wasmUrl(path) {
  return _WASM_CACHE_VERSION
    ? `${path}?v=${encodeURIComponent(_WASM_CACHE_VERSION)}`
    : path;
}

// Lazy WASM loader for classic browser Web Workers.
// Called before the first Rust-path run; resolves immediately on repeat calls.
async function ensureRustWorker() {
  if (rustWorker || _rustWorkerFailed) return;
  if (_rustWorkerLoading) { await _rustWorkerLoading; return; }
  if (typeof importScripts === "undefined") return; // not a classic worker

  _rustWorkerLoading = (async () => {
    try {
      importScripts(_wasmUrl("./rust/pkg-no-modules/d4optimizer.js"));
      // wasm_bindgen is now a global set by the imported script.
      // Pass the .wasm URL explicitly because document.currentScript is
      // unavailable in workers, so the auto-detect path cannot be used.
      await wasm_bindgen(_wasmUrl("./rust/pkg-no-modules/d4optimizer_bg.wasm")); // eslint-disable-line no-undef
      rustWorker = wasm_bindgen; // eslint-disable-line no-undef
    } catch (e) {
      console.warn("[d4optimizer] WASM load failed; falling back to JS:", e);
      _rustWorkerFailed = true;
    } finally {
      _rustWorkerLoading = null;
    }
  })();
  await _rustWorkerLoading;
}

const DEFAULT_MAX_AFFIX_SLOTS = 4;
const FEASIBILITY_STRATEGY = "v3-feasibility";
const FALLBACK_STRATEGY = "v3-v2-fallback";
const DECOMPOSITION_STRATEGY = "v3-decomposition-ilp";
const RESIDUAL_STRATEGY = "v3-residual-lao-star";
const CLOSED_FORM_CASE_IDS = Object.freeze({
  A: "A",
  B: "B",
  C: "C",
  D: "D",
  E: "E",
  F: "F",
  G: "G",
  // Re-enchant of the already-enchanted non-GA slot to a different target affix.
  // Deterministic outcome; cost = RE_ENCHANT_TIE_BREAK_COST to break cycles.
  REENCHANT: "REENCHANT",
});
const KEEP_PLAN_CASE_ID = "KEEP";
const RESIDUAL_STATE_LIMIT = 500;
const RESIDUAL_STATE_LIMIT_CAP = 4096;
const RESIDUAL_MAX_ITERATIONS = 4096;
const RESIDUAL_MAX_ITERATIONS_CAP = 1048576;
const RESIDUAL_EPSILON = 1e-9;
// Phase 2 (expected-step value iteration) compares against a *relative*
// tolerance rather than absolute, because cube-step values can grow into the
// thousands when low-probability target affixes are involved (e.g. class=Any
// Adept skill targets at ~1/240 per cube). An absolute 1e-9 demands twelve
// significant figures of agreement on values of order 10^3 and pushes value
// iteration into millions of iterations.
const RESIDUAL_PHASE2_EPSILON = 1e-6;
const RESIDUAL_ACTION_EPSILON = 1e-8;

// =====================  Inlined v1 base helpers  ====================
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
let rulesSolverModule = null;

if (typeof module !== "undefined" && module.exports) {
  gearSlotLegality = require("./gear-slot-legality.js");
  try { rulesSolverModule = require("./d4cubeoptimv3-rules-solver.js"); } catch (_) { /* dev-only module */ }
}

// Load worker-side helper modules when running as a browser Web Worker.
// Functions become worker-scope globals; gracefully degrade if unavailable.
if (typeof importScripts !== "undefined") {
  try { importScripts("./random-forest.js"); } catch (_) { /* scorer unavailable */ }
  try { importScripts("./gear-slot-legality.js"); } catch (_) { /* slot legality unavailable */ }
  try { importScripts("./d4cubeoptimv3-rules-solver.js"); } catch (_) { /* rules solver unavailable */ }
  if (typeof d4cubeoptimGearSlotLegality !== "undefined") {
    gearSlotLegality = d4cubeoptimGearSlotLegality;
  }
  if (typeof d4cubeoptimRulesSolver !== "undefined") {
    rulesSolverModule = d4cubeoptimRulesSolver;
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

// (v1 self.onmessage handler removed — v3 owns the worker entry point now)

/**

/**

/**

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
 * Check whether `state` carries the same affixId on two slots. D4 never allows
 * duplicate affixes on an item, so any reroll/add outcome that would produce one
 * is impossible (the game excludes on-item affixes from the reroll pool). This
 * complements `violatesFamilyUniqueness`, which only screens family-level
 * collisions (elemental/resistance/skill families) and not plain singletons such
 * as Critical Strike Damage.
 */
function hasDuplicateAffixId(state) {
  const seen = new Set();
  for (const entry of state.affixes) {
    if (!entry || !entry.affixId) {
      continue;
    }
    if (seen.has(entry.affixId)) {
      return true;
    }
    seen.add(entry.affixId);
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
    disableEnchanting: !!(gaConfig && gaConfig.disableEnchanting),
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

/**

/**

/**
 * Compute a canonical string key for a state, used as the MCTS node ID.
 * Two states that are equivalent in every meaningful way produce the same key.
 *
 * @param {Object} state
 * @returns {string}
 */
function stateKey(state) {
  const tokens = state.affixes
    .map((entry) => `${entry.affixId}|${entry.isGA ? 1 : 0}|${entry.isEnchanted ? 1 : 0}`)
    .sort();
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

  // Precomputed sets used both for focused-churn pruning (below) and the
  // enchant-candidate pruning further down.
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
  // Categories that can still produce a missing target via a focused reroll.
  // A focused reroll lands in its own prism category, so a category outside this
  // set can never advance toward an unmet target.
  const missingTargetFocusedCategories = new Set();
  for (const entry of target.affixes) {
    const id = entry && entry.affixId;
    if (!id || currentAffixIds.has(id)) {
      continue;
    }
    const affix = env.affixMap[id];
    if (!affix) {
      continue;
    }
    for (const cat of getAffixCategoriesForOp(affix, "focused")) {
      missingTargetFocusedCategories.add(cat);
    }
  }

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
      // Prune strictly-dominated "churn" focused rerolls: when this prism cannot
      // produce any still-missing target AND every eligible source already holds
      // a satisfied (non-unsatisfactory) target affix, the reroll can only swap a
      // wanted affix for a non-improving one (or itself). It never advances the
      // lexicographic objective, so it is never part of an optimal policy —
      // leaving it in let the solver churn a matched target at apparent zero
      // cost (e.g. recommending a Resourceful reroll of a matched Lucky-Hit when
      // the only missing target lives in Aggressive).
      const churnDominated =
        !missingTargetFocusedCategories.has(categoryName)
        && eligibleFocused.every(({ entry }) => (
          entry && entry.affixId && targetIds.has(entry.affixId) && !unsatisfactoryIds.has(entry.affixId)
        ));
      if (!touchesGA && !churnDominated && !isAdeptFocusedBlocked(state, env, categoryName)) {
        actions.push({ type: "focused", prism: categoryName });
      }
    }
  }

  // Enchant action generation — skipped entirely when disableEnchanting is set.
  if (env.disableEnchanting) {
    return actions;
  }

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

/**

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

/** Prism category subject to the Mainstat focused-reroll block. */
const ADEPT_PRISM_NAME = "Adept";
/** Canonical affix id for Mainstat (slugified catalog name). */
const MAINSTAT_AFFIX_ID = "mainstat";

/**
 * The game refuses Focused Reroll with the Adept prism when the item already
 * holds Mainstat plus any skill-rank affix — i.e. the focused-eligible Adept
 * pool contains Mainstat and at least one other entry. Enchant-locked slots
 * are invisible to the cube, so an enchanted Mainstat does not trigger the
 * block. See docs/game-mechanics.md → Known Mechanical Edge Cases.
 *
 * JS-only: the Rust v4 path (D4_USE_RUST) does not model this lockout yet.
 *
 * @param {Object} state
 * @param {Object} env
 * @param {string} categoryName - prism being considered for a focused reroll.
 * @param {number} [excludeIndex] - slot assumed removed before the reroll
 *   (closed-form Case C plans the focused after removing the host).
 * @returns {boolean}
 */
function isAdeptFocusedBlocked(state, env, categoryName, excludeIndex) {
  if (categoryName !== ADEPT_PRISM_NAME) {
    return false;
  }
  let eligible = getEligibleByCategory(state, env, categoryName, "focused");
  if (Number.isInteger(excludeIndex)) {
    eligible = eligible.filter(({ index }) => index !== excludeIndex);
  }
  return eligible.length >= 2
    && eligible.some(({ entry }) => entry && entry.affixId === MAINSTAT_AFFIX_ID);
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
      if (violatesFamilyUniqueness(next, env) || hasDuplicateAffixId(next)) {
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
    if (isAdeptFocusedBlocked(state, env, action.prism)) {
      return [];
    }
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
        if (violatesFamilyUniqueness(next, env) || hasDuplicateAffixId(next)) {
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
          if (violatesFamilyUniqueness(next, env) || hasDuplicateAffixId(next)) {
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

/**

/**

/**

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

/**

/**

/**

/**

/**

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

/**

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

/**

/**

/**

/**

/**

/**

/**

/**

/**

/**

/**

/**

/**

/**

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

/**

// (v1 module.exports removed — merged into v3 module.exports at the bottom)


// ============  Inlined v2 residual / SSP helpers  =================
/**
 * d4cubeoptimv2-worker.js
 *
 * Exact two-phase SSP solver built on the shared transition helpers from the
 * v1 worker. Phase 1 maximizes eventual success probability on the reachable
 * graph. Phase 2 minimizes expected cube steps among Phase 1-optimal actions.
 */

// (v2 baseWorker bootstrap removed — v1 helpers are now inline above)
let workerStopRequested = false;

const EXACT_SSP_STATE_LIMIT = 8192;
const EXACT_SSP_MAX_ITERATIONS = 2048;
const EXACT_SSP_EPSILON = 1e-9;
const EXACT_SSP_ACTION_EPSILON = 1e-8;

const FAMILY_LIMIT_MESSAGES = {
  "elemental-damage": "Impossible target: only one Elemental Damage type can exist on an item.",
  "specific-resistance": "Impossible target: only one Specific Resistance type can exist on an item.",
};

function normalizeUnsatisfactoryAffixIds(gaConfig) {
  if (!gaConfig || !Array.isArray(gaConfig.unsatisfactoryAffixIds)) {
    return [];
  }

  return gaConfig.unsatisfactoryAffixIds
    .filter((affixId) => typeof affixId === "string" && affixId)
    .slice()
    .sort();
}

function cloneStateV2(state) {
  const next = cloneState(state);
  next.unsatisfactoryAffixIds = Array.isArray(state && state.unsatisfactoryAffixIds)
    ? state.unsatisfactoryAffixIds.slice()
    : [];
  return next;
}

function attachUnsatisfactoryToState(state, gaConfig) {
  const next = cloneStateV2(state);
  next.unsatisfactoryAffixIds = normalizeUnsatisfactoryAffixIds(gaConfig);
  return next;
}

function sortAffixEntries(entries) {
  return entries.slice().sort((left, right) => {
    const leftToken = `${left.affixId}|${left.isGA ? 1 : 0}|${left.isEnchanted ? 1 : 0}`;
    const rightToken = `${right.affixId}|${right.isGA ? 1 : 0}|${right.isEnchanted ? 1 : 0}`;
    return leftToken.localeCompare(rightToken);
  });
}

function getAffixCountsV2(affixes, filterFn) {
  const counts = Object.create(null);

  for (const entry of Array.isArray(affixes) ? affixes : []) {
    if (!entry || !entry.affixId) {
      continue;
    }
    if (typeof filterFn === "function" && !filterFn(entry)) {
      continue;
    }
    counts[entry.affixId] = (counts[entry.affixId] || 0) + 1;
  }

  return counts;
}

function getFamilyForAffix(affixId, env) {
  const affix = env && env.affixMap ? env.affixMap[affixId] : null;
  return affix && affix.family ? affix.family : "";
}

function getCategorySignatureForAffix(affixId, env) {
  const affix = env && env.affixMap ? env.affixMap[affixId] : null;
  const categories = affix && Array.isArray(affix.categories)
    ? affix.categories.slice().sort().join("&")
    : "";
  const family = getFamilyForAffix(affixId, env);
  return family ? `${categories}::${family}` : categories;
}

function getTotalRequiredGACount(env) {
  return 0;
}

function getMissingTargetAffixIdsV2(state, env) {
  const stateCounts = getAffixCountsV2(state && state.affixes);
  const missing = [];

  for (const [affixId, requiredCount] of Object.entries(env && env.targetCounts ? env.targetCounts : {})) {
    const have = stateCounts[affixId] || 0;
    for (let index = have; index < requiredCount; index += 1) {
      missing.push(affixId);
    }
  }

  return missing;
}

function getMatchedTargetFlagsV2(state, env) {
  const seenCounts = Object.create(null);

  return (state && Array.isArray(state.affixes) ? state.affixes : []).map((entry) => {
    if (!entry || !entry.affixId || !(env.targetCounts[entry.affixId] || 0)) {
      return false;
    }

    const nextSeen = (seenCounts[entry.affixId] || 0) + 1;
    seenCounts[entry.affixId] = nextSeen;
    return nextSeen <= env.targetCounts[entry.affixId];
  });
}

function getMissingRequiredGAIdsV2(state, env) {
  const missing = [];

  return missing;
}

function hasDuplicateAffixIdsV2(state) {
  return Object.values(getAffixCountsV2(state && state.affixes)).some((count) => count > 1);
}

function isSymmetricTrashEntry(entry, state, env) {
  if (!entry || !entry.affixId || entry.isGA || entry.isEnchanted) {
    return false;
  }

  if ((env.targetCounts[entry.affixId] || 0) > 0) {
    return false;
  }

  const unsatisfactoryCounts = getUnsatisfactoryCounts(state);
  return (unsatisfactoryCounts[entry.affixId] || 0) === 0;
}

function getAffixTokenForStateKey(entry, state, env) {
  if (env && isSymmetricTrashEntry(entry, state, env)) {
    return `trash<${getCategorySignatureForAffix(entry.affixId, env)}>`;
  }

  return entry.affixId;
}

function stateKeyV2(state, env = null) {
  const tokens = sortAffixEntries((state && state.affixes) || [])
    .map((entry) => `${getAffixTokenForStateKey(entry, state, env)}|${entry.isGA ? 1 : 0}|${entry.isEnchanted ? 1 : 0}`);
  const unsatisfactory = Array.isArray(state && state.unsatisfactoryAffixIds)
    ? state.unsatisfactoryAffixIds.slice().sort().join(",")
    : "";
  return [
    `L${state && state.isLegendary ? 1 : 0}`,
    `S${(state && state.gearSlot) || "Any"}`,
    `C${(state && state.class) || "Any"}`,
    `A${tokens.join(",")}`,
    `U${unsatisfactory}`,
  ].join("#");
}

function canonicalizeUnsatisfactoryIds(state) {
  const next = cloneStateV2(state);
  const presentCounts = Object.create(null);
  for (const entry of next.affixes) {
    presentCounts[entry.affixId] = (presentCounts[entry.affixId] || 0) + 1;
  }

  const unsatisfactoryCounts = Object.create(null);
  for (const affixId of Array.isArray(next.unsatisfactoryAffixIds) ? next.unsatisfactoryAffixIds : []) {
    if (!affixId) {
      continue;
    }
    const used = unsatisfactoryCounts[affixId] || 0;
    if (used >= (presentCounts[affixId] || 0)) {
      continue;
    }
    unsatisfactoryCounts[affixId] = used + 1;
  }

  next.unsatisfactoryAffixIds = Object.entries(unsatisfactoryCounts)
    .flatMap(([affixId, count]) => Array.from({ length: count }, () => affixId))
    .sort();
  next.affixes = sortAffixEntries(next.affixes);
  return next;
}

function buildEnvV2(data, gaConfig, target) {
  const env = buildEnv(data, gaConfig, target);
  env.unsatisfactoryCounts = Object.create(null);
  for (const affixId of normalizeUnsatisfactoryAffixIds(gaConfig)) {
    env.unsatisfactoryCounts[affixId] = (env.unsatisfactoryCounts[affixId] || 0) + 1;
  }
  env.stateLimit = EXACT_SSP_STATE_LIMIT;
  env.maxIterations = EXACT_SSP_MAX_ITERATIONS;
  env.epsilon = EXACT_SSP_EPSILON;
  env.totalRequiredGACount = getTotalRequiredGACount(env);
  env.sourceTotalGACount = Array.isArray(gaConfig && gaConfig.currentGAAffixes)
    ? gaConfig.currentGAAffixes.filter(Boolean).length
    : 0;
  env.impossibleTargetGAReason = getStaticImpossibleReasonV2(env);
  return env;
}

function getStaticImpossibleReasonV2(env) {
  const familyCounts = Object.create(null);

  for (const [affixId, count] of Object.entries(env && env.targetCounts ? env.targetCounts : {})) {
    const family = getFamilyForAffix(affixId, env);
    if (!family) {
      continue;
    }
    familyCounts[family] = (familyCounts[family] || 0) + count;
  }

  for (const [family, total] of Object.entries(familyCounts)) {
    if (total > 1 && FAMILY_LIMIT_MESSAGES[family]) {
      return FAMILY_LIMIT_MESSAGES[family];
    }
  }

  if ((env && env.sourceTotalGACount) < (env && env.totalRequiredGACount)) {
    const need = env.totalRequiredGACount;
    const have = env.sourceTotalGACount;
    const slotWord = need === 1 ? "slot" : "slots";
    return `Impossible target: requires ${need} Greater Affix ${slotWord}, but the source item only has ${have}.`;
  }

  return "";
}

function terminalSummaryV2() {
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

function getUnsatisfactoryCounts(state) {
  const counts = Object.create(null);
  for (const affixId of Array.isArray(state && state.unsatisfactoryAffixIds) ? state.unsatisfactoryAffixIds : []) {
    counts[affixId] = (counts[affixId] || 0) + 1;
  }
  return counts;
}

function isSuccessStateV2(state, target, env) {
  if (((state && state.unsatisfactoryAffixIds) || []).length > 0) {
    return false;
  }

  const stateCounts = getAffixCountsV2(state && state.affixes);

  for (const requirement of (target && Array.isArray(target.affixes)) ? target.affixes : []) {
    if (!requirement || !requirement.affixId) {
      continue;
    }
    if ((stateCounts[requirement.affixId] || 0) < 1) {
      return false;
    }
  }

  return true;
}

function classifyDeadReason(state, target, env) {
  if (env.impossibleTargetGAReason) {
    return env.impossibleTargetGAReason;
  }

  if (hasDuplicateAffixIdsV2(state)) {
    return "Duplicate affixes are not allowed on an item.";
  }

  if (getAffixCountsV2(state && state.affixes, (entry) => !!entry.isGA) && getAffixCountsV2(state && state.affixes, (entry) => !!entry.isGA)) {
    const currentTotalGA = (state && Array.isArray(state.affixes) ? state.affixes : [])
      .filter((entry) => entry && entry.isGA)
      .length;
    if (currentTotalGA < env.totalRequiredGACount) {
      return "Too few Greater Affix slots remain to satisfy the target.";
    }
  }

  const missingRequiredGAIds = getMissingRequiredGAIdsV2(state, env);
  if (missingRequiredGAIds.length > 0) {
    // Greater Affixes can never be acquired by any cube or enchant operation
    // (re-enchant produces non-GA when the affix changes; same-affix re-enchant
    // is a no-op). A missing required GA is therefore unrecoverable.
    return "A required target GA is missing and cannot be restored by any operation.";
  }

  if (Array.isArray(state.unsatisfactoryAffixIds) && state.unsatisfactoryAffixIds.length > 0) {
    const unsatisfactoryCounts = getUnsatisfactoryCounts(state);
    for (const [affixId, count] of Object.entries(unsatisfactoryCounts)) {
      const hasTarget = target.affixes.some((entry) => entry.affixId === affixId);
      if (!hasTarget) {
        continue;
      }
      const matchingEntries = state.affixes.filter((entry) => entry.affixId === affixId);
      // A slot only counts as truly locked when it's enchanted AND GA — that's
      // the one configuration the new model can't re-roll (re-enchanting an
      // enchanted+GA slot is forbidden because changing the affix would destroy
      // the GA, and same-affix re-enchant is a no-op).
      const lockedCount = matchingEntries.filter((entry) => entry.isEnchanted && entry.isGA).length;
      if (lockedCount >= count) {
        return `${affixName(affixId, env)} still needs improvement but the slot is locked.`;
      }
    }
  }

  return "";
}

function isDeadStateV2(state, target, env) {
  return !!classifyDeadReason(state, target, env);
}

function normalizeOutcomeStateV2(state) {
  return canonicalizeUnsatisfactoryIds(state);
}

function markUnsatisfactoryTransition(prevState, nextState, action, env) {
  const next = cloneStateV2(nextState);
  const priorCounts = getUnsatisfactoryCounts(prevState);

  if (!Object.keys(priorCounts).length) {
    return normalizeOutcomeStateV2(next);
  }

  const nextCounts = getAffixCountsV2(next.affixes);
  const remaining = [];

  for (const [affixId, count] of Object.entries(priorCounts)) {
    let keepCount = Math.min(count, nextCounts[affixId] || 0);

    if (action.type === "enchant" && action.targetAffixId === affixId) {
      keepCount = 0;
    }

    if (action.type !== "enchant" && isCubeAction(action) && keepCount > 0) {
      const nextMatching = next.affixes.filter((entry) => entry.affixId === affixId);
      const unlocked = nextMatching.filter((entry) => !entry.isEnchanted).length;
      keepCount = Math.min(keepCount, unlocked);
    }

    for (let index = 0; index < keepCount; index += 1) {
      remaining.push(affixId);
    }
  }

  next.unsatisfactoryAffixIds = remaining.sort();
  return normalizeOutcomeStateV2(next);
}

function isDisposableEnchantSource(state, sourceIndex, env) {
  const entry = state && Array.isArray(state.affixes) ? state.affixes[sourceIndex] : null;
  if (!entry || entry.isEnchanted) {
    return false;
  }

  const stateCounts = getAffixCountsV2(state.affixes);

  if (((stateCounts[entry.affixId] || 0) - 1) < (env.targetCounts[entry.affixId] || 0)) {
    return false;
  }

  return true;
}

function getGADonorSourceIndexes(state, env) {
  const indexes = [];

  for (let index = 0; index < (state && Array.isArray(state.affixes) ? state.affixes.length : 0); index += 1) {
    const entry = state.affixes[index];
    if (!entry || !entry.isGA || entry.isEnchanted) {
      continue;
    }
    if (!isDisposableEnchantSource(state, index, env)) {
      continue;
    }
    indexes.push(index);
  }

  return indexes;
}

function getForcedGAEnchantActions(state, env) {
  // Fresh enchant is required to supply a "GA donor" action — once any slot
  // is enchanted, the sticky-slot rule forbids enchanting a different slot.
  if ((state.affixes || []).some((entry) => entry.isEnchanted)) {
    return [];
  }

  const missingRequiredGAIds = getMissingRequiredGAIdsV2(state, env);
  if (missingRequiredGAIds.length !== 1) {
    return [];
  }

  return getGADonorSourceIndexes(state, env).map((sourceIndex) => ({
    type: "enchant",
    sourceIndex,
    targetAffixId: missingRequiredGAIds[0],
  }));
}

function getLateEnchantActions(state, target, env, actions) {
  // Same sticky-slot restriction as getForcedGAEnchantActions.
  if ((state.affixes || []).some((entry) => entry.isEnchanted)) {
    return [];
  }

  const missingTargetIds = getMissingTargetAffixIdsV2(state, env);
  const unsatisfactoryIds = Array.isArray(state.unsatisfactoryAffixIds)
    ? state.unsatisfactoryAffixIds.slice()
    : [];
  const unresolvedIds = Array.from(new Set([...missingTargetIds, ...unsatisfactoryIds]));

  if (unresolvedIds.length !== 1) {
    return [];
  }

  const targetAffixId = unresolvedIds[0];
  const unsatisfactoryOnly = unsatisfactoryIds.includes(targetAffixId) && missingTargetIds.length === 0;

  return actions.filter((action) => {
    if (!action || action.type !== "enchant" || action.targetAffixId !== targetAffixId) {
      return false;
    }

    if (!Number.isInteger(action.sourceIndex)) {
      return false;
    }

    const entry = state.affixes[action.sourceIndex];
    if (!entry || entry.isEnchanted) {
      return false;
    }

    if (entry.affixId === targetAffixId && !unsatisfactoryOnly) {
      return false;
    }

    if (unsatisfactoryOnly) {
      return entry.affixId === targetAffixId;
    }

    return isDisposableEnchantSource(state, action.sourceIndex, env);
  });
}

function getRelevantAddPrismsV2(state, env) {
  const prisms = new Set();

  for (const affixId of getMissingTargetAffixIdsV2(state, env)) {
    const affix = env && env.affixMap ? env.affixMap[affixId] : null;
    for (const category of affix && Array.isArray(affix.categories) ? affix.categories : []) {
      prisms.add(category);
    }
  }

  return prisms;
}

function dedupeActions(actions) {
  const seen = new Set();
  const deduped = [];

  for (const action of actions) {
    const key = actionKey(action);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(action);
  }

  return deduped;
}

function getValidActionsV2(state, target, env) {
  const relevantAddPrisms = getRelevantAddPrismsV2(state, env);
  const actions = getValidActions(state, target, env)
    .filter((action) => {
      if (action && action.type === "add") {
        return relevantAddPrisms.has(action.prism);
      }

      if (!action || action.type !== "enchant") {
        return true;
      }
      if (!Number.isInteger(action.sourceIndex)) {
        return false;
      }
      const entry = state && Array.isArray(state.affixes) ? state.affixes[action.sourceIndex] : null;
      if (!entry) {
        return false;
      }
      // Re-enchanting the existing enchanted slot is legal under the new
      // model as long as it is not GA; the base worker already enforces both
      // rules in its enchant generation. v2 piggybacks on that and only adds
      // its own GA-donor/late-enchant supplements below.
      return action.targetAffixId !== entry.affixId;
    });

  const forcedGAEnchantActions = getForcedGAEnchantActions(state, env);
  if (forcedGAEnchantActions.length > 0) {
    return dedupeActions(forcedGAEnchantActions);
  }

  const lateEnchantActions = getLateEnchantActions(state, target, env, actions);

  // Prism-unblock enchants: same-affix fresh enchant on each un-enchanted
  // slot that either (a) is a protected GA or (b) is a non-GA matched-target
  // slot whose affix appears in env.targetCounts.  The base getValidActions
  // generates these actions, but the same-affix filter above strips them
  // (line ~2299).  They must be re-added here because they have material
  // effects that the solver cannot discover otherwise:
  //
  //   (a) Protected-GA slots:
  //       1. Locking the GA slot (isEnchanted=true) excludes it from
  //          getEligibleByCategory, which un-blocks cube rerolls in the same
  //          prism category that were previously forbidden by the strictMode
  //          touchesGA guard.  When the GA affix belongs to, say, the
  //          Protector category, Protector chaotic rerolls are entirely
  //          blocked until the slot is enchanted.  The solver cannot find the
  //          optimal "enchant GA first, then chaotic-reroll Protector"
  //          sequence if this action is absent from the graph.
  //       2. When the GA slot also carries a "Needs Improvement" marker, this
  //          is the only legal action that both clears the NI and preserves
  //          the GA.  The late-enchant path only fires when exactly one target
  //          remains unresolved, so multi-target scenarios need this
  //          unconditional path.
  //
  //   (b) Non-GA matched-target slots:
  //       isCategoryFocusedBlockedByMatchedTargetV3 returns true (blocking
  //       closed-form Cases B, C, F, G) when an un-enchanted matched-target
  //       slot shares its prism category with a missing target.  It returns
  //       false when that slot has isEnchanted=true.  Enchanting such a slot
  //       in place therefore unlocks the affected prism for cube ops, enabling
  //       the solver to discover the optimal "enchant non-GA target first,
  //       then reroll the now-unblocked prism" sequence.  Without this action
  //       in the graph the blocked prism appears permanently closed and the
  //       solver underestimates its options.
  //
  // Only fresh enchants are relevant (once any slot is enchanted the
  // sticky-slot rule prevents enchanting any other slot).
  const prismUnblockEnchants = [];
  if (!(state.affixes || []).some((e) => e.isEnchanted)) {
    for (let i = 0; i < (state.affixes || []).length; i++) {
      const entry = (state.affixes || [])[i];
      if (
        entry &&
        entry.affixId &&
        (isProtectedGA(entry, env) ||
          (!entry.isGA && (env.targetCounts[entry.affixId] || 0) > 0))
      ) {
        prismUnblockEnchants.push({ type: "enchant", sourceIndex: i, targetAffixId: entry.affixId });
      }
    }
  }

  return dedupeActions([
    ...actions.filter((action) => action.type !== "enchant"),
    ...lateEnchantActions,
    ...prismUnblockEnchants,
  ]);
}

function getActionOutcomesV2(state, action, env) {
  const merged = new Map();
  let totalProbability = 0;

  for (const outcome of getActionOutcomes(state, action, env)) {
    const nextState = markUnsatisfactoryTransition(state, outcome.state, action, env);
    if (hasDuplicateAffixIdsV2(nextState)) {
      continue;
    }

    const key = stateKeyV2(nextState, env);
    const existing = merged.get(key);
    if (existing) {
      existing.probability += outcome.probability;
      totalProbability += outcome.probability;
      continue;
    }

    merged.set(key, {
      probability: outcome.probability,
      state: nextState,
    });
    totalProbability += outcome.probability;
  }

  if (totalProbability <= EXACT_SSP_EPSILON) {
    return [];
  }

  return Array.from(merged.values()).map((entry) => ({
    probability: entry.probability / totalProbability,
    state: entry.state,
  }));
}

function compareCandidates(left, right) {
  const leftSuccess = Number.isFinite(left.successProb) ? left.successProb : -1;
  const rightSuccess = Number.isFinite(right.successProb) ? right.successProb : -1;
  if (Math.abs(leftSuccess - rightSuccess) > EXACT_SSP_ACTION_EPSILON) {
    return rightSuccess - leftSuccess;
  }

  const leftSteps = Number.isFinite(left.expectedSteps) ? left.expectedSteps : Infinity;
  const rightSteps = Number.isFinite(right.expectedSteps) ? right.expectedSteps : Infinity;
  if (Math.abs(leftSteps - rightSteps) > EXACT_SSP_ACTION_EPSILON) {
    return leftSteps - rightSteps;
  }

  return actionKey(left.action).localeCompare(actionKey(right.action));
}

function getResolvedActionSuccess(entry, stateIndex, values) {
  let selfProbability = 0;
  let leaveSuccess = 0;

  for (const transition of entry.transitions) {
    if (transition.childIndex === stateIndex) {
      selfProbability += transition.probability;
      continue;
    }
    leaveSuccess += transition.probability * values[transition.childIndex];
  }

  const leaveProbability = 1 - selfProbability;
  if (leaveProbability <= EXACT_SSP_EPSILON) {
    return 0;
  }

  const candidate = leaveSuccess / leaveProbability;
  return Math.max(0, Math.min(1, candidate));
}

function getResolvedActionWeightedCost(entry, stateIndex, optimalSuccess, costs) {
  let selfProbability = 0;
  let leaveWeightedCost = 0;

  for (const transition of entry.transitions) {
    if (transition.childIndex === stateIndex) {
      selfProbability += transition.probability;
      continue;
    }
    leaveWeightedCost += transition.probability * costs[transition.childIndex];
  }

  const leaveProbability = 1 - selfProbability;
  if (leaveProbability <= EXACT_SSP_EPSILON) {
    return Infinity;
  }

  return (entry.cubeCost * optimalSuccess + leaveWeightedCost) / leaveProbability;
}

function getStepEstimateReason(phase1, phase2, env) {
  const blockedPhases = [];

  if (!phase1 || !phase1.converged) {
    blockedPhases.push("phase 1");
  }
  if (!phase2 || !phase2.converged) {
    blockedPhases.push("phase 2");
  }

  if (blockedPhases.length === 0) {
    return "";
  }

  return `Expected cube steps unavailable: ${blockedPhases.join(" and ")} did not converge within ${env.maxIterations} iterations.`;
}

function solvePhase1(graph, env) {
  const values = new Float64Array(graph.nodes.length);
  for (let index = 0; index < graph.nodes.length; index += 1) {
    if (graph.nodes[index].success) {
      values[index] = 1;
    }
  }

  let converged = false;
  let iterations = 0;
  let residual = Infinity;
  for (; iterations < env.maxIterations; iterations += 1) {
    let maxDelta = 0;
    for (let index = 0; index < graph.nodes.length; index += 1) {
      const node = graph.nodes[index];
      if (node.success) {
        continue;
      }
      if (node.deadReason) {
        values[index] = 0;
        continue;
      }

      let best = 0;
      for (const entry of node.actionEntries) {
        const candidate = getResolvedActionSuccess(entry, index, values);
        if (candidate > best) {
          best = candidate;
        }
      }

      maxDelta = Math.max(maxDelta, Math.abs(best - values[index]));
      values[index] = best;
    }

    residual = maxDelta;

    if (maxDelta < env.epsilon) {
      iterations += 1;
      converged = true;
      break;
    }
  }

  return { values, iterations, converged, residual };
}

function solvePhase2(graph, phase1, env) {
  const costs = new Float64Array(graph.nodes.length);

  let converged = false;
  let iterations = 0;
  let residual = Infinity;
  for (; iterations < env.maxIterations; iterations += 1) {
    let maxDelta = 0;

    for (let index = 0; index < graph.nodes.length; index += 1) {
      const node = graph.nodes[index];
      if (node.success || node.deadReason) {
        costs[index] = 0;
        continue;
      }

      const optimalSuccess = phase1.values[index];
      if (optimalSuccess <= env.epsilon) {
        costs[index] = 0;
        continue;
      }

      let best = Infinity;
      for (const entry of node.actionEntries) {
        const success = getResolvedActionSuccess(entry, index, phase1.values);

        if (Math.abs(success - optimalSuccess) > EXACT_SSP_ACTION_EPSILON) {
          continue;
        }

        const candidate = getResolvedActionWeightedCost(entry, index, optimalSuccess, costs);
        if (candidate < best) {
          best = candidate;
        }
      }

      const nextValue = Number.isFinite(best) ? best : 0;
      maxDelta = Math.max(maxDelta, Math.abs(nextValue - costs[index]));
      costs[index] = nextValue;
    }

    residual = maxDelta;

    if (maxDelta < env.epsilon) {
      iterations += 1;
      converged = true;
      break;
    }
  }

  return { costs, iterations, converged, residual };
}

function summarizeRootV2(graph, rootKey, env, target, phase1, phase2, options = {}) {
  const rootIndex = graph.nodes.findIndex((node) => node.key === rootKey);
  const root = rootIndex >= 0 ? graph.nodes[rootIndex] : null;
  if (!root) {
    return emptySummary("Exact solver root state was not found.");
  }

  if (root.success) {
    const result = terminalSummaryV2();
    result.diagnostics.strategy = "exact-ssp";
    result.diagnostics.expandedStates = graph.nodes.length;
    result.diagnostics.deadStates = graph.deadStates;
    return result;
  }

  if (root.deadReason) {
    const result = emptySummary(root.deadReason);
    result.diagnostics.strategy = "exact-ssp";
    result.diagnostics.expandedStates = graph.nodes.length;
    result.diagnostics.deadStates = graph.deadStates;
    return result;
  }

  const stepEstimateReason = getStepEstimateReason(phase1, phase2, env);
  const stepEstimatesReliable = !stepEstimateReason;
  const candidateActions = root.actionEntries.map((entry) => {
    const successProb = getResolvedActionSuccess(entry, rootIndex, phase1.values);
    let expectedSteps = null;

    if (stepEstimatesReliable && successProb > env.epsilon) {
      const weighted = getResolvedActionWeightedCost(entry, rootIndex, successProb, phase2.costs);
      expectedSteps = Number.isFinite(weighted)
        ? weighted / successProb
        : null;
    }

    const breakdown = getActionProbabilityBreakdown(root.state, entry.action, env);

    return {
      action: entry.action,
      visits: 0,
      successProb,
      expectedSteps,
      rank: successProb,
      probabilityBreakdown: breakdown.outcomes,
      sourceBreakdown: breakdown.sources,
    };
  }).sort(compareCandidates);

  const best = candidateActions[0] || null;
  return {
    action: best ? best.action : null,
    successProb: phase1.values[rootIndex],
    expectedSteps: stepEstimatesReliable && phase1.values[rootIndex] > env.epsilon
      ? phase2.costs[rootIndex] / phase1.values[rootIndex]
      : null,
    variance: null,
    stdDev: null,
    oneStepRisk: best
      ? getOneStepTargetLossRisk(root.state, best.action, env, target)
      : [],
    diagnostics: {
      reason: best ? null : (root.deadReason || "No valid action from current state."),
      rootVisits: 0,
      strategy: "exact-ssp",
      expandedStates: graph.nodes.length,
      deadStates: graph.deadStates,
      phase1Iterations: phase1.iterations,
      phase2Iterations: phase2.iterations,
      phase1Converged: !!phase1.converged,
      phase2Converged: !!phase2.converged,
      stepEstimatesReliable,
      candidateActions: candidateActions.slice(0, 6),
      ...(stepEstimateReason ? { stepEstimateReason } : {}),
      ...(options.reason ? { note: options.reason } : {}),
    },
  };
}

// (v2 module.exports removed — merged into v3 module.exports at the bottom)


// =================  v3-specific logic  ============================
const RESIDUAL_STATE_LIMIT_PER_SECOND = 50;
const RESIDUAL_MAX_ITERATIONS_PER_SECOND = 32768;
const APPROX_COMPARE_SUCCESS_EPSILON = 1e-9;
const APPROX_COMPARE_STEPS_EPSILON = 1e-9;
const ILP_APPROX_BOUND_GAP_THRESHOLD = 0.25;

function normalizeIdList(list) {
  return Array.from(new Set(
    (Array.isArray(list) ? list : [])
      .filter((value) => typeof value === "string" && value)
  )).sort();
}

function getCurrentAffixes(state) {
  return Array.isArray(state && state.affixes)
    ? state.affixes.filter((entry) => entry && entry.affixId)
    : [];
}

function getTargetEntries(target) {
  return Array.isArray(target && target.affixes)
    ? target.affixes.filter((entry) => entry && typeof entry.affixId === "string" && entry.affixId)
    : [];
}

function getHostEntryV3(state, slotIndex) {
  const affixes = getCurrentAffixes(state);
  return Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < affixes.length
    ? affixes[slotIndex]
    : null;
}

function getCurrentGACountsV3(state) {
  const counts = Object.create(null);

  for (const entry of getCurrentAffixes(state)) {
    if (!entry.isGA) {
      continue;
    }
    counts[entry.affixId] = (counts[entry.affixId] || 0) + 1;
  }

  return counts;
}

function getTotalCurrentGACountV3(state) {
  return getCurrentAffixes(state).filter((entry) => entry.isGA).length;
}

function getImproveAffixIdsV3(target, gaConfig) {
  const targetImproves = getTargetEntries(target)
    .filter((entry) => !!entry.needsImprovement)
    .map((entry) => entry.affixId);
  const gaConfigImproves = Array.isArray(gaConfig && gaConfig.unsatisfactoryAffixIds)
    ? gaConfig.unsatisfactoryAffixIds
    : [];

  return new Set(normalizeIdList([...targetImproves, ...gaConfigImproves]));
}

function getForbiddenAffixIdsV3(target, gaConfig) {
  return new Set(normalizeIdList([
    ...((target && Array.isArray(target.forbiddenAffixIds)) ? target.forbiddenAffixIds : []),
    ...((gaConfig && Array.isArray(gaConfig.forbiddenAffixIds)) ? gaConfig.forbiddenAffixIds : []),
  ]));
}

function getProtectedAffixIdsV3(target, gaConfig) {
  return new Set(normalizeIdList([
    ...((target && Array.isArray(target.protectedAffixIds)) ? target.protectedAffixIds : []),
    ...((gaConfig && Array.isArray(gaConfig.protectedAffixIds)) ? gaConfig.protectedAffixIds : []),
  ]));
}

function getMaxAffixSlotsV3(state, data) {
  const configured = Number(data && data.maxAffixSlots);
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }

  const stateCapacity = Number(state && state.maxAffixSlots);
  if (Number.isInteger(stateCapacity) && stateCapacity > 0) {
    return stateCapacity;
  }

  return DEFAULT_MAX_AFFIX_SLOTS;
}

function getAffixFamilyV3(affixId, env) {
  const affix = env && env.affixMap ? env.affixMap[affixId] : null;
  if (affix && affix.family) {
    return affix.family;
  }
  if (typeof affixId !== "string") {
    return "";
  }
  if (affixId === "elemental-damage-other" || affixId.startsWith("elemental-damage-")) {
    return "elemental-damage";
  }
  if (affixId === "specific-resistance-other" || affixId.startsWith("specific-resistance-")) {
    return "specific-resistance";
  }
  return "";
}

function getAffixCategoriesV3(affixId, env) {
  const affix = env && env.affixMap ? env.affixMap[affixId] : null;
  return affix && Array.isArray(affix.categories)
    ? affix.categories.slice().sort()
    : [];
}

function getAffixCategoriesForOpV3(affixId, operationType, env) {
  const affix = env && env.affixMap ? env.affixMap[affixId] : null;
  if (
    affix
    && operationType
    && affix.operationCategories
    && Array.isArray(affix.operationCategories[operationType])
  ) {
    return affix.operationCategories[operationType].slice().sort();
  }
  return affix && Array.isArray(affix.categories) ? affix.categories.slice().sort() : [];
}

function affixHasCategoryV3(affixId, category, env, operationType) {
  return getAffixCategoriesForOpV3(affixId, operationType || null, env).includes(category);
}

function affixSupportsClassV3(affix, className) {
  if (!affix) {
    return false;
  }
  if (!className || className === "Any") {
    return true;
  }
  const affixClass = affix.class;
  if (!affixClass || affixClass === "Any") {
    return true;
  }
  return affixClass === className;
}

function isAffixLegalForStateV3(affixId, state, env) {
  const affix = env && env.affixMap ? env.affixMap[affixId] : null;
  if (!affix) {
    return false;
  }

  const className = (state && state.class) || "Any";
  if (!affixSupportsClassV3(affix, className)) {
    return false;
  }

  const legalSlots = Array.isArray(affix.gearSlots) ? affix.gearSlots : null;
  const gearSlot = (state && state.gearSlot) || "Any";
  if (!legalSlots || gearSlot === "Any") {
    return true;
  }

  return legalSlots.includes("Any") || legalSlots.includes(gearSlot);
}

function getCategoryAffixesForStateV3(state, category, env, operationType) {
  const gearSlot = (state && state.gearSlot) || "Any";
  const className = (state && state.class) || "Any";
  let base;

  const bySlotByClass = env
    && env.categoryAffixesBySlotByClass
    && env.categoryAffixesBySlotByClass[gearSlot]
    && env.categoryAffixesBySlotByClass[gearSlot][className];
  if (bySlotByClass && Array.isArray(bySlotByClass[category])) {
    base = bySlotByClass[category];
  } else if (gearSlot === "Any" && className === "Any") {
    base = env && env.categoryAffixes ? (env.categoryAffixes[category] || []) : [];
  } else {
    const bySlot = env && env.categoryAffixesBySlot ? env.categoryAffixesBySlot[gearSlot] : null;
    const slotBase = bySlot && Array.isArray(bySlot[category])
      ? bySlot[category]
      : (env && env.categoryAffixes ? (env.categoryAffixes[category] || []) : [])
          .filter((affix) => {
            const legalSlots = Array.isArray(affix.gearSlots) ? affix.gearSlots : null;
            if (!legalSlots || gearSlot === "Any") {
              return true;
            }
            return legalSlots.includes("Any") || legalSlots.includes(gearSlot);
          });
    base = slotBase.filter((affix) => affixSupportsClassV3(affix, className));
  }

  if (!operationType) {
    return base;
  }
  return base.filter((affix) => getAffixCategoriesForOpV3(affix.id, operationType, env).includes(category));
}

function getCategoryPoolSizeV3(state, category, env, operationType) {
  const affixes = getCategoryAffixesForStateV3(state, category, env, operationType);
  return Array.isArray(affixes) ? affixes.length : 0;
}

function countPresentAffixesInCategoryV3(state, category, env, options = {}) {
  const ignoreIndex = Number.isInteger(options.ignoreIndex) ? options.ignoreIndex : -1;
  const operationType = options.operationType || null;
  let count = 0;

  getCurrentAffixes(state).forEach((entry, index) => {
    if (index === ignoreIndex) {
      return;
    }
    if (affixHasCategoryV3(entry.affixId, category, env, operationType)) {
      count += 1;
    }
  });

  return count;
}

function getCategorySuccessDenominatorV3(state, category, env, options = {}) {
  const operationType = options.operationType || null;
  const poolSize = getCategoryPoolSizeV3(state, category, env, operationType);
  const presentCount = countPresentAffixesInCategoryV3(state, category, env, options);
  return Math.max(0, poolSize - presentCount);
}


// Returns true when using `prism` for a focused/chaotic/remove cube action
// would randomly put a protected GA at risk because that GA's affix is also
// in the prism's category for the "focused" operation type.
// Cases B, C, F, G must skip prisms for which this returns true.
function isCategoryFocusedBlockedByGAV3(state, prism, env) {
  if (!env || !env.strictMode || !env.gaRequiredCounts) { return false; }
  return getCurrentAffixes(state).some((entry) => {
    if (!entry.isGA || entry.isEnchanted) { return false; }
    if (!(env.gaRequiredCounts[entry.affixId] > 0)) { return false; }
    return affixHasCategoryV3(entry.affixId, prism, env, "focused");
  });
}

// Returns true when any non-enchanted target affix (other than the slot being intentionally
// rerolled at excludeSlotIndex) shares the prism category for the "focused" operation type.
// A focused reroll randomly selects from ALL eligible slots, so a matched target in the same
// category would be endangered — the closed-form formula (which assumes deterministic selection)
// must not be used in that scenario. Cases B, C, F, G must skip prisms for which this returns true.
function isCategoryFocusedBlockedByMatchedTargetV3(state, prism, env, excludeSlotIndex) {
  if (!env || !env.targetCounts) { return false; }
  return getCurrentAffixes(state).some((entry, index) => {
    if (index === excludeSlotIndex) { return false; }
    if (entry.isEnchanted) { return false; }
    if (!(env.targetCounts[entry.affixId] > 0)) { return false; }
    return affixHasCategoryV3(entry.affixId, prism, env, "focused");
  });
}

function isUniqueUnlockedCategoryHostV3(state, slotIndex, category, env, operationType) {
  const matches = [];

  getCurrentAffixes(state).forEach((entry, index) => {
    if (entry.isEnchanted) {
      return;
    }
    if (!affixHasCategoryV3(entry.affixId, category, env, operationType || null)) {
      return;
    }
    matches.push(index);
  });

  return matches.length === 1 && matches[0] === slotIndex;
}

// Bug 1 (over-estimate): when no slot is currently enchanted, the optimal
// policy after Add(prism) into an empty slot is to Enchant that slot to the
// target affix (deterministic, 1 extra step) if the Add doesn't land on
// target directly. Cost: 1 (Add) + ((n-1)/n) × 1 (Enchant) = 2 - 1/n,
// substantially tighter than the default geometric retry model n - 1 + 1/n.
function canUseEnchantFollowUpAfterAddV3(state, env, targetAffixId) {
  if (!state || !env || !targetAffixId) return false;
  // Sticky-slot rule: once any slot is enchanted, no other slot can be enchanted.
  if (getCurrentAffixes(state).some((entry) => entry.isEnchanted)) return false;
  // The target affix must be legal for the slot/class (i.e. enchant-eligible).
  return isAffixLegalForStateV3(targetAffixId, state, env);
}

// Bug 2 (under-estimate): when the Bug-1 fix path is unavailable (a slot IS
// enchanted) AND another non-enchanted slot is a matched-target whose affix
// shares the prism's category, recovery from a wrong Add via
// Focused/Chaotic/Remove(prism) would risk destroying the matched target.
// The actual recovery cost is high and Case A's n-1+1/n formula significantly
// under-estimates it. We don't try to fix the formula (analytically
// intractable for the recovery sub-policy) — we just flag the candidate as
// `looseEstimate: true` so the UI can warn the user.
function isCaseAStuckRecoveryRiskV3(state, target, env, prism) {
  if (!state || !target || !env || !prism) return false;
  if (!getCurrentAffixes(state).some((entry) => entry.isEnchanted)) return false;
  const targetIds = new Set(
    (target.affixes || []).map((entry) => entry.affixId).filter(Boolean)
  );
  return getCurrentAffixes(state).some((entry) => {
    if (entry.isEnchanted) return false;
    if (!entry.affixId || !targetIds.has(entry.affixId)) return false;
    return affixHasCategoryV3(entry.affixId, prism, env, "focused");
  });
}

function computeCaseAExpectedStepsV3(n, context) {
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  // Bug 1 fix: when enchant-follow-up is available, the optimal policy is
  // 1 Add + (with probability (n-1)/n) 1 Enchant. Cost = 2 - 1/n.
  if (context && context.useEnchantFollowUp === true) {
    return 2 - (1 / n);
  }
  // Default: cube-retry model — 1 Add + expected (n-1) failed retries with
  // remove+add cycles, all probability-weighted.
  return n - 1 + (1 / n);
}

function computeCaseBExpectedStepsV3(n) {
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
}

function computeCaseCExpectedStepsV3(n) {
  const caseA = computeCaseAExpectedStepsV3(n);
  return Number.isFinite(caseA) ? 1 + caseA : null;
}

function computeDeterministicEnchantExpectedStepsV3() {
  return 1;
}

function createClosedFormCandidateV3(caseId, slotIndex, targetEntry, expectedSteps, extra = {}) {
  return {
    ok: true,
    caseId,
    slotIndex,
    targetAffixId: targetEntry.affixId,
    expectedSteps,
    ...extra,
  };
}

function compareClosedFormCandidatesV3(left, right) {
  const leftSteps = Number.isFinite(left.expectedSteps) ? left.expectedSteps : Infinity;
  const rightSteps = Number.isFinite(right.expectedSteps) ? right.expectedSteps : Infinity;
  if (Math.abs(leftSteps - rightSteps) > 1e-9) {
    return leftSteps - rightSteps;
  }

  const leftToken = `${left.caseId}|${left.prism || ""}|${left.removePrism || ""}`;
  const rightToken = `${right.caseId}|${right.prism || ""}|${right.removePrism || ""}`;
  return leftToken.localeCompare(rightToken);
}

function isEmptyHostSlotV3(state, slotIndex, maxAffixSlots = DEFAULT_MAX_AFFIX_SLOTS) {
  const affixes = getCurrentAffixes(state);
  return Number.isInteger(slotIndex)
    && slotIndex >= affixes.length
    && slotIndex < maxAffixSlots;
}

function isDiscretionaryEnchantSlotV3(state, target, gaConfig, slotIndex, env, options = {}) {
  const hostEntry = getHostEntryV3(state, slotIndex);
  if (!hostEntry || hostEntry.isEnchanted) {
    return false;
  }

  const protectedAffixIds = options.protectedAffixIds instanceof Set
    ? options.protectedAffixIds
    : getProtectedAffixIdsV3(target, gaConfig);
  if (protectedAffixIds.has(hostEntry.affixId)) {
    return false;
  }

  if ((env.targetCounts[hostEntry.affixId] || 0) > 0) {
    return false;
  }

  return true;
}


function getClosedFormResidualReasonV3(state, targetEntry, slotIndex, env, options = {}) {
  const maxAffixSlots = Number.isInteger(options.maxAffixSlots)
    ? options.maxAffixSlots
    : getMaxAffixSlotsV3(state, options.data || null);

  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= maxAffixSlots) {
    return "Slot index is outside the available host range.";
  }

  const hostEntry = getHostEntryV3(state, slotIndex);
  if (!hostEntry && !isEmptyHostSlotV3(state, slotIndex, maxAffixSlots)) {
    return "Host slot is not addressable in the current item shape.";
  }

  if (hostEntry && hostEntry.isEnchanted) {
    return "Host slot is already enchanted, so closed-form cube-touch cases do not apply.";
  }

  const targetCategoriesAdd = getAffixCategoriesForOpV3(targetEntry.affixId, "add", env);
  const targetCategoriesFocused = getAffixCategoriesForOpV3(targetEntry.affixId, "focused", env);
  if (targetCategoriesAdd.length === 0 && targetCategoriesFocused.length === 0) {
    return "Target affix has no legal category source in the current catalog.";
  }

  if (!hostEntry) {
    return "No closed-form empty-slot plan has positive remaining pool size.";
  }

  const sharedCategories = targetCategoriesFocused.filter(
    (category) => affixHasCategoryV3(hostEntry.affixId, category, env, "focused")
  );
  if (sharedCategories.length > 0) {
    return "Host slot shares a category with the target, but the closed-form assumptions for Cases B, F, or G are not satisfied.";
  }

  if (state.isLegendary) {
    return "Remove Affix is unavailable on Legendary items, so Case C is not applicable.";
  }

  const removableCategories = getAffixCategoriesForOpV3(hostEntry.affixId, "remove", env)
    .filter((category) => isUniqueUnlockedCategoryHostV3(state, slotIndex, category, env, "remove"));
  if (removableCategories.length === 0) {
    return "Remove would not be deterministic because the host is not the unique unlocked slot in any current category.";
  }

  return "No closed-form case applies; escalate this target-slot pair to the residual solver.";
}

function getClosedFormPlanCandidatesV3(state, targetEntry, slotIndex, env, options = {}) {
  const candidates = [];
  const maxAffixSlots = Number.isInteger(options.maxAffixSlots)
    ? options.maxAffixSlots
    : getMaxAffixSlotsV3(state, options.data || null);
  const hostEntry = getHostEntryV3(state, slotIndex);
  // Use "add"-appropriate categories for Case A (empty slot), "focused" for all reroll cases.
  const targetCategoriesAdd = getAffixCategoriesForOpV3(targetEntry.affixId, "add", env);
  const targetCategoriesFocused = getAffixCategoriesForOpV3(targetEntry.affixId, "focused", env);

  if (
    !Number.isInteger(slotIndex)
    || slotIndex < 0
    || slotIndex >= maxAffixSlots
    || (targetCategoriesAdd.length === 0 && targetCategoriesFocused.length === 0)
  ) {
    return candidates;
  }

  // A discretionary "preserve" enchant is only available when no slot is
  // already enchanted (sticky-slot rule); the existing enchanted slot is
  // covered by re-enchant actions generated elsewhere.
  const hasEnchantedSlot = !!(state && Array.isArray(state.affixes)
    && state.affixes.some((entry) => entry && entry.isEnchanted));

  if (
    hostEntry
    && options.allowDiscretionaryEnchant === true
    && !hasEnchantedSlot
    && isDiscretionaryEnchantSlotV3(state, options.target || null, options.gaConfig || null, slotIndex, env, options)
  ) {
    candidates.push(createClosedFormCandidateV3(
      CLOSED_FORM_CASE_IDS.E,
      slotIndex,
      targetEntry,
      computeDeterministicEnchantExpectedStepsV3(),
      {
        actionType: "enchant",
        sourceIndex: slotIndex,
      }
    ));
  }

  if (!hostEntry) {
    if (!isEmptyHostSlotV3(state, slotIndex, maxAffixSlots)) {
      return candidates;
    }

    for (const prism of targetCategoriesAdd) {
      const n = getCategorySuccessDenominatorV3(state, prism, env, { operationType: "add" });
      const useEnchantFollowUp = canUseEnchantFollowUpAfterAddV3(state, env, targetEntry.affixId);
      const expectedSteps = computeCaseAExpectedStepsV3(n, { useEnchantFollowUp });
      if (Number.isFinite(expectedSteps)) {
        // Stuck-recovery risk only matters when the Bug 1 fix path is NOT
        // available; the helper enforces that itself.
        const looseEstimate = isCaseAStuckRecoveryRiskV3(state, options.target, env, prism);
        candidates.push(createClosedFormCandidateV3(
          CLOSED_FORM_CASE_IDS.A,
          slotIndex,
          targetEntry,
          expectedSteps,
          { prism, denominator: n, useEnchantFollowUp, looseEstimate }
        ));
      }
    }

    return candidates.sort(compareClosedFormCandidatesV3);
  }

  if (hostEntry.isEnchanted) {
    // For non-GA enchanted slots whose current affix is not in the target
    // set, propose re-enchanting the slot directly to the missing target.
    // The model treats Enchantress re-enchant as deterministic, so this is
    // one Enchantress visit at RE_ENCHANT_TIE_BREAK_COST expected cost.
    // The decomposition ILP arbitrates this against Case A "add to empty
    // slot" candidates and picks the cheaper plan.
    if (
      !hostEntry.isGA
      // Host affix must not itself be a required target: re-enchanting would
      // lose the satisfied target and swap it for another.
      && (env.targetCounts[hostEntry.affixId] || 0) === 0
      // Target affix must not already be present on a different slot
      // (enchant cannot create a duplicate affixId on the item).
      && !getCurrentAffixes(state).some(
        (entry, idx) => idx !== slotIndex && entry && entry.affixId === targetEntry.affixId
      )
    ) {
      candidates.push(createClosedFormCandidateV3(
        CLOSED_FORM_CASE_IDS.REENCHANT,
        slotIndex,
        targetEntry,
        RE_ENCHANT_TIE_BREAK_COST,
        { actionType: "enchant", sourceIndex: slotIndex }
      ));
    }
    return candidates;
  }

  const sharedCategories = targetCategoriesFocused.filter(
    (category) => affixHasCategoryV3(hostEntry.affixId, category, env, "focused")
  );

  if (targetEntry.needsImprovement && hostEntry.affixId === targetEntry.affixId && !hostEntry.isGA) {
    for (const prism of sharedCategories) {
      if (isCategoryFocusedBlockedByGAV3(state, prism, env)) { continue; }
      if (isCategoryFocusedBlockedByMatchedTargetV3(state, prism, env, slotIndex)) { continue; }
      if (isAdeptFocusedBlocked(state, env, prism)) { continue; }
      const n = getCategorySuccessDenominatorV3(state, prism, env, { operationType: "focused" });
      const expectedSteps = options.touchOnlyImprovement
        ? 1
        : computeCaseBExpectedStepsV3(n);
      if (Number.isFinite(expectedSteps)) {
        candidates.push(createClosedFormCandidateV3(
          CLOSED_FORM_CASE_IDS.F,
          slotIndex,
          targetEntry,
          expectedSteps,
          { prism, denominator: n }
        ));
      }
    }
  }

  if (sharedCategories.length > 0 && hostEntry.affixId !== targetEntry.affixId && !hostEntry.isGA) {
    for (const prism of sharedCategories) {
      if (isCategoryFocusedBlockedByGAV3(state, prism, env)) { continue; }
      if (isCategoryFocusedBlockedByMatchedTargetV3(state, prism, env, slotIndex)) { continue; }
      if (isAdeptFocusedBlocked(state, env, prism)) { continue; }
      const n = getCategorySuccessDenominatorV3(state, prism, env, { operationType: "focused" });
      const expectedSteps = computeCaseBExpectedStepsV3(n);
      if (Number.isFinite(expectedSteps)) {
        candidates.push(createClosedFormCandidateV3(
          CLOSED_FORM_CASE_IDS.B,
          slotIndex,
          targetEntry,
          expectedSteps,
          { prism, denominator: n }
        ));
      }
    }
  }

  if (sharedCategories.length > 0 && hostEntry.isGA) {
    for (const prism of sharedCategories) {
      if (isCategoryFocusedBlockedByGAV3(state, prism, env)) { continue; }
      if (isCategoryFocusedBlockedByMatchedTargetV3(state, prism, env, slotIndex)) { continue; }
      if (isAdeptFocusedBlocked(state, env, prism)) { continue; }
      const n = getCategorySuccessDenominatorV3(state, prism, env, { operationType: "focused" });
      const expectedSteps = computeCaseBExpectedStepsV3(n);
      if (Number.isFinite(expectedSteps)) {
        candidates.push(createClosedFormCandidateV3(
          CLOSED_FORM_CASE_IDS.G,
          slotIndex,
          targetEntry,
          expectedSteps,
          { prism, denominator: n }
        ));
      }
    }
  }

  if (sharedCategories.length === 0 && !state.isLegendary) {
    const removableCategories = getAffixCategoriesForOpV3(hostEntry.affixId, "remove", env)
      .filter((category) => isUniqueUnlockedCategoryHostV3(state, slotIndex, category, env, "remove"));

    for (const removePrism of removableCategories) {
      for (const prism of targetCategoriesFocused) {
        if (isCategoryFocusedBlockedByGAV3(state, prism, env)) { continue; }
        if (isCategoryFocusedBlockedByMatchedTargetV3(state, prism, env, slotIndex)) { continue; }
        if (isAdeptFocusedBlocked(state, env, prism, slotIndex)) { continue; }
        const n = getCategorySuccessDenominatorV3(state, prism, env, { ignoreIndex: slotIndex, operationType: "focused" });
        const expectedSteps = computeCaseCExpectedStepsV3(n);
        if (Number.isFinite(expectedSteps)) {
          candidates.push(createClosedFormCandidateV3(
            CLOSED_FORM_CASE_IDS.C,
            slotIndex,
            targetEntry,
            expectedSteps,
            { prism, removePrism, denominator: n }
          ));
        }
      }
    }
  }

  return candidates.sort(compareClosedFormCandidatesV3);
}

function chooseBestClosedFormPlanV3(state, targetEntry, slotIndex, env, options = {}) {
  const candidates = getClosedFormPlanCandidatesV3(state, targetEntry, slotIndex, env, options);
  if (candidates.length > 0) {
    return candidates[0];
  }

  return {
    ok: false,
    slotIndex,
    targetAffixId: targetEntry && targetEntry.affixId ? targetEntry.affixId : "",
    residualReason: getClosedFormResidualReasonV3(state, targetEntry, slotIndex, env, options),
  };
}

function buildClosedFormPlanTableV3(state, target, data, gaConfig, options = {}) {
  const env = options.env || buildEnv(data || {}, gaConfig || {}, target || {});
  const feasibility = options.feasibility || analyzeFeasibilityV3(state, target, data, gaConfig);
  const maxAffixSlots = Number.isInteger(options.maxAffixSlots)
    ? options.maxAffixSlots
    : getMaxAffixSlotsV3(state, data);

  return getTargetEntries(target).map((targetEntry, targetIndex) => ({
    targetIndex,
    targetAffixId: targetEntry.affixId,
    slots: Array.from({ length: maxAffixSlots }, (_, slotIndex) => chooseBestClosedFormPlanV3(
      state,
      targetEntry,
      slotIndex,
      env,
      {
        ...options,
        data,
        gaConfig,
        target,
        feasibility,
        maxAffixSlots,
      }
    )),
  }));
}

function isTargetSatisfiedAtSlotV3(state, targetEntry, slotIndex) {
  const hostEntry = getHostEntryV3(state, slotIndex);
  if (!hostEntry || hostEntry.affixId !== targetEntry.affixId) {
    return false;
  }

  if (targetEntry.needsImprovement) {
    return false;
  }

  return true;
}

function createKeepPlanOptionV3(targetIndex, targetEntry, slotIndex) {
  return {
    id: `t${targetIndex}-s${slotIndex}-keep`,
    key: `t${targetIndex}|s${slotIndex}|${KEEP_PLAN_CASE_ID}`,
    targetIndex,
    targetAffixId: targetEntry.affixId,
    slotIndex,
    caseId: KEEP_PLAN_CASE_ID,
    prism: "",
    removePrism: "",
    prismDelta: 0,
    usesEnchant: false,
    costKind: "constant",
    constantCost: 0,
    baseDenominator: null,
    requiresStage: false,
    action: null,
  };
}

function getDecompositionOptionActionV3(option) {
  if (!option || option.caseId === KEEP_PLAN_CASE_ID) {
    return null;
  }

  if (option.caseId === CLOSED_FORM_CASE_IDS.A) {
    return { type: "add", prism: option.prism };
  }
  if (
    option.caseId === CLOSED_FORM_CASE_IDS.B
    || option.caseId === CLOSED_FORM_CASE_IDS.F
    || option.caseId === CLOSED_FORM_CASE_IDS.G
  ) {
    return { type: "focused", prism: option.prism };
  }
  if (option.caseId === CLOSED_FORM_CASE_IDS.C) {
    return { type: "remove", prism: option.removePrism };
  }
  if (
    option.caseId === CLOSED_FORM_CASE_IDS.D
    || option.caseId === CLOSED_FORM_CASE_IDS.E
    || option.caseId === CLOSED_FORM_CASE_IDS.REENCHANT
  ) {
    return {
      type: "enchant",
      sourceIndex: option.slotIndex,
      targetAffixId: option.targetAffixId,
    };
  }

  return null;
}

function createDecompositionOptionV3(targetIndex, targetEntry, slotIndex, candidate, state, env) {
  const hostEntry = getHostEntryV3(state, slotIndex);
  // For Case A use add-op categories; for focused-reroll cases use focused-op categories.
  const caseUsesAdd = candidate.caseId === CLOSED_FORM_CASE_IDS.A;
  const targetCategories = caseUsesAdd
    ? getAffixCategoriesForOpV3(targetEntry.affixId, "add", env)
    : getAffixCategoriesForOpV3(targetEntry.affixId, "focused", env);
  const requiresConcretePrism = (
    candidate.caseId === CLOSED_FORM_CASE_IDS.A
    || candidate.caseId === CLOSED_FORM_CASE_IDS.B
    || candidate.caseId === CLOSED_FORM_CASE_IDS.C
    || candidate.caseId === CLOSED_FORM_CASE_IDS.F
    || candidate.caseId === CLOSED_FORM_CASE_IDS.G
  );

  const prism = candidate.prism || (targetCategories.length === 1 ? targetCategories[0] : "");
  if (requiresConcretePrism && !prism) {
    return null;
  }

  const prismOpType = caseUsesAdd ? "add" : "focused";
  const prismDelta = prism && hostEntry && affixHasCategoryV3(hostEntry.affixId, prism, env, prismOpType)
    ? 0
    : prism
      ? 1
      : 0;
  const constantCase = (
    candidate.caseId === CLOSED_FORM_CASE_IDS.D
    || candidate.caseId === CLOSED_FORM_CASE_IDS.E
    || candidate.caseId === CLOSED_FORM_CASE_IDS.REENCHANT
    || (
      candidate.caseId === CLOSED_FORM_CASE_IDS.F
      && Number.isFinite(candidate.expectedSteps)
      && Math.abs(candidate.expectedSteps - 1) <= 1e-9
    )
  );
  const option = {
    id: `t${targetIndex}-s${slotIndex}-${candidate.caseId}-${candidate.prism || "none"}-${candidate.removePrism || "none"}`,
    key: `t${targetIndex}|s${slotIndex}|${candidate.caseId}|${candidate.prism || ""}|${candidate.removePrism || ""}`,
    targetIndex,
    targetAffixId: targetEntry.affixId,
    slotIndex,
    caseId: candidate.caseId,
    prism,
    removePrism: candidate.removePrism || "",
    prismDelta,
    usesEnchant: candidate.caseId === CLOSED_FORM_CASE_IDS.D || candidate.caseId === CLOSED_FORM_CASE_IDS.E || candidate.caseId === CLOSED_FORM_CASE_IDS.REENCHANT,
    costKind: constantCase ? "constant" : "stage",
    constantCost: constantCase ? candidate.expectedSteps : 0,
    baseDenominator: Number.isFinite(candidate.denominator) ? candidate.denominator : null,
    requiresStage: !!prism && (prismDelta > 0 || !constantCase),
    sourceIndex: Number.isInteger(candidate.sourceIndex) ? candidate.sourceIndex : slotIndex,
    // Carry forward Bug 1 / Bug 2 flags from the candidate so they reach the
    // final diagnostics.decomposition.selectedOptions[*] entries and the
    // stage-adjusted Case A formula picks the right branch.
    useEnchantFollowUp: candidate.useEnchantFollowUp === true,
    looseEstimate: candidate.looseEstimate === true,
  };
  option.action = getDecompositionOptionActionV3(option);
  return option;
}

function compareDecompositionOptionsV3(left, right) {
  if (left.slotIndex !== right.slotIndex) {
    return left.slotIndex - right.slotIndex;
  }

  const leftCost = computeDecompositionOptionExpectedStepsV3(left, 0);
  const rightCost = computeDecompositionOptionExpectedStepsV3(right, 0);
  if (Math.abs(leftCost - rightCost) > 1e-9) {
    return leftCost - rightCost;
  }

  return left.key.localeCompare(right.key);
}

function buildDecompositionPlanInputV3(state, target, data, gaConfig, options = {}) {
  const env = options.env || buildEnv(data || {}, gaConfig || {}, target || {});
  const feasibility = options.feasibility || analyzeFeasibilityV3(state, target, data, gaConfig);
  const maxAffixSlots = Number.isInteger(options.maxAffixSlots)
    ? options.maxAffixSlots
    : getMaxAffixSlotsV3(state, data);
  const protectedAffixIds = new Set(
    feasibility && feasibility.details && Array.isArray(feasibility.details.protectedAffixIds)
      ? feasibility.details.protectedAffixIds
      : []
  );
  const targets = [];
  const allOptions = [];
  const residualTargets = [];

  getTargetEntries(target).forEach((targetEntry, targetIndex) => {
    const row = {
      targetIndex,
      targetAffixId: targetEntry.affixId,
      options: [],
      residualSlots: [],
    };
    const seen = new Set();

    for (let slotIndex = 0; slotIndex < maxAffixSlots; slotIndex += 1) {
      const hostEntry = getHostEntryV3(state, slotIndex);

      if (isTargetSatisfiedAtSlotV3(state, targetEntry, slotIndex)) {
        const keep = createKeepPlanOptionV3(targetIndex, targetEntry, slotIndex);
        if (!seen.has(keep.key)) {
          row.options.push(keep);
          allOptions.push(keep);
          seen.add(keep.key);
        }
      }

      if (hostEntry && protectedAffixIds.has(hostEntry.affixId)) {
        row.residualSlots.push({
          slotIndex,
          reason: "Slot is explicitly protected and excluded from host pools.",
        });
        continue;
      }

      const candidates = getClosedFormPlanCandidatesV3(state, targetEntry, slotIndex, env, {
        ...options,
        data,
        gaConfig,
        target,
        feasibility,
        maxAffixSlots,
        allowDiscretionaryEnchant: true,
      });

      if (candidates.length === 0) {
        row.residualSlots.push({
          slotIndex,
          reason: getClosedFormResidualReasonV3(state, targetEntry, slotIndex, env, {
            ...options,
            data,
            gaConfig,
            target,
            maxAffixSlots,
          }),
        });
        continue;
      }

      for (const candidate of candidates) {
        const option = createDecompositionOptionV3(targetIndex, targetEntry, slotIndex, candidate, state, env);
        if (!option || seen.has(option.key)) {
          continue;
        }
        row.options.push(option);
        allOptions.push(option);
        seen.add(option.key);
      }
    }

    row.options.sort(compareDecompositionOptionsV3);
    targets.push(row);

    if (row.options.length === 0) {
      residualTargets.push({
        targetIndex,
        targetAffixId: targetEntry.affixId,
        reason: row.residualSlots[0]
          ? row.residualSlots[0].reason
          : "No decomposition-safe host option exists for this target.",
      });
    }
  });

  return {
    ok: residualTargets.length === 0,
    reason: residualTargets.length === 0
      ? ""
      : "At least one target lacks a decomposition-safe host assignment and must be escalated to the residual solver.",
    env,
    feasibility,
    maxAffixSlots,
    targets,
    options: allOptions,
    residualTargets,
  };
}

function computeDecompositionOptionExpectedStepsV3(option, stage = 0) {
  if (!option) {
    return Infinity;
  }

  if (option.caseId === KEEP_PLAN_CASE_ID) {
    return 0;
  }

  if (option.costKind === "constant") {
    return option.constantCost;
  }

  const adjustedDenominator = Number(option.baseDenominator) - Number(stage);
  if (!Number.isFinite(adjustedDenominator) || adjustedDenominator <= 0) {
    return Infinity;
  }

  if (option.caseId === CLOSED_FORM_CASE_IDS.A) {
    // Preserve the enchant-follow-up flag computed at candidate-generation
    // time. The flag depends on the initial state (no slot enchanted yet),
    // which is the relevant time-of-evaluation for a Case A Add.
    return computeCaseAExpectedStepsV3(
      adjustedDenominator,
      option.useEnchantFollowUp === true ? { useEnchantFollowUp: true } : null
    );
  }
  if (
    option.caseId === CLOSED_FORM_CASE_IDS.B
    || option.caseId === CLOSED_FORM_CASE_IDS.F
    || option.caseId === CLOSED_FORM_CASE_IDS.G
  ) {
    return computeCaseBExpectedStepsV3(adjustedDenominator);
  }
  if (option.caseId === CLOSED_FORM_CASE_IDS.C) {
    return computeCaseCExpectedStepsV3(adjustedDenominator);
  }
  if (option.caseId === CLOSED_FORM_CASE_IDS.D || option.caseId === CLOSED_FORM_CASE_IDS.E) {
    return computeDeterministicEnchantExpectedStepsV3();
  }

  return Infinity;
}

function getValidDecompositionStagesV3(option, maxConsumerCount) {
  if (!option || !option.requiresStage) {
    return [];
  }

  let upperBound = option.prismDelta > 0 ? maxConsumerCount - 1 : maxConsumerCount;
  if (option.costKind === "stage") {
    upperBound = Math.min(upperBound, Number(option.baseDenominator) - 1);
  }

  if (!Number.isFinite(upperBound) || upperBound < 0) {
    return [];
  }

  return Array.from({ length: upperBound + 1 }, (_, stage) => stage);
}

function optionsConflictV3(left, right) {
  if (!left || !right || left.id === right.id) {
    return false;
  }

  if (left.slotIndex === right.slotIndex) {
    return true;
  }

  if (left.removePrism && right.prism && left.removePrism === right.prism) {
    return true;
  }

  if (right.removePrism && left.prism && right.removePrism === left.prism) {
    return true;
  }

  return !!(left.removePrism && right.removePrism && left.removePrism === right.removePrism);
}

function buildDecompositionILPProblemV3(planInput) {
  const variables = [];
  const objectiveCoefficients = [];
  const constraints = [];

  function addBinaryVariable(name, objectiveCoefficient = 0) {
    const index = variables.length;
    variables.push({ name, type: "binary" });
    objectiveCoefficients.push(objectiveCoefficient);
    return index;
  }

  function coefficientVector(entries) {
    const coefficients = Array.from({ length: variables.length }, () => 0);
    for (const entry of entries) {
      coefficients[entry.index] = entry.value;
    }
    return coefficients;
  }

  for (const option of planInput.options) {
    option.pickVarName = `pick_${option.id}`;
    option.pickVarIndex = addBinaryVariable(
      option.pickVarName,
      option.costKind === "constant" ? option.constantCost : 0
    );
    option.stageVarIndexes = Object.create(null);
    option.stageVarNames = Object.create(null);
  }

  const prismGroups = new Map();
  for (const option of planInput.options) {
    if (!option.requiresStage || !option.prism) {
      continue;
    }
    if (!prismGroups.has(option.prism)) {
      prismGroups.set(option.prism, []);
    }
    prismGroups.get(option.prism).push(option);
  }

  for (const [prism, prismOptions] of prismGroups.entries()) {
    const consumers = prismOptions.filter((option) => option.prismDelta > 0);
    const occupancyVarIndexes = [];

    for (let stage = 0; stage < consumers.length; stage += 1) {
      occupancyVarIndexes.push(addBinaryVariable(`occ_${prism}_${stage}`, 0));
    }

    for (const option of prismOptions) {
      option.validStages = getValidDecompositionStagesV3(option, consumers.length);
      for (const stage of option.validStages) {
        const objectiveCoefficient = option.costKind === "stage"
          ? computeDecompositionOptionExpectedStepsV3(option, stage)
          : 0;
        option.stageVarNames[stage] = `stage_${option.id}_${stage}`;
        option.stageVarIndexes[stage] = addBinaryVariable(
          option.stageVarNames[stage],
          objectiveCoefficient
        );
      }
    }

    prismGroups.set(prism, {
      prism,
      options: prismOptions,
      consumers,
      occupancyVarIndexes,
    });
  }

  for (const row of planInput.targets) {
    constraints.push({
      coefficients: coefficientVector(row.options.map((option) => ({ index: option.pickVarIndex, value: 1 }))),
      operator: "=",
      rhs: 1,
    });
  }

  const slotGroups = new Map();
  for (const option of planInput.options) {
    if (!slotGroups.has(option.slotIndex)) {
      slotGroups.set(option.slotIndex, []);
    }
    slotGroups.get(option.slotIndex).push(option);
  }
  for (const slotOptions of slotGroups.values()) {
    constraints.push({
      coefficients: coefficientVector(slotOptions.map((option) => ({ index: option.pickVarIndex, value: 1 }))),
      operator: "<=",
      rhs: 1,
    });
  }

  const enchantOptions = planInput.options.filter((option) => option.usesEnchant);
  if (enchantOptions.length > 0) {
    constraints.push({
      coefficients: coefficientVector(enchantOptions.map((option) => ({ index: option.pickVarIndex, value: 1 }))),
      operator: "<=",
      rhs: 1,
    });
  }

  for (let leftIndex = 0; leftIndex < planInput.options.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < planInput.options.length; rightIndex += 1) {
      const left = planInput.options[leftIndex];
      const right = planInput.options[rightIndex];
      if (!optionsConflictV3(left, right)) {
        continue;
      }

      constraints.push({
        coefficients: coefficientVector([
          { index: left.pickVarIndex, value: 1 },
          { index: right.pickVarIndex, value: 1 },
        ]),
        operator: "<=",
        rhs: 1,
      });
    }
  }

  for (const prismGroup of prismGroups.values()) {
    const { options, consumers, occupancyVarIndexes } = prismGroup;

    for (const option of options) {
      constraints.push({
        coefficients: coefficientVector([
          { index: option.pickVarIndex, value: -1 },
          ...option.validStages.map((stage) => ({ index: option.stageVarIndexes[stage], value: 1 })),
        ]),
        operator: "=",
        rhs: 0,
      });

      for (const stage of option.validStages) {
        if (stage === 0) {
          continue;
        }

        constraints.push({
          coefficients: coefficientVector([
            { index: option.stageVarIndexes[stage], value: 1 },
            { index: occupancyVarIndexes[stage - 1], value: -1 },
          ]),
          operator: "<=",
          rhs: 0,
        });
      }
    }

    for (let stage = 0; stage < occupancyVarIndexes.length; stage += 1) {
      const stageEntries = [];

      for (const option of consumers) {
        if (Object.prototype.hasOwnProperty.call(option.stageVarIndexes, stage)) {
          stageEntries.push({ index: option.stageVarIndexes[stage], value: 1 });
        }
      }
      stageEntries.push({ index: occupancyVarIndexes[stage], value: -1 });

      constraints.push({
        coefficients: coefficientVector(stageEntries),
        operator: "=",
        rhs: 0,
      });

      if (stage > 0) {
        constraints.push({
          coefficients: coefficientVector([
            { index: occupancyVarIndexes[stage], value: 1 },
            { index: occupancyVarIndexes[stage - 1], value: -1 },
          ]),
          operator: "<=",
          rhs: 0,
        });
      }
    }
  }

  return {
    problem: {
      variables,
      objective: {
        sense: "min",
        coefficients: objectiveCoefficients,
      },
      constraints,
      options: {
        iterationLimit: 65536,
      },
    },
  };
}

function buildDecompositionScheduleV3(selectedOptions) {
  const steps = selectedOptions
    .filter((option) => option.action)
    .map((option) => ({
      ...option,
      expectedSteps: computeDecompositionOptionExpectedStepsV3(option, Number.isInteger(option.stage) ? option.stage : 0),
    }));

  steps.sort((left, right) => {
    const leftStage = Number.isInteger(left.stage) ? left.stage : -1;
    const rightStage = Number.isInteger(right.stage) ? right.stage : -1;
    if (leftStage !== rightStage) {
      return leftStage - rightStage;
    }

    const prismOrder = (left.prism || "").localeCompare(right.prism || "");
    if (prismOrder !== 0) {
      return prismOrder;
    }

    if (left.prismDelta !== right.prismDelta) {
      return left.prismDelta - right.prismDelta;
    }

    if (left.targetIndex !== right.targetIndex) {
      return left.targetIndex - right.targetIndex;
    }

    return left.slotIndex - right.slotIndex;
  });

  return steps;
}

function buildDecompositionSelectionFromILPResultV3(planInput, ilpResult) {
  const selectedOptions = planInput.options
    .filter((option) => Number(ilpResult.assignment && ilpResult.assignment[option.pickVarName]) > 0.5)
    .map((option) => ({ ...option }));

  for (const option of selectedOptions) {
    if (!option.requiresStage) {
      option.stage = null;
      continue;
    }

    option.stage = option.validStages.find((stage) => Number(ilpResult.assignment[option.stageVarNames[stage]]) > 0.5);
    if (!Number.isInteger(option.stage)) {
      option.stage = 0;
    }
  }

  const expectedSteps = selectedOptions.reduce((sum, option) => (
    sum + computeDecompositionOptionExpectedStepsV3(option, Number.isInteger(option.stage) ? option.stage : 0)
  ), 0);
  const schedule = buildDecompositionScheduleV3(selectedOptions);

  return {
    expectedSteps,
    action: schedule.length > 0 ? schedule[0].action : null,
    schedule,
    selectedOptions,
  };
}

function solveDecompositionPlanV3(planInput) {
  if (!planInput || !planInput.ok) {
    return {
      ok: false,
      reason: planInput ? planInput.reason : "Decomposition input is unavailable.",
      planInput,
      ilpResult: null,
    };
  }

  if (!ilpWorker || typeof ilpWorker.solveILP !== "function") {
    return {
      ok: false,
      reason: "The ILP solver is unavailable in this environment.",
      planInput,
      ilpResult: null,
    };
  }

  const ilpModel = buildDecompositionILPProblemV3(planInput);
  const ilpResult = ilpWorker.solveILP(ilpModel.problem);
  const hasFeasibleIncumbent = !!(
    ilpResult
    && ilpResult.assignment
    && typeof ilpResult.assignment === "object"
    && ilpResult.status === "ITERATION_LIMIT"
  );
  if (!ilpResult || (ilpResult.status !== "OPTIMAL" && !hasFeasibleIncumbent)) {
    return {
      ok: false,
      reason: ilpResult
        ? `The decomposition ILP returned ${ilpResult.status}.`
        : "The decomposition ILP did not return a result.",
      planInput,
      ilpResult,
    };
  }

  const selectedOptions = planInput.options
    .filter((option) => Number(ilpResult.assignment && ilpResult.assignment[option.pickVarName]) > 0.5)
    .map((option) => ({ ...option }));

  for (const option of selectedOptions) {
    if (!option.requiresStage) {
      option.stage = null;
      continue;
    }

    option.stage = option.validStages.find((stage) => Number(ilpResult.assignment[option.stageVarNames[stage]]) > 0.5);
    if (!Number.isInteger(option.stage)) {
      option.stage = 0;
    }
  }

  const expectedSteps = selectedOptions.reduce((sum, option) => (
    sum + computeDecompositionOptionExpectedStepsV3(option, Number.isInteger(option.stage) ? option.stage : 0)
  ), 0);
  const schedule = buildDecompositionScheduleV3(selectedOptions);

  return {
    ok: true,
    approximate: ilpResult.status !== "OPTIMAL",
    reason: ilpResult.status !== "OPTIMAL"
      ? "Decomposition returned the best feasible ILP incumbent found before the solver limit."
      : "",
    expectedSteps: expectedSteps,
    action: schedule.length > 0 ? schedule[0].action : null,
    schedule: schedule,
    selectedOptions: selectedOptions,
    planInput,
    ilpModel: ilpModel.problem,
    ilpResult,
  };
}

function buildDecompositionDiagnosticsV3(details = {}) {
  const applicable = typeof details.applicable === "boolean" ? details.applicable : null;
  return {
    status: typeof details.status === "string"
      ? details.status
      : (applicable === true ? "APPLICABLE" : (applicable === false ? "ESCALATED" : "NOT_RUN")),
    applicable,
    reason: typeof details.reason === "string" ? details.reason : "",
    optionCount: Number.isFinite(details.optionCount) ? details.optionCount : 0,
    targetCount: Number.isFinite(details.targetCount) ? details.targetCount : 0,
    residualTargets: Array.isArray(details.residualTargets) ? details.residualTargets : [],
    selectedOptions: Array.isArray(details.selectedOptions) ? details.selectedOptions : [],
  };
}

function buildILPDiagnosticsV3(details = {}) {
  return {
    status: typeof details.status === "string" ? details.status : "NOT_RUN",
    approximate: details.approximate === true,
    objective: Number.isFinite(details.objective) ? details.objective : null,
    bestBound: Number.isFinite(details.bestBound) ? details.bestBound : null,
    nodesVisited: Number.isFinite(details.nodesVisited) ? details.nodesVisited : 0,
    iterations: Number.isFinite(details.iterations) ? details.iterations : 0,
  };
}

function buildResidualDiagnosticsV3(details = {}) {
  return {
    status: typeof details.status === "string" ? details.status : "NOT_RUN",
    approximate: details.approximate === true,
    abstractStates: Number.isFinite(details.abstractStates) ? details.abstractStates : 0,
    deadStates: Number.isFinite(details.deadStates) ? details.deadStates : 0,
    stateLimit: Number.isFinite(details.stateLimit) ? details.stateLimit : RESIDUAL_STATE_LIMIT,
    phase1Iterations: Number.isFinite(details.phase1Iterations) ? details.phase1Iterations : 0,
    phase2Iterations: Number.isFinite(details.phase2Iterations) ? details.phase2Iterations : 0,
    phase1Converged: typeof details.phase1Converged === "boolean" ? details.phase1Converged : null,
    phase2Converged: typeof details.phase2Converged === "boolean" ? details.phase2Converged : null,
    phase1Residual: Number.isFinite(details.phase1Residual) ? details.phase1Residual : null,
    phase2Residual: Number.isFinite(details.phase2Residual) ? details.phase2Residual : null,
    phase1PolicyStates: Number.isFinite(details.phase1PolicyStates) ? details.phase1PolicyStates : 0,
    phase2PolicyStates: Number.isFinite(details.phase2PolicyStates) ? details.phase2PolicyStates : 0,
    heuristic: typeof details.heuristic === "string" ? details.heuristic : "",
  };
}

function buildWorkerDiagnosticsV3(summaryDiagnostics = {}, options = {}) {
  const diagnostics = summaryDiagnostics && typeof summaryDiagnostics === "object"
    ? summaryDiagnostics
    : {};

  return {
    ...diagnostics,
    reason: typeof diagnostics.reason === "string" ? diagnostics.reason : "",
    rootVisits: Number.isFinite(diagnostics.rootVisits) ? diagnostics.rootVisits : 0,
    candidateActions: Array.isArray(diagnostics.candidateActions) ? diagnostics.candidateActions : [],
    strategy: options.strategy,
    phase: options.phase,
    feasibility: options.feasibility || buildFeasibilitySuccess({}),
    decomposition: buildDecompositionDiagnosticsV3(options.decomposition),
    ilp: buildILPDiagnosticsV3(options.ilp),
    residual: buildResidualDiagnosticsV3(options.residual),
  };
}

function buildDecompositionResultV3(solution, feasibility) {
  const candidateActions = solution.schedule.map((step) => ({
    action: step.action,
    expectedSteps: step.expectedSteps,
    successProb: 1,
    visits: 0,
    sourceBreakdown: [],
    probabilityBreakdown: [],
    targetAffixId: step.targetAffixId,
    caseId: step.caseId,
    slotIndex: step.slotIndex,
    stage: step.stage,
  }));
  const reason = solution.approximate
    ? "Decomposition returned the best feasible ILP incumbent found before the solver limit; this action is not proven optimal."
    : (solution.action
      ? "Decomposition solved the instance exactly with the scoped ILP layer."
      : "Current state already satisfies the target under the decomposition model.");

  const ilpDiagnostics = {
    status: solution.ilpResult.status,
    approximate: solution.approximate === true,
    objective: solution.ilpResult.objective,
    bestBound: solution.ilpResult.bestBound,
    nodesVisited: solution.ilpResult.nodesVisited,
    iterations: solution.ilpResult.iterations,
  };
  const decompositionDiagnostics = {
    status: solution.approximate ? "APPROXIMATE_LIMIT" : "APPLICABLE",
    applicable: true,
    reason: solution.approximate ? reason : "",
    optionCount: solution.planInput.options.length,
    targetCount: solution.planInput.targets.length,
    selectedOptions: solution.selectedOptions.map((option) => ({
      targetIndex: option.targetIndex,
      targetAffixId: option.targetAffixId,
      slotIndex: option.slotIndex,
      caseId: option.caseId,
      prism: option.prism,
      removePrism: option.removePrism,
      stage: option.stage,
      expectedSteps: computeDecompositionOptionExpectedStepsV3(option, Number.isInteger(option.stage) ? option.stage : 0),
      useEnchantFollowUp: option.useEnchantFollowUp === true,
      looseEstimate: option.looseEstimate === true,
    })),
  };

  return {
    iterations: solution.ilpResult.iterations,
    approximate: solution.approximate === true,
    action: solution.action,
    expectedSteps: solution.expectedSteps,
    variance: null,
    stdDev: null,
    successProb: 1,
    oneStepRisk: [],
    diagnostics: buildWorkerDiagnosticsV3(
      {
        reason,
        rootVisits: 0,
        candidateActions,
      },
      {
        strategy: DECOMPOSITION_STRATEGY,
        phase: "phase-4-decomposition-ilp",
        feasibility,
        decomposition: decompositionDiagnostics,
        ilp: ilpDiagnostics,
      }
    ),
    tree: null,
    stoppedByUser: false,
    elapsedMs: 0,
  };
}

function buildILPFailureResultV3(solution, feasibility) {
  const result = emptySummary(solution.reason);
  result.diagnostics = buildWorkerDiagnosticsV3(result.diagnostics, {
    strategy: DECOMPOSITION_STRATEGY,
    phase: "phase-4-decomposition-ilp",
    feasibility,
    decomposition: {
      status: "APPLICABLE",
      applicable: true,
      optionCount: solution.planInput && Array.isArray(solution.planInput.options) ? solution.planInput.options.length : 0,
      targetCount: solution.planInput && Array.isArray(solution.planInput.targets) ? solution.planInput.targets.length : 0,
    },
    ilp: solution.ilpResult
      ? {
        status: solution.ilpResult.status,
        objective: solution.ilpResult.objective,
        bestBound: solution.ilpResult.bestBound,
        nodesVisited: solution.ilpResult.nodesVisited,
        iterations: solution.ilpResult.iterations,
      }
      : { status: "UNAVAILABLE" },
  });

  return {
    iterations: solution.ilpResult ? solution.ilpResult.iterations : 0,
    ...result,
    tree: null,
    stoppedByUser: false,
    elapsedMs: 0,
  };
}

function getResidualRelevantAffixIdsV3(target, gaConfig, feasibility = null) {
  const details = feasibility && feasibility.details ? feasibility.details : {};
  return new Set(normalizeIdList([
    ...getTargetEntries(target).map((entry) => entry.affixId),
    ...(Array.isArray(details.protectedAffixIds) ? details.protectedAffixIds : []),
    ...(Array.isArray(details.forbiddenAffixIds) ? details.forbiddenAffixIds : []),
    ...(Array.isArray(details.improveAffixIds) ? details.improveAffixIds : []),
    ...((gaConfig && Array.isArray(gaConfig.protectedAffixIds)) ? gaConfig.protectedAffixIds : []),
    ...((gaConfig && Array.isArray(gaConfig.forbiddenAffixIds)) ? gaConfig.forbiddenAffixIds : []),
    ...((gaConfig && Array.isArray(gaConfig.unsatisfactoryAffixIds)) ? gaConfig.unsatisfactoryAffixIds : []),
  ]));
}

function getResidualAffixSignatureV3(affixId, env) {
  const categories = getAffixCategoriesV3(affixId, env);
  const family = getAffixFamilyV3(affixId, env);
  return family ? `${categories.join("&")}::${family}` : categories.join("&");
}

function createResidualAbstractionContextV3(target, data, gaConfig, options = {}) {
  const baseEnv = options.baseEnv || buildEnv(data || {}, gaConfig || {}, target || {});
  const v2Env = options.v2Env || (typeof buildEnvV2 === "function"
    ? buildEnvV2(data || {}, gaConfig || {}, target || {})
    : null);

  return {
    baseEnv,
    v2Env,
    relevantAffixIds: getResidualRelevantAffixIdsV3(target, gaConfig, options.feasibility || null),
  };
}

function getResidualAffixTokenV3(entry, context) {
  if (!entry || !entry.affixId) {
    return "";
  }

  if (context.relevantAffixIds.has(entry.affixId)) {
    return entry.affixId;
  }

  return `trash<${getResidualAffixSignatureV3(entry.affixId, context.baseEnv)}>`;
}

function residualStateKeyV3(state, context) {
  const tokens = getCurrentAffixes(state)
    .map((entry) => `${getResidualAffixTokenV3(entry, context)}|${entry.isGA ? 1 : 0}|${entry.isEnchanted ? 1 : 0}`)
    .sort();
  const unsatisfactory = Array.isArray(state && state.unsatisfactoryAffixIds)
    ? state.unsatisfactoryAffixIds.slice().sort().join(",")
    : "";

  return [
    `L${state && state.isLegendary ? 1 : 0}`,
    `S${(state && state.gearSlot) || "Any"}`,
    `C${(state && state.class) || "Any"}`,
    `A${tokens.join(",")}`,
    `U${unsatisfactory}`,
  ].join("#");
}

function createResidualGraphNodeV3(state, key, target, env) {
  const success = isSuccessStateV2(state, target, env);
  const deadReason = success ? "" : classifyDeadReason(state, target, env);
  const actions = success || deadReason ? [] : getValidActionsV2(state, target, env);
  return {
    key,
    state,
    actions,
    actionEntries: [],
    success,
    deadReason,
  };
}

function buildResidualEnvV3(data, gaConfig, target, overrides = {}) {
  if (typeof buildEnvV2 !== "function") {
    return null;
  }

  const env = buildEnvV2(data || {}, gaConfig || {}, target || {});
  env.stateLimit = Number.isFinite(overrides.stateLimit) ? overrides.stateLimit : RESIDUAL_STATE_LIMIT;
  env.maxIterations = Number.isFinite(overrides.maxIterations) ? overrides.maxIterations : RESIDUAL_MAX_ITERATIONS;
  env.epsilon = Number.isFinite(overrides.epsilon) ? overrides.epsilon : RESIDUAL_EPSILON;
  env.phase2Epsilon = Number.isFinite(overrides.phase2Epsilon) ? overrides.phase2Epsilon : RESIDUAL_PHASE2_EPSILON;
  return env;
}

function getResidualEnvOverridesForTimeV3(timeMs) {
  if (!Number.isFinite(timeMs)) {
    return {};
  }

  if (timeMs <= 0) {
    return {
      stateLimit: RESIDUAL_STATE_LIMIT_CAP,
      maxIterations: RESIDUAL_MAX_ITERATIONS_CAP,
    };
  }

  const seconds = Math.max(0, timeMs / 1000);
  return {
    stateLimit: Math.min(
      RESIDUAL_STATE_LIMIT_CAP,
      Math.max(RESIDUAL_STATE_LIMIT, Math.round(RESIDUAL_STATE_LIMIT + seconds * RESIDUAL_STATE_LIMIT_PER_SECOND))
    ),
    maxIterations: Math.min(
      RESIDUAL_MAX_ITERATIONS_CAP,
      Math.max(RESIDUAL_MAX_ITERATIONS, Math.round(RESIDUAL_MAX_ITERATIONS + seconds * RESIDUAL_MAX_ITERATIONS_PER_SECOND))
    ),
  };
}

function getEffectiveResidualEnvOverridesV3(payload, options = {}) {
  return {
    ...getResidualEnvOverridesForTimeV3(Number(payload && payload.timeMs)),
    ...(options.residualEnvOverrides || {}),
  };
}

function buildResidualReachableGraphV3(rootState, target, data, gaConfig, options = {}) {
  if (typeof attachUnsatisfactoryToState !== "function") {
    return {
      ok: false,
      reason: "Residual solver helpers are unavailable in this environment.",
      nodes: [],
      deadStates: 0,
    };
  }

  const env = options.v2Env || buildResidualEnvV3(data, gaConfig, target);
  const context = options.context || createResidualAbstractionContextV3(target, data, gaConfig, {
    feasibility: options.feasibility || null,
    baseEnv: options.baseEnv || null,
    v2Env: env,
  });
  const stopView = options.stopView || null;
  const limit = Number.isFinite(options.stateLimit) ? options.stateLimit : env.stateLimit;
  const attachedRoot = options.rootAlreadyAttached
    ? rootState
    : attachUnsatisfactoryToState(rootState, gaConfig || {});
  const root = normalizeOutcomeStateV2(attachedRoot);
  const rootKey = residualStateKeyV3(root, context);
  const keyToIndex = new Map([[rootKey, 0]]);
  const nodes = [createResidualGraphNodeV3(root, rootKey, target, env)];
  let deadStates = nodes[0].deadReason ? 1 : 0;

  for (let queueIndex = 0; queueIndex < nodes.length; queueIndex += 1) {
    if (shouldStop(stopView)) {
      throw new Error("Optimization stopped.");
    }

    const node = nodes[queueIndex];
    if (node.success || node.deadReason) {
      continue;
    }

    const actionEntries = [];
    for (const action of node.actions) {
      const merged = new Map();

      for (const outcome of getActionOutcomesV2(node.state, action, env)) {
        const child = normalizeOutcomeStateV2(outcome.state);
        const childKey = residualStateKeyV3(child, context);
        const existing = merged.get(childKey);

        if (existing) {
          existing.probability += outcome.probability;
          continue;
        }

        merged.set(childKey, {
          probability: outcome.probability,
          state: child,
        });
      }

      const transitions = [];
      for (const [childKey, entry] of merged.entries()) {
        let childIndex = keyToIndex.get(childKey);

        if (childIndex === undefined) {
          if (nodes.length >= limit) {
            return {
              ok: false,
              limit,
              rootKey,
              nodes,
              deadStates,
              context,
              env,
              reason: `Residual abstract graph exceeded limit (${limit} states).`,
            };
          }

          childIndex = nodes.length;
          keyToIndex.set(childKey, childIndex);
          const childNode = createResidualGraphNodeV3(entry.state, childKey, target, env);
          if (childNode.deadReason) {
            deadStates += 1;
          }
          nodes.push(childNode);
        }

        transitions.push({
          probability: entry.probability,
          childIndex,
        });
      }

      actionEntries.push({
        action,
        cubeCost: actionCost(action, node.state),
        transitions,
      });
    }

    node.actionEntries = actionEntries;
  }

  return {
    ok: true,
    rootKey,
    rootIndex: 0,
    nodes,
    deadStates,
    context,
    env,
  };
}

function isResidualTargetResolvedV3(state, targetEntry) {
  const matching = getCurrentAffixes(state).filter((entry) => entry.affixId === targetEntry.affixId);
  if (matching.length === 0) {
    return false;
  }
  if (targetEntry.needsImprovement) {
    const unsatisfactory = new Set(Array.isArray(state && state.unsatisfactoryAffixIds) ? state.unsatisfactoryAffixIds : []);
    if (unsatisfactory.has(targetEntry.affixId)) {
      return false;
    }
  }

  return true;
}

function computeResidualHeuristicStepsV3(state, target, data, gaConfig, options = {}) {
  const env = options.baseEnv || buildEnv(data || {}, gaConfig || {}, target || {});
  const maxAffixSlots = Number.isInteger(options.maxAffixSlots)
    ? options.maxAffixSlots
    : getMaxAffixSlotsV3(state, data);
  let lowerBound = 0;

  for (const targetEntry of getTargetEntries(target)) {
    if (isResidualTargetResolvedV3(state, targetEntry)) {
      continue;
    }

    let best = Infinity;
    for (let slotIndex = 0; slotIndex < maxAffixSlots; slotIndex += 1) {
      const candidates = getClosedFormPlanCandidatesV3(state, targetEntry, slotIndex, env, {
        data,
        gaConfig,
        target,
        feasibility: buildFeasibilitySuccess({}),
        maxAffixSlots,
        allowDiscretionaryEnchant: false,
        touchOnlyImprovement: true,
      });

      for (const candidate of candidates) {
        if (!Number.isFinite(candidate.expectedSteps)) {
          continue;
        }
        best = Math.min(best, candidate.expectedSteps);
      }
    }

    if (Number.isFinite(best)) {
      lowerBound = Math.max(lowerBound, best);
    }
  }

  return lowerBound;
}

function getResolvedActionSuccessV3(entry, stateIndex, values) {
  let selfProbability = 0;
  let leaveSuccess = 0;

  for (const transition of entry.transitions) {
    if (transition.childIndex === stateIndex) {
      selfProbability += transition.probability;
      continue;
    }
    leaveSuccess += transition.probability * values[transition.childIndex];
  }

  const leaveProbability = 1 - selfProbability;
  if (leaveProbability <= RESIDUAL_EPSILON) {
    return 0;
  }

  const candidate = leaveSuccess / leaveProbability;
  return Math.max(0, Math.min(1, candidate));
}

function getResolvedActionWeightedCostV3(entry, stateIndex, optimalSuccess, costs) {
  let selfProbability = 0;
  let leaveWeightedCost = 0;

  for (const transition of entry.transitions) {
    if (transition.childIndex === stateIndex) {
      selfProbability += transition.probability;
      continue;
    }
    leaveWeightedCost += transition.probability * costs[transition.childIndex];
  }

  const leaveProbability = 1 - selfProbability;
  if (leaveProbability <= RESIDUAL_EPSILON) {
    return Infinity;
  }

  return (entry.cubeCost * optimalSuccess + leaveWeightedCost) / leaveProbability;
}

function selectBestResidualPhase1ActionIndexV3(node, stateIndex, values) {
  let bestIndex = -1;
  let bestValue = -1;
  let bestKey = "";

  for (let index = 0; index < node.actionEntries.length; index += 1) {
    const entry = node.actionEntries[index];
    const candidate = getResolvedActionSuccessV3(entry, stateIndex, values);
    const key = actionKey(entry.action);

    if (
      candidate > bestValue + RESIDUAL_ACTION_EPSILON
      || (
        Math.abs(candidate - bestValue) <= RESIDUAL_ACTION_EPSILON
        && (bestIndex < 0 || key.localeCompare(bestKey) < 0)
      )
    ) {
      bestIndex = index;
      bestValue = candidate;
      bestKey = key;
    }
  }

  return bestIndex;
}

// For each non-terminal node, pre-filter action entries down to the subset whose
// Phase-1 success value equals the node's optimal success (within tolerance).
// Phase 1 values are frozen by the time Phase 2 runs, so this set is invariant
// across Phase 2 iterations. Recomputing it per iteration was the dominant cost
// (~60% of wall time in the Class=Any Adept-heavy profile).
function buildResidualPhase2EligibleActionsV3(graph, phase1Values, env) {
  const eligible = new Array(graph.nodes.length);
  const epsilon = Number.isFinite(env && env.epsilon) ? env.epsilon : RESIDUAL_EPSILON;

  for (let stateIndex = 0; stateIndex < graph.nodes.length; stateIndex += 1) {
    const node = graph.nodes[stateIndex];
    if (!node || node.success || node.deadReason) {
      eligible[stateIndex] = null;
      continue;
    }

    const optimalSuccess = phase1Values[stateIndex];
    if (optimalSuccess <= epsilon) {
      eligible[stateIndex] = null;
      continue;
    }

    const indices = [];
    for (let actionIndex = 0; actionIndex < node.actionEntries.length; actionIndex += 1) {
      const entry = node.actionEntries[actionIndex];
      const success = getResolvedActionSuccessV3(entry, stateIndex, phase1Values);
      if (Math.abs(success - optimalSuccess) <= RESIDUAL_ACTION_EPSILON) {
        indices.push(actionIndex);
      }
    }
    eligible[stateIndex] = Int32Array.from(indices);
  }

  return eligible;
}

function selectBestResidualPhase2ActionIndexV3(node, stateIndex, phase1Values, costs, env, eligibleIndices) {
  const optimalSuccess = phase1Values[stateIndex];
  if (optimalSuccess <= env.epsilon) {
    return -1;
  }

  const indices = eligibleIndices || null;
  const iterCount = indices ? indices.length : node.actionEntries.length;

  let bestIndex = -1;
  let bestCost = Infinity;
  let bestKey = "";

  for (let i = 0; i < iterCount; i += 1) {
    const index = indices ? indices[i] : i;
    const entry = node.actionEntries[index];
    if (!indices) {
      const success = getResolvedActionSuccessV3(entry, stateIndex, phase1Values);
      if (Math.abs(success - optimalSuccess) > RESIDUAL_ACTION_EPSILON) {
        continue;
      }
    }

    const candidate = getResolvedActionWeightedCostV3(entry, stateIndex, optimalSuccess, costs);
    const key = actionKey(entry.action);
    if (
      candidate < bestCost - RESIDUAL_ACTION_EPSILON
      || (
        Math.abs(candidate - bestCost) <= RESIDUAL_ACTION_EPSILON
        && (bestIndex < 0 || key.localeCompare(bestKey) < 0)
      )
    ) {
      bestIndex = index;
      bestCost = candidate;
      bestKey = key;
    }
  }

  return bestIndex;
}

function getResidualPolicyGraphV3(graph, rootIndex, selectActionIndex) {
  const queue = [rootIndex];
  const visited = new Set();
  const order = [];
  const policy = new Int32Array(graph.nodes.length).fill(-1);

  while (queue.length > 0) {
    const stateIndex = queue.shift();
    if (visited.has(stateIndex)) {
      continue;
    }
    visited.add(stateIndex);
    order.push(stateIndex);

    const node = graph.nodes[stateIndex];
    if (!node || node.success || node.deadReason) {
      continue;
    }

    const actionIndex = selectActionIndex(node, stateIndex);
    policy[stateIndex] = actionIndex;
    if (actionIndex < 0) {
      continue;
    }

    for (const transition of node.actionEntries[actionIndex].transitions) {
      queue.push(transition.childIndex);
    }
  }

  return { order, policy };
}

function getResidualPolicySignatureV3(policyInfo) {
  return policyInfo.order.map((stateIndex) => `${stateIndex}:${policyInfo.policy[stateIndex]}`).join(",");
}

function solveResidualLAOPhase1V3(graph, env, options = {}) {
  const values = new Float64Array(graph.nodes.length);
  const stopView = options.stopView || null;

  for (let index = 0; index < graph.nodes.length; index += 1) {
    const node = graph.nodes[index];
    values[index] = node.success ? 1 : 0;
  }

  let converged = false;
  let iterations = 0;
  let residual = Infinity;
  let policyStates = 1;
  const policyImprovementSteps = 1;

  for (; iterations < env.maxIterations; iterations += 1) {
    if (shouldStop(stopView)) {
      throw new Error("Optimization stopped.");
    }

    let maxDelta = 0;

    for (let index = 0; index < graph.nodes.length; index += 1) {
      const node = graph.nodes[index];
      if (node.success) {
        values[index] = 1;
        continue;
      }
      if (node.deadReason) {
        values[index] = 0;
        continue;
      }

      let nextValue = 0;
      for (const entry of node.actionEntries) {
        const candidate = getResolvedActionSuccessV3(entry, index, values);
        if (candidate > nextValue) {
          nextValue = candidate;
        }
      }
      maxDelta = Math.max(maxDelta, Math.abs(nextValue - values[index]));
      values[index] = nextValue;
    }

    residual = maxDelta;

    if (maxDelta < env.epsilon) {
      iterations += 1;
      converged = true;
      break;
    }
  }

  const finalPolicy = getResidualPolicyGraphV3(
    graph,
    graph.rootIndex,
    (node, stateIndex) => selectBestResidualPhase1ActionIndexV3(node, stateIndex, values)
  );
  policyStates = finalPolicy.order.length;

  return { values, iterations, converged, residual, policyStates, policyImprovementSteps };
}

function solveResidualLAOPhase2V3(graph, phase1, target, data, gaConfig, options = {}) {
  const env = options.env;
  const baseEnv = options.baseEnv;
  const stopView = options.stopView || null;
  const costs = new Float64Array(graph.nodes.length);

  const eligibleActions = buildResidualPhase2EligibleActionsV3(graph, phase1.values, env);

  const absEpsilon = Number.isFinite(env && env.epsilon) ? env.epsilon : RESIDUAL_EPSILON;
  const relEpsilon = Number.isFinite(env && env.phase2Epsilon) ? env.phase2Epsilon : RESIDUAL_PHASE2_EPSILON;

  let converged = false;
  let iterations = 0;
  let residual = Infinity;
  let policyStates = 1;
  let policyImprovementSteps = 0;

  for (; iterations < env.maxIterations; iterations += 1) {
    if (shouldStop(stopView)) {
      throw new Error("Optimization stopped.");
    }

    policyImprovementSteps += 1;
    let maxDelta = 0;
    let maxAbsValue = 0;

    for (let index = 0; index < graph.nodes.length; index += 1) {
      const node = graph.nodes[index];
      if (node.success || node.deadReason) {
        costs[index] = 0;
        continue;
      }

      const optimalSuccess = phase1.values[index];
      if (optimalSuccess <= absEpsilon) {
        costs[index] = 0;
        continue;
      }

      const bestIndex = selectBestResidualPhase2ActionIndexV3(
        node, index, phase1.values, costs, env, eligibleActions[index]
      );
      const rawValue = bestIndex >= 0
        ? getResolvedActionWeightedCostV3(node.actionEntries[bestIndex], index, optimalSuccess, costs)
        : 0;
      const nextValue = Number.isFinite(rawValue) ? rawValue : 0;
      const delta = Math.abs(nextValue - costs[index]);
      if (delta > maxDelta) {
        maxDelta = delta;
      }
      const absNext = nextValue < 0 ? -nextValue : nextValue;
      if (absNext > maxAbsValue) {
        maxAbsValue = absNext;
      }
      costs[index] = nextValue;
    }

    residual = maxDelta;

    const scale = maxAbsValue > 1 ? maxAbsValue : 1;
    if (maxDelta / scale < relEpsilon) {
      iterations += 1;
      converged = true;
      break;
    }
  }

  const finalPolicy = getResidualPolicyGraphV3(
    graph,
    graph.rootIndex,
    (node, stateIndex) => selectBestResidualPhase2ActionIndexV3(
      node, stateIndex, phase1.values, costs, env, eligibleActions[stateIndex]
    )
  );
  policyStates = finalPolicy.order.length;

  return { costs, iterations, converged, residual, policyStates, policyImprovementSteps };
}

function solveResidualExactV3(graph, env) {
  const phase1 = solvePhase1(graph, env);
  const phase2 = solvePhase2(graph, phase1, env);
  return { phase1, phase2 };
}

function solveResidualLAOStarV3(graph, target, data, gaConfig, options = {}) {
  const env = options.env || graph.env;
  const baseEnv = options.baseEnv || (graph.context ? graph.context.baseEnv : buildEnv(data || {}, gaConfig || {}, target || {}));
  const phase1 = solveResidualLAOPhase1V3(graph, env, { stopView: options.stopView || null });
  if (!phase1.converged) {
    return {
      status: "ITERATION_LIMIT",
      phase1,
      phase2: null,
    };
  }

  const phase2 = solveResidualLAOPhase2V3(graph, phase1, target, data, gaConfig, {
    env,
    baseEnv,
    stopView: options.stopView || null,
  });
  if (!phase2.converged) {
    return {
      status: "ITERATION_LIMIT",
      phase1,
      phase2,
    };
  }

  return {
    status: "OPTIMAL",
    phase1,
    phase2,
  };
}

function buildResidualFailureResultV3(message, feasibility, decompositionInput, details = {}) {
  const result = emptySummary(message);
  result.diagnostics = buildWorkerDiagnosticsV3(result.diagnostics, {
    strategy: RESIDUAL_STRATEGY,
    phase: "phase-5-residual-lao-star",
    feasibility,
    decomposition: {
      status: "ESCALATED",
      applicable: false,
      reason: decompositionInput && typeof decompositionInput.reason === "string" ? decompositionInput.reason : "",
      optionCount: decompositionInput && Array.isArray(decompositionInput.options) ? decompositionInput.options.length : 0,
      targetCount: decompositionInput && Array.isArray(decompositionInput.targets) ? decompositionInput.targets.length : 0,
      residualTargets: decompositionInput && Array.isArray(decompositionInput.residualTargets)
        ? decompositionInput.residualTargets
        : [],
    },
    residual: details,
  });

  return {
    iterations: Number.isFinite(details.iterations) ? details.iterations : 0,
    ...result,
    tree: null,
    stoppedByUser: false,
    elapsedMs: 0,
  };
}

function buildResidualResultV3(graph, target, env, residualSolution, feasibility, decompositionInput) {
  const summary = summarizeRootV2(
    graph,
    graph.rootKey,
    env,
    target,
    residualSolution.phase1,
    residualSolution.phase2,
    { reason: "Residual abstract-state solver selected this action after decomposition escalation." }
  );

  return {
    iterations: residualSolution.phase1.iterations + residualSolution.phase2.iterations,
    ...summary,
    diagnostics: buildWorkerDiagnosticsV3(summary.diagnostics, {
      strategy: RESIDUAL_STRATEGY,
      phase: "phase-5-residual-lao-star",
      feasibility,
      decomposition: {
        status: "ESCALATED",
        applicable: false,
        reason: decompositionInput && typeof decompositionInput.reason === "string" ? decompositionInput.reason : "",
        optionCount: decompositionInput && Array.isArray(decompositionInput.options) ? decompositionInput.options.length : 0,
        targetCount: decompositionInput && Array.isArray(decompositionInput.targets) ? decompositionInput.targets.length : 0,
        residualTargets: decompositionInput && Array.isArray(decompositionInput.residualTargets)
          ? decompositionInput.residualTargets
          : [],
      },
      residual: {
        status: residualSolution.status,
        abstractStates: graph.nodes.length,
        deadStates: graph.deadStates,
        stateLimit: env.stateLimit,
        phase1Iterations: residualSolution.phase1.iterations,
        phase2Iterations: residualSolution.phase2.iterations,
        phase1Converged: residualSolution.phase1.converged,
        phase2Converged: residualSolution.phase2.converged,
        phase1Residual: residualSolution.phase1.residual,
        phase2Residual: residualSolution.phase2.residual,
        phase1PolicyStates: residualSolution.phase1.policyStates,
        phase2PolicyStates: residualSolution.phase2.policyStates,
        phase1PolicySteps: residualSolution.phase1.policyImprovementSteps || 0,
        phase2PolicySteps: residualSolution.phase2.policyImprovementSteps || 0,
        heuristic: "Closed-form lower bound on the hardest unresolved target; success heuristic is optimistic 1.",
      },
    }),
    tree: null,
    stoppedByUser: false,
    elapsedMs: 0,
  };
}

function buildResidualApproximateResultV3(graph, target, env, residualSolution, feasibility, decompositionInput) {
  const effectivePhase2 = residualSolution.phase2 || {
    iterations: 0,
    converged: false,
    residual: Infinity,
    policyStates: 0,
    costs: new Float64Array(graph.nodes.length),
  };
  const summary = summarizeRootV2(
    graph,
    graph.rootKey,
    env,
    target,
    residualSolution.phase1,
    effectivePhase2,
    { reason: "Residual abstract-state solver returned the best policy found before reaching solver limits." }
  );

  // summarizeRootV2 refuses to report expected-step estimates whenever Phase 2
  // did not converge. For an approximate result the user has nothing better to
  // look at than the best-so-far cost — surface it (labelled approximate) so
  // the UI is not stuck showing only "-".
  if (
    summary.expectedSteps == null
    && residualSolution.phase1
    && residualSolution.phase1.converged
    && effectivePhase2.costs
    && Number.isFinite(graph.rootIndex)
    && graph.rootIndex >= 0
  ) {
    const rootSuccess = residualSolution.phase1.values[graph.rootIndex];
    const rootCost = effectivePhase2.costs[graph.rootIndex];
    if (rootSuccess > env.epsilon && Number.isFinite(rootCost)) {
      summary.expectedSteps = rootCost / rootSuccess;
    }
  }

  const phase1Iterations = residualSolution.phase1 ? residualSolution.phase1.iterations : 0;
  const phase2Iterations = residualSolution.phase2 ? residualSolution.phase2.iterations : 0;
  const reason = `Residual solver reached ${env.maxIterations} iterations without convergence; returning the best-so-far policy estimate.`;

  return {
    iterations: phase1Iterations + phase2Iterations,
    approximate: true,
    ...summary,
    diagnostics: buildWorkerDiagnosticsV3(
      {
        ...(summary.diagnostics || {}),
        reason,
      },
      {
        strategy: RESIDUAL_STRATEGY,
        phase: "phase-5-residual-lao-star",
        feasibility,
        decomposition: {
          status: "ESCALATED",
          applicable: false,
          reason: decompositionInput && typeof decompositionInput.reason === "string" ? decompositionInput.reason : "",
          optionCount: decompositionInput && Array.isArray(decompositionInput.options) ? decompositionInput.options.length : 0,
          targetCount: decompositionInput && Array.isArray(decompositionInput.targets) ? decompositionInput.targets.length : 0,
          residualTargets: decompositionInput && Array.isArray(decompositionInput.residualTargets)
            ? decompositionInput.residualTargets
            : [],
        },
        residual: {
          status: "APPROXIMATE_LIMIT",
          approximate: true,
          abstractStates: graph.nodes.length,
          deadStates: graph.deadStates,
          stateLimit: env.stateLimit,
          phase1Iterations,
          phase2Iterations,
          phase1Converged: !!(residualSolution.phase1 && residualSolution.phase1.converged),
          phase2Converged: !!(residualSolution.phase2 && residualSolution.phase2.converged),
          phase1Residual: residualSolution.phase1 ? residualSolution.phase1.residual : null,
          phase2Residual: residualSolution.phase2 ? residualSolution.phase2.residual : null,
          phase1PolicyStates: residualSolution.phase1 ? residualSolution.phase1.policyStates : 0,
          phase2PolicyStates: residualSolution.phase2 ? residualSolution.phase2.policyStates : 0,
          phase1PolicySteps: residualSolution.phase1 ? (residualSolution.phase1.policyImprovementSteps || 0) : 0,
          phase2PolicySteps: residualSolution.phase2 ? (residualSolution.phase2.policyImprovementSteps || 0) : 0,
          heuristic: "Closed-form lower bound on the hardest unresolved target; success heuristic is optimistic 1.",
        },
      }
    ),
    tree: null,
    stoppedByUser: false,
    elapsedMs: 0,
  };
}

function solveResidualPayloadV3(payload, options = {}) {
  const feasibility = options.feasibility || analyzeFeasibilityV3(payload.state, payload.target, payload.data, payload.gaConfig);
  const decompositionInput = options.decompositionInput || buildDecompositionPlanInputV3(
    payload.state,
    payload.target,
    payload.data,
    payload.gaConfig,
    { feasibility }
  );
  const baseEnv = buildEnv(payload.data || {}, payload.gaConfig || {}, payload.target || {});
  const v2Env = options.residualEnv || buildResidualEnvV3(
    payload.data,
    payload.gaConfig,
    payload.target,
    options.residualEnvOverrides || {}
  );

  if (!v2Env || typeof summarizeRootV2 !== "function") {
    return buildResidualFailureResultV3(
      "Residual solver helpers are unavailable in this environment.",
      feasibility,
      decompositionInput,
      { status: "UNAVAILABLE" }
    );
  }

  const graph = buildResidualReachableGraphV3(payload.state, payload.target, payload.data, payload.gaConfig, {
    feasibility,
    baseEnv,
    v2Env,
    stopView: options.stopView || null,
  });
  if (!graph.ok) {
    return buildResidualFailureResultV3(graph.reason, feasibility, decompositionInput, {
      status: "STATE_LIMIT",
      abstractStates: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
      deadStates: Number.isFinite(graph.deadStates) ? graph.deadStates : 0,
      stateLimit: graph.limit || (v2Env && v2Env.stateLimit) || RESIDUAL_STATE_LIMIT,
    });
  }

  const residualSolution = solveResidualLAOStarV3(graph, payload.target, payload.data, payload.gaConfig, {
    env: v2Env,
    baseEnv,
    stopView: options.stopView || null,
  });
  if (residualSolution.status !== "OPTIMAL") {
    if (residualSolution.status === "ITERATION_LIMIT" && residualSolution.phase1) {
      return buildResidualApproximateResultV3(
        graph,
        payload.target,
        v2Env,
        residualSolution,
        feasibility,
        decompositionInput
      );
    }

    const phase1Iterations = residualSolution.phase1 ? residualSolution.phase1.iterations : 0;
    const phase2Iterations = residualSolution.phase2 ? residualSolution.phase2.iterations : 0;
    return buildResidualFailureResultV3(
      `Residual solver reached ${v2Env.maxIterations} iterations without convergence.`,
      feasibility,
      decompositionInput,
      {
        status: residualSolution.status,
        iterations: phase1Iterations + phase2Iterations,
        abstractStates: graph.nodes.length,
        deadStates: graph.deadStates,
        stateLimit: v2Env.stateLimit,
      }
    );
  }

  return buildResidualResultV3(graph, payload.target, v2Env, residualSolution, feasibility, decompositionInput);
}

function buildFeasibilityFailure(check, message, details = {}) {
  return {
    ok: false,
    check,
    message,
    details,
  };
}

function buildFeasibilitySuccess(details = {}) {
  return {
    ok: true,
    check: null,
    message: "",
    details,
  };
}

function analyzeFeasibilityV3(state, target, data, gaConfig) {
  const env = buildEnv(data || {}, gaConfig || {}, target || {});
  const targetEntries = getTargetEntries(target);
  const maxAffixSlots = getMaxAffixSlotsV3(state, data);
  const improveAffixIds = getImproveAffixIdsV3(target, gaConfig);
  const forbiddenAffixIds = getForbiddenAffixIdsV3(target, gaConfig);
  const protectedAffixIds = getProtectedAffixIdsV3(target, gaConfig);
  const targetIdSet = new Set(targetEntries.map((entry) => entry.affixId));

  const distinctRequiredTargetCount = targetEntries.length;
  const additionalProtectedCount = Array.from(protectedAffixIds)
    .filter((affixId) => !targetIdSet.has(affixId))
    .length;
  const protectedUnionCount = distinctRequiredTargetCount + additionalProtectedCount;

  if (protectedUnionCount > maxAffixSlots) {
    return buildFeasibilityFailure(
      "F4",
      `Required and protected affixes exceed slot capacity: need ${protectedUnionCount}, but only ${maxAffixSlots} slots are available.`,
      {
        maxAffixSlots,
        protectedUnionCount,
        protectedAffixIds: Array.from(protectedAffixIds),
      }
    );
  }

  for (const entry of targetEntries) {
    if (!isAffixLegalForStateV3(entry.affixId, state, env)) {
      return buildFeasibilityFailure(
        "F5",
        `Target affix ${affixName(entry.affixId, env)} is not legal for the current item slot, class, or affix pool.`,
        {
          illegalAffixId: entry.affixId,
          gearSlot: (state && state.gearSlot) || "Any",
          class: (state && state.class) || "Any",
        }
      );
    }
  }

  const requiredCounts = Object.create(null);
  const familyCounts = Object.create(null);
  for (const entry of targetEntries) {
    requiredCounts[entry.affixId] = (requiredCounts[entry.affixId] || 0) + 1;
    const family = getAffixFamilyV3(entry.affixId, env);
    if (family) {
      familyCounts[family] = (familyCounts[family] || 0) + 1;
    }
  }

  const duplicateRequiredAffix = Object.entries(requiredCounts)
    .find(([, count]) => count > 1);
  if (duplicateRequiredAffix) {
    return buildFeasibilityFailure(
      "F6",
      `Target affix ${affixName(duplicateRequiredAffix[0], env)} is required more than once, which exceeds item uniqueness constraints.`,
      { duplicateAffixId: duplicateRequiredAffix[0], duplicateCount: duplicateRequiredAffix[1] }
    );
  }

  const familyConflict = Object.entries(familyCounts).find(([, count]) => count > 1);
  if (familyConflict) {
    return buildFeasibilityFailure(
      "F6",
      `Target contains mutually exclusive affixes from the ${familyConflict[0]} family.`,
      { conflictingFamily: familyConflict[0], familyCount: familyConflict[1] }
    );
  }

  const forbiddenConflict = targetEntries.find((entry) => forbiddenAffixIds.has(entry.affixId));
  if (forbiddenConflict) {
    return buildFeasibilityFailure(
      "F7",
      `Target affix ${affixName(forbiddenConflict.affixId, env)} is both required and forbidden.`,
      { conflictingAffixId: forbiddenConflict.affixId }
    );
  }

  return buildFeasibilitySuccess({
    maxAffixSlots,
    protectedAffixIds: Array.from(protectedAffixIds),
    forbiddenAffixIds: Array.from(forbiddenAffixIds),
    improveAffixIds: Array.from(improveAffixIds),
  });
}

function buildFeasibilityFailureResult(feasibility) {
  const result = emptySummary(feasibility.message);
  result.diagnostics = buildWorkerDiagnosticsV3(result.diagnostics, {
    strategy: FEASIBILITY_STRATEGY,
    phase: "phase-1",
    feasibility,
  });

  return {
    iterations: 0,
    ...result,
    tree: null,
    stoppedByUser: false,
    elapsedMs: 0,
  };
}

function addDelegationDiagnostics(result, feasibility) {
  const diagnostics = result && result.diagnostics ? result.diagnostics : {};
  return {
    ...result,
    diagnostics: buildWorkerDiagnosticsV3(
      {
        ...diagnostics,
        delegatedStrategy: diagnostics.strategy || null,
        note: "v3 decomposition declined to model this instance exactly and the residual LAO* solver is not implemented yet, so the worker delegated to the v2 exact fallback.",
      },
      {
        strategy: FALLBACK_STRATEGY,
        phase: "phase-4-residual-v2-fallback",
        feasibility,
      }
    ),
  };
}

function shouldCompareApproximateILPWithResidualV3(solution) {
  if (!solution || !solution.ok || !solution.approximate || !solution.ilpResult) {
    return false;
  }

  if (solution.ilpResult.status !== "ITERATION_LIMIT") {
    return false;
  }

  const objective = Number(solution.ilpResult.objective);
  const bestBound = Number(solution.ilpResult.bestBound);
  if (!Number.isFinite(objective) || !Number.isFinite(bestBound)) {
    return true;
  }

  const boundGap = Math.max(0, objective - bestBound);
  return boundGap > ILP_APPROX_BOUND_GAP_THRESHOLD;
}

function choosePreferredApproximateResultV3(decompositionResult, residualResult) {
  const residualSuccess = Number(residualResult && residualResult.successProb);
  const decompositionSuccess = Number(decompositionResult && decompositionResult.successProb);

  if (Number.isFinite(residualSuccess) && Number.isFinite(decompositionSuccess)) {
    if (residualSuccess > decompositionSuccess + APPROX_COMPARE_SUCCESS_EPSILON) {
      return residualResult;
    }
    if (decompositionSuccess > residualSuccess + APPROX_COMPARE_SUCCESS_EPSILON) {
      return decompositionResult;
    }
  }

  const residualSteps = Number(residualResult && residualResult.expectedSteps);
  const decompositionSteps = Number(decompositionResult && decompositionResult.expectedSteps);
  if (Number.isFinite(residualSteps) && Number.isFinite(decompositionSteps)) {
    if (residualSteps + APPROX_COMPARE_STEPS_EPSILON < decompositionSteps) {
      return residualResult;
    }
    if (decompositionSteps + APPROX_COMPARE_STEPS_EPSILON < residualSteps) {
      return decompositionResult;
    }
  }

  const residualStatus = residualResult
    && residualResult.diagnostics
    && residualResult.diagnostics.residual
    ? residualResult.diagnostics.residual.status
    : "";
  if (residualStatus === "OPTIMAL") {
    return residualResult;
  }

  return decompositionResult;
}

// Bug 2 belt-and-suspenders: tag diagnostics.looseEstimate on the final
// result regardless of which strategy was used (decomposition or residual).
// This ensures the UI warning fires even if decomposition.selectedOptions
// is empty (e.g. when the residual solver is used for the same state that
// would produce a loose Case A estimate via decomposition).
function tagLooseEstimateIfApplicableV3(result, payload) {
  if (!result || !result.diagnostics) return result;
  if (!result.action || result.action.type !== "add" || !result.action.prism) return result;
  const env = buildEnv(payload.data || {}, payload.gaConfig || {}, payload.target || {});
  if (!isCaseAStuckRecoveryRiskV3(payload.state, payload.target, env, result.action.prism)) {
    return result;
  }
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      looseEstimate: true,
    },
  };
}

function optimizePayloadV3(payload, options = {}) {
  // refineDepth controls Bellman-backup depth for residual results.
  //   1 (default) → one concrete backup step when the residual layer wins.
  //   2           → two steps (used by runOptimizationV3 for better accuracy).
  //   0           → skip refinement (MC per-step lookups, recursive sub-calls).
  const refineDepth = options.refineDepth != null ? options.refineDepth : 1;
  // refineTopK controls how many top candidates are refined before re-picking.
  //   1 (default) → refine only the closed-form winner (old behaviour).
  //   6           → refine all 6 candidates; used by runOptimizationV3 to catch
  //                  cases where closed-form mis-orders (see fix notes in plan).
  const refineTopK = options.refineTopK != null ? options.refineTopK : 1;
  // refineBudgetMs: wall-clock cap for the refinement loop across all candidates.
  //   Infinity (default) → no cap; sub-calls finish unconditionally.
  const refineBudgetMs = options.refineBudgetMs != null ? options.refineBudgetMs : Infinity;

  const result = computeOptimizationResultV3(payload, options);

  const refined = (refineDepth > 0 && shouldRefineResultV3(result))
    ? refineRootActionV3(payload, result, { refineDepth, refineTopK, refineBudgetMs })
    : result;
  return tagLooseEstimateIfApplicableV3(refined, payload);
}

function computeOptimizationResultV3(payload, options = {}) {
  const feasibility = analyzeFeasibilityV3(payload.state, payload.target, payload.data, payload.gaConfig);
  if (!feasibility.ok) {
    return buildFeasibilityFailureResult(feasibility);
  }

  const residualEnvOverrides = getEffectiveResidualEnvOverridesV3(payload, options);

  const decompositionInput = buildDecompositionPlanInputV3(
    payload.state,
    payload.target,
    payload.data,
    payload.gaConfig,
    { feasibility }
  );
  if (decompositionInput.ok) {
    const solution = solveDecompositionPlanV3(decompositionInput);
    if (solution.ok) {
      const decompositionResult = buildDecompositionResultV3(solution, feasibility);
      if (!shouldCompareApproximateILPWithResidualV3(solution)) {
        return decompositionResult;
      }

      const residualApproxCandidate = solveResidualPayloadV3(payload, {
        feasibility,
        decompositionInput: {
          ...decompositionInput,
          ok: false,
          reason: "Decomposition returned only a wide-gap approximate ILP incumbent, so the case was also evaluated by the residual solver.",
        },
        stopView: options.stopView || null,
        residualEnv: options.residualEnv || null,
        residualEnvOverrides,
      });

      return choosePreferredApproximateResultV3(decompositionResult, residualApproxCandidate);
    }
    if (solution.ilpResult && solution.ilpResult.status === "INFEASIBLE") {
      return solveResidualPayloadV3(payload, {
        feasibility,
        decompositionInput: {
          ...decompositionInput,
          ok: false,
          reason: "The decomposition ILP found no feasible exact host assignment, so the case was escalated to the residual solver.",
        },
        stopView: options.stopView || null,
        residualEnv: options.residualEnv || null,
        residualEnvOverrides,
      });
    }
    if (solution.ilpResult) {
      return buildILPFailureResultV3(solution, feasibility);
    }
  }

  return solveResidualPayloadV3(payload, {
    feasibility,
    decompositionInput,
    stopView: options.stopView || null,
    residualEnv: options.residualEnv || null,
    residualEnvOverrides,
  });
}

// Approach 1 — one-step concrete refinement of residual headline values.
//
// The residual LAO* solver works on an abstract state graph that collapses
// distinct concrete successor states together. The abstract value at a node
// is an aggregate that can overshoot the true value of any particular
// concrete successor — sometimes by 2–3× (e.g. the user-reported 39.61 vs
// the correct ~14.07 for a deterministic Remove that lands in a
// decomposition-safe successor).
//
// We tighten the headline by performing one Bellman backup in CONCRETE
// space: for each (probability, successor) outcome of the recommended
// action, recursively call optimizePayloadV3(successor, { refineDepth: 0 })
// and use its expectedSteps. The recursive call routes through the
// decomposition layer when possible (exact), or back through residual
// (still approximate, but rooted one step deeper).
//
// Refinement is a strict improvement: it never worsens the headline.
// It's skipped when:
//   - the decomposition layer already produced an exact result, or
//   - any successor is infeasible / unevaluable (we bail rather than emit
//     a value built on partially-broken sub-results).

function shouldRefineResultV3(result) {
  if (!result || !result.diagnostics) return false;
  if (result.diagnostics.strategy !== RESIDUAL_STRATEGY) return false;
  if (!result.action) return false;
  if (!Number.isFinite(result.expectedSteps)) return false;
  return true;
}

// ── Inner Bellman-backup helper ───────────────────────────────────────────────
//
// Performs a single concrete Bellman-backup step for one (payload, action) pair.
// Shared by both applyOneStepRefinementV3 and refineRootActionV3.
//
// Parameters:
//   payload        — the optimizer payload for the current state.
//   action         — the action whose value we are computing.
//   env            — pre-built env from buildEnv(payload.*).
//   subRefineDepth — refineDepth to pass to recursive optimizePayloadV3 calls.
//                    0 = no further refinement (old behaviour).
//                    1 = one more step of refinement at each successor (depth-2
//                        Bellman from the root's perspective).
//   successorCache — shared Map({ stateKey → { value, looseEstimate } }) across
//                    multiple candidates to avoid re-evaluating the same
//                    concrete successor state more than once.
//
// Returns { refinedSteps, anySuccessorLoose } on success, or null when any
// successor is unevaluable (we bail rather than emit a partial result).
function refineOneAction(payload, action, env, subRefineDepth, successorCache) {
  const outcomes = getActionOutcomes(payload.state, action, env);
  if (!outcomes || outcomes.length === 0) return null;

  let sum = 0;
  let anySuccessorLoose = false;

  for (const outcome of outcomes) {
    const successor = outcome.state;
    const key = stateKey(successor);
    if (!successorCache.has(key)) {
      const term = isTerminal(successor, payload.target, env);
      let entry;
      if (term.terminal && term.success) {
        entry = { value: 0, looseEstimate: false };
      } else if (term.terminal && !term.success) {
        entry = { value: Infinity, looseEstimate: false };
      } else {
        // Strip timeMs from successor payloads: the caller's expanded residual
        // budget (e.g. timeMs:0 → 4096-state graph) applies to the root
        // evaluation only.  Sub-calls use the default 500-state budget so the
        // refinement loop doesn't cascade O(budget^depth) in wall time.
        // Successor states are typically simpler (one fewer wrong affix) and
        // are handled by the decomposition layer or a small residual graph.
        const { timeMs: _ignored, ...payloadBase } = payload;  // eslint-disable-line no-unused-vars
        const successorPayload = { ...payloadBase, state: successor };
        const subResult = optimizePayloadV3(successorPayload, { refineDepth: subRefineDepth });
        entry = {
          value: subResult && Number.isFinite(subResult.expectedSteps) ? subResult.expectedSteps : NaN,
          looseEstimate: !!(subResult && subResult.diagnostics && subResult.diagnostics.looseEstimate),
        };
      }
      successorCache.set(key, entry);
    }
    const cached = successorCache.get(key);
    if (!Number.isFinite(cached.value)) {
      // Unevaluable successor — bail rather than emit a partial refinement.
      return null;
    }
    if (cached.looseEstimate) anySuccessorLoose = true;
    sum += outcome.probability * cached.value;
  }

  return { refinedSteps: 1 + sum, anySuccessorLoose };
}

// ── Top-K root-action refinement ──────────────────────────────────────────────
//
// Refines up to `opts.refineTopK` of the ranked candidate actions from
// `result.diagnostics.candidateActions` and re-picks by the lowest refined
// value. This fixes the class of mis-orderings where the closed-form (abstract)
// LAO* value ranks action A above action B, but the concrete 1-step Bellman
// backup shows B is actually cheaper.
//
// When refineTopK = 1 this degenerates to the old applyOneStepRefinementV3
// behaviour (refine only the winner, no re-picking). The caller opts in to
// wider refinement; runOptimizationV3 uses K=6 and depth=2 by default.
//
// opts:
//   refineDepth   — Bellman backup depth. Sub-calls receive refineDepth-1 so
//                   depth=2 at the root means depth=1 at each successor.
//   refineTopK    — max candidates to refine (default 1, capped to available).
//   refineBudgetMs — wall-clock cap; stops before the next candidate if elapsed.
//                    Infinity = no cap (default).
function refineRootActionV3(payload, result, opts) {
  const { refineDepth, refineTopK, refineBudgetMs } = opts;
  const env = buildEnv(payload.data || {}, payload.gaConfig || {}, payload.target || {});

  // candidateActions is already sorted best-first (lowest closed-form rank).
  const allCandidates = (result.diagnostics && result.diagnostics.candidateActions) || [];
  const k = Math.max(1, Math.min(refineTopK, allCandidates.length));
  const candidates = allCandidates.slice(0, k);

  // Shared cache across all candidates: if two actions lead to the same
  // concrete successor state, we only pay the sub-optimize cost once.
  const successorCache = new Map();
  const t0 = Date.now();
  let bestRefined = null;

  for (const candidate of candidates) {
    if (Date.now() - t0 > refineBudgetMs) break;

    const r = refineOneAction(payload, candidate.action, env, refineDepth - 1, successorCache);
    if (r == null) continue;   // unevaluable successor — skip this candidate

    // Pick by the concrete refined value, which is the more accurate estimate.
    // We deliberately do NOT filter candidates by `refined <= abstract`: the
    // residual abstract value is not always an upper bound — when a prism holds
    // a matched target, the abstraction under-estimates the random-source
    // collision cost (e.g. abstract 6.0 vs. true ~20). Filtering those out
    // discarded the genuinely-cheapest action and left only over-estimated ones,
    // so the solver could recommend a regressive reroll. Comparing refined
    // values head-to-head is correct regardless of whether the abstract over- or
    // under-estimated.
    if (bestRefined == null || r.refinedSteps < bestRefined.refinedSteps) {
      bestRefined = { ...r, action: candidate.action };
    }
  }

  // If no candidate survived (all bailed or failed the sanity check), fall
  // back to the unrefined result so we never emit a worse recommendation.
  if (bestRefined == null) return result;

  // Build the refined result.  The action may differ from result.action — that
  // is the whole point.  Preserve everything else (including candidateActions
  // in diagnostics so the UI can still show alternates).
  return {
    ...result,
    action: bestRefined.action,
    expectedSteps: bestRefined.refinedSteps,
    diagnostics: {
      ...result.diagnostics,
      // Propagate looseEstimate transitively if any successor's value is loose.
      ...(bestRefined.anySuccessorLoose ? { looseEstimate: true } : {}),
      refinement: {
        applied: true,
        topK: candidates.length,
        depth: refineDepth,
        originalAction: result.action,
        originalSteps: result.expectedSteps,
        refinedSteps: bestRefined.refinedSteps,
        timedOut: Date.now() - t0 > refineBudgetMs,
      },
    },
  };
}

// ── Legacy single-action refinement (kept for reference) ─────────────────────
//
// Now superseded at the call site by refineRootActionV3 (called from
// optimizePayloadV3). Refactored to delegate to the shared helpers so it stays
// consistent if called directly.
function applyOneStepRefinementV3(payload, result) {
  const env = buildEnv(payload.data || {}, payload.gaConfig || {}, payload.target || {});
  const cache = new Map();
  const r = refineOneAction(payload, result.action, env, 0, cache);
  if (r == null) return result;

  const originalSteps = result.expectedSteps;
  const refinedSteps = r.refinedSteps;

  // Only adopt the refinement when it's a strict improvement.
  if (!(refinedSteps <= originalSteps + 1e-9)) return result;

  const outcomes = getActionOutcomes(payload.state, result.action, env);
  return {
    ...result,
    expectedSteps: refinedSteps,
    diagnostics: {
      ...result.diagnostics,
      ...(r.anySuccessorLoose ? { looseEstimate: true } : {}),
      refinement: {
        applied: true,
        originalSteps,
        refinedSteps,
        outcomeCount: outcomes ? outcomes.length : 0,
      },
    },
  };
}

function optimizeScenarioV3(payload, options = {}) {
  return optimizePayloadV3(payload, {
    stopView: null,
    scorer: options.scorer || null,
  });
}

// ── Gold-standard Monte Carlo verification (Tighten Steps Estimate) ──────────
//
// When payload.tightenStepsLevel is "light" | "heavy" | "adaptive", after the
// regular optimizer result is computed we simulate K full rollouts. At each
// step of each rollout we call optimizePayloadV3(currentState) (cached by
// state key) to choose the action, then sample an outcome from
// getActionOutcomes. Final headline = MC mean ± 95% CI.
//
// Goal vs. Approach 1: Approach 1 gives a tight depth-1 backup against the
// best-of-solvers value at successor states. MC with re-optimization at
// every step measures what the user will actually experience over many
// independent crafting attempts (always click "Optimize" between actions).
// Both should agree when the policy is optimal and decomposition is exact
// at the successor; disagreement is a useful quality signal.

const MC_LIGHT_ROLLOUTS = 100;
const MC_HEAVY_ROLLOUTS = 500;
const MC_ADAPTIVE_MAX_ROLLOUTS = 2000;
const MC_ADAPTIVE_WALL_BUDGET_MS = 120_000;
const MC_ADAPTIVE_CHECK_EVERY = 50;       // re-check CI every N rollouts
const MC_ADAPTIVE_TARGET_REL_HALF_WIDTH = 0.1; // CI half-width ≤ 10% of mean
const MC_ROLLOUT_STEP_CAP = 1000;
const MC_PROGRESS_EVERY = 20;

function resolveMCBudgetV3(payload) {
  const level = payload.tightenStepsLevel;
  const overrides = payload.tightenStepsOverrides || {};
  if (level === "light") {
    const target = overrides.lightRollouts != null ? overrides.lightRollouts : MC_LIGHT_ROLLOUTS;
    return { level, targetRollouts: target, maxRollouts: target, wallBudgetMs: Infinity, adaptive: false };
  }
  if (level === "heavy") {
    const target = overrides.heavyRollouts != null ? overrides.heavyRollouts : MC_HEAVY_ROLLOUTS;
    return { level, targetRollouts: target, maxRollouts: target, wallBudgetMs: Infinity, adaptive: false };
  }
  if (level === "adaptive") {
    const maxR = overrides.adaptiveMaxRollouts != null ? overrides.adaptiveMaxRollouts : MC_ADAPTIVE_MAX_ROLLOUTS;
    const wall = overrides.adaptiveWallBudgetMs != null ? overrides.adaptiveWallBudgetMs : MC_ADAPTIVE_WALL_BUDGET_MS;
    return { level, targetRollouts: maxR, maxRollouts: maxR, wallBudgetMs: wall, adaptive: true };
  }
  return null;
}

function computeMCStatsV3(stepCounts) {
  const n = stepCounts.length;
  if (n === 0) return { mean: NaN, stdev: NaN, ci95halfWidth: NaN };
  let sum = 0;
  for (const x of stepCounts) sum += x;
  const mean = sum / n;
  if (n === 1) return { mean, stdev: 0, ci95halfWidth: 0 };
  let sqSum = 0;
  for (const x of stepCounts) sqSum += (x - mean) * (x - mean);
  const stdev = Math.sqrt(sqSum / (n - 1));
  const ci95halfWidth = 1.96 * stdev / Math.sqrt(n);
  return { mean, stdev, ci95halfWidth };
}

function pickWeightedOutcomeV3(outcomes) {
  // outcomes: Array<{ probability, state }>. Probabilities should sum to ≈1.
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < outcomes.length; i++) {
    acc += outcomes[i].probability;
    if (r <= acc) return outcomes[i];
  }
  return outcomes[outcomes.length - 1];
}

// MC-specific corrections to the worker's outcome generator:
//
// 1. `buildEnv` adds family-aggregate "Other" entries to the affix map (e.g.
//    `elemental-damage-other`, `specific-resistance-other`). These are
//    modeling abstractions for value computation. The in-game cube always
//    produces a SPECIFIC subtype, so when MC samples an outcome containing
//    an "Other" id we expand it back to a uniformly-random non-target
//    non-duplicate family member.
//
// 2. The worker's outcome generator for `add`/`focused`/`chaotic` may produce
//    outcomes where the same affixId appears in multiple slots. The
//    optimizer's downstream feasibility check rejects such states and
//    returns no action — so following them in MC traps the rollout at the
//    step cap. In D4 the cube never produces duplicates of currently-held
//    affixes. We filter these out and renormalize, matching in-game
//    distribution.

function stateHasDuplicateAffixesV3(state) {
  if (!state || !Array.isArray(state.affixes)) return false;
  const seen = new Set();
  for (const entry of state.affixes) {
    if (!entry || !entry.affixId) continue;
    if (seen.has(entry.affixId)) return true;
    seen.add(entry.affixId);
  }
  return false;
}

function filterValidMCOutcomesV3(outcomes) {
  const valid = outcomes.filter((o) => !stateHasDuplicateAffixesV3(o.state));
  if (valid.length === 0) return [];
  const total = valid.reduce((s, o) => s + o.probability, 0);
  if (total <= 0) return [];
  return valid.map((o) => ({ probability: o.probability / total, state: o.state }));
}
function expandFamilyOtherInStateV3(successor, env, target) {
  if (!env || !env.familyOtherId) return successor;
  const otherIds = new Set(Object.values(env.familyOtherId));
  if (otherIds.size === 0) return successor;

  const targetIds = new Set((target && target.affixes) ? target.affixes.map((e) => e.affixId) : []);
  const presentIds = new Set(successor.affixes.map((a) => a.affixId));

  let replacedAffixes = null; // copy-on-write
  for (let i = 0; i < successor.affixes.length; i++) {
    const entry = successor.affixes[i];
    if (!otherIds.has(entry.affixId)) continue;

    const family = getAffixFamily(entry.affixId, env.affixMap);
    if (!family) continue;

    // Find real members of this family that are NOT target, NOT family-other,
    // NOT already present on the item, AND legal for the gear slot.
    const candidates = [];
    for (const affix of Object.values(env.affixMap)) {
      if (!affix || affix.family !== family) continue;
      if (otherIds.has(affix.id)) continue;
      if (targetIds.has(affix.id)) continue;
      if (presentIds.has(affix.id)) continue;
      candidates.push(affix);
    }
    if (candidates.length === 0) continue;

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    if (!replacedAffixes) replacedAffixes = successor.affixes.slice();
    replacedAffixes[i] = { ...entry, affixId: pick.id };
    presentIds.delete(entry.affixId);
    presentIds.add(pick.id);
  }
  if (!replacedAffixes) return successor;
  return { ...successor, affixes: replacedAffixes };
}

function isStopSignalledV3(stopView) {
  if (!stopView) return false;
  try {
    return Atomics.load(stopView, 0) !== 0;
  } catch (_) {
    return false;
  }
}

/**
 * Shared MC rollout engine. Repeatedly simulates `policyFn` from
 * `payload.state` until the budget is exhausted (or the stop signal /
 * adaptive CI target fires) and returns raw rollout statistics.
 *
 * `policyFn(state) -> action | null` supplies the next action for a concrete
 * state; `null` means the policy is stuck (recorded as a dead rollout).
 *
 * Truncated rollouts are split into:
 *   - dead:   terminal failure (GA broken), stuck policy, or no valid outcomes;
 *   - capped: hit MC_ROLLOUT_STEP_CAP without terminating.
 *
 * By default every transition counts as one step (the historical gold-
 * standard metric). With `options.useCubeStepCosts` each transition counts
 * `actionCost(action, state)` instead (cube ops 1, fresh enchant 0,
 * re-enchant 0.5) — the optimizer's actual objective. The rollout-length cap
 * always applies to transition count, not accumulated cost.
 *
 * @returns {{ stepCounts: number[], truncatedRolloutCount: number,
 *             deadRolloutCount: number, cappedRolloutCount: number,
 *             successSteps: number[], failureSteps: number[],
 *             aborted: boolean, earlyConverged: boolean, wallTimeMs: number }}
 */
function runMCRolloutLoopV3(payload, env, policyFn, budget, options = {}) {
  const stepCounts = [];
  let truncatedRolloutCount = 0;
  let deadRolloutCount = 0;
  let cappedRolloutCount = 0;
  const successSteps = [];  // actual steps for successful rollouts (when includeRolloutData)
  const failureSteps = [];  // actual steps for failed/truncated rollouts (before cap)
  const includeRolloutData = !!payload.includeRolloutData;
  const useCubeStepCosts = !!options.useCubeStepCosts;
  const startTime = Date.now();

  let aborted = false;
  let earlyConverged = false;

  for (let rollout = 0; rollout < budget.maxRollouts; rollout++) {
    if (isStopSignalledV3(options.stopView)) { aborted = true; break; }
    if (Date.now() - startTime > budget.wallBudgetMs) { aborted = true; break; }

    let state = payload.state;
    let steps = 0;
    let transitions = 0;
    let truncated = false;
    let dead = false;
    let capped = false;

    while (true) {
      const term = isTerminal(state, payload.target, env);
      if (term.terminal) {
        if (!term.success) {
          // Dead state encountered mid-rollout (GA broken). Cap as truncated.
          truncated = true;
          dead = true;
          if (includeRolloutData) failureSteps.push(steps); // actual steps before cap
          steps = MC_ROLLOUT_STEP_CAP;
        }
        break;
      }
      if (transitions >= MC_ROLLOUT_STEP_CAP) {
        truncated = true;
        capped = true;
        if (includeRolloutData) failureSteps.push(steps);
        break;
      }

      const action = policyFn(state);
      if (!action) {
        truncated = true;
        dead = true;
        if (includeRolloutData) failureSteps.push(steps);
        steps = MC_ROLLOUT_STEP_CAP;
        break;
      }

      const rawOutcomes = getActionOutcomes(state, action, env);
      if (!rawOutcomes || rawOutcomes.length === 0) {
        truncated = true;
        dead = true;
        if (includeRolloutData) failureSteps.push(steps);
        break;
      }
      const outcomes = filterValidMCOutcomesV3(rawOutcomes);
      if (outcomes.length === 0) {
        truncated = true;
        dead = true;
        if (includeRolloutData) failureSteps.push(steps);
        break;
      }

      const chosen = pickWeightedOutcomeV3(outcomes);
      steps += useCubeStepCosts ? actionCost(action, state) : 1;
      transitions++;
      state = expandFamilyOtherInStateV3(chosen.state, env, payload.target);
    }

    stepCounts.push(steps);
    if (truncated) {
      truncatedRolloutCount++;
      if (dead) deadRolloutCount++;
      if (capped) cappedRolloutCount++;
    } else if (includeRolloutData) {
      successSteps.push(steps);
    }

    const completed = stepCounts.length;
    if (typeof options.onProgress === "function" &&
        (completed % MC_PROGRESS_EVERY === 0 || completed === budget.maxRollouts)) {
      const stats = computeMCStatsV3(stepCounts);
      options.onProgress({
        completed,
        total: budget.targetRollouts,
        intermediateMean: stats.mean,
      });
    }

    if (budget.adaptive && completed >= MC_ADAPTIVE_CHECK_EVERY &&
        completed % MC_ADAPTIVE_CHECK_EVERY === 0) {
      const stats = computeMCStatsV3(stepCounts);
      if (Number.isFinite(stats.ci95halfWidth) && Number.isFinite(stats.mean) &&
          stats.mean > 0 && stats.ci95halfWidth <= MC_ADAPTIVE_TARGET_REL_HALF_WIDTH * stats.mean) {
        earlyConverged = true;
        break;
      }
    }
  }

  return {
    stepCounts,
    truncatedRolloutCount,
    deadRolloutCount,
    cappedRolloutCount,
    successSteps,
    failureSteps,
    aborted,
    earlyConverged,
    wallTimeMs: Date.now() - startTime,
  };
}

function runMCVerificationV3(payload, intermediateResult, options = {}) {
  const budget = resolveMCBudgetV3(payload);
  if (!budget) return intermediateResult;
  if (!intermediateResult || !intermediateResult.action) return intermediateResult;
  if (!Number.isFinite(intermediateResult.expectedSteps)) return intermediateResult;

  const env = buildEnv(payload.data || {}, payload.gaConfig || {}, payload.target || {});
  const actionCache = new Map();          // stateKey -> { type, prism, ... } or null (dead)
  const includeRolloutData = !!payload.includeRolloutData;

  if (typeof options.onProgress === "function") {
    options.onProgress({ completed: 0, total: budget.targetRollouts, intermediateResult });
  }

  // Seed cache with the headline state's action — the optimizer already
  // computed it for the displayed recommendation.
  actionCache.set(stateKey(payload.state), intermediateResult.action);

  const policyFn = (state) => {
    const key = stateKey(state);
    let action = actionCache.get(key);
    if (action === undefined) {
      const subResult = optimizePayloadV3({ ...payload, state }, { refineDepth: 0 });
      action = subResult && subResult.action ? subResult.action : null;
      actionCache.set(key, action);
    }
    return action;
  };

  const run = runMCRolloutLoopV3(payload, env, policyFn, budget, options);
  const stats = computeMCStatsV3(run.stepCounts);
  const completedRollouts = run.stepCounts.length;
  const finalApproximate = !!intermediateResult.approximate || run.aborted ||
    (budget.adaptive && !run.earlyConverged && completedRollouts >= budget.maxRollouts);

  return {
    ...intermediateResult,
    expectedSteps: Number.isFinite(stats.mean) ? stats.mean : intermediateResult.expectedSteps,
    approximate: finalApproximate,
    diagnostics: {
      ...intermediateResult.diagnostics,
      goldStandard: {
        applied: true,
        level: budget.level,
        rollouts: completedRollouts,
        mean: stats.mean,
        ci95halfWidth: stats.ci95halfWidth,
        stdev: stats.stdev,
        intermediateSteps: intermediateResult.expectedSteps,
        truncatedRolloutCount: run.truncatedRolloutCount,
        wallTimeMs: run.wallTimeMs,
        aborted: run.aborted,
        earlyConverged: run.earlyConverged,
        adaptive: budget.adaptive,
        ...(includeRolloutData ? { successStepCounts: run.successSteps, failureStepCounts: run.failureSteps } : {}),
      },
    },
  };
}

/**
 * Run the MC rollout engine for an arbitrary policy function and return
 * standalone statistics (no optimizer involvement). Used by the rules-based
 * solver evaluation; the comparison harness pins the budget via
 * `payload.tightenStepsLevel` + `payload.tightenStepsOverrides` so both
 * policies see identical rollout counts.
 *
 * @param {Object} payload - { state, target, data, gaConfig, tightenStepsLevel,
 *   tightenStepsOverrides?, includeRolloutData? }
 * @param {function(Object): (Object|null)} policyFn - state -> action | null.
 * @param {Object} [options] - { stopView?, onProgress?, env?, budget? }
 * @returns {Object|null} stats object, or null when no budget is configured.
 */
function runPolicyMCEvaluationV3(payload, policyFn, options = {}) {
  const budget = options.budget || resolveMCBudgetV3(payload);
  if (!budget) return null;

  const env = options.env
    || buildEnv(payload.data || {}, payload.gaConfig || {}, payload.target || {});
  const run = runMCRolloutLoopV3(payload, env, policyFn, budget, options);
  const stats = computeMCStatsV3(run.stepCounts);
  const completedRollouts = run.stepCounts.length;
  const includeRolloutData = !!payload.includeRolloutData;

  return {
    applied: true,
    level: budget.level,
    rollouts: completedRollouts,
    mean: stats.mean,
    ci95halfWidth: stats.ci95halfWidth,
    stdev: stats.stdev,
    truncatedRolloutCount: run.truncatedRolloutCount,
    deadRolloutCount: run.deadRolloutCount,
    cappedRolloutCount: run.cappedRolloutCount,
    successRate: completedRollouts > 0
      ? (completedRollouts - run.truncatedRolloutCount) / completedRollouts
      : NaN,
    wallTimeMs: run.wallTimeMs,
    aborted: run.aborted,
    earlyConverged: run.earlyConverged,
    adaptive: budget.adaptive,
    ...(includeRolloutData ? { successStepCounts: run.successSteps, failureStepCounts: run.failureSteps } : {}),
  };
}

// ── Rules-policy dev diagnostics ─────────────────────────────────────────────
// When the run payload carries `rulesPolicy: true` (Settings → Developer →
// "Compare rules-based policy", off by default), the secondary rules-based
// solver's headline pick — and, when MC verification is requested, its own
// MC stats through the same rollout engine — are attached to the result
// under diagnostics.rulesPolicy. Always JS-side; cheap (no optimizer calls).

function computeRulesPolicyDiagnosticsV3(payload, options = {}) {
  if (!rulesSolverModule || typeof rulesSolverModule.createRulesPolicyV3 !== "function") {
    return { applied: false, error: "rules solver module unavailable" };
  }
  try {
    const helpers = {
      buildEnv,
      getValidActions,
      getActionOutcomes,
      getEligibleByCategory,
      getCategoryAffixesForState,
      getCategoryWeightTotal,
      getEffectiveAffixRollWeight,
      buildFamilyCountsForPool,
      isTerminal,
      stateKey,
      actionKey,
    };
    const policyFn = rulesSolverModule.createRulesPolicyV3(payload, helpers);
    const pick = rulesSolverModule.selectRulesActionV3(
      payload.state, payload.target, policyFn.env, helpers
    );
    const wantsVerification = payload.tightenStepsLevel === "light"
      || payload.tightenStepsLevel === "heavy"
      || payload.tightenStepsLevel === "adaptive";
    let mc = null;
    if (wantsVerification && pick) {
      mc = runPolicyMCEvaluationV3(payload, policyFn, {
        env: policyFn.env,
        stopView: options.stopView,
      });
      if (mc) {
        // The per-rollout step lists are bulky and unused by the dev panel.
        delete mc.successStepCounts;
        delete mc.failureStepCounts;
      }
    }
    return {
      applied: true,
      action: pick ? pick.action : null,
      ruleName: pick ? pick.ruleName : null,
      mc,
    };
  } catch (e) {
    return { applied: false, error: String((e && e.message) || e) };
  }
}

function attachRulesPolicyDiagnosticsV3(payload, result, options = {}) {
  if (!payload || payload.rulesPolicy !== true || !result) {
    return result;
  }
  return {
    ...result,
    diagnostics: {
      ...(result.diagnostics || {}),
      rulesPolicy: computeRulesPolicyDiagnosticsV3(payload, options),
    },
  };
}

// ── ILP callback for Rust WASM path ──────────────────────────────────────────
// The Rust optimizer calls this with a serialized DecompositionPlanInput and
// expects a serialized solveDecompositionPlanV3 result back.
//
// Rust JSON serialization creates separate copies of option objects in both
// planInput.options and targets[i].options. solveDecompositionPlanV3 relies
// on buildDecompositionILPProblemV3 mutating planInput.options and those
// mutations being visible via the same object references in targets[i].options.
// We fix this by re-linking before calling the solver.
function makeRustIlpCallback() {
  return function rustIlpCallback(planInputJson) {
    try {
      const planInput = JSON.parse(planInputJson);
      // Re-link targets[i].options to reference the same objects as planInput.options.
      if (Array.isArray(planInput.options) && Array.isArray(planInput.targets)) {
        const byId = Object.create(null);
        for (const o of planInput.options) {
          if (o && o.id) byId[o.id] = o;
        }
        for (const row of planInput.targets) {
          if (Array.isArray(row.options)) {
            row.options = row.options.map((o) => (o && o.id && byId[o.id]) ? byId[o.id] : o);
          }
        }
      }
      const solution = solveDecompositionPlanV3(planInput);
      return JSON.stringify(solution);
    } catch (_) {
      return null;
    }
  };
}

function runOptimizationV3(payload, runId) {
  const stopBuffer = payload.stopBuffer || null;
  const stopView = stopBuffer ? new Int32Array(stopBuffer) : null;

  // ── Rust WASM path ────────────────────────────────────────────────────────
  if ((D4_USE_RUST || payload.useRust) && rustWorker && typeof rustWorker.optimize_payload === "function") {
    const payloadJson = JSON.stringify(payload);
    const ilpCb = makeRustIlpCallback();
    let result;
    try {
      const resultJson = rustWorker.optimize_payload(payloadJson, ilpCb);
      result = JSON.parse(resultJson);
    } catch (e) {
      // Fall back to JS path on error
      result = null;
    }

    if (result) {
      const wantsVerification = payload.tightenStepsLevel === "light"
        || payload.tightenStepsLevel === "heavy"
        || payload.tightenStepsLevel === "adaptive";

      if (!wantsVerification) {
        self.postMessage({ type: "done", runId, ...attachRulesPolicyDiagnosticsV3(payload, result, { stopView }) });
        return;
      }

      let firstProgressSent = false;
      let finalResult;
      if (typeof rustWorker.run_mc_verification === "function") {
        // Use Rust MC path
        try {
          const intermediateJson = JSON.stringify(result);
          const onProgressCb = (progressJson) => {
            try {
              const progress = JSON.parse(progressJson);
              const msg = {
                type: "verifying",
                runId,
                completed: progress.completed,
                total: progress.total,
              };
              if (!firstProgressSent && progress.intermediateResult) {
                msg.intermediateResult = progress.intermediateResult;
                firstProgressSent = true;
              }
              if (progress.intermediateMean !== undefined) {
                msg.intermediateMean = progress.intermediateMean;
              }
              self.postMessage(msg);
            } catch (_) {}
          };
          const finalJson = rustWorker.run_mc_verification(payloadJson, intermediateJson, ilpCb, onProgressCb);
          finalResult = JSON.parse(finalJson);
        } catch (_) {
          // Fall back to JS MC
          finalResult = runMCVerificationV3(payload, result, {
            stopView,
            onProgress: (progress) => {
              const msg = { type: "verifying", runId, completed: progress.completed, total: progress.total };
              if (!firstProgressSent && progress.intermediateResult) { msg.intermediateResult = progress.intermediateResult; firstProgressSent = true; }
              if (progress.intermediateMean !== undefined) { msg.intermediateMean = progress.intermediateMean; }
              self.postMessage(msg);
            },
          });
        }
      } else {
        // JS MC with Rust optimizer result as intermediate
        finalResult = runMCVerificationV3(payload, result, {
          stopView,
          onProgress: (progress) => {
            const msg = { type: "verifying", runId, completed: progress.completed, total: progress.total };
            if (!firstProgressSent && progress.intermediateResult) { msg.intermediateResult = progress.intermediateResult; firstProgressSent = true; }
            if (progress.intermediateMean !== undefined) { msg.intermediateMean = progress.intermediateMean; }
            self.postMessage(msg);
          },
        });
      }
      self.postMessage({ type: "done", runId, ...attachRulesPolicyDiagnosticsV3(payload, finalResult, { stopView }) });
      return;
    }
  }

  // ── JS path (default) ─────────────────────────────────────────────────────
  const result = optimizePayloadV3(payload, {
    stopView,
    refineDepth: 2,      // two concrete Bellman-backup steps
    refineTopK: 6,       // refine all 6 candidates before re-picking
    refineBudgetMs: 8000, // hard cap; falls back to best refined so far
  });

  const wantsVerification = payload.tightenStepsLevel === "light"
    || payload.tightenStepsLevel === "heavy"
    || payload.tightenStepsLevel === "adaptive";

  if (!wantsVerification) {
    self.postMessage({ type: "done", runId, ...attachRulesPolicyDiagnosticsV3(payload, result, { stopView }) });
    return;
  }

  let firstProgressSent = false;
  const finalResult = runMCVerificationV3(payload, result, {
    stopView,
    onProgress: (progress) => {
      const msg = {
        type: "verifying",
        runId,
        completed: progress.completed,
        total: progress.total,
      };
      if (!firstProgressSent && progress.intermediateResult) {
        msg.intermediateResult = progress.intermediateResult;
        firstProgressSent = true;
      }
      if (progress.intermediateMean !== undefined) {
        msg.intermediateMean = progress.intermediateMean;
      }
      self.postMessage(msg);
    },
  });

  self.postMessage({ type: "done", runId, ...attachRulesPolicyDiagnosticsV3(payload, finalResult, { stopView }) });
}

if (typeof self !== "undefined") {
  self.onmessage = async (event) => {
    const payload = event.data || {};

    if (payload.type === "set-scorer-model") {
      return;
    }

    if (payload.type === "stop") {
      return;
    }

    if (payload.type === "run") {
      const runId = Number(payload.runId) || 0;
      try {
        if (payload.useRust && !rustWorker && !_rustWorkerFailed) {
          await ensureRustWorker();
        }
        runOptimizationV3(payload, runId);
      } catch (error) {
        self.postMessage({
          type: "error",
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (payload.type === "compute-distribution") {
      const runId = Number(payload.runId) || 0;
      const intermediateResult = payload.intermediateResult;
      if (!intermediateResult || !intermediateResult.action) {
        self.postMessage({ type: "distribution-done", runId, goldStandard: null });
        return;
      }
      try {
        const distPayload = {
          ...payload,
          tightenStepsLevel: "light",
          tightenStepsOverrides: { lightRollouts: Number(payload.distRollouts) || 200 },
          includeRolloutData: true,
        };
        const stopBuffer = payload.stopBuffer || null;
        const stopView = stopBuffer ? new Int32Array(stopBuffer) : null;
        const result = runMCVerificationV3(distPayload, intermediateResult, {
          stopView,
          onProgress: (progress) => {
            self.postMessage({
              type: "distribution-progress",
              runId,
              completed: progress.completed,
              total: progress.total,
            });
          },
        });
        self.postMessage({
          type: "distribution-done",
          runId,
          goldStandard: result.diagnostics && result.diagnostics.goldStandard
            ? result.diagnostics.goldStandard
            : null,
        });
      } catch (error) {
        self.postMessage({
          type: "distribution-done",
          runId,
          goldStandard: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_MAX_AFFIX_SLOTS,
    FEASIBILITY_STRATEGY,
    FALLBACK_STRATEGY,
    DECOMPOSITION_STRATEGY,
    RESIDUAL_STRATEGY,
    CLOSED_FORM_CASE_IDS,
    normalizeIdList,
    getCurrentAffixes,
    getTargetEntries,
    getHostEntryV3,
    getCurrentGACountsV3,
    getTotalCurrentGACountV3,
    getImproveAffixIdsV3,
    getForbiddenAffixIdsV3,
    getProtectedAffixIdsV3,
    getMaxAffixSlotsV3,
    getAffixFamilyV3,
    getAffixCategoriesV3,
    getAffixCategoriesForOpV3,
    affixHasCategoryV3,
    isAffixLegalForStateV3,
    getCategoryPoolSizeV3,
    countPresentAffixesInCategoryV3,
    getCategorySuccessDenominatorV3,
    isCategoryFocusedBlockedByGAV3,
    isCategoryFocusedBlockedByMatchedTargetV3,
    isUniqueUnlockedCategoryHostV3,
    computeCaseAExpectedStepsV3,
    computeCaseBExpectedStepsV3,
    computeCaseCExpectedStepsV3,
    computeDeterministicEnchantExpectedStepsV3,
    isEmptyHostSlotV3,
    isDiscretionaryEnchantSlotV3,
    getClosedFormResidualReasonV3,
    getClosedFormPlanCandidatesV3,
    chooseBestClosedFormPlanV3,
    buildClosedFormPlanTableV3,
    isTargetSatisfiedAtSlotV3,
    buildDecompositionPlanInputV3,
    computeDecompositionOptionExpectedStepsV3,
    optionsConflictV3,
    buildDecompositionILPProblemV3,
    solveDecompositionPlanV3,
    getResidualRelevantAffixIdsV3,
    getResidualAffixSignatureV3,
    createResidualAbstractionContextV3,
    getResidualAffixTokenV3,
    residualStateKeyV3,
    buildResidualEnvV3,
    getResidualEnvOverridesForTimeV3,
    buildResidualReachableGraphV3,
    computeResidualHeuristicStepsV3,
    solveResidualExactV3,
    solveResidualLAOStarV3,
    buildResidualApproximateResultV3,
    getValidActionsV2,
    solveResidualPayloadV3,
    analyzeFeasibilityV3,
    optimizePayloadV3,
    optimizeScenarioV3,
    runOptimizationV3,
    runMCVerificationV3,
    runMCRolloutLoopV3,
    runPolicyMCEvaluationV3,
    computeRulesPolicyDiagnosticsV3,
    attachRulesPolicyDiagnosticsV3,
    resolveMCBudgetV3,
    computeMCStatsV3,
    // MC verification budget constants — exposed for tests + benchmarks.
    MC_LIGHT_ROLLOUTS,
    MC_HEAVY_ROLLOUTS,
    MC_ADAPTIVE_MAX_ROLLOUTS,
    MC_ADAPTIVE_WALL_BUDGET_MS,
    MC_ADAPTIVE_CHECK_EVERY,
    MC_ADAPTIVE_TARGET_REL_HALF_WIDTH,
    MC_ROLLOUT_STEP_CAP,
    MC_PROGRESS_EVERY,
    // Re-export key base-worker helpers used by tests.
    buildEnv: buildEnv,
    stateKey: stateKey,
    actionKey: actionKey,
    isTerminal: isTerminal,
    breaksRequiredGA: breaksRequiredGA,
    getAffixCounts: getAffixCounts,
    getActionOutcomes: getActionOutcomes,
    getValidActions: getValidActions,
    getEligibleByCategory: getEligibleByCategory,
    isAdeptFocusedBlocked: isAdeptFocusedBlocked,
    getCategoryAffixesForState: getCategoryAffixesForState,
    getCategoryWeightTotal: getCategoryWeightTotal,
    affixSupportsClass: affixSupportsClass,
    getEffectiveAffixRollWeight: getEffectiveAffixRollWeight,
    buildFamilyCountsForPool: buildFamilyCountsForPool,
    makeRustIlpCallback: makeRustIlpCallback,
  };
}
