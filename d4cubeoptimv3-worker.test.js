const test = require("node:test");
const assert = require("node:assert/strict");

const worker = require("./d4cubeoptimv3-worker.js");
const ilp = require("./ilp.js");

const TEST_TIMEOUT_MS = 1000;

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

function buildFixture() {
  const categoryToNames = {
    Aggressive: [
      "Critical Strike Chance",
      "Critical Strike Damage",
      { name: "Elemental Damage (Physical)", family: "elemental-damage" },
      { name: "Elemental Damage (Fire)", family: "elemental-damage" },
      "Thorns",
    ],
    Pragmatic: ["Movement Speed", "Maximum Evade Charges"],
    Protector: ["Armor", "Maximum Life"],
    Resourceful: ["Maximum Resource"],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  return {
    data: {
      affixes,
      categories,
      targetAffixIds: [],
      maxAffixSlots: 4,
    },
    byName,
  };
}

function buildExpandedResidualFixture() {
  const categoryToNames = {
    Aggressive: [
      "Critical Strike Chance",
      "Critical Strike Damage",
      "Vulnerable Damage",
      "Weapon Damage",
      "Attack Speed",
      "All Damage",
      "DoT Damage",
      { name: "Elemental Damage (Physical)", family: "elemental-damage", rollWeight: 1 / 6 },
      { name: "Elemental Damage (Fire)", family: "elemental-damage", rollWeight: 1 / 6 },
      { name: "Elemental Damage (Cold)", family: "elemental-damage", rollWeight: 1 / 6 },
      { name: "Elemental Damage (Shadow)", family: "elemental-damage", rollWeight: 1 / 6 },
      { name: "Elemental Damage (Lightning)", family: "elemental-damage", rollWeight: 1 / 6 },
      { name: "Elemental Damage (Poison)", family: "elemental-damage", rollWeight: 1 / 6 },
      "Thorns",
    ],
    Pragmatic: [
      "Movement Speed",
      "Maximum Evade Charges",
      "Barrier Generation",
      "Cooldown Reduction",
      "Thorns",
    ],
    Protector: ["Armor", "Maximum Life"],
    Resourceful: ["Maximum Resource"],
    Adept: ["Mainstat"],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  return {
    data: {
      affixes,
      categories,
      targetAffixIds: [],
      maxAffixSlots: 4,
    },
    byName,
  };
}

function buildState(affixes, options = {}) {
  return {
    gearSlot: options.gearSlot || "Any",
    isLegendary: !!options.isLegendary,
    enchantressAvailable: options.enchantressAvailable !== false,
    affixes: affixes.map((entry) => ({
      affixId: entry.affixId,
      isGA: !!entry.isGA,
      isEnchanted: !!entry.isEnchanted,
    })),
  };
}

function buildTarget(entries, options = {}) {
  const target = {
    affixes: entries.map((entry) => ({
      affixId: entry.affixId,
      requireGA: !!entry.requireGA,
      needsImprovement: !!entry.needsImprovement,
    })),
  };

  if (Array.isArray(options.forbiddenAffixIds)) {
    target.forbiddenAffixIds = options.forbiddenAffixIds.slice();
  }
  if (Array.isArray(options.protectedAffixIds)) {
    target.protectedAffixIds = options.protectedAffixIds.slice();
  }

  return target;
}

function approxEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `Expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function assertStableDiagnosticsContract(result, expectations = {}) {
  assert.ok(result);
  assert.ok(result.diagnostics);
  assert.ok(Object.prototype.hasOwnProperty.call(result, "tree"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "stoppedByUser"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "elapsedMs"));

  const { diagnostics } = result;
  assert.equal(typeof diagnostics.reason, "string");
  assert.ok(Number.isFinite(diagnostics.rootVisits));
  assert.ok(Array.isArray(diagnostics.candidateActions));
  assert.equal(typeof diagnostics.strategy, "string");
  assert.equal(typeof diagnostics.phase, "string");
  assert.equal(typeof diagnostics.feasibility.ok, "boolean");

  assert.ok(diagnostics.decomposition);
  assert.equal(typeof diagnostics.decomposition.status, "string");
  assert.ok(Object.prototype.hasOwnProperty.call(diagnostics.decomposition, "applicable"));
  assert.ok(Array.isArray(diagnostics.decomposition.residualTargets));
  assert.ok(Array.isArray(diagnostics.decomposition.selectedOptions));

  assert.ok(diagnostics.ilp);
  assert.equal(typeof diagnostics.ilp.status, "string");

  assert.ok(diagnostics.residual);
  assert.equal(typeof diagnostics.residual.status, "string");

  if (Object.prototype.hasOwnProperty.call(expectations, "strategy")) {
    assert.equal(diagnostics.strategy, expectations.strategy);
  }
  if (Object.prototype.hasOwnProperty.call(expectations, "decompositionStatus")) {
    assert.equal(diagnostics.decomposition.status, expectations.decompositionStatus);
  }
  if (Object.prototype.hasOwnProperty.call(expectations, "ilpStatus")) {
    assert.equal(diagnostics.ilp.status, expectations.ilpStatus);
  }
  if (Object.prototype.hasOwnProperty.call(expectations, "residualStatus")) {
    assert.equal(diagnostics.residual.status, expectations.residualStatus);
  }
}

function solveLinearSystem(matrix, vector) {
  const n = matrix.length;
  const rows = matrix.map((row, index) => row.slice().concat(vector[index]));

  for (let pivot = 0; pivot < n; pivot += 1) {
    let maxRow = pivot;
    for (let row = pivot + 1; row < n; row += 1) {
      if (Math.abs(rows[row][pivot]) > Math.abs(rows[maxRow][pivot])) {
        maxRow = row;
      }
    }

    const pivotValue = rows[maxRow][pivot];
    assert.ok(Math.abs(pivotValue) > 1e-12, "Expected a non-singular linear system.");
    if (maxRow !== pivot) {
      const tmp = rows[pivot];
      rows[pivot] = rows[maxRow];
      rows[maxRow] = tmp;
    }

    for (let row = pivot + 1; row < n; row += 1) {
      const factor = rows[row][pivot] / rows[pivot][pivot];
      for (let column = pivot; column <= n; column += 1) {
        rows[row][column] -= factor * rows[pivot][column];
      }
    }
  }

  const solution = Array.from({ length: n }, () => 0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let rhs = rows[row][n];
    for (let column = row + 1; column < n; column += 1) {
      rhs -= rows[row][column] * solution[column];
    }
    solution[row] = rhs / rows[row][row];
  }

  return solution;
}

function solveExpectedStepsFromTransientMatrix(Q) {
  const n = Q.length;
  const matrix = Array.from({ length: n }, (_, row) => (
    Array.from({ length: n }, (_, column) => (row === column ? 1 : 0) - Q[row][column])
  ));
  const rhs = Array.from({ length: n }, () => 1);
  return solveLinearSystem(matrix, rhs);
}

function oracleCaseA(n) {
  return solveExpectedStepsFromTransientMatrix([
    [0, (n - 1) / n],
    [0, (n - 2) / (n - 1)],
  ])[0];
}

function oracleCaseBLike(n) {
  return solveExpectedStepsFromTransientMatrix([
    [1 - (1 / n)],
  ])[0];
}

function oracleCaseC(n) {
  return solveExpectedStepsFromTransientMatrix([
    [0, 1, 0],
    [0, 0, (n - 1) / n],
    [0, 0, (n - 2) / (n - 1)],
  ])[0];
}

function oracleCaseDeterministicOneStep() {
  return solveExpectedStepsFromTransientMatrix([[0]])[0];
}

function getRootIndex(graph) {
  return graph.nodes.findIndex((node) => node.key === graph.rootKey);
}

function buildOrderingFixture() {
  const categoryToNames = {
    Pragmatic: ["Movement Speed", "Maximum Evade Charges", "Potion Capacity"],
    Protector: ["Armor"],
  };
  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  return {
    data: {
      affixes,
      categories,
      targetAffixIds: [],
      maxAffixSlots: 3,
    },
    byName,
  };
}

function enumeratePermutations(items) {
  if (items.length <= 1) {
    return [items.slice()];
  }

  const out = [];
  items.forEach((item, index) => {
    const rest = items.slice(0, index).concat(items.slice(index + 1));
    enumeratePermutations(rest).forEach((tail) => out.push([item].concat(tail)));
  });
  return out;
}

function enumerateBestPrismSchedule(options) {
  const consumers = options.filter((option) => option.prismDelta > 0);
  const nonConsumers = options.filter((option) => option.prismDelta === 0);
  const permutations = enumeratePermutations(consumers);
  let best = null;

  permutations.forEach((order) => {
    const stageById = new Map();
    let cost = 0;
    let feasible = true;

    order.forEach((option, stage) => {
      const expectedSteps = worker.computeDecompositionOptionExpectedStepsV3(option, stage);
      if (!Number.isFinite(expectedSteps)) {
        feasible = false;
        return;
      }
      stageById.set(option.id, stage);
      cost += expectedSteps;
    });
    if (!feasible) {
      return;
    }

    nonConsumers.forEach((option) => {
      let bestStage = 0;
      let bestStageCost = Infinity;
      for (let stage = 0; stage <= consumers.length; stage += 1) {
        const expectedSteps = worker.computeDecompositionOptionExpectedStepsV3(option, stage);
        if (!Number.isFinite(expectedSteps)) {
          continue;
        }
        if (expectedSteps < bestStageCost - 1e-9) {
          bestStage = stage;
          bestStageCost = expectedSteps;
        }
      }

      if (!Number.isFinite(bestStageCost)) {
        feasible = false;
        return;
      }

      stageById.set(option.id, bestStage);
      cost += bestStageCost;
    });
    if (!feasible) {
      return;
    }

    if (!best || cost < best.cost - 1e-9) {
      best = { cost, stageById };
    }
  });

  return best;
}

function enumerateBestDecompositionPlan(planInput) {
  let best = null;

  function evaluateSelection(selection) {
    const grouped = new Map();
    let totalCost = 0;
    const stageById = new Map();

    selection.forEach((option) => {
      if (option.requiresStage && option.prism) {
        if (!grouped.has(option.prism)) {
          grouped.set(option.prism, []);
        }
        grouped.get(option.prism).push(option);
        return;
      }

      totalCost += worker.computeDecompositionOptionExpectedStepsV3(option, 0);
    });

    for (const options of grouped.values()) {
      const bestPrism = enumerateBestPrismSchedule(options);
      if (!bestPrism) {
        return;
      }
      totalCost += bestPrism.cost;
      bestPrism.stageById.forEach((stage, id) => stageById.set(id, stage));
    }

    if (!best || totalCost < best.cost - 1e-9) {
      best = {
        cost: totalCost,
        selection: selection.slice(),
        stageById,
      };
    }
  }

  function search(targetOffset, selection, usedSlots, enchantUsed) {
    if (targetOffset >= planInput.targets.length) {
      evaluateSelection(selection);
      return;
    }

    const row = planInput.targets[targetOffset];
    row.options.forEach((option) => {
      if (usedSlots.has(option.slotIndex)) {
        return;
      }
      if (option.usesEnchant && enchantUsed) {
        return;
      }
      if (selection.some((selected) => worker.optionsConflictV3(selected, option))) {
        return;
      }

      selection.push(option);
      usedSlots.add(option.slotIndex);
      search(targetOffset + 1, selection, usedSlots, enchantUsed || option.usesEnchant);
      usedSlots.delete(option.slotIndex);
      selection.pop();
    });
  }

  search(0, [], new Set(), false);
  return best;
}

test("optimizeScenarioV3 solves decomposition-eligible cases through the ILP layer", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: true, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Maximum Life"].id, requireGA: false },
  ]);

  data.targetAffixIds = target.affixes.map((entry) => entry.affixId);

  const result = worker.optimizeScenarioV3({
    state,
    target,
    data,
    gaConfig: {
      currentGAAffixes: [byName["Armor"].id],
      unsatisfactoryAffixIds: [],
      strictMode: false,
      sacrificeAffixId: "",
    },
  });

  assertStableDiagnosticsContract(result, {
    strategy: worker.DECOMPOSITION_STRATEGY,
    decompositionStatus: "APPLICABLE",
    ilpStatus: "OPTIMAL",
    residualStatus: "NOT_RUN",
  });
  assert.equal(result.diagnostics.strategy, worker.DECOMPOSITION_STRATEGY);
  assert.equal(result.diagnostics.feasibility.ok, true);
  assert.equal(result.successProb, 1);
  assert.equal(result.action.type, "enchant");
  approxEqual(result.expectedSteps, 1);
});

test("optimizeScenarioV3 returns an approximate decomposition action when ILP hits a limit with an incumbent", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: true, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Maximum Life"].id, requireGA: false },
  ]);

  data.targetAffixIds = target.affixes.map((entry) => entry.affixId);

  const originalSolveILP = ilp.solveILP;
  ilp.solveILP = (problem) => {
    const exact = originalSolveILP(problem);
    return {
      ...exact,
      status: "ITERATION_LIMIT",
      note: "Test override: return incumbent at limit.",
    };
  };

  let result;
  try {
    result = worker.optimizeScenarioV3({
      state,
      target,
      data,
      gaConfig: {
        currentGAAffixes: [byName["Armor"].id],
        unsatisfactoryAffixIds: [],
        strictMode: false,
        sacrificeAffixId: "",
      },
    });
  } finally {
    ilp.solveILP = originalSolveILP;
  }

  assertStableDiagnosticsContract(result, {
    strategy: worker.DECOMPOSITION_STRATEGY,
    decompositionStatus: "APPROXIMATE_LIMIT",
    ilpStatus: "ITERATION_LIMIT",
    residualStatus: "NOT_RUN",
  });
  assert.equal(result.approximate, true);
  assert.equal(result.successProb, 1);
  assert.equal(result.action.type, "enchant");
  assert.match(result.diagnostics.reason, /not proven optimal/i);
});

test("optimizeScenarioV3 compares wide-gap ILP approximations against residual and can prefer residual", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: true, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Maximum Life"].id, requireGA: false },
  ]);

  data.targetAffixIds = target.affixes.map((entry) => entry.affixId);

  const originalSolveILP = ilp.solveILP;
  ilp.solveILP = (problem) => {
    const exact = originalSolveILP(problem);
    return {
      ...exact,
      status: "ITERATION_LIMIT",
      bestBound: Number.isFinite(exact.objective) ? exact.objective - 5 : -5,
      note: "Test override: force a wide incumbent-bound gap.",
    };
  };

  let result;
  try {
    result = worker.optimizeScenarioV3({
      state,
      target,
      data,
      gaConfig: {
        currentGAAffixes: [byName["Armor"].id],
        unsatisfactoryAffixIds: [],
        strictMode: false,
        sacrificeAffixId: "",
      },
    });
  } finally {
    ilp.solveILP = originalSolveILP;
  }

  assertStableDiagnosticsContract(result, {
    strategy: worker.RESIDUAL_STRATEGY,
    decompositionStatus: "ESCALATED",
  });
  assert.equal(result.diagnostics.feasibility.ok, true);
  assert.match(result.diagnostics.decomposition.reason, /wide-gap approximate ilp incumbent/i);
  assert.ok(result.action);
  assert.equal(typeof result.successProb, "number");
  assert.ok(result.successProb > 0);
});

test("F4 fails when required plus protected affixes exceed slot capacity", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([]);
  const target = buildTarget([
    { affixId: byName["Armor"].id },
    { affixId: byName["Maximum Life"].id },
    { affixId: byName["Movement Speed"].id },
    { affixId: byName["Maximum Resource"].id },
  ], {
    protectedAffixIds: [byName["Critical Strike Chance"].id],
  });

  const feasibility = worker.analyzeFeasibilityV3(state, target, data, {});
  assert.equal(feasibility.ok, false);
  assert.equal(feasibility.check, "F4");
});

test("F5 fails when a required affix is not in the legal affix pool", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data } = buildFixture();
  const state = buildState([]);
  const target = buildTarget([
    { affixId: "not-in-pool", requireGA: false },
  ]);

  const feasibility = worker.analyzeFeasibilityV3(state, target, data, {});
  assert.equal(feasibility.ok, false);
  assert.equal(feasibility.check, "F5");
});

test("F5 fails when a target affix is illegal for the selected gear slot", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildExpandedResidualFixture();
  const state = buildState([], {
    gearSlot: "Helm",
  });
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id },
  ]);

  const feasibility = worker.analyzeFeasibilityV3(state, target, data, {});
  assert.equal(feasibility.ok, false);
  assert.equal(feasibility.check, "F5");
  assert.match(feasibility.message, /not legal for the current item slot/i);
});

test("F6 fails on mutually exclusive target families", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([]);
  const target = buildTarget([
    { affixId: byName["Elemental Damage (Physical)"].id },
    { affixId: byName["Elemental Damage (Fire)"].id },
  ]);

  const feasibility = worker.analyzeFeasibilityV3(state, target, data, {});
  assert.equal(feasibility.ok, false);
  assert.equal(feasibility.check, "F6");
});

test("F7 fails when a required affix is also forbidden", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([]);
  const target = buildTarget([
    { affixId: byName["Armor"].id },
  ], {
    forbiddenAffixIds: [byName["Armor"].id],
  });

  const feasibility = worker.analyzeFeasibilityV3(state, target, data, {});
  assert.equal(feasibility.ok, false);
  assert.equal(feasibility.check, "F7");
});

test("Case A closed-form matches the exact tabular oracle", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
  ]);
  const env = require("./d4cubeoptim-worker.js").buildEnv(data, {}, target);

  const plan = worker.chooseBestClosedFormPlanV3(state, target.affixes[0], 1, env, {
    data,
    gaConfig: {},
    target,
    maxAffixSlots: 4,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.caseId, worker.CLOSED_FORM_CASE_IDS.A);
  approxEqual(plan.expectedSteps, worker.computeCaseAExpectedStepsV3(2));
  approxEqual(plan.expectedSteps, oracleCaseA(2));
});

test("Case B closed-form matches the exact tabular oracle", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Maximum Evade Charges"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
  ]);
  const env = require("./d4cubeoptim-worker.js").buildEnv(data, {}, target);

  const plan = worker.chooseBestClosedFormPlanV3(state, target.affixes[0], 0, env, {
    data,
    gaConfig: {},
    target,
  });

  assert.equal(plan.caseId, worker.CLOSED_FORM_CASE_IDS.B);
  approxEqual(plan.expectedSteps, oracleCaseBLike(1));
});

test("Case C closed-form matches the exact tabular oracle", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
  ]);
  const env = require("./d4cubeoptim-worker.js").buildEnv(data, {}, target);

  const plan = worker.chooseBestClosedFormPlanV3(state, target.affixes[0], 0, env, {
    data,
    gaConfig: {},
    target,
  });

  assert.equal(plan.caseId, worker.CLOSED_FORM_CASE_IDS.C);
  approxEqual(plan.expectedSteps, worker.computeCaseCExpectedStepsV3(2));
  approxEqual(plan.expectedSteps, oracleCaseC(2));
});

test("Case E closed-form matches the exact tabular oracle", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
  ]);
  const env = require("./d4cubeoptim-worker.js").buildEnv(data, {}, target);

  const plan = worker.chooseBestClosedFormPlanV3(state, target.affixes[0], 0, env, {
    data,
    gaConfig: {},
    target,
    allowDiscretionaryEnchant: true,
  });

  assert.equal(plan.caseId, worker.CLOSED_FORM_CASE_IDS.E);
  approxEqual(plan.expectedSteps, oracleCaseDeterministicOneStep());
});

test("Case F closed-form matches the exact tabular oracle", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false, needsImprovement: true },
  ]);
  const env = require("./d4cubeoptim-worker.js").buildEnv(data, {
    unsatisfactoryAffixIds: [byName["Movement Speed"].id],
  }, target);

  const plan = worker.chooseBestClosedFormPlanV3(state, target.affixes[0], 0, env, {
    data,
    gaConfig: { unsatisfactoryAffixIds: [byName["Movement Speed"].id] },
    target,
  });

  assert.equal(plan.caseId, worker.CLOSED_FORM_CASE_IDS.F);
  approxEqual(plan.expectedSteps, oracleCaseBLike(1));
});

test("Case G closed-form matches the exact tabular oracle", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Movement Speed"].id, isGA: true, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Maximum Evade Charges"].id, requireGA: false },
  ]);
  const env = require("./d4cubeoptim-worker.js").buildEnv(data, {
    currentGAAffixes: [byName["Movement Speed"].id],
  }, target);

  const plan = worker.chooseBestClosedFormPlanV3(state, target.affixes[0], 0, env, {
    data,
    gaConfig: { currentGAAffixes: [byName["Movement Speed"].id] },
    target,
  });

  assert.equal(plan.caseId, worker.CLOSED_FORM_CASE_IDS.G);
  approxEqual(plan.expectedSteps, oracleCaseBLike(1));
});

test("closed-form classifier explains residual-only non-unique remove cases", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
  ]);
  const env = require("./d4cubeoptim-worker.js").buildEnv(data, {}, target);

  const plan = worker.chooseBestClosedFormPlanV3(state, target.affixes[0], 0, env, {
    data,
    gaConfig: {},
    target,
  });

  assert.equal(plan.ok, false);
  assert.match(plan.residualReason, /remove would not be deterministic/i);
});

test("buildClosedFormPlanTableV3 provides a stable target-slot coefficient table", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Maximum Evade Charges"].id, requireGA: false },
  ]);

  const table = worker.buildClosedFormPlanTableV3(state, target, data, {});
  assert.equal(table.length, 2);
  assert.equal(table[0].slots.length, 4);
  assert.equal(table[0].slots[1].ok, true);
});

test("closed-form pool sizes respect slot legality narrowing", { timeout: TEST_TIMEOUT_MS }, () => {
  const { affixes, byName, categories } = buildCatalogFixture({
    Aggressive: [
      "Critical Strike Chance",
      "Attack Speed",
      "Weapon Damage",
    ],
  });
  const data = {
    affixes,
    categories,
    targetAffixIds: [],
    maxAffixSlots: 1,
    gearSlots: ["Any", "Ring", "Gloves"],
  };
  const state = buildState([
    { affixId: byName["Attack Speed"].id, isGA: false, isEnchanted: false },
  ], {
    gearSlot: "Ring",
  });
  const target = buildTarget([
    { affixId: byName["Critical Strike Chance"].id, requireGA: false },
  ]);
  const env = require("./d4cubeoptim-worker.js").buildEnv(data, {}, target);

  const plan = worker.chooseBestClosedFormPlanV3(state, target.affixes[0], 0, env, {
    data,
    gaConfig: {},
    target,
  });

  assert.equal(plan.caseId, worker.CLOSED_FORM_CASE_IDS.B);
  approxEqual(plan.expectedSteps, 1);
});

test("solveDecompositionPlanV3 keeps multi-category add targets in decomposition when the prism is explicit", { timeout: TEST_TIMEOUT_MS }, () => {
  const { affixes, byName, categories } = buildCatalogFixture({
    Aggressive: ["Thorns"],
    Pragmatic: ["Movement Speed", "Maximum Evade Charges", "Thorns"],
  });
  const data = {
    affixes,
    categories,
    targetAffixIds: [],
    maxAffixSlots: 1,
  };
  const state = buildState([]);
  const target = buildTarget([
    { affixId: byName["Thorns"].id, requireGA: false },
  ]);

  const planInput = worker.buildDecompositionPlanInputV3(state, target, data, {});
  const solved = worker.solveDecompositionPlanV3(planInput);

  assert.equal(planInput.ok, true);
  assert.equal(solved.ok, true);
  assert.equal(solved.selectedOptions.length, 1);
  assert.equal(solved.selectedOptions[0].caseId, worker.CLOSED_FORM_CASE_IDS.A);
  assert.equal(solved.selectedOptions[0].prism, "Aggressive");
  assert.equal(solved.action.type, "add");
  assert.equal(solved.action.prism, "Aggressive");
  approxEqual(solved.expectedSteps, 1);
});

test("optimizeScenarioV3 keeps multi-category deterministic enchant targets in decomposition", { timeout: TEST_TIMEOUT_MS }, () => {
  const { affixes, byName, categories } = buildCatalogFixture({
    Aggressive: ["Thorns"],
    Pragmatic: ["Movement Speed", "Thorns"],
    Protector: ["Armor"],
  });
  const data = {
    affixes,
    categories,
    targetAffixIds: [],
    maxAffixSlots: 1,
  };
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Thorns"].id, requireGA: false },
  ]);

  data.targetAffixIds = target.affixes.map((entry) => entry.affixId);

  const result = worker.optimizeScenarioV3({
    state,
    target,
    data,
    gaConfig: {
      currentGAAffixes: [],
      unsatisfactoryAffixIds: [],
      strictMode: false,
      sacrificeAffixId: "",
    },
  });

  assertStableDiagnosticsContract(result, {
    strategy: worker.DECOMPOSITION_STRATEGY,
    decompositionStatus: "APPLICABLE",
    ilpStatus: "OPTIMAL",
    residualStatus: "NOT_RUN",
  });
  assert.equal(result.successProb, 1);
  assert.equal(result.action.type, "enchant");
  approxEqual(result.expectedSteps, 1);
});

test("solveDecompositionPlanV3 matches exhaustive enumeration on a same-category ordering case", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildOrderingFixture();
  const state = buildState([
    { affixId: byName["Maximum Evade Charges"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ], {
    isLegendary: false,
  });
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Potion Capacity"].id, requireGA: false },
  ]);

  const planInput = worker.buildDecompositionPlanInputV3(state, target, data, {});
  assert.equal(planInput.ok, true);

  const exact = enumerateBestDecompositionPlan(planInput);
  const solved = worker.solveDecompositionPlanV3(planInput);
  const naiveStageZeroCost = solved.selectedOptions.reduce((sum, option) => (
    sum + worker.computeDecompositionOptionExpectedStepsV3(option, 0)
  ), 0);

  assert.equal(solved.ok, true);
  approxEqual(solved.expectedSteps, exact.cost);
  assert.ok(naiveStageZeroCost > solved.expectedSteps);
});

test("residualStateKeyV3 collapses irrelevant same-signature affixes", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const target = buildTarget([
    { affixId: byName["Armor"].id, requireGA: false },
  ]);
  const context = worker.createResidualAbstractionContextV3(target, data, {}, {
    feasibility: worker.analyzeFeasibilityV3(buildState([]), target, data, {}),
  });

  const first = buildState([
    { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: false },
  ]);
  const second = buildState([
    { affixId: byName["Maximum Evade Charges"].id, isGA: false, isEnchanted: false },
  ]);

  assert.equal(worker.residualStateKeyV3(first, context), worker.residualStateKeyV3(second, context));
});

test("solveResidualLAOStarV3 matches the exact abstract oracle on a residual-only case", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
  ]);
  const feasibility = worker.analyzeFeasibilityV3(state, target, data, {});
  const graph = worker.buildResidualReachableGraphV3(state, target, data, {}, { feasibility });
  const exact = worker.solveResidualExactV3(graph, graph.env);
  const lao = worker.solveResidualLAOStarV3(graph, target, data, {}, {
    env: graph.env,
    baseEnv: graph.context.baseEnv,
  });
  const rootIndex = getRootIndex(graph);

  assert.equal(graph.ok, true);
  assert.equal(lao.status, "OPTIMAL");
  approxEqual(lao.phase1.values[rootIndex], exact.phase1.values[rootIndex]);
  approxEqual(lao.phase2.costs[rootIndex], exact.phase2.costs[rootIndex]);
});

test("solveResidualLAOStarV3 reports iteration limit when capped", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
  ]);
  const feasibility = worker.analyzeFeasibilityV3(state, target, data, {});
  const graph = worker.buildResidualReachableGraphV3(state, target, data, {}, { feasibility });
  graph.env.maxIterations = 1;

  const lao = worker.solveResidualLAOStarV3(graph, target, data, {}, {
    env: graph.env,
    baseEnv: graph.context.baseEnv,
  });

  assert.equal(lao.status, "ITERATION_LIMIT");
});

test("optimizePayloadV3 returns a stable diagnostics contract for infeasible inputs", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([]);
  const target = buildTarget([
    { affixId: byName["Armor"].id, requireGA: false },
    { affixId: byName["Maximum Life"].id, requireGA: false },
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Maximum Resource"].id, requireGA: false },
  ], {
    protectedAffixIds: [byName["Critical Strike Chance"].id],
  });

  const result = worker.optimizePayloadV3({
    state,
    target,
    data,
    gaConfig: {},
  });

  assertStableDiagnosticsContract(result, {
    strategy: worker.FEASIBILITY_STRATEGY,
    decompositionStatus: "NOT_RUN",
    ilpStatus: "NOT_RUN",
    residualStatus: "NOT_RUN",
  });
  assert.equal(result.successProb, 0);
  assert.equal(result.diagnostics.feasibility.check, "F4");
});

test("optimizePayloadV3 returns an approximate residual action when iteration limits are reached", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Critical Strike Chance"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Critical Strike Damage"].id, isGA: false, isEnchanted: false },
  ], {
    enchantressAvailable: false,
  });
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
  ]);

  const result = worker.optimizePayloadV3({
    state,
    target,
    data,
    gaConfig: {},
  }, {
    residualEnvOverrides: { maxIterations: 1 },
  });

  assertStableDiagnosticsContract(result, {
    strategy: worker.RESIDUAL_STRATEGY,
    decompositionStatus: "ESCALATED",
    ilpStatus: "NOT_RUN",
    residualStatus: "APPROXIMATE_LIMIT",
  });
  assert.equal(result.approximate, true);
  assert.ok(result.action);
  assert.equal(typeof result.successProb, "number");
  assert.ok(result.successProb > 0);
  assert.match(result.diagnostics.reason, /best-so-far policy estimate/i);
});

test("optimizeScenarioV3 escalates decomposition-ILP infeasible cases to the residual solver", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Critical Strike Chance"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Thorns"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Critical Strike Chance"].id, requireGA: false },
    { affixId: byName["Critical Strike Damage"].id, requireGA: false },
    { affixId: byName["Elemental Damage (Physical)"].id, requireGA: false },
    { affixId: byName["Thorns"].id, requireGA: false },
  ]);

  const result = worker.optimizeScenarioV3({
    state,
    target,
    data,
    gaConfig: {},
  });

  assertStableDiagnosticsContract(result, {
    strategy: worker.RESIDUAL_STRATEGY,
    decompositionStatus: "ESCALATED",
    ilpStatus: "NOT_RUN",
    residualStatus: "OPTIMAL",
  });
  assert.equal(result.diagnostics.feasibility.ok, true);
  assert.match(result.diagnostics.decomposition.reason, /decomposition ilp found no feasible exact host assignment/i);
  assert.equal(result.action.type, "remove");
  assert.equal(result.action.prism, "Protector");
  assert.equal(result.successProb, 1);
});

test("optimizePayloadV3 uses timeMs to widen the residual search budget on hard cases", { timeout: 5000 }, () => {
  const { data, byName } = buildExpandedResidualFixture();
  const payload = {
    state: buildState([
      { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
      { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
      { affixId: byName["Vulnerable Damage"].id, isGA: false, isEnchanted: false },
      { affixId: byName["Thorns"].id, isGA: false, isEnchanted: false },
    ]),
    target: buildTarget([
      { affixId: byName["Critical Strike Chance"].id, requireGA: false },
      { affixId: byName["Critical Strike Damage"].id, requireGA: false },
      { affixId: byName["Vulnerable Damage"].id, requireGA: false },
      { affixId: byName["Elemental Damage (Physical)"].id, requireGA: false },
    ]),
    data,
    gaConfig: {},
  };
  payload.data.targetAffixIds = payload.target.affixes.map((entry) => entry.affixId);

  const defaultBudget = worker.optimizePayloadV3(payload);
  const extendedBudget = worker.optimizePayloadV3({
    ...payload,
    timeMs: 10000,
  });

  assertStableDiagnosticsContract(defaultBudget, {
    strategy: worker.RESIDUAL_STRATEGY,
    decompositionStatus: "ESCALATED",
    ilpStatus: "NOT_RUN",
    residualStatus: "STATE_LIMIT",
  });
  assertStableDiagnosticsContract(extendedBudget, {
    strategy: worker.RESIDUAL_STRATEGY,
    decompositionStatus: "ESCALATED",
    ilpStatus: "NOT_RUN",
    residualStatus: "OPTIMAL",
  });
  assert.equal(defaultBudget.action, null);
  assert.equal(extendedBudget.action.type, "remove");
  assert.equal(extendedBudget.action.prism, "Protector");
  assert.ok(extendedBudget.successProb > 0.999);
  assert.ok(Number.isFinite(extendedBudget.expectedSteps));
  assert.ok(extendedBudget.diagnostics.residual.stateLimit > defaultBudget.diagnostics.residual.stateLimit);
  assert.ok(extendedBudget.diagnostics.residual.abstractStates > defaultBudget.diagnostics.residual.abstractStates);
});

test("getResidualEnvOverridesForTimeV3 keeps a materially larger residual iteration budget", () => {
  assert.deepEqual(worker.getResidualEnvOverridesForTimeV3(0), {
    stateLimit: 4096,
    maxIterations: 1048576,
  });

  assert.deepEqual(worker.getResidualEnvOverridesForTimeV3(30000), {
    stateLimit: 2000,
    maxIterations: 987136,
  });

  assert.deepEqual(worker.getResidualEnvOverridesForTimeV3(60000), {
    stateLimit: 3500,
    maxIterations: 1048576,
  });
});

test("optimizeScenarioV3 routes residual-only cases through the residual solver", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Critical Strike Chance"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Critical Strike Damage"].id, isGA: false, isEnchanted: false },
  ], {
    enchantressAvailable: false,
  });
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
  ]);

  const result = worker.optimizeScenarioV3({
    state,
    target,
    data,
    gaConfig: {},
  });

  assertStableDiagnosticsContract(result, {
    strategy: worker.RESIDUAL_STRATEGY,
    decompositionStatus: "ESCALATED",
    ilpStatus: "NOT_RUN",
    residualStatus: "OPTIMAL",
  });
  assert.equal(result.diagnostics.strategy, worker.RESIDUAL_STRATEGY);
  assert.equal(result.diagnostics.feasibility.ok, true);
  assert.equal(result.diagnostics.decomposition.status, "ESCALATED");
  assert.equal(result.diagnostics.decomposition.applicable, false);
  assert.equal(result.diagnostics.residual.status, "OPTIMAL");
  assert.equal(typeof result.successProb, "number");
});

test("runOptimizationV3 preserves the v2-style done message contract", { timeout: TEST_TIMEOUT_MS, concurrency: false }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([]);
  const target = buildTarget([
    { affixId: byName["Armor"].id, requireGA: false },
    { affixId: byName["Maximum Life"].id, requireGA: false },
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Maximum Resource"].id, requireGA: false },
  ], {
    protectedAffixIds: [byName["Critical Strike Chance"].id],
  });
  const messages = [];
  const previousSelf = globalThis.self;
  globalThis.self = {
    postMessage(message) {
      messages.push(message);
    },
  };

  try {
    worker.runOptimizationV3({
      state,
      target,
      data,
      gaConfig: {},
    }, 17);
  } finally {
    if (typeof previousSelf === "undefined") {
      delete globalThis.self;
    } else {
      globalThis.self = previousSelf;
    }
  }

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "done");
  assert.equal(messages[0].runId, 17);
  assertStableDiagnosticsContract(messages[0], {
    strategy: worker.FEASIBILITY_STRATEGY,
    decompositionStatus: "NOT_RUN",
    ilpStatus: "NOT_RUN",
    residualStatus: "NOT_RUN",
  });
});

test("solveResidualLAOStarV3 converges under modified policy iteration for a many-action GA-target case", { timeout: 5000 }, () => {
  const categoryToNames = {
    Aggressive: [
      "Critical Strike Chance",
      "Critical Strike Damage",
      "All Damage",
      "Attack Speed",
      "Vulnerable Damage",
      "Weapon Damage",
      { name: "Elemental Damage (Physical)", family: "elemental-damage" },
      { name: "Elemental Damage (Fire)", family: "elemental-damage" },
      { name: "Elemental Damage (Cold)", family: "elemental-damage" },
      { name: "Elemental Damage (Lightning)", family: "elemental-damage" },
      "DoT Damage",
    ],
    Protector: ["Maximum Life", "Damage Reduction", "Armor", "Barrier"],
    Adept: ["Mainstat", "Dexterity"],
    Pragmatic: ["Movement Speed", "Maximum Evade Charges", "Cooldown Reduction"],
    Resourceful: ["Maximum Resource"],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  const data = {
    affixes,
    categories,
    targetAffixIds: [],
    maxAffixSlots: 4,
  };

  const state = buildState([
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Damage Reduction"].id, isGA: false, isEnchanted: false },
    { affixId: byName["All Damage"].id, isGA: true, isEnchanted: false },
    { affixId: byName["Attack Speed"].id, isGA: false, isEnchanted: false },
  ], { enchantressAvailable: false });

  const target = buildTarget([
    { affixId: byName["Critical Strike Chance"].id, requireGA: false },
    { affixId: byName["Mainstat"].id, requireGA: false },
    { affixId: byName["All Damage"].id, requireGA: false },
    { affixId: byName["Elemental Damage (Physical)"].id, requireGA: false },
  ]);

  data.targetAffixIds = target.affixes.map((entry) => entry.affixId);

  const gaConfig = {
    currentGAAffixes: [byName["All Damage"].id],
    unsatisfactoryAffixIds: [],
    strictMode: false,
    sacrificeAffixId: "",
  };

  const feasibility = worker.analyzeFeasibilityV3(state, target, data, gaConfig);
  assert.equal(feasibility.ok, true, `Feasibility failed: ${feasibility.message}`);

  const graph = worker.buildResidualReachableGraphV3(state, target, data, gaConfig, {
    feasibility,
    stateLimit: 5000,
  });
  assert.equal(graph.ok, true, `Graph build failed: ${graph.reason}`);
  assert.ok(graph.nodes.length > 5, `Expected non-trivial graph, got ${graph.nodes.length} states`);

  // With requireGA removed the abstract state space is larger (~671 nodes). Phase 1 converges
  // quickly (~500 iterations) but phase 2 has some peripheral states (not on the optimal policy
  // path) that keep the global maxDelta residual near 1.4e-8, which never drops below the default
  // 1e-9 epsilon regardless of iteration count. The root-node values, however, converge to within
  // 2.84e-8 of exact after just ~1000 iterations. We give a modest budget and verify the
  // root-node values (the meaningful correctness property), not the global convergence flag.
  graph.env.maxIterations = 5000;

  const exact = worker.solveResidualExactV3(graph, graph.env);
  const lao = worker.solveResidualLAOStarV3(graph, target, data, gaConfig, {
    env: graph.env,
    baseEnv: graph.context.baseEnv,
  });

  const rootIndex = getRootIndex(graph);

  // Phase 1 must converge quickly (it does in ~500 iterations).
  assert.equal(lao.phase1.converged, true);
  assert.ok(
    lao.phase1.iterations < 2000,
    `Phase 1 should converge well under budget; got ${lao.phase1.iterations} iterations`
  );
  assert.ok(typeof lao.phase1.policyImprovementSteps === "number");
  assert.ok(lao.phase1.policyImprovementSteps >= 1);
  // Phase 2 may report ITERATION_LIMIT (global residual is stuck near 1.4e-8 asymptotically)
  // but the root-node values already match the exact solution to within 1e-6.
  const phase2 = lao.phase2 !== null ? lao.phase2 : { costs: new Float64Array(graph.nodes.length) };
  approxEqual(lao.phase1.values[rootIndex], exact.phase1.values[rootIndex], 1e-6);
  approxEqual(phase2.costs[rootIndex], exact.phase2.costs[rootIndex], 1e-6);
});

// Regression: isCategoryFocusedBlockedByGAV3 must prevent the decomposition model
// from suggesting a focused reroll that randomly endangers a protected GA on another slot.
// The user's case: Max Life, Thorns, All Damage (GA), Attack Speed (GA+Enchanted) →
// target CSC, Damage Reduction, All Damage, Attack Speed.  Thorns and All Damage are
// both Aggressive; a focused Aggressive reroll would randomly change one of them, so
// the decomposition cannot safely plan a Case B using Aggressive prism.  The optimizer
// must escalate to the residual solver, which blocks Aggressive focused actions due to
// strict mode and finds P=1 via a safe sequence (Pragmatic remove Thorns, Aggressive add
// CSC, Protector focused reroll Max Life → Damage Reduction).
test("isCategoryFocusedBlockedByGAV3 escalates to residual when protected GA shares prism category", { timeout: 10000 }, () => {
  const categoryToNames = {
    Aggressive: [
      "Critical Strike Chance",
      "Critical Strike Damage",
      "All Damage",
      "Attack Speed",
      "Thorns",
      "DoT Damage",
    ],
    Pragmatic: ["Barrier Generation", "Cooldown Reduction", "Thorns"],
    Protector: ["Armor", "Maximum Life", "Damage Reduction", "Dodge Chance"],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  const data = { affixes, categories, targetAffixIds: [], maxAffixSlots: 4 };

  const state = buildState([
    { affixId: byName["Maximum Life"].id, isGA: false },
    { affixId: byName["Thorns"].id, isGA: false },
    { affixId: byName["All Damage"].id, isGA: true },
    { affixId: byName["Attack Speed"].id, isGA: true, isEnchanted: true },
  ], { enchantressAvailable: false });

  const target = buildTarget([
    { affixId: byName["Critical Strike Chance"].id },
    { affixId: byName["Damage Reduction"].id },
    { affixId: byName["All Damage"].id },
    { affixId: byName["Attack Speed"].id },
  ]);

  const gaConfig = {
    currentGAAffixes: [byName["All Damage"].id, byName["Attack Speed"].id],
    strictMode: true,
  };

  const result = worker.optimizePayloadV3({ state, target, data, gaConfig });

  // Decomposition must not solve it (All Damage GA blocks Aggressive prism Case B for Thorns).
  // The optimizer should escalate to the residual solver.
  assert.ok(
    result.diagnostics.strategy !== worker.DECOMPOSITION_STRATEGY
    || result.diagnostics.residual.status !== "NOT_RUN",
    "Expected escalation to residual solver, not a pure decomposition result"
  );

  // Success probability must be < 1 (there is GA risk) or = 1 only via a verified safe path.
  // The key invariant: if successProb = 1, the strategy must be Residual (not Decomposition)
  // because only the residual solver correctly models the GA preservation constraint.
  if (result.diagnostics.strategy === worker.DECOMPOSITION_STRATEGY
      && result.diagnostics.residual.status === "NOT_RUN") {
    assert.ok(
      result.successProb < 1,
      `Decomposition returned P=${result.successProb} but All Damage GA is at risk via Aggressive prism`
    );
  }
});

// Helper: build a catalog fixture with Thorns carrying the correct per-operation overrides
// (Aggressive=add, Protector=focused+chaotic, Pragmatic=remove).
function buildThornsOverrideFixture() {
  const categoryToNames = {
    Aggressive: ["Critical Strike Chance", "Attack Speed", "Thorns"],
    Pragmatic: ["Movement Speed", "Lucky Hit Chance", "Thorns"],
    Protector: ["Armor", "Maximum Life", "Damage Reduction", "Thorns"],
    Resourceful: ["Maximum Resource"],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);

  // Attach operation-category overrides to Thorns to model the asymmetric prism bug.
  const thorns = byName["Thorns"];
  thorns.operationCategories = {
    add:     ["Aggressive"],
    focused: ["Protector"],
    chaotic: ["Protector"],
    remove:  ["Pragmatic"],
  };

  const data = { affixes, categories, targetAffixIds: [], maxAffixSlots: 4 };
  return { data, byName };
}

test("Thorns can only be added via Aggressive prism with operationCategories override", () => {
  const { data, byName } = buildThornsOverrideFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));

  // An item with 3 affixes (room to add).
  const state = buildState([
    { affixId: byName["Armor"].id },
    { affixId: byName["Maximum Life"].id },
    { affixId: byName["Movement Speed"].id },
  ]);

  // Aggressive add should produce Thorns as a possible outcome.
  const addAggressiveOutcomes = worker.getActionOutcomes(
    state, { type: "add", prism: "Aggressive" }, env
  );
  assert.ok(
    addAggressiveOutcomes.some((o) => o.state.affixes.some((a) => a.affixId === byName["Thorns"].id)),
    "Aggressive add must be able to produce Thorns"
  );

  // Pragmatic add must NOT produce Thorns (Pragmatic is for remove, not add).
  const addPragmaticOutcomes = worker.getActionOutcomes(
    state, { type: "add", prism: "Pragmatic" }, env
  );
  assert.ok(
    !addPragmaticOutcomes.some((o) => o.state.affixes.some((a) => a.affixId === byName["Thorns"].id)),
    "Pragmatic add must not produce Thorns"
  );

  // Protector add must NOT produce Thorns (Protector is for focused/chaotic, not add).
  const addProtectorOutcomes = worker.getActionOutcomes(
    state, { type: "add", prism: "Protector" }, env
  );
  assert.ok(
    !addProtectorOutcomes.some((o) => o.state.affixes.some((a) => a.affixId === byName["Thorns"].id)),
    "Protector add must not produce Thorns"
  );
});

test("Thorns can only be targeted for focused/chaotic reroll via Protector prism with operationCategories override", () => {
  const { data, byName } = buildThornsOverrideFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));

  // Item with Thorns on it — focused/chaotic reroll eligibility check.
  const state = buildState([
    { affixId: byName["Armor"].id },
    { affixId: byName["Thorns"].id },
    { affixId: byName["Movement Speed"].id },
  ]);

  const getEligible = (prism, opType) =>
    worker.getEligibleByCategory(state, env, prism, opType);

  // Thorns is eligible for Protector focused reroll.
  assert.ok(
    getEligible("Protector", "focused").some((e) => e.entry.affixId === byName["Thorns"].id),
    "Thorns must be eligible for Protector focused reroll"
  );
  // Thorns is eligible for Protector chaotic reroll.
  assert.ok(
    getEligible("Protector", "chaotic").some((e) => e.entry.affixId === byName["Thorns"].id),
    "Thorns must be eligible for Protector chaotic reroll"
  );
  // Thorns is NOT eligible for Aggressive focused reroll.
  assert.ok(
    !getEligible("Aggressive", "focused").some((e) => e.entry.affixId === byName["Thorns"].id),
    "Thorns must not be eligible for Aggressive focused reroll"
  );
  // Thorns is NOT eligible for Pragmatic focused reroll.
  assert.ok(
    !getEligible("Pragmatic", "focused").some((e) => e.entry.affixId === byName["Thorns"].id),
    "Thorns must not be eligible for Pragmatic focused reroll"
  );
});

test("Thorns can only be removed via Pragmatic prism with operationCategories override", () => {
  const { data, byName } = buildThornsOverrideFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));

  const state = buildState([
    { affixId: byName["Armor"].id },
    { affixId: byName["Thorns"].id },
    { affixId: byName["Movement Speed"].id },
  ], { isLegendary: false });

  const getEligible = (prism, opType) =>
    worker.getEligibleByCategory(state, env, prism, opType);

  // Thorns is eligible for Pragmatic remove.
  assert.ok(
    getEligible("Pragmatic", "remove").some((e) => e.entry.affixId === byName["Thorns"].id),
    "Thorns must be eligible for Pragmatic remove"
  );
  // Thorns is NOT eligible for Aggressive remove.
  assert.ok(
    !getEligible("Aggressive", "remove").some((e) => e.entry.affixId === byName["Thorns"].id),
    "Thorns must not be eligible for Aggressive remove"
  );
  // Thorns is NOT eligible for Protector remove.
  assert.ok(
    !getEligible("Protector", "remove").some((e) => e.entry.affixId === byName["Thorns"].id),
    "Thorns must not be eligible for Protector remove"
  );
});

// Helper: build a catalog fixture containing both Specific Skill Ranks (Adept, cube-ok)
// and Category Skill Ranks (Adept, enchant-only via empty operationCategories overrides).
function buildSkillRanksFixture() {
  const categoryToNames = {
    Adept: ["Mainstat", "Specific Skill Ranks", "Category Skill Ranks"],
    Protector: ["Armor", "Maximum Life", "Damage Reduction"],
    Aggressive: ["Critical Strike Chance", "Attack Speed"],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);

  // Attach empty operation overrides to Category Skill Ranks — mirrors config.js.
  const categorySkillRanks = byName["Category Skill Ranks"];
  categorySkillRanks.operationCategories = {
    add:     [],
    focused: [],
    chaotic: [],
    remove:  [],
  };

  const data = { affixes, categories, targetAffixIds: [], maxAffixSlots: 4 };
  return { data, byName };
}

test("Category Skill Ranks is excluded from all cube operation pools via operationCategories override", () => {
  const { data, byName } = buildSkillRanksFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));

  const state = buildState([
    { affixId: byName["Armor"].id },
    { affixId: byName["Maximum Life"].id },
    { affixId: byName["Critical Strike Chance"].id },
  ]);

  const getEligible = (prism, opType) =>
    worker.getEligibleByCategory(state, env, prism, opType);

  // Category Skill Ranks must not appear in any cube operation pool.
  assert.ok(
    !getEligible("Adept", "add").some((e) => e.entry.affixId === byName["Category Skill Ranks"].id),
    "Category Skill Ranks must not appear in Adept add pool"
  );
  assert.ok(
    !getEligible("Adept", "focused").some((e) => e.entry.affixId === byName["Category Skill Ranks"].id),
    "Category Skill Ranks must not appear in Adept focused pool"
  );
  assert.ok(
    !getEligible("Adept", "chaotic").some((e) => e.entry.affixId === byName["Category Skill Ranks"].id),
    "Category Skill Ranks must not appear in Adept chaotic pool"
  );
});

test("Specific Skill Ranks remains cube-modifiable and is unaffected by Category Skill Ranks override", () => {
  const { data, byName } = buildSkillRanksFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));

  const state = buildState([
    { affixId: byName["Armor"].id },
    { affixId: byName["Maximum Life"].id },
    { affixId: byName["Specific Skill Ranks"].id },
  ]);

  // Specific Skill Ranks must appear in the Adept pool for focused reroll.
  const focusedEligible = worker.getEligibleByCategory(state, env, "Adept", "focused");
  assert.ok(
    focusedEligible.some((e) => e.entry.affixId === byName["Specific Skill Ranks"].id),
    "Specific Skill Ranks must be eligible for Adept focused reroll"
  );

  // An Adept add must be able to produce Specific Skill Ranks.
  const addOutcomes = worker.getActionOutcomes(
    buildState([{ affixId: byName["Armor"].id }]),
    { type: "add", prism: "Adept" },
    env
  );
  assert.ok(
    addOutcomes.some((o) => o.state.affixes.some((a) => a.affixId === byName["Specific Skill Ranks"].id)),
    "Adept add must be able to produce Specific Skill Ranks"
  );
  // Category Skill Ranks must not appear as an Adept add outcome.
  assert.ok(
    !addOutcomes.some((o) => o.state.affixes.some((a) => a.affixId === byName["Category Skill Ranks"].id)),
    "Adept add must not produce Category Skill Ranks"
  );
});

test("Category Skill Ranks is accessible as an enchant target when present in target affixes", () => {
  const { data, byName } = buildSkillRanksFixture();

  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
  ], { enchantressAvailable: true });

  const target = buildTarget([
    { affixId: byName["Category Skill Ranks"].id, requireGA: false },
  ]);

  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  const env = worker.buildEnv(data, {}, target);
  const actions = worker.getValidActions(state, target, env);

  const enchantActions = actions.filter((a) => a.type === "enchant");
  assert.ok(enchantActions.length > 0, "Expected at least one enchant action");
  assert.ok(
    enchantActions.some((a) => a.targetAffixId === byName["Category Skill Ranks"].id),
    "Category Skill Ranks must be an available enchant target"
  );
});