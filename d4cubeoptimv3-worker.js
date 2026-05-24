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

let sharedWorker = null;
let fallbackWorker = null;
let ilpWorker = null;

if (typeof module !== "undefined" && module.exports) {
  ilpWorker = require("./ilp.js");
  sharedWorker = require("./d4cubeoptim-worker.js");
  fallbackWorker = require("./d4cubeoptimv2-worker.js");
} else if (typeof importScripts !== "undefined") {
  importScripts("./ilp.js");
  importScripts("./d4cubeoptimv2-worker.js");
  ilpWorker = {
    solveILP: typeof solveILP === "function" ? solveILP : null,
  };
  sharedWorker = {
    buildEnv,
    emptySummary,
    affixName,
    shouldStop: typeof shouldStop === "function" ? shouldStop : null,
    isCubeAction: typeof isCubeAction === "function" ? isCubeAction : null,
    actionKey: typeof actionKey === "function" ? actionKey : null,
  };
  fallbackWorker = {
    EXACT_SSP_EPSILON: typeof EXACT_SSP_EPSILON === "number" ? EXACT_SSP_EPSILON : 1e-9,
    buildEnvV2: typeof buildEnvV2 === "function" ? buildEnvV2 : null,
    attachUnsatisfactoryToState: typeof attachUnsatisfactoryToState === "function" ? attachUnsatisfactoryToState : null,
    cloneStateV2: typeof cloneStateV2 === "function" ? cloneStateV2 : null,
    stateKeyV2: typeof stateKeyV2 === "function" ? stateKeyV2 : null,
    normalizeOutcomeStateV2: typeof normalizeOutcomeStateV2 === "function" ? normalizeOutcomeStateV2 : null,
    terminalSummaryV2: typeof terminalSummaryV2 === "function" ? terminalSummaryV2 : null,
    isSuccessStateV2: typeof isSuccessStateV2 === "function" ? isSuccessStateV2 : null,
    classifyDeadReason: typeof classifyDeadReason === "function" ? classifyDeadReason : null,
    isDeadStateV2: typeof isDeadStateV2 === "function" ? isDeadStateV2 : null,
    getValidActionsV2: typeof getValidActionsV2 === "function" ? getValidActionsV2 : null,
    getActionOutcomesV2: typeof getActionOutcomesV2 === "function" ? getActionOutcomesV2 : null,
    solvePhase1: typeof solvePhase1 === "function" ? solvePhase1 : null,
    solvePhase2: typeof solvePhase2 === "function" ? solvePhase2 : null,
    summarizeRootV2: typeof summarizeRootV2 === "function" ? summarizeRootV2 : null,
    optimizePayloadV2: typeof optimizePayloadV2 === "function" ? optimizePayloadV2 : null,
    optimizeScenarioV2: typeof optimizeScenarioV2 === "function" ? optimizeScenarioV2 : null,
  };
}

if (!sharedWorker) {
  throw new Error("Unable to load shared worker helpers for v3 solver.");
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
});
const KEEP_PLAN_CASE_ID = "KEEP";
const RESIDUAL_STATE_LIMIT = 500;
const RESIDUAL_STATE_LIMIT_CAP = 4096;
const RESIDUAL_MAX_ITERATIONS = 4096;
const RESIDUAL_MAX_ITERATIONS_CAP = 1048576;
const RESIDUAL_EPSILON = 1e-9;
const RESIDUAL_ACTION_EPSILON = 1e-8;
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

function isAffixLegalForStateV3(affixId, state, env) {
  const affix = env && env.affixMap ? env.affixMap[affixId] : null;
  if (!affix) {
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
  let base;

  if (gearSlot === "Any") {
    base = env && env.categoryAffixes ? (env.categoryAffixes[category] || []) : [];
  } else {
    const bySlot = env && env.categoryAffixesBySlot ? env.categoryAffixesBySlot[gearSlot] : null;
    if (bySlot && Array.isArray(bySlot[category])) {
      base = bySlot[category];
    } else {
      const affixes = env && env.categoryAffixes ? (env.categoryAffixes[category] || []) : [];
      base = affixes.filter((affix) => isAffixLegalForStateV3(affix.id, state, env));
    }
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

function computeCaseAExpectedStepsV3(n) {
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
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

  if (
    hostEntry
    && options.allowDiscretionaryEnchant === true
    && state && state.enchantressAvailable
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
      const expectedSteps = computeCaseAExpectedStepsV3(n);
      if (Number.isFinite(expectedSteps)) {
        candidates.push(createClosedFormCandidateV3(
          CLOSED_FORM_CASE_IDS.A,
          slotIndex,
          targetEntry,
          expectedSteps,
          { prism, denominator: n }
        ));
      }
    }

    return candidates.sort(compareClosedFormCandidatesV3);
  }

  if (hostEntry.isEnchanted) {
    return candidates;
  }

  const sharedCategories = targetCategoriesFocused.filter(
    (category) => affixHasCategoryV3(hostEntry.affixId, category, env, "focused")
  );

  if (targetEntry.needsImprovement && hostEntry.affixId === targetEntry.affixId && !hostEntry.isGA) {
    for (const prism of sharedCategories) {
      if (isCategoryFocusedBlockedByGAV3(state, prism, env)) { continue; }
      if (isCategoryFocusedBlockedByMatchedTargetV3(state, prism, env, slotIndex)) { continue; }
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

  if (sharedCategories.length === 0) {
    const removableCategories = getAffixCategoriesForOpV3(hostEntry.affixId, "remove", env)
      .filter((category) => isUniqueUnlockedCategoryHostV3(state, slotIndex, category, env, "remove"));

    for (const removePrism of removableCategories) {
      for (const prism of targetCategoriesFocused) {
        if (isCategoryFocusedBlockedByGAV3(state, prism, env)) { continue; }
        if (isCategoryFocusedBlockedByMatchedTargetV3(state, prism, env, slotIndex)) { continue; }
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
  const env = options.env || sharedWorker.buildEnv(data || {}, gaConfig || {}, target || {});
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
  if (option.caseId === CLOSED_FORM_CASE_IDS.D || option.caseId === CLOSED_FORM_CASE_IDS.E) {
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
    usesEnchant: candidate.caseId === CLOSED_FORM_CASE_IDS.D || candidate.caseId === CLOSED_FORM_CASE_IDS.E,
    costKind: constantCase ? "constant" : "stage",
    constantCost: constantCase ? candidate.expectedSteps : 0,
    baseDenominator: Number.isFinite(candidate.denominator) ? candidate.denominator : null,
    requiresStage: !!prism && (prismDelta > 0 || !constantCase),
    sourceIndex: Number.isInteger(candidate.sourceIndex) ? candidate.sourceIndex : slotIndex,
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
  const env = options.env || sharedWorker.buildEnv(data || {}, gaConfig || {}, target || {});
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
    return computeCaseAExpectedStepsV3(adjustedDenominator);
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
  const result = sharedWorker.emptySummary(solution.reason);
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
  const baseEnv = options.baseEnv || sharedWorker.buildEnv(data || {}, gaConfig || {}, target || {});
  const v2Env = options.v2Env || (fallbackWorker && typeof fallbackWorker.buildEnvV2 === "function"
    ? fallbackWorker.buildEnvV2(data || {}, gaConfig || {}, target || {})
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
    `E${state && state.enchantressAvailable ? 1 : 0}`,
    `S${(state && state.gearSlot) || "Any"}`,
    `A${tokens.join(",")}`,
    `U${unsatisfactory}`,
  ].join("#");
}

function createResidualGraphNodeV3(state, key, target, env) {
  const success = fallbackWorker.isSuccessStateV2(state, target, env);
  const deadReason = success ? "" : fallbackWorker.classifyDeadReason(state, target, env);
  const actions = success || deadReason ? [] : fallbackWorker.getValidActionsV2(state, target, env);
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
  if (!fallbackWorker || typeof fallbackWorker.buildEnvV2 !== "function") {
    return null;
  }

  const env = fallbackWorker.buildEnvV2(data || {}, gaConfig || {}, target || {});
  env.stateLimit = Number.isFinite(overrides.stateLimit) ? overrides.stateLimit : RESIDUAL_STATE_LIMIT;
  env.maxIterations = Number.isFinite(overrides.maxIterations) ? overrides.maxIterations : RESIDUAL_MAX_ITERATIONS;
  env.epsilon = Number.isFinite(overrides.epsilon) ? overrides.epsilon : RESIDUAL_EPSILON;
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
  if (!fallbackWorker || typeof fallbackWorker.attachUnsatisfactoryToState !== "function") {
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
    : fallbackWorker.attachUnsatisfactoryToState(rootState, gaConfig || {});
  const root = fallbackWorker.normalizeOutcomeStateV2(attachedRoot);
  const rootKey = residualStateKeyV3(root, context);
  const keyToIndex = new Map([[rootKey, 0]]);
  const nodes = [createResidualGraphNodeV3(root, rootKey, target, env)];
  let deadStates = nodes[0].deadReason ? 1 : 0;

  for (let queueIndex = 0; queueIndex < nodes.length; queueIndex += 1) {
    if (sharedWorker.shouldStop(stopView)) {
      throw new Error("Optimization stopped.");
    }

    const node = nodes[queueIndex];
    if (node.success || node.deadReason) {
      continue;
    }

    const actionEntries = [];
    for (const action of node.actions) {
      const merged = new Map();

      for (const outcome of fallbackWorker.getActionOutcomesV2(node.state, action, env)) {
        const child = fallbackWorker.normalizeOutcomeStateV2(outcome.state);
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
        cubeCost: sharedWorker.isCubeAction(action) ? 1 : 0,
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
  const env = options.baseEnv || sharedWorker.buildEnv(data || {}, gaConfig || {}, target || {});
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
    const key = sharedWorker.actionKey(entry.action);

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

function selectBestResidualPhase2ActionIndexV3(node, stateIndex, phase1Values, costs, env) {
  const optimalSuccess = phase1Values[stateIndex];
  if (optimalSuccess <= env.epsilon) {
    return -1;
  }

  let bestIndex = -1;
  let bestCost = Infinity;
  let bestKey = "";

  for (let index = 0; index < node.actionEntries.length; index += 1) {
    const entry = node.actionEntries[index];
    const success = getResolvedActionSuccessV3(entry, stateIndex, phase1Values);
    if (Math.abs(success - optimalSuccess) > RESIDUAL_ACTION_EPSILON) {
      continue;
    }

    const candidate = getResolvedActionWeightedCostV3(entry, stateIndex, optimalSuccess, costs);
    const key = sharedWorker.actionKey(entry.action);
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
    if (sharedWorker.shouldStop(stopView)) {
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

  let converged = false;
  let iterations = 0;
  let residual = Infinity;
  let policyStates = 1;
  let policyImprovementSteps = 0;

  for (; iterations < env.maxIterations; iterations += 1) {
    if (sharedWorker.shouldStop(stopView)) {
      throw new Error("Optimization stopped.");
    }

    policyImprovementSteps += 1;
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

      const bestIndex = selectBestResidualPhase2ActionIndexV3(node, index, phase1.values, costs, env);
      const rawValue = bestIndex >= 0
        ? getResolvedActionWeightedCostV3(node.actionEntries[bestIndex], index, optimalSuccess, costs)
        : 0;
      const nextValue = Number.isFinite(rawValue) ? rawValue : 0;
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

  const finalPolicy = getResidualPolicyGraphV3(
    graph,
    graph.rootIndex,
    (node, stateIndex) => selectBestResidualPhase2ActionIndexV3(node, stateIndex, phase1.values, costs, env)
  );
  policyStates = finalPolicy.order.length;

  return { costs, iterations, converged, residual, policyStates, policyImprovementSteps };
}

function solveResidualExactV3(graph, env) {
  const phase1 = fallbackWorker.solvePhase1(graph, env);
  const phase2 = fallbackWorker.solvePhase2(graph, phase1, env);
  return { phase1, phase2 };
}

function solveResidualLAOStarV3(graph, target, data, gaConfig, options = {}) {
  const env = options.env || graph.env;
  const baseEnv = options.baseEnv || (graph.context ? graph.context.baseEnv : sharedWorker.buildEnv(data || {}, gaConfig || {}, target || {}));
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
  const result = sharedWorker.emptySummary(message);
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
  const summary = fallbackWorker.summarizeRootV2(
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
  const summary = fallbackWorker.summarizeRootV2(
    graph,
    graph.rootKey,
    env,
    target,
    residualSolution.phase1,
    effectivePhase2,
    { reason: "Residual abstract-state solver returned the best policy found before reaching solver limits." }
  );

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
  const baseEnv = sharedWorker.buildEnv(payload.data || {}, payload.gaConfig || {}, payload.target || {});
  const v2Env = options.residualEnv || buildResidualEnvV3(
    payload.data,
    payload.gaConfig,
    payload.target,
    options.residualEnvOverrides || {}
  );

  if (!v2Env || !fallbackWorker || typeof fallbackWorker.summarizeRootV2 !== "function") {
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
  const env = sharedWorker.buildEnv(data || {}, gaConfig || {}, target || {});
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
        `Target affix ${sharedWorker.affixName(entry.affixId, env)} is not legal for the current item slot or affix pool.`,
        { illegalAffixId: entry.affixId, gearSlot: (state && state.gearSlot) || "Any" }
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
      `Target affix ${sharedWorker.affixName(duplicateRequiredAffix[0], env)} is required more than once, which exceeds item uniqueness constraints.`,
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
      `Target affix ${sharedWorker.affixName(forbiddenConflict.affixId, env)} is both required and forbidden.`,
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
  const result = sharedWorker.emptySummary(feasibility.message);
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

function optimizePayloadV3(payload, options = {}) {
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

function optimizeScenarioV3(payload, options = {}) {
  return optimizePayloadV3(payload, {
    stopView: null,
    scorer: options.scorer || null,
  });
}

function runOptimizationV3(payload, runId) {
  const stopBuffer = payload.stopBuffer || null;
  const stopView = stopBuffer ? new Int32Array(stopBuffer) : null;
  const result = optimizePayloadV3(payload, { stopView });
  self.postMessage({
    type: "done",
    runId,
    ...result,
  });
}

if (typeof self !== "undefined") {
  self.onmessage = (event) => {
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
        runOptimizationV3(payload, runId);
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
    solveResidualPayloadV3,
    analyzeFeasibilityV3,
    optimizePayloadV3,
    optimizeScenarioV3,
    runOptimizationV3,
    // Re-export key base-worker helpers used by tests.
    buildEnv: sharedWorker ? sharedWorker.buildEnv : null,
    getActionOutcomes: sharedWorker ? sharedWorker.getActionOutcomes : null,
    getValidActions: sharedWorker ? sharedWorker.getValidActions : null,
    getEligibleByCategory: sharedWorker ? sharedWorker.getEligibleByCategory : null,
  };
}