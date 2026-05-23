/* d4cubeoptim-worker.js
 * Monte Carlo optimizer for Horadric Cube affix planning.
 */

let stopRequested = false;
const ROOT_EXPLORE_EPSILON = 0.14;
const ROOT_MIN_VISITS_BASE = 6;
const ROOT_MIN_VISITS_LOG_SCALE = 2;
const ROLLOUT_EPSILON = 0;
const RULE_SUCCESS_THRESHOLD = 1 - 1e-9;
const ELEMENTAL_DAMAGE_FAMILY = "elemental-damage";
const SPECIFIC_RESISTANCE_FAMILY = "specific-resistance";
const FAMILY_OTHER_IDS = {
  [ELEMENTAL_DAMAGE_FAMILY]: `${ELEMENTAL_DAMAGE_FAMILY}-other`,
  [SPECIFIC_RESISTANCE_FAMILY]: `${SPECIFIC_RESISTANCE_FAMILY}-other`,
};

if (typeof self !== "undefined") {
  self.onmessage = (event) => {
    const payload = event.data || {};

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

function runOptimization(payload, runId) {
  const stopBuffer = payload.stopBuffer || null;
  const stopView = stopBuffer ? new Int32Array(stopBuffer) : null;
  const result = optimizePayload(payload, {
    stopView,
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

function optimizeScenario(payload) {
  stopRequested = false;
  return optimizePayload(payload, {
    stopView: null,
    onProgress: null,
  });
}

function shouldStop(stopView) {
  if (stopRequested) {
    return true;
  }
  if (stopView && typeof Atomics !== "undefined") {
    return Atomics.load(stopView, 0) === 1;
  }
  return false;
}

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

function getAffixFamily(affixId, affixMap) {
  const affix = affixMap[affixId];
  if (affix && affix.family) {
    return affix.family;
  }
  return inferAffixFamily(affixId);
}

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

function canonicalizeStateForEnv(state, env) {
  const next = cloneState(state);
  next.affixes = next.affixes.map((entry) => ({
    affixId: canonicalizeAffixIdForState(entry.affixId, env),
    isGA: !!entry.isGA,
    isEnchanted: !!entry.isEnchanted,
  }));
  return next;
}

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

function buildEnv(data, gaConfig, target) {
  const categories = data.categories || {};
  const categoryNames = Object.keys(categories);
  const affixes = data.affixes || [];
  const affixMap = Object.create(null);
  const categoryAffixes = Object.create(null);

  for (const affix of affixes) {
    affixMap[affix.id] = affix;
  }

  for (const categoryName of categoryNames) {
    categoryAffixes[categoryName] = (categories[categoryName] || [])
      .map((id) => affixMap[id])
      .filter(Boolean);
  }

  const wantedByFamily = Object.create(null);

  const gaRequiredCounts = Object.create(null);
  const gaSacrificeId = (gaConfig && gaConfig.sacrificeAffixId) || "";
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
  const targetGARequired = Object.create(null);
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

    if (req.requireGA) {
      targetGARequired[req.affixId] = (targetGARequired[req.affixId] || 0) + 1;
    }
  }

  for (const [affixId, requiredCount] of Object.entries(targetGARequired)) {
    gaRequiredCounts[affixId] = requiredCount;
  }

  const familyOtherId = {
    [ELEMENTAL_DAMAGE_FAMILY]: FAMILY_OTHER_IDS[ELEMENTAL_DAMAGE_FAMILY],
    [SPECIFIC_RESISTANCE_FAMILY]: FAMILY_OTHER_IDS[SPECIFIC_RESISTANCE_FAMILY],
  };

  for (const [family, otherId] of Object.entries(familyOtherId)) {
    if (affixMap[otherId]) {
      continue;
    }

    const seedAffix = affixes.find((entry) => getAffixFamily(entry.id, affixMap) === family);
    if (!seedAffix) {
      continue;
    }

    affixMap[otherId] = {
      id: otherId,
      name: family === ELEMENTAL_DAMAGE_FAMILY ? "Elemental Damage (Other)" : "Specific Resistance (Other)",
      categories: Array.isArray(seedAffix.categories) ? [...seedAffix.categories] : [],
      family,
      rollWeight: 1,
    };
  }

  const impossibleTargetFamilyReason = getImpossibleTargetFamilyReason(targetCounts, affixMap);
  const impossibleTargetGAReason = impossibleTargetFamilyReason || getImpossibleTargetGAReason(sourceGACounts, targetGARequired, affixMap);

  return {
    affixMap,
    categoryNames,
    categoryAffixes,
    targetAffixSet: new Set(data.targetAffixIds || []),
    gaRequiredCounts,
    gaSacrificeId,
    sourceGACounts,
    impossibleTargetGAReason,
    wantedByFamily,
    familyOtherId,
    strictMode: !!(gaConfig && gaConfig.strictMode),
    rulesEnabled: !gaConfig || gaConfig.rulesEnabled !== false,
    targetCounts,
    targetGARequired,
  };
}

function getImpossibleTargetGAReason(sourceGACounts, targetGARequired, affixMap) {
  for (const [affixId, requiredCount] of Object.entries(targetGARequired)) {
    if ((sourceGACounts[affixId] || 0) >= requiredCount) {
      continue;
    }

    const affix = affixMap[affixId];
    const name = affix ? affix.name : affixId;
    return `Impossible target: ${name} cannot be required as GA because it was not GA on the source item.`;
  }

  return "";
}

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

function createNode(state) {
  return {
    state: cloneState(state),
    visits: 0,
    actions: Object.create(null),
  };
}

function stateKey(state) {
  const tokens = state.affixes
    .map((entry) => `${entry.affixId}|${entry.isGA ? 1 : 0}|${entry.isEnchanted ? 1 : 0}`);
  return [
    `L${state.isLegendary ? 1 : 0}`,
    `E${state.enchantressAvailable ? 1 : 0}`,
    `S${state.gearSlot || "any"}`,
    tokens.join(","),
  ].join("#");
}

function cloneState(state) {
  return {
    isLegendary: !!state.isLegendary,
    enchantressAvailable: !!state.enchantressAvailable,
    gearSlot: state.gearSlot || "Any",
    affixes: (state.affixes || []).map((entry) => ({
      affixId: entry.affixId,
      isGA: !!entry.isGA,
      isEnchanted: !!entry.isEnchanted,
    })),
  };
}

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

function isProtectedGA(entry, env) {
  if (!entry || !entry.isGA) {
    return false;
  }
  return (env.gaRequiredCounts[entry.affixId] || 0) > 0;
}

function isTerminal(state, target, env) {
  if (breaksRequiredGA(state, env)) {
    return { terminal: true, success: false };
  }

  const stateCounts = getAffixCounts(state.affixes);
  for (const requirement of target.affixes) {
    if (!stateCounts[requirement.affixId]) {
      return { terminal: false, success: false };
    }

    if (requirement.requireGA) {
      const gaCount = state.affixes.filter((entry) => entry.affixId === requirement.affixId && entry.isGA).length;
      if (gaCount < 1) {
        return { terminal: false, success: false };
      }
    }
  }

  return { terminal: true, success: true };
}

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

function actionKey(action) {
  const source = Number.isInteger(action.sourceIndex) ? action.sourceIndex : "_";
  const target = action.targetAffixId || "_";
  const prism = action.prism || "_";
  return `${action.type}|${prism}|${source}|${target}`;
}

function getValidActions(state, target, env) {
  const actions = [];

  for (const categoryName of env.categoryNames) {
    if (state.affixes.length < 4) {
      actions.push({ type: "add", prism: categoryName });
    }

    const eligible = getEligibleByCategory(state, env, categoryName);
    const touchesProtectedGA = eligible.some(({ entry }) => isProtectedGA(entry, env));

    if (!state.isLegendary && eligible.length > 0) {
      if (!touchesProtectedGA) {
        actions.push({ type: "remove", prism: categoryName });
      }
    }

    if (eligible.length > 0) {
      if (!touchesProtectedGA) {
        actions.push({ type: "chaotic", prism: categoryName });
        actions.push({ type: "focused", prism: categoryName });
      }
    }
  }

  if (state.enchantressAvailable && !state.affixes.some((entry) => entry.isEnchanted)) {
    const desiredIds = new Set(target.affixes.map((entry) => entry.affixId));

    state.affixes.forEach((entry, index) => {
      desiredIds.add(entry.affixId);
      for (const targetAffixId of desiredIds) {
        if (isProtectedGA(entry, env) && targetAffixId !== entry.affixId) {
          continue;
        }
        actions.push({
          type: "enchant",
          sourceIndex: index,
          targetAffixId,
        });
      }
    });
  }

  return actions;
}

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

function getEligibleByCategory(state, env, categoryName) {
  return state.affixes
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (entry.isEnchanted) {
        return false;
      }
      const affix = env.affixMap[entry.affixId];
      return affix && affix.categories.includes(categoryName);
    });
}

function getAffixRollWeight(affix) {
  const weight = Number(affix && affix.rollWeight);
  if (!Number.isFinite(weight) || weight <= 0) {
    return 1;
  }
  return weight;
}

function getCategoryWeightTotal(env, categoryName) {
  const list = env.categoryAffixes[categoryName] || [];
  let total = 0;
  for (const affix of list) {
    total += getAffixRollWeight(affix);
  }
  return total;
}

function getActionOutcomes(state, action, env) {
  const outcomes = [];

  if (action.type === "add") {
    const list = env.categoryAffixes[action.prism] || [];
    if (list.length === 0 || state.affixes.length >= 4) {
      return [];
    }

    const totalWeight = getCategoryWeightTotal(env, action.prism);
    if (totalWeight <= 0) {
      return [];
    }

    for (const affix of list) {
      const p = getAffixRollWeight(affix) / totalWeight;
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
    return mergeOutcomes(outcomes);
  }

  if (action.type === "remove") {
    if (state.isLegendary) {
      return [];
    }
    const eligible = getEligibleByCategory(state, env, action.prism);
    if (eligible.length === 0) {
      return [];
    }

    const p = 1 / eligible.length;
    for (const { index } of eligible) {
      const next = cloneState(state);
      next.affixes.splice(index, 1);
      outcomes.push({ probability: p, state: next });
    }
    return mergeOutcomes(outcomes);
  }

  if (action.type === "focused") {
    const eligible = getEligibleByCategory(state, env, action.prism);
    if (eligible.length === 0) {
      return [];
    }

    const list = env.categoryAffixes[action.prism] || [];
    if (list.length === 0) {
      return [];
    }

    const sourceP = 1 / eligible.length;
    const totalWeight = getCategoryWeightTotal(env, action.prism);
    if (totalWeight <= 0) {
      return [];
    }

    for (const { index } of eligible) {
      for (const affix of list) {
        const affixP = getAffixRollWeight(affix) / totalWeight;
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
    return mergeOutcomes(outcomes);
  }

  if (action.type === "chaotic") {
    const eligible = getEligibleByCategory(state, env, action.prism);
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
        const list = env.categoryAffixes[categoryName] || [];
        if (list.length === 0) {
          continue;
        }

        const totalWeight = getCategoryWeightTotal(env, categoryName);
        if (totalWeight <= 0) {
          continue;
        }

        for (const affix of list) {
          const affixP = getAffixRollWeight(affix) / totalWeight;
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

    return mergeOutcomes(outcomes);
  }

  if (action.type === "enchant") {
    if (!state.enchantressAvailable || state.affixes.some((entry) => entry.isEnchanted)) {
      return [];
    }
    if (!Number.isInteger(action.sourceIndex) || action.sourceIndex < 0 || action.sourceIndex >= state.affixes.length) {
      return [];
    }
    if (!action.targetAffixId || !env.affixMap[action.targetAffixId]) {
      return [];
    }

    const source = state.affixes[action.sourceIndex];
    if (source.isEnchanted) {
      return [];
    }

    const next = cloneState(state);
    next.affixes[action.sourceIndex] = {
      affixId: canonicalizeAffixIdForState(action.targetAffixId, env),
      isGA: !!source.isGA,
      isEnchanted: true,
    };
    next.enchantressAvailable = false;

    if (violatesFamilyUniqueness(next, env)) {
      return [];
    }

    return [{ probability: 1, state: next }];
  }

  return [];
}

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

function isCubeAction(action) {
  return action.type === "add" || action.type === "remove" || action.type === "chaotic" || action.type === "focused";
}

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
    return {
      cubeSteps: heuristicRemainingSteps(node.state, target, env),
      successProb: heuristicSuccessProbability(node.state, target, env),
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
    } else {
      successProb = heuristicSuccessProbability(cur, target, env);
      stepEstimate = steps + heuristicRemainingSteps(cur, target, env);
    }

    successProbSum += successProb;
    cubeStepsSum += stepEstimate;
  }

  return {
    cubeSteps: cubeStepsSum / Math.max(1, rolloutCount),
    successProb: successProbSum / Math.max(1, rolloutCount),
  };
}

function chooseRolloutAction(state, actions, env, target) {
  if (Math.random() < ROLLOUT_EPSILON) {
    return actions[Math.floor(Math.random() * actions.length)];
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

  return bestAction;
}

function scoreEpisode(cubeSteps, successProb) {
  return (successProb * 130) - ((1 - successProb) * 45) - cubeSteps;
}

function clampProb(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function immediateStepHint(state, action, env, target) {
  const outcomes = getActionOutcomes(state, action, env);
  if (outcomes.length === 0) {
    return 35;
  }

  const cubeCost = isCubeAction(action) ? 1 : 0;
  let successMass = 0;
  let weightedSteps = 0;

  for (const outcome of outcomes) {
    const term = isTerminal(outcome.state, target, env);
    let successProb;
    let remainingSteps;

    if (term.terminal) {
      successProb = term.success ? 1 : 0;
      remainingSteps = 0;
    } else {
      successProb = heuristicSuccessProbability(outcome.state, target, env);
      remainingSteps = heuristicRemainingSteps(outcome.state, target, env);
    }

    successMass += outcome.probability * successProb;
    weightedSteps += outcome.probability * successProb * (cubeCost + remainingSteps);
  }

  if (successMass > 1e-7) {
    return weightedSteps / successMass;
  }

  return cubeCost + heuristicRemainingSteps(state, target, env);
}

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
        diagnostics: {
          reason: ruleDecision.reason,
          rootVisits: root.visits,
          strategy: "rules-first",
          rule: ruleDecision,
          candidateActions: [],
        },
      };
    }

    return emptySummary("No actions from current state");
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
      expectedSteps = heuristicRemainingSteps(root.state, target, env) + (isCubeAction(entry.action) ? 1 : 0);
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
    diagnostics: {
      rootVisits: root.visits,
      strategy: ruleDecision && ruleDecision.action ? "rules-first" : "mcts",
      rule: ruleDecision || null,
      candidateActions: actionsTop,
    },
  };
}

function immediateSuccessHint(state, action, env, target) {
  const outcomes = getActionOutcomes(state, action, env);
  if (outcomes.length === 0) {
    return 0;
  }

  let hint = 0;
  for (const outcome of outcomes) {
    const term = isTerminal(outcome.state, target, env);
    if (term.terminal) {
      hint += outcome.probability * (term.success ? 1 : 0);
      continue;
    }
    hint += outcome.probability * heuristicSuccessProbability(outcome.state, target, env);
  }
  return clampProb(hint);
}

function getAffixIdCountsFromState(state) {
  return getAffixCounts((state && state.affixes) || []);
}

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

    const eligible = getEligibleByCategory(state, env, action.prism);
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
    const eligible = getEligibleByCategory(state, env, action.prism);
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

function topBreakdown(list) {
  return list
    .filter((entry) => Number.isFinite(entry.probability) && entry.probability > 0)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 6);
}

function sourceLabel(state, index, env) {
  if (!Number.isInteger(index) || index < 0 || index >= state.affixes.length) {
    return "Selected affix";
  }
  return affixName(state.affixes[index].affixId, env);
}

function affixName(affixId, env) {
  const affix = env.affixMap[affixId];
  return affix ? affix.name : affixId;
}

function rolloutStateScore(state, target, env) {
  const terminal = isTerminal(state, target, env);
  if (terminal.terminal) {
    return terminal.success ? 100 : -120;
  }

  return (heuristicSuccessProbability(state, target, env) * 200) - heuristicRemainingSteps(state, target, env);
}

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

function canUseFocusedBridgeSource(entry, env, matchedFlags, index) {
  if (!entry || !entry.affixId || entry.isEnchanted) {
    return false;
  }
  if (matchedFlags[index]) {
    return false;
  }
  return !isProtectedGA(entry, env);
}

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

function getFocusedCategoryHitCost(env, categoryName, targetAffixId) {
  const list = env.categoryAffixes[categoryName] || [];
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

      const list = env.categoryAffixes[categoryName] || [];
      const seenNextIds = new Set();
      for (const candidate of list) {
        if (seenNextIds.has(candidate.id)) {
          continue;
        }
        seenNextIds.add(candidate.id);

        const hitCost = getFocusedCategoryHitCost(env, categoryName, candidate.id);
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

    const requiredGA = env.targetGARequired[affixId] || 0;
    const currentGA = stateGACounts[affixId] || 0;
    if (requiredGA > currentGA) {
      return null;
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

function estimateMissingAffixSteps(state, env, affixId, openSlots, extraCount, matchedFlags) {
  const affix = env.affixMap[affixId];
  if (!affix || !Array.isArray(affix.categories) || affix.categories.length === 0) {
    return 35;
  }

  let best = Infinity;

  for (const categoryName of affix.categories) {
    const list = env.categoryAffixes[categoryName] || [];
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

function evaluateState(state, target, env) {
  if (breaksRequiredGA(state, env)) {
    return -220;
  }

  const stateCounts = getAffixCounts(state.affixes);
  const stateGACounts = getAffixCounts(state.affixes, (entry) => entry.isGA);

  let score = 0;
  let missing = 0;

  for (const requirement of target.affixes) {
    if (stateCounts[requirement.affixId] > 0) {
      score += 24;
    } else {
      score -= 20;
      missing += 1;
    }

    if (requirement.requireGA) {
      if ((stateGACounts[requirement.affixId] || 0) > 0) {
        score += 16;
      } else {
        score -= 28;
      }
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

  const guaranteedFocusedBridge = getGuaranteedFocusedBridgeEstimate(state, target, env);
  if (guaranteedFocusedBridge) {
    return guaranteedFocusedBridge.successProb;
  }

  const score = evaluateState(state, target, env);
  const logistic = 1 / (1 + Math.exp(-((score - 4) / 16)));
  const remainingSteps = heuristicRemainingSteps(state, target, env);
  const reachability = Math.exp(-(remainingSteps / 24));
  return clampProb(logistic * reachability);
}

function heuristicRemainingSteps(state, target, env) {
  if (env.impossibleTargetGAReason) {
    return 35;
  }

  const terminal = isTerminal(state, target, env);
  if (terminal.terminal) {
    return 0;
  }

  const guaranteedFocusedBridge = getGuaranteedFocusedBridgeEstimate(state, target, env);
  if (guaranteedFocusedBridge) {
    return guaranteedFocusedBridge.expectedSteps;
  }

  const stateCounts = getAffixCounts(state.affixes);
  const stateGACounts = getAffixCounts(state.affixes, (entry) => entry.isGA);
  const targetCounts = env.targetCounts || getTargetCountsFromTarget(target);
  const matchedFlags = markMatchedTargetAffixes(state, targetCounts);

  let openSlots = Math.max(0, 4 - state.affixes.length);
  let extraCount = matchedFlags.reduce((count, matched) => count + (matched ? 0 : 1), 0);
  let total = 0;
  let missingGA = 0;

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

    const requiredGA = env.targetGARequired[affixId] || 0;
    const currentGA = stateGACounts[affixId] || 0;
    missingGA += Math.max(0, requiredGA - currentGA);
  }

  if (missingGA > 0) {
    total += missingGA * 4.5;
  }

  return Math.max(1, total);
}

function emptySummary(reason) {
  return {
    action: null,
    expectedSteps: null,
    variance: null,
    stdDev: null,
    successProb: 0,
    diagnostics: {
      reason,
      rootVisits: 0,
      candidateActions: [],
    },
  };
}

function terminalSummary(terminal, env) {
  if (terminal.success) {
    return {
      action: null,
      expectedSteps: 0,
      variance: 0,
      stdDev: 0,
      successProb: 1,
      diagnostics: {
        reason: "Current state already satisfies the target.",
        rootVisits: 0,
        candidateActions: [],
      },
    };
  }

  return emptySummary(env.impossibleTargetGAReason || "Target requirements cannot be satisfied from the current state.");
}

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
    getEligibleByCategory,
    getActionOutcomes,
    mergeOutcomes,
    isCubeAction,
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
    heuristicSuccessProbability,
    heuristicRemainingSteps,
    emptySummary,
    shrinkTree,
  };
}
