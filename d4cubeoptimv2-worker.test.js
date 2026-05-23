const test = require("node:test");
const assert = require("node:assert/strict");

const worker = require("./d4cubeoptimv2-worker.js");
const workerV1 = require("./d4cubeoptim-worker.js");

function approxEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `Expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildCatalogFixture(categoryToNames) {
  const byId = new Map();

  for (const [category, names] of Object.entries(categoryToNames)) {
    for (const entry of names) {
      const name = typeof entry === "string" ? entry : entry.name;
      const family = typeof entry === "string" ? "" : String(entry.family || "");
      const rollWeight = typeof entry === "string" ? 1 : Number(entry.rollWeight);
      const id = normalizeName(name);

      if (!byId.has(id)) {
        byId.set(id, {
          id,
          name,
          categories: [],
          family,
          rollWeight: Number.isFinite(rollWeight) && rollWeight > 0 ? rollWeight : 1,
        });
      }

      if (family) {
        byId.get(id).family = family;
      }
      if (Number.isFinite(rollWeight) && rollWeight > 0) {
        byId.get(id).rollWeight = rollWeight;
      }
      byId.get(id).categories.push(category);
    }
  }

  const affixes = Array.from(byId.values());
  const byName = Object.fromEntries(affixes.map((affix) => [affix.name, affix]));
  const categories = Object.fromEntries(
    Object.entries(categoryToNames).map(([category, names]) => [
      category,
      names.map((entry) => byName[typeof entry === "string" ? entry : entry.name].id),
    ])
  );

  return { affixes, byName, categories };
}

function buildSimpleFixture() {
  const categoryToNames = {
    Protector: ["Armor", "Life on Hit"],
    Pragmatic: ["Movement Speed", "Maximum Evade Charges"],
    Resourceful: ["Maximum Resource"],
    Adept: ["Mainstat"],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  return {
    data: {
      affixes,
      categories,
      targetAffixIds: [],
    },
    byName,
  };
}

function buildState(affixes, options = {}) {
  return {
    gearSlot: options.gearSlot || "Any",
    isLegendary: !!options.isLegendary,
    enchantressAvailable: !!options.enchantressAvailable,
    affixes: affixes.map((entry) => ({
      affixId: entry.affixId,
      isGA: !!entry.isGA,
      isEnchanted: !!entry.isEnchanted,
    })),
    unsatisfactoryAffixIds: Array.isArray(options.unsatisfactoryAffixIds)
      ? options.unsatisfactoryAffixIds.slice()
      : [],
  };
}

function buildOneMissingFixture() {
  const { data, byName } = buildSimpleFixture();
  const currentState = buildState([
    { affixId: byName["Armor"].id, isGA: true, isEnchanted: false },
    { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: false },
  ], {
    enchantressAvailable: false,
  });

  const target = {
    affixes: [
      { affixId: byName["Armor"].id, requireGA: true },
      { affixId: byName["Movement Speed"].id, requireGA: false },
      { affixId: byName["Maximum Evade Charges"].id, requireGA: false },
    ],
  };

  return {
    data: {
      ...data,
      targetAffixIds: target.affixes.map((entry) => entry.affixId),
    },
    byName,
    currentState,
    target,
  };
}

function buildGAEnchantTransferFixture() {
  const { data, byName } = buildSimpleFixture();
  const currentState = buildState([
    { affixId: byName["Armor"].id, isGA: true, isEnchanted: false },
    { affixId: byName["Life on Hit"].id, isGA: false, isEnchanted: false },
  ], {
    enchantressAvailable: true,
  });

  const target = {
    affixes: [
      { affixId: byName["Movement Speed"].id, requireGA: true },
      { affixId: byName["Life on Hit"].id, requireGA: false },
    ],
  };

  return {
    data: {
      ...data,
      targetAffixIds: target.affixes.map((entry) => entry.affixId),
    },
    byName,
    currentState,
    target,
  };
}

test("stateKeyV2 is order-independent for affixes and needs-improvement markers", () => {
  const stateA = buildState([
    { affixId: "armor", isGA: true, isEnchanted: false },
    { affixId: "movement-speed", isGA: false, isEnchanted: false },
  ], {
    enchantressAvailable: true,
    unsatisfactoryAffixIds: ["movement-speed", "armor"],
  });

  const stateB = buildState([
    { affixId: "movement-speed", isGA: false, isEnchanted: false },
    { affixId: "armor", isGA: true, isEnchanted: false },
  ], {
    enchantressAvailable: true,
    unsatisfactoryAffixIds: ["armor", "movement-speed"],
  });

  assert.equal(worker.stateKeyV2(stateA), worker.stateKeyV2(stateB));
});

test("enchant outcomes preserve GA while cube-touch outcomes destroy it", () => {
  const { data, byName } = buildSimpleFixture();
  const target = {
    affixes: [{ affixId: byName["Movement Speed"].id, requireGA: false }],
  };
  const env = worker.buildEnvV2(data, {
    currentGAAffixes: [byName["Armor"].id],
    unsatisfactoryAffixIds: [],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const state = buildState([
    { affixId: byName["Armor"].id, isGA: true, isEnchanted: false },
  ], {
    enchantressAvailable: true,
  });

  const enchantOutcomes = worker.getActionOutcomesV2(state, {
    type: "enchant",
    sourceIndex: 0,
    targetAffixId: byName["Movement Speed"].id,
  }, env);

  assert.equal(enchantOutcomes.length, 1);
  assert.deepEqual(enchantOutcomes[0].state.affixes, [
    {
      affixId: byName["Movement Speed"].id,
      isGA: true,
      isEnchanted: true,
    },
  ]);
  assert.equal(enchantOutcomes[0].state.enchantressAvailable, false);

  const cubeOutcomes = worker.getActionOutcomesV2(state, {
    type: "focused",
    prism: "Protector",
  }, env);

  assert.ok(cubeOutcomes.length > 0);
  assert.ok(cubeOutcomes.every((outcome) => outcome.state.affixes[0].isGA === false));
});

test("locked needs-improvement targets are classified as dead states", () => {
  const { data, byName } = buildSimpleFixture();
  const target = {
    affixes: [{ affixId: byName["Movement Speed"].id, requireGA: false }],
  };
  const env = worker.buildEnvV2(data, {
    currentGAAffixes: [],
    unsatisfactoryAffixIds: [byName["Movement Speed"].id],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const state = buildState([
    { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: true },
  ], {
    enchantressAvailable: false,
    unsatisfactoryAffixIds: [byName["Movement Speed"].id],
  });

  const reason = worker.classifyDeadReason(state, target, env);
  assert.match(reason, /needs improvement/i);
  assert.equal(worker.isDeadStateV2(state, target, env), true);
  assert.equal(worker.isSuccessStateV2(state, target, env), false);
});

test("v2 defers enchanting while more than one target affix is still unresolved", () => {
  const { data, byName } = buildSimpleFixture();
  const target = {
    affixes: [
      { affixId: byName["Movement Speed"].id, requireGA: false },
      { affixId: byName["Maximum Evade Charges"].id, requireGA: false },
    ],
  };
  const env = worker.buildEnvV2(data, {
    currentGAAffixes: [],
    unsatisfactoryAffixIds: [],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Life on Hit"].id, isGA: false, isEnchanted: false },
  ], {
    enchantressAvailable: true,
  });

  const actions = worker.getValidActionsV2(state, target, env);
  assert.equal(actions.some((action) => action.type === "enchant"), false);
});

test("v2 allows GA transfer by enchant instead of treating target GA identity as impossible", () => {
  const { data, currentState, target } = buildGAEnchantTransferFixture();
  const env = worker.buildEnvV2(data, {
    currentGAAffixes: [currentState.affixes[0].affixId],
    unsatisfactoryAffixIds: [],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  assert.equal(env.impossibleTargetGAReason, "");

  const actions = worker.getValidActionsV2(currentState, target, env);
  assert.deepEqual(actions, [{
    type: "enchant",
    sourceIndex: 0,
    targetAffixId: target.affixes[0].affixId,
  }]);

  const result = worker.optimizeScenarioV2({
    state: currentState,
    target,
    data,
    gaConfig: {
      currentGAAffixes: [currentState.affixes[0].affixId],
      unsatisfactoryAffixIds: [],
      strictMode: false,
      sacrificeAffixId: "",
    },
  });

  assert.deepEqual(result.action, actions[0]);
  approxEqual(result.successProb, 1);
});

test("optimizeScenarioV2 returns a zero-step summary when the current state already satisfies the target", () => {
  const { data, byName } = buildSimpleFixture();
  const currentState = buildState([
    { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: false },
  ], {
    enchantressAvailable: false,
  });
  const target = {
    affixes: [{ affixId: byName["Movement Speed"].id, requireGA: false }],
  };

  const result = worker.optimizeScenarioV2({
    state: currentState,
    target,
    data: {
      ...data,
      targetAffixIds: target.affixes.map((entry) => entry.affixId),
    },
    gaConfig: {
      currentGAAffixes: [],
      unsatisfactoryAffixIds: [],
      strictMode: false,
      sacrificeAffixId: "",
    },
  });

  assert.equal(result.action, null);
  approxEqual(result.successProb, 1);
  approxEqual(result.expectedSteps, 0);
  assert.equal(result.diagnostics.strategy, "exact-ssp");
});

test("summarizeRootV2 hides expected steps when exact SSP value iteration does not converge", () => {
  const { data, currentState, target, byName } = buildOneMissingFixture();
  const env = worker.buildEnvV2(data, {
    currentGAAffixes: [byName["Armor"].id],
    unsatisfactoryAffixIds: [],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);
  const graph = worker.expandReachableGraph(currentState, target, env);

  assert.equal(graph.ok, true);

  const phase1 = {
    values: new Float64Array(graph.nodes.length),
    iterations: env.maxIterations,
    converged: false,
    residual: Infinity,
  };
  for (let index = 0; index < graph.nodes.length; index += 1) {
    if (graph.nodes[index].success) {
      phase1.values[index] = 1;
    }
  }

  const phase2 = {
    costs: new Float64Array(graph.nodes.length),
    iterations: env.maxIterations,
    converged: false,
    residual: Infinity,
  };

  const summary = worker.summarizeRootV2(graph, graph.rootKey, env, target, phase1, phase2);
  assert.equal(summary.expectedSteps, null);
  assert.equal(summary.diagnostics.stepEstimatesReliable, false);
  assert.match(summary.diagnostics.stepEstimateReason, /did not converge/i);
  assert.ok(summary.diagnostics.candidateActions.every((entry) => entry.expectedSteps === null));
});

test("phase 1 prefers higher success probability before phase 2 minimizes steps", () => {
  const env = {
    epsilon: 1e-9,
    maxIterations: 2048,
  };

  const graph = {
    rootKey: "root",
    deadStates: 1,
    nodes: [
      {
        key: "root",
        state: null,
        success: false,
        deadReason: "",
        actionEntries: [
          {
            action: { type: "focused", prism: "Protector" },
            cubeCost: 1,
            transitions: [
              { probability: 0.9, childIndex: 1 },
              { probability: 0.1, childIndex: 3 },
            ],
          },
          {
            action: { type: "remove", prism: "Resourceful" },
            cubeCost: 1,
            transitions: [{ probability: 1, childIndex: 2 }],
          },
        ],
      },
      {
        key: "success",
        state: null,
        success: true,
        deadReason: "",
        actionEntries: [],
      },
      {
        key: "mid",
        state: null,
        success: false,
        deadReason: "",
        actionEntries: [
          {
            action: { type: "add", prism: "Pragmatic" },
            cubeCost: 1,
            transitions: [{ probability: 1, childIndex: 1 }],
          },
        ],
      },
      {
        key: "dead",
        state: null,
        success: false,
        deadReason: "dead",
        actionEntries: [],
      },
    ],
  };

  const phase1 = worker.solvePhase1(graph, env);
  approxEqual(phase1.values[2], 1);
  approxEqual(phase1.values[0], 1);

  const phase2 = worker.solvePhase2(graph, phase1, env);
  approxEqual(phase2.costs[2], 1);
  approxEqual(phase2.costs[0], 2);
});

test("optimizeScenarioV2 minimizes expected steps among equal-success actions", () => {
  const { data, byName } = buildSimpleFixture();
  const currentState = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ], {
    enchantressAvailable: false,
  });
  const target = {
    affixes: [{ affixId: byName["Movement Speed"].id, requireGA: false }],
  };

  const result = worker.optimizeScenarioV2({
    state: currentState,
    target,
    data: {
      ...data,
      targetAffixIds: target.affixes.map((entry) => entry.affixId),
    },
    gaConfig: {
      currentGAAffixes: [],
      unsatisfactoryAffixIds: [],
      strictMode: false,
      sacrificeAffixId: "",
    },
  });

  assert.deepEqual(result.action, {
    type: "add",
    prism: "Pragmatic",
  });
  assert.ok(result.successProb > 0.999999);
  approxEqual(result.expectedSteps, 1.5, 1e-6);
  assert.equal(result.diagnostics.strategy, "exact-ssp");
});

test("v2 keeps the same best action as v1 on a one-missing scenario while enforcing set semantics", () => {
  const { data, currentState, target, byName } = buildOneMissingFixture();
  const gaConfig = {
    currentGAAffixes: [byName["Armor"].id],
    strictMode: false,
    sacrificeAffixId: "",
  };

  const envV1 = workerV1.buildEnv(data, gaConfig, target);
  const exactV1 = workerV1.getExactSmallStateSummary(currentState, target, envV1);
  assert.ok(exactV1);

  const resultV2 = worker.optimizeScenarioV2({
    state: currentState,
    target,
    data,
    gaConfig: {
      ...gaConfig,
      unsatisfactoryAffixIds: [],
    },
  });

  assert.deepEqual(resultV2.action, exactV1.action);
  assert.ok(resultV2.successProb > 0.999999);
  approxEqual(resultV2.expectedSteps, 1, 1e-9);
  assert.ok(resultV2.expectedSteps < exactV1.expectedSteps);
  assert.equal(resultV2.iterations, 0);
  assert.equal(resultV2.diagnostics.strategy, "exact-ssp");
});