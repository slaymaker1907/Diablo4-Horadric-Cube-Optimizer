/**
 * d4cubeoptimv2-worker.js
 *
 * Exact two-phase SSP solver built on the shared transition helpers from the
 * v1 worker. Phase 1 maximizes eventual success probability on the reachable
 * graph. Phase 2 minimizes expected cube steps among Phase 1-optimal actions.
 */

let baseWorker = null;

if (typeof module !== "undefined" && module.exports) {
  baseWorker = require("./d4cubeoptim-worker.js");
} else if (typeof importScripts !== "undefined") {
  importScripts("./d4cubeoptim-worker.js");
  baseWorker = {
    buildEnv,
    stateKey,
    cloneState,
    isTerminal,
    breaksRequiredGA,
    actionKey,
    getValidActions,
    getActionOutcomes,
    isCubeAction,
    getOneStepTargetLossRisk,
    getActionProbabilityBreakdown,
    affixName,
    getTargetCountsFromTarget,
    emptySummary,
    terminalSummary,
    shouldStop,
    clampProb,
  };
}

if (!baseWorker) {
  throw new Error("Unable to load d4cubeoptim-worker.js helpers for v2 solver.");
}

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
  const next = baseWorker.cloneState(state);
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
    `E${state && state.enchantressAvailable ? 1 : 0}`,
    `S${(state && state.gearSlot) || "Any"}`,
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
  const env = baseWorker.buildEnv(data, gaConfig, target);
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
    if (!state.enchantressAvailable) {
      return "A required target GA is missing and enchanting is no longer available.";
    }

    if (missingRequiredGAIds.length > 1) {
      return "More than one required GA identity is still missing, but only one enchant remains.";
    }

    if (getGADonorSourceIndexes(state, env).length === 0) {
      return "No disposable GA remains to transfer onto the required target affix.";
    }
  }

  if (!state.enchantressAvailable && Array.isArray(state.unsatisfactoryAffixIds) && state.unsatisfactoryAffixIds.length > 0) {
    const unsatisfactoryCounts = getUnsatisfactoryCounts(state);
    for (const [affixId, count] of Object.entries(unsatisfactoryCounts)) {
      const hasTarget = target.affixes.some((entry) => entry.affixId === affixId);
      if (!hasTarget) {
        continue;
      }
      const matchingEntries = state.affixes.filter((entry) => entry.affixId === affixId);
      const lockedCount = matchingEntries.filter((entry) => entry.isEnchanted).length;
      if (lockedCount >= count) {
        return `${baseWorker.affixName(affixId, env)} still needs improvement but the slot is locked.`;
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

    if (action.type !== "enchant" && baseWorker.isCubeAction(action) && keepCount > 0) {
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
  if (!state.enchantressAvailable || (state.affixes || []).some((entry) => entry.isEnchanted)) {
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
  if (!state.enchantressAvailable || (state.affixes || []).some((entry) => entry.isEnchanted)) {
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
    const key = baseWorker.actionKey(action);
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
  const actions = baseWorker.getValidActions(state, target, env)
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
      if (!entry || entry.isEnchanted) {
        return false;
      }
      return action.targetAffixId !== entry.affixId;
    });

  const forcedGAEnchantActions = getForcedGAEnchantActions(state, env);
  if (forcedGAEnchantActions.length > 0) {
    return dedupeActions(forcedGAEnchantActions);
  }

  const lateEnchantActions = getLateEnchantActions(state, target, env, actions);
  return dedupeActions([
    ...actions.filter((action) => action.type !== "enchant"),
    ...lateEnchantActions,
  ]);
}

function getActionOutcomesV2(state, action, env) {
  const merged = new Map();
  let totalProbability = 0;

  for (const outcome of baseWorker.getActionOutcomes(state, action, env)) {
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

  return baseWorker.actionKey(left.action).localeCompare(baseWorker.actionKey(right.action));
}

function createGraphNode(state, key, target, env) {
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

function expandReachableGraph(rootState, target, env, options = {}) {
  const limit = Number.isFinite(options.stateLimit) ? options.stateLimit : env.stateLimit;
  const stopView = options.stopView || null;

  const root = normalizeOutcomeStateV2(rootState);
  const rootKey = stateKeyV2(root, env);
  const keyToIndex = new Map([[rootKey, 0]]);
  const nodes = [createGraphNode(root, rootKey, target, env)];
  let deadStates = nodes[0].deadReason ? 1 : 0;

  for (let queueIndex = 0; queueIndex < nodes.length; queueIndex += 1) {
    if (shouldStopV2(stopView)) {
      throw new Error("Optimization stopped.");
    }

    const node = nodes[queueIndex];
    if (node.success || node.deadReason) {
      continue;
    }

    const actionEntries = [];
    for (const action of node.actions) {
      const outcomes = getActionOutcomesV2(node.state, action, env);
      const transitions = [];

      for (const outcome of outcomes) {
        const child = normalizeOutcomeStateV2(outcome.state);
        const childKey = stateKeyV2(child, env);
        let childIndex = keyToIndex.get(childKey);

        if (childIndex === undefined) {
          if (nodes.length >= limit) {
            return {
              ok: false,
              limit,
              rootKey,
              nodes,
              deadStates,
              reason: `Reachable state graph exceeded exact solver limit (${limit} states).`,
            };
          }

          childIndex = nodes.length;
          keyToIndex.set(childKey, childIndex);
          const childNode = createGraphNode(child, childKey, target, env);
          if (childNode.deadReason) {
            deadStates += 1;
          }
          nodes.push(childNode);
        }

        transitions.push({
          probability: outcome.probability,
          childIndex,
        });
      }

      actionEntries.push({
        action,
        cubeCost: baseWorker.isCubeAction(action) ? 1 : 0,
        transitions,
      });
    }

    node.actionEntries = actionEntries;
  }

  return {
    ok: true,
    rootKey,
    nodes,
    deadStates,
  };
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
    return baseWorker.emptySummary("Exact solver root state was not found.");
  }

  if (root.success) {
    const result = terminalSummaryV2();
    result.diagnostics.strategy = "exact-ssp";
    result.diagnostics.expandedStates = graph.nodes.length;
    result.diagnostics.deadStates = graph.deadStates;
    return result;
  }

  if (root.deadReason) {
    const result = baseWorker.emptySummary(root.deadReason);
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

    const breakdown = baseWorker.getActionProbabilityBreakdown(root.state, entry.action, env);

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
      ? baseWorker.getOneStepTargetLossRisk(root.state, best.action, env, target)
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

function shouldStopV2(stopView) {
  if (workerStopRequested) {
    return true;
  }

  return baseWorker.shouldStop(stopView);
}

function optimizePayloadV2(payload, options = {}) {
  const {
    state,
    target,
    data,
    gaConfig,
  } = payload;
  const stopView = options.stopView || null;

  const env = buildEnvV2(data, gaConfig, target);
  const rootState = attachUnsatisfactoryToState(state, gaConfig);

  if (env.impossibleTargetGAReason) {
    const result = baseWorker.emptySummary(env.impossibleTargetGAReason);
    result.diagnostics.strategy = "exact-ssp";
    result.diagnostics.expandedStates = 0;
    result.diagnostics.deadStates = 0;
    return result;
  }

  const initialTerminal = isSuccessStateV2(rootState, target, env);
  if (initialTerminal) {
    const result = terminalSummaryV2();
    result.diagnostics.strategy = "exact-ssp";
    result.diagnostics.expandedStates = 1;
    result.diagnostics.deadStates = 0;
    return {
      iterations: 0,
      ...result,
      tree: null,
      stoppedByUser: false,
      elapsedMs: 0,
    };
  }

  const deadReason = classifyDeadReason(rootState, target, env);
  if (deadReason) {
    const result = baseWorker.emptySummary(deadReason);
    result.diagnostics.strategy = "exact-ssp";
    result.diagnostics.expandedStates = 1;
    result.diagnostics.deadStates = 1;
    return {
      iterations: 0,
      ...result,
      tree: null,
      stoppedByUser: false,
      elapsedMs: 0,
    };
  }

  const startedAt = Date.now();
  const graph = expandReachableGraph(rootState, target, env, {
    stateLimit: env.stateLimit,
    stopView,
  });

  if (!graph.ok) {
    const result = baseWorker.emptySummary(graph.reason);
    result.diagnostics.strategy = "exact-ssp";
    result.diagnostics.expandedStates = graph.nodes.length;
    result.diagnostics.deadStates = graph.deadStates;
    return {
      iterations: 0,
      ...result,
      tree: null,
      stoppedByUser: false,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const phase1 = solvePhase1(graph, env);
  const phase2 = solvePhase2(graph, phase1, env);
  const result = summarizeRootV2(graph, graph.rootKey, env, target, phase1, phase2);

  return {
    iterations: 0,
    ...result,
    tree: null,
    stoppedByUser: false,
    elapsedMs: Date.now() - startedAt,
  };
}

function optimizeScenarioV2(payload, options = {}) {
  workerStopRequested = false;
  return optimizePayloadV2(payload, {
    stopView: null,
    scorer: options.scorer || null,
  });
}

function runOptimizationV2(payload, runId) {
  const stopBuffer = payload.stopBuffer || null;
  const stopView = stopBuffer ? new Int32Array(stopBuffer) : null;
  const result = optimizePayloadV2(payload, { stopView });
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
      workerStopRequested = true;
      return;
    }

    if (payload.type === "run") {
      workerStopRequested = false;
      const runId = Number(payload.runId) || 0;
      try {
        runOptimizationV2(payload, runId);
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
    EXACT_SSP_STATE_LIMIT,
    EXACT_SSP_MAX_ITERATIONS,
    EXACT_SSP_EPSILON,
    buildEnvV2,
    attachUnsatisfactoryToState,
    cloneStateV2,
    stateKeyV2,
    normalizeOutcomeStateV2,
    terminalSummaryV2,
    isSuccessStateV2,
    classifyDeadReason,
    isDeadStateV2,
    getValidActionsV2,
    getActionOutcomesV2,
    expandReachableGraph,
    solvePhase1,
    solvePhase2,
    summarizeRootV2,
    optimizePayloadV2,
    optimizeScenarioV2,
    runOptimizationV2,
    baseWorker,
  };
}