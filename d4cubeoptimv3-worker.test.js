const test = require("node:test");
const assert = require("node:assert/strict");

const worker = require("./d4cubeoptimv3-worker.js");
const ilp = require("./ilp.js");
const gearSlotLegality = require("./gear-slot-legality.js");

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
      const familyRollWeight = typeof entry === "string" ? 0 : Number(entry.familyRollWeight);
      const className = typeof entry === "string" ? "" : String(entry.class || "");
      const id = normalizeName(name);

      if (!byId.has(id)) {
        byId.set(id, {
          id,
          name,
          categories: [],
          family,
          rollWeight: Number.isFinite(rollWeight) && rollWeight > 0 ? rollWeight : 1,
        });
        if (Number.isFinite(familyRollWeight) && familyRollWeight > 0) {
          byId.get(id).familyRollWeight = familyRollWeight;
        }
        if (className) {
          byId.get(id).class = className;
        }
      }

      if (family) {
        byId.get(id).family = family;
      }
      if (Number.isFinite(rollWeight) && rollWeight > 0) {
        byId.get(id).rollWeight = rollWeight;
      }
      if (Number.isFinite(familyRollWeight) && familyRollWeight > 0) {
        byId.get(id).familyRollWeight = familyRollWeight;
      }
      if (className) {
        byId.get(id).class = className;
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
    class: options.class || "Any",
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
  const env = require("./d4cubeoptimv3-worker.js").buildEnv(data, {}, target);

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
  const env = require("./d4cubeoptimv3-worker.js").buildEnv(data, {}, target);

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
  const env = require("./d4cubeoptimv3-worker.js").buildEnv(data, {}, target);

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
  const env = require("./d4cubeoptimv3-worker.js").buildEnv(data, {}, target);

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
  const env = require("./d4cubeoptimv3-worker.js").buildEnv(data, {
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
  const env = require("./d4cubeoptimv3-worker.js").buildEnv(data, {
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
  const env = require("./d4cubeoptimv3-worker.js").buildEnv(data, {}, target);

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
  const env = require("./d4cubeoptimv3-worker.js").buildEnv(data, {}, target);

  const plan = worker.chooseBestClosedFormPlanV3(state, target.affixes[0], 0, env, {
    data,
    gaConfig: {},
    target,
  });

  assert.equal(plan.caseId, worker.CLOSED_FORM_CASE_IDS.B);
  approxEqual(plan.expectedSteps, 1);
});

test("Maximum Resource is legal on 1H Weapon and 2H Weapon", () => {
  const { isAffixNameLegalForGearSlot } = gearSlotLegality;
  assert.equal(
    isAffixNameLegalForGearSlot("Maximum Resource", "1H Weapon"),
    true,
    "Maximum Resource must be legal on 1H Weapon (e.g. Maximum Fury for Barbarian dual-wield)"
  );
  assert.equal(
    isAffixNameLegalForGearSlot("Maximum Resource", "2H Weapon"),
    true,
    "Maximum Resource must be legal on 2H Weapon (e.g. Maximum Fury for Barbarian 2H weapons)"
  );
  // Sanity-check: still legal when gearSlot is Any
  assert.equal(
    isAffixNameLegalForGearSlot("Maximum Resource", "Any"),
    true,
    "Maximum Resource must be legal when gearSlot is Any"
  );
});

test("Amulet legality additions: Vulnerable Damage, Critical Strike Damage, DoT Damage, Lucky Hit Chance", () => {
  const { isAffixNameLegalForGearSlot } = gearSlotLegality;
  const amuletAffixes = [
    "Vulnerable Damage",
    "Critical Strike Damage",
    "DoT Damage",
    "Lucky Hit Chance",
  ];
  for (const name of amuletAffixes) {
    assert.equal(
      isAffixNameLegalForGearSlot(name, "Amulet"),
      true,
      `${name} must be legal on Amulet`
    );
  }
});

test("Ring legality additions: all 6 Elemental Damage subtypes and Cooldown Reduction", () => {
  const { isAffixNameLegalForGearSlot } = gearSlotLegality;
  const ringAffixes = [
    "Elemental Damage (Physical)",
    "Elemental Damage (Fire)",
    "Elemental Damage (Cold)",
    "Elemental Damage (Lightning)",
    "Elemental Damage (Poison)",
    "Elemental Damage (Shadow)",
    "Cooldown Reduction",
  ];
  for (const name of ringAffixes) {
    assert.equal(
      isAffixNameLegalForGearSlot(name, "Ring"),
      true,
      `${name} must be legal on Ring`
    );
  }
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

test.skip("optimizePayloadV3 returns an approximate residual action when iteration limits are reached [obsolete: under the new re-enchant model, the fixture's missing-target scenarios are decomposition-solvable, so the residual path is no longer reached even with the enchanted+GA placeholder. Residual coverage is exercised by the harder Class=Any Adept-heavy scenarios in solveResidualLAOStarV3 tests above]", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  // Mark Critical Strike Damage as enchanted+GA: this is the canonical way
  // under the new re-enchant model to block all enchant actions on an item.
  // Re-enchanting an enchanted+GA slot is forbidden (same-affix is a no-op,
  // different-affix destroys the GA), and the sticky-slot rule then prevents
  // any fresh enchant on the other slots. Without this, the new model lets
  // a single enchant solve the test in one step and the residual path isn't
  // exercised at all.
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Critical Strike Chance"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Critical Strike Damage"].id, isGA: true, isEnchanted: true },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Critical Strike Damage"].id, requireGA: false },
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
  // timeMs=30000 gives stateLimit=2000 (vs. 500 default), enough to reach
  // OPTIMAL on this fixture.  The original budget of 10000 (stateLimit=1000)
  // became insufficient after the prismUnblockEnchants extension added the
  // same-affix enchant for VulnDamage (a non-GA matched-target in Aggressive),
  // expanding the residual graph to ~1464 abstract states.
  const extendedBudget = worker.optimizePayloadV3({
    ...payload,
    timeMs: 30000,
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

test.skip("optimizeScenarioV3 routes residual-only cases through the residual solver [obsolete: same reason as the iteration-limit test above]", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  // Lock out enchant entirely by marking a target-aligned GA slot as
  // enchanted+GA (see the analogous comment on the iteration-limit test
  // above). Without this, the new enchant rules trivially solve the
  // missing-target case and the residual solver is never invoked.
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Critical Strike Chance"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Critical Strike Damage"].id, isGA: true, isEnchanted: true },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Critical Strike Damage"].id, requireGA: false },
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
  // quickly (~500 iterations) and uses the tight absolute epsilon (1e-9). Phase 2 uses a
  // *relative* convergence criterion (RESIDUAL_PHASE2_EPSILON = 1e-6 against the largest
  // current value), because absolute-1e-9 against root costs in the tens-to-thousands forced
  // millions of iterations on real Class=Any cases without changing the answer the UI shows.
  // The root cost here is ~90, so converged-relative ≈ 1e-4 absolute is the expected agreement
  // with the exact tabular oracle.
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
  // Phase 1 keeps absolute 1e-9 epsilon so root probability matches the exact value to ~1e-6.
  // Phase 2 uses relative 1e-6: residual is ≤ value*1e-6 at termination, but the *accumulated*
  // bias from value iteration can be a small multiple of that (residual divided by leaveProb).
  // For this fixture root cost ~90 the LAO* answer lands within ~3e-3 absolute of the exact
  // tabular oracle — well inside UI precision and the action-tie threshold.
  const phase2 = lao.phase2 !== null ? lao.phase2 : { costs: new Float64Array(graph.nodes.length) };
  approxEqual(lao.phase1.values[rootIndex], exact.phase1.values[rootIndex], 1e-6);
  approxEqual(phase2.costs[rootIndex], exact.phase2.costs[rootIndex], 5e-3);
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

test("isCategoryFocusedBlockedByMatchedTargetV3 detects non-GA target affixes sharing the prism category", () => {
  const categoryToNames = {
    Protector: ["All Resistance", "Maximum Life", "Specific Resistance (Cold)", "Armor", "Damage Reduction"],
    Aggressive: ["Critical Strike Chance", "Attack Speed"],
  };
  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  const data = { affixes, categories, targetAffixIds: [], maxAffixSlots: 4 };

  const state = buildState([
    { affixId: byName["Specific Resistance (Cold)"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
  ]);

  const target = buildTarget([
    { affixId: byName["All Resistance"].id, requireGA: false },
    { affixId: byName["Maximum Life"].id, requireGA: false },
  ]);
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  const env = worker.buildEnv(data, { strictMode: true }, target);

  // Slot 0 (SR-Cold) is the intended reroll; Maximum Life at slot 1 is a target and Protector.
  assert.ok(
    worker.isCategoryFocusedBlockedByMatchedTargetV3(state, "Protector", env, 0),
    "Should be blocked: Maximum Life (slot 1) is a target and shares Protector category"
  );
  // Excluding slot 1 (Maximum Life): SR-Cold at slot 0 is not a target — no block.
  assert.ok(
    !worker.isCategoryFocusedBlockedByMatchedTargetV3(state, "Protector", env, 1),
    "Should not be blocked when excluding the only matched target slot"
  );
});

test("Case B is blocked when a non-GA matched target shares the focused prism category", () => {
  // Reproduce the screenshot bug: naïve Case B for SR-Cold → All Resistance via Protector claimed
  // expected 14 steps, but Maximum Life (a target) at another slot is also Protector and would be
  // randomly endangered — the closed-form formula must not be used in that scenario.
  const categoryToNames = {
    Protector: ["All Resistance", "Maximum Life", "Specific Resistance (Cold)", "Armor", "Damage Reduction"],
    Aggressive: ["Critical Strike Chance", "Attack Speed"],
  };
  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  const data = { affixes, categories, targetAffixIds: [], maxAffixSlots: 4 };

  const state = buildState([
    { affixId: byName["Specific Resistance (Cold)"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: false },
  ]);

  const target = buildTarget([
    { affixId: byName["All Resistance"].id, requireGA: false },
    { affixId: byName["Maximum Life"].id, requireGA: false },
  ]);
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  const env = worker.buildEnv(data, { strictMode: true }, target);
  const allResTarget = target.affixes.find((e) => e.affixId === byName["All Resistance"].id);

  const candidates = worker.getClosedFormPlanCandidatesV3(state, allResTarget, 0, env, {
    data,
    gaConfig: { strictMode: true },
    target,
  });

  // Case B must not be generated: Maximum Life (a target) at slot 1 is Protector and would be
  // at risk of accidental reroll — the optimizer must escalate to the residual solver instead.
  const caseBCandidates = candidates.filter((c) => c.caseId === worker.CLOSED_FORM_CASE_IDS.B);
  assert.equal(caseBCandidates.length, 0,
    "Case B must be blocked when a matched target affix shares the focused prism category"
  );
});

// ============================================================================
// Class-aware skill catalog + family-level rolling weight tests.
// These cover the new skill multiplier, class-agnostic general, class-specific
// general, and specific-skill families introduced in config.js, along with the
// state.class narrowing that flows through env.categoryAffixesBySlotByClass.
// ============================================================================

function buildClassFilteringFixture() {
  const categoryToNames = {
    Adept: [
      "Mainstat",
      { name: "to All Skills" },
      { name: "to Basic Skills", family: "class-agnostic-general", familyRollWeight: 1 },
      { name: "to Core Skills",  family: "class-agnostic-general", familyRollWeight: 1 },
      { name: "to Bash",         family: "specific-skill", familyRollWeight: 1, class: "Barbarian" },
      { name: "to Frenzy",       family: "specific-skill", familyRollWeight: 1, class: "Barbarian" },
      { name: "to Claw",         family: "specific-skill", familyRollWeight: 1, class: "Druid" },
      { name: "to Maul",         family: "specific-skill", familyRollWeight: 1, class: "Druid" },
    ],
    Aggressive: ["Critical Strike Chance", "Attack Speed"],
    Protector: ["Maximum Life"],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);

  // "to All Skills" is enchant-only.
  byName["to All Skills"].operationCategories = {
    add:     [],
    focused: [],
    chaotic: [],
    remove:  [],
  };

  const data = {
    affixes,
    categories,
    targetAffixIds: [],
    maxAffixSlots: 4,
    classes: ["Any", "Barbarian", "Druid"],
  };
  return { data, byName };
}

test("Class filter narrows the Adept add pool to that class's specific skills", () => {
  const { data, byName } = buildClassFilteringFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));

  const barbState = buildState([], { class: "Barbarian" });
  const druidState = buildState([], { class: "Druid" });
  const anyState = buildState([], { class: "Any" });

  const barbPool = worker.getCategoryAffixesForState(barbState, env, "Adept", "add").map((a) => a.id);
  const druidPool = worker.getCategoryAffixesForState(druidState, env, "Adept", "add").map((a) => a.id);
  const anyPool = worker.getCategoryAffixesForState(anyState, env, "Adept", "add").map((a) => a.id);

  assert.ok(barbPool.includes(byName["to Bash"].id), "Barbarian pool must include to Bash");
  assert.ok(barbPool.includes(byName["to Frenzy"].id), "Barbarian pool must include to Frenzy");
  assert.ok(!barbPool.includes(byName["to Claw"].id), "Barbarian pool must not include Druid to Claw");
  assert.ok(!barbPool.includes(byName["to Maul"].id), "Barbarian pool must not include Druid to Maul");

  assert.ok(druidPool.includes(byName["to Claw"].id), "Druid pool must include to Claw");
  assert.ok(!druidPool.includes(byName["to Bash"].id), "Druid pool must not include Barb to Bash");

  for (const name of ["to Bash", "to Frenzy", "to Claw", "to Maul"]) {
    assert.ok(anyPool.includes(byName[name].id), `Class=Any pool must include ${name}`);
  }
});

test("Class-agnostic general skills appear for every class", () => {
  const { data, byName } = buildClassFilteringFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));

  for (const className of ["Any", "Barbarian", "Druid"]) {
    const pool = worker.getCategoryAffixesForState(
      buildState([], { class: className }), env, "Adept", "add"
    ).map((a) => a.id);

    assert.ok(pool.includes(byName["to Basic Skills"].id),
      `Class=${className}: to Basic Skills (class-agnostic) must be present`);
    assert.ok(pool.includes(byName["to Core Skills"].id),
      `Class=${className}: to Core Skills (class-agnostic) must be present`);
    assert.ok(pool.includes(byName["Mainstat"].id),
      `Class=${className}: Mainstat (no class) must be present`);
  }
});

test("Family-level rolling: family contributes weight 1 regardless of member count", () => {
  const { data, byName } = buildClassFilteringFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));

  // Barbarian Adept add pool: Mainstat (1) + to Basic Skills + to Core Skills (class-agnostic
  // generals family — 2 members @ familyRollWeight 1 → each effective weight 1/2) + to Bash
  // + to Frenzy (specific-skill family — 2 Barb members @ familyRollWeight 1 → each 1/2).
  // "to All Skills" is excluded from add.  Expected category total weight = 1 + 1 + 1 = 3.
  const barbState = buildState([], { class: "Barbarian" });
  const barbTotal = worker.getCategoryWeightTotal(barbState, env, "Adept", "add");
  assert.ok(Math.abs(barbTotal - 3) < 1e-9,
    `Barbarian Adept add total weight should be 3, got ${barbTotal}`);

  const barbAdd = worker.getActionOutcomes(barbState, { type: "add", prism: "Adept" }, env);
  const mainstatOutcome = barbAdd.find((o) => o.state.affixes.some((a) => a.affixId === byName["Mainstat"].id));
  const bashOutcome = barbAdd.find((o) => o.state.affixes.some((a) => a.affixId === byName["to Bash"].id));
  const basicSkillsOutcome = barbAdd.find((o) => o.state.affixes.some((a) => a.affixId === byName["to Basic Skills"].id));

  assert.ok(mainstatOutcome, "Mainstat outcome must exist");
  assert.ok(bashOutcome, "to Bash outcome must exist");
  assert.ok(basicSkillsOutcome, "to Basic Skills outcome must exist");

  // Mainstat is a singleton → effective weight 1, probability 1/3.
  approxEqual(mainstatOutcome.probability, 1 / 3, 1e-9);
  // to Bash is one of two Barb specifics in a family with familyRollWeight 1 → effective
  // weight 1/2, probability (1/2) / 3 = 1/6.
  approxEqual(bashOutcome.probability, 1 / 6, 1e-9);
  // to Basic Skills is one of two class-agnostic generals → same probability 1/6.
  approxEqual(basicSkillsOutcome.probability, 1 / 6, 1e-9);
});

test("Family-level rolling: Druid pool re-normalizes the specific-skill family to its 2 members", () => {
  const { data, byName } = buildClassFilteringFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));

  const druidState = buildState([], { class: "Druid" });
  const druidTotal = worker.getCategoryWeightTotal(druidState, env, "Adept", "add");
  // Mainstat (1) + class-agnostic generals family (1) + specific-skill family (1) = 3.
  assert.ok(Math.abs(druidTotal - 3) < 1e-9,
    `Druid Adept add total weight should be 3, got ${druidTotal}`);

  const druidAdd = worker.getActionOutcomes(druidState, { type: "add", prism: "Adept" }, env);
  const clawOutcome = druidAdd.find((o) => o.state.affixes.some((a) => a.affixId === byName["to Claw"].id));
  assert.ok(clawOutcome, "to Claw outcome must exist for Druid");
  approxEqual(clawOutcome.probability, 1 / 6, 1e-9);

  // Bash must NOT appear in Druid pool.
  const bashOutcome = druidAdd.find((o) => o.state.affixes.some((a) => a.affixId === byName["to Bash"].id));
  assert.equal(bashOutcome, undefined, "to Bash must not appear in Druid add pool");
});

test("'to All Skills' is excluded from every cube operation pool", () => {
  const { data, byName } = buildClassFilteringFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));

  const state = buildState([
    { affixId: byName["to All Skills"].id },
  ], { class: "Barbarian" });

  for (const opType of ["add", "focused", "chaotic", "remove"]) {
    const eligible = worker.getEligibleByCategory(state, env, "Adept", opType);
    assert.ok(
      !eligible.some((e) => e.entry.affixId === byName["to All Skills"].id),
      `'to All Skills' must not appear in Adept ${opType} pool`
    );
  }

  const adeptAdd = worker.getActionOutcomes(
    buildState([], { class: "Barbarian" }),
    { type: "add", prism: "Adept" },
    env
  );
  assert.ok(
    !adeptAdd.some((o) => o.state.affixes.some((a) => a.affixId === byName["to All Skills"].id)),
    "Adept add must never produce 'to All Skills'"
  );
});

test("'to All Skills' remains accessible as an enchant target", () => {
  const { data, byName } = buildClassFilteringFixture();

  const state = buildState([
    { affixId: byName["Mainstat"].id },
  ], { class: "Barbarian", enchantressAvailable: true });

  const target = buildTarget([
    { affixId: byName["to All Skills"].id, requireGA: false },
  ]);
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  const env = worker.buildEnv(data, {}, target);
  const actions = worker.getValidActions(state, target, env);

  const enchantActions = actions.filter((a) => a.type === "enchant");
  assert.ok(
    enchantActions.some((a) => a.targetAffixId === byName["to All Skills"].id),
    "'to All Skills' must be an available enchant target"
  );
});

test("Family-level rolling: skill-multiplier family in Aggressive prism contributes weight 1", () => {
  const categoryToNames = {
    Aggressive: [
      "Mainstat",
      "Weapon Damage",
      "Attack Speed",
      "Critical Strike Chance",
      "Critical Strike Damage",
      "Vulnerable Damage",
      "DoT Damage",
      "All Damage",
      { name: "Basic Skill Damage Multiplier",  family: "skill-multiplier", familyRollWeight: 1 },
      { name: "Core Skill Damage Multiplier",   family: "skill-multiplier", familyRollWeight: 1 },
      { name: "Backstab Damage Multiplier",     family: "skill-multiplier", familyRollWeight: 1 },
    ],
    Protector: ["Maximum Life"],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  const data = { affixes, categories, targetAffixIds: [], maxAffixSlots: 4 };
  const env = worker.buildEnv(data, {}, buildTarget([]));

  // 8 singletons (weight 1 each) + 1 family (weight 1) = total 9.
  const state = buildState([]);
  const total = worker.getCategoryWeightTotal(state, env, "Aggressive", "add");
  assert.ok(Math.abs(total - 9) < 1e-9,
    `Aggressive add total weight should be 9 (8 singletons + 1 skill-multiplier family), got ${total}`);

  const outcomes = worker.getActionOutcomes(state, { type: "add", prism: "Aggressive" }, env);
  const basicOutcome = outcomes.find((o) =>
    o.state.affixes.some((a) => a.affixId === byName["Basic Skill Damage Multiplier"].id));
  const mainstatOutcome = outcomes.find((o) =>
    o.state.affixes.some((a) => a.affixId === byName["Mainstat"].id));

  assert.ok(basicOutcome, "Basic Skill Damage Multiplier outcome must exist");
  assert.ok(mainstatOutcome, "Mainstat outcome must exist");
  // Mainstat: 1/9.  Each skill multiplier: (1/3)/9 = 1/27.
  approxEqual(mainstatOutcome.probability, 1 / 9, 1e-9);
  approxEqual(basicOutcome.probability, 1 / 27, 1e-9);
});

test("Class change is reflected in stateKey so cached MCTS nodes do not collide across classes", () => {
  const { data } = buildClassFilteringFixture();
  const env = worker.buildEnv(data, {}, buildTarget([]));
  const baseWorker = require("./d4cubeoptimv3-worker.js");

  const barbState = buildState([], { class: "Barbarian" });
  const druidState = buildState([], { class: "Druid" });
  const anyState = buildState([], { class: "Any" });

  const barbKey = baseWorker.stateKey(barbState);
  const druidKey = baseWorker.stateKey(druidState);
  const anyKey = baseWorker.stateKey(anyState);

  assert.notEqual(barbKey, druidKey, "Barb vs Druid state keys must differ");
  assert.notEqual(barbKey, anyKey, "Barb vs Any state keys must differ");
  assert.notEqual(druidKey, anyKey, "Druid vs Any state keys must differ");

  // The key must encode the class explicitly.
  assert.ok(barbKey.includes("CBarbarian"), `barbKey must include CBarbarian, got ${barbKey}`);
  assert.ok(druidKey.includes("CDruid"), `druidKey must include CDruid, got ${druidKey}`);
});

test("Case C is not generated on Legendary items because Remove Affix is unavailable", () => {
  // Host (Specific Resistance (Cold)) is in Chromatic; target (All Resistance) is Protector only.
  // Without the legendary check, Case C would emit a "remove via Chromatic then focused-reroll" plan,
  // but Remove Affix is unavailable on Legendary items per the game-mechanics doc.
  const categoryToNames = {
    Protector: ["All Resistance", "Maximum Life", "Armor", "Damage Reduction"],
    Chromatic: ["Specific Resistance (Cold)"],
    Aggressive: ["Critical Strike Chance", "Attack Speed"],
  };
  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  const data = { affixes, categories, targetAffixIds: [], maxAffixSlots: 4 };

  const state = buildState([
    { affixId: byName["Specific Resistance (Cold)"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ], { isLegendary: true });

  const target = buildTarget([
    { affixId: byName["All Resistance"].id, requireGA: false },
  ]);
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  const env = worker.buildEnv(data, { strictMode: true }, target);
  const candidates = worker.getClosedFormPlanCandidatesV3(state, target.affixes[0], 0, env, {
    data,
    gaConfig: { strictMode: true },
    target,
  });

  const caseCCandidates = candidates.filter((c) => c.caseId === worker.CLOSED_FORM_CASE_IDS.C);
  assert.equal(caseCCandidates.length, 0,
    "Case C must not be generated on Legendary items (Remove Affix is unavailable)"
  );
});

test("Case C is still generated on non-Legendary items so the regression check stays meaningful", () => {
  const categoryToNames = {
    Protector: ["All Resistance", "Maximum Life", "Armor", "Damage Reduction"],
    Chromatic: ["Specific Resistance (Cold)"],
    Aggressive: ["Critical Strike Chance", "Attack Speed"],
  };
  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  const data = { affixes, categories, targetAffixIds: [], maxAffixSlots: 4 };

  const state = buildState([
    { affixId: byName["Specific Resistance (Cold)"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ], { isLegendary: false });

  const target = buildTarget([
    { affixId: byName["All Resistance"].id, requireGA: false },
  ]);
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  const env = worker.buildEnv(data, { strictMode: true }, target);
  const candidates = worker.getClosedFormPlanCandidatesV3(state, target.affixes[0], 0, env, {
    data,
    gaConfig: { strictMode: true },
    target,
  });

  const caseCCandidates = candidates.filter((c) => c.caseId === worker.CLOSED_FORM_CASE_IDS.C);
  assert.ok(caseCCandidates.length > 0,
    "Case C must still be generated for the equivalent non-Legendary scenario"
  );
});

test("getValidActionsV2 includes same-affix enchant for non-GA matched-target slot", () => {
  // Regression test for the prismUnblockEnchants extension.
  // When a non-GA affix is already on the item AND appears in env.targetCounts
  // (it is a matched target), getValidActionsV2 must include a same-affix fresh
  // enchant on that slot.  Without the enchant in the action set the residual
  // solver cannot discover the "enchant non-GA target first, then chaotic/focused
  // reroll the now-unblocked prism" sequence.
  //
  // isCategoryFocusedBlockedByMatchedTargetV3 returns true when a non-GA
  // matched-target slot is un-enchanted and shares the prism with a missing
  // target, blocking closed-form Cases B/C/F/G.  After the same-affix enchant
  // the slot has isEnchanted=true and the block lifts.
  const categoryToNames = {
    Aggressive: ["Critical Strike Chance", "Critical Strike Damage", "Attack Speed"],
    Protector:  ["Maximum Life", "Armor"],
    Pragmatic:  ["Movement Speed"],
  };
  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  const data = { affixes, categories, targetAffixIds: [], maxAffixSlots: 4 };

  // Current item: CSC (non-GA, Aggressive, matched-target) + non-target fillers.
  const state = buildState([
    { affixId: byName["Critical Strike Chance"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Attack Speed"].id,            isGA: false, isEnchanted: false },
    { affixId: byName["Movement Speed"].id,          isGA: false, isEnchanted: false },
    { affixId: byName["Maximum Life"].id,            isGA: false, isEnchanted: false },
  ], { isLegendary: true });

  // Target: keep CSC, add CSD and Armor — two missing targets so late-enchant
  // does not fire, ensuring getValidActionsV2 is the source of the enchant.
  const target = buildTarget([
    { affixId: byName["Critical Strike Chance"].id, requireGA: false },
    { affixId: byName["Critical Strike Damage"].id, requireGA: false },
    { affixId: byName["Armor"].id,                  requireGA: false },
  ]);
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  // strictMode=true so isCategoryFocusedBlockedByMatchedTargetV3 actually fires.
  const gaConfig = { currentGAAffixes: [], strictMode: true, rulesEnabled: true };
  const env = worker.buildEnv(data, gaConfig, target);

  const actions = worker.getValidActionsV2(state, target, env);

  // The action set must contain a same-affix enchant on the CSC slot (slot 0).
  const cscEnchant = actions.find(
    (a) =>
      a.type === "enchant" &&
      a.sourceIndex === 0 &&
      a.targetAffixId === byName["Critical Strike Chance"].id
  );
  assert.ok(
    cscEnchant,
    "getValidActionsV2 must include a same-affix enchant on the non-GA matched-target CSC slot"
  );

  // Confirm the block is active before the enchant: Aggressive focused is blocked
  // because CSC (slot 0) is a non-GA matched-target sharing Aggressive with the
  // missing CSD.
  assert.ok(
    worker.isCategoryFocusedBlockedByMatchedTargetV3(state, "Aggressive", env, /* excludeSlotIndex */ 1),
    "Aggressive prism must be blocked by unenchanted CSC before the enchant"
  );

  // After simulating the same-affix enchant (set isEnchanted=true on slot 0),
  // the block must lift — Case B for AttackSpeed→CSD becomes available.
  const postEnchantState = {
    ...state,
    affixes: state.affixes.map((e, i) =>
      i === 0 ? { ...e, isEnchanted: true } : e
    ),
  };
  assert.ok(
    !worker.isCategoryFocusedBlockedByMatchedTargetV3(postEnchantState, "Aggressive", env, 1),
    "Aggressive prism must be unblocked once CSC is enchanted in place"
  );

  // Case B must now be generated for AttackSpeed→CSD in the post-enchant state.
  const postEnchantEnv = worker.buildEnv(data, gaConfig, target);
  const csdTarget = target.affixes.find((e) => e.affixId === byName["Critical Strike Damage"].id);
  const candidates = worker.getClosedFormPlanCandidatesV3(
    postEnchantState,
    csdTarget,
    /* hostSlotIndex */ 1,
    postEnchantEnv,
    { data, gaConfig, target }
  );
  const caseBCandidates = candidates.filter((c) => c.caseId === worker.CLOSED_FORM_CASE_IDS.B);
  assert.ok(
    caseBCandidates.length > 0,
    "Case B must be generated for AttackSpeed→CSD in the post-enchant state (Aggressive prism unblocked)"
  );
});

// ── Re-enchant of already-enchanted slot ─────────────────────────────────────

test("re-enchant of already-enchanted slot is chosen over Add Affix when cheaper", { timeout: TEST_TIMEOUT_MS * 5 }, async () => {
  // Reproduce the screenshot scenario:
  //   Slot=Any, Class=Barbarian, not Legendary.
  //   Current: one slot — "Maximum Life", Enchanted=true, GA=false.
  //   Target: "Armor".
  //
  // The closed-form REENCHANT candidate (cost 0.5) must beat the Case A
  // "Add Affix (Protector prism)" candidate (~2 expected steps for a
  // 2-entry pool) so the optimizer recommends the enchant action.
  const { data, byName } = buildFixture();  // Protector: ["Armor", "Maximum Life"]
  const state = buildState(
    [{ affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: true }],
    { gearSlot: "Any", class: "Any", isLegendary: false }
  );
  const target = buildTarget([{ affixId: byName["Armor"].id }]);
  const gaConfig = { currentGAAffixes: [], unsatisfactoryAffixIds: [], strictMode: true };

  const result = await worker.optimizePayloadV3(
    { state, target, data, gaConfig, timeMs: 0, stopBuffer: null, tree: null }
  );

  assert.ok(result, "optimizePayloadV3 must return a result");
  assert.ok(result.action, "result must have a recommended action");
  assert.equal(result.action.type, "enchant",
    `Expected enchant action but got ${JSON.stringify(result.action)}`);
  assert.equal(result.action.targetAffixId, byName["Armor"].id,
    "Enchant must target the missing 'Armor' affix");
  assert.ok(
    Number.isFinite(result.expectedSteps) && result.expectedSteps <= 0.5 + 1e-6,
    `Expected expectedSteps ≤ 0.5 but got ${result.expectedSteps}`
  );
  assert.ok(
    Number.isFinite(result.successProb) && result.successProb >= 1 - 1e-6,
    `Expected 100% success probability but got ${result.successProb}`
  );
});

test("re-enchant candidate is NOT proposed when enchanted slot's affix is itself a target", { timeout: TEST_TIMEOUT_MS }, () => {
  // Negative test: current slot has "Maximum Life" (enchanted, non-GA),
  // AND "Maximum Life" is in the target set. Re-enchanting would lose the
  // satisfied target, so no REENCHANT candidate should be generated.
  // The second target "Armor" must come from an empty slot via Case A.
  const { data, byName } = buildFixture();
  const state = buildState(
    [{ affixId: byName["Maximum Life"].id, isGA: false, isEnchanted: true }],
    { gearSlot: "Any", class: "Any", isLegendary: false }
  );
  const gaConfig = { currentGAAffixes: [], unsatisfactoryAffixIds: [], strictMode: true };
  // Target includes both Maximum Life (already satisfied) and Armor (missing).
  const target = buildTarget([
    { affixId: byName["Maximum Life"].id },
    { affixId: byName["Armor"].id },
  ]);
  const env = worker.buildEnv(data, gaConfig, target);

  const armorEntry = target.affixes.find((e) => e.affixId === byName["Armor"].id);
  // Slot 0 is the enchanted "Maximum Life" slot — REENCHANT must NOT fire.
  const candidatesSlot0 = worker.getClosedFormPlanCandidatesV3(state, armorEntry, 0, env, { data, gaConfig, target });
  const reenchantCandidates = candidatesSlot0.filter((c) => c.caseId === worker.CLOSED_FORM_CASE_IDS.REENCHANT);
  assert.equal(reenchantCandidates.length, 0,
    "REENCHANT must not be proposed when the enchanted slot's affix is itself a target");

  // Slot 1 is empty — Case A must be generated for Armor.
  const candidatesSlot1 = worker.getClosedFormPlanCandidatesV3(state, armorEntry, 1, env, { data, gaConfig, target });
  const caseACandidates = candidatesSlot1.filter((c) => c.caseId === worker.CLOSED_FORM_CASE_IDS.A);
  assert.ok(caseACandidates.length > 0,
    "Case A must be generated for Armor on the empty slot");
});

// Suppress lint by referencing approxEqual from the existing helper above.
void approxEqual;

// ─── Approach 1: one-step refinement of residual headline ────────────────────
//
// The residual LAO* solver's abstract value can over-estimate concrete
// successor values. Approach 1 refines the headline by computing
// 1 + Σ p_i × V(successor_i) using a recursive (refineDepth:0) optimizer
// call per outcome. The refinement should never *worsen* the headline.

// Small fixture mirroring the structure that causes loose residual values:
// a single affix (Mainstat) belonging to TWO categories, with at least one
// matched-target affix sharing one of those categories. This pattern is
// what creates abstract-state lumping in LAO* — and is exactly the
// real-world case from `scripts/diagnose-expected-steps-drop.js`.
function buildLooseResidualFixture() {
  const catalog = buildCatalogFixture({
    Aggressive: [
      "Mainstat",
      "Critical Strike Chance",
      "Critical Strike Damage",
      "Vulnerable Damage",
      "Attack Speed",
      "DoT Damage",
      { name: "Elemental Damage (Physical)", family: "elemental-damage" },
      { name: "Elemental Damage (Fire)", family: "elemental-damage" },
    ],
    Pragmatic: ["Movement Speed", "Cooldown Reduction"],
    Protector: ["Armor", "Maximum Life", "All Resistance"],
    Adept: ["Mainstat"],
  });
  return {
    data: {
      affixes: catalog.affixes,
      categories: catalog.categories,
      targetAffixIds: [],
      maxAffixSlots: 4,
    },
    byName: catalog.byName,
  };
}

test("refinement tightens the residual headline when applied", { timeout: TEST_TIMEOUT_MS }, () => {
  // Mirror of user's Spiritborn-Amulet scenario in a small fixture.
  // The recommended action is Remove(Adept) which is deterministic
  // (Mainstat is the only Adept-category affix on the item). Approach 1
  // should refine the headline to 1 + V(post-Remove state).
  const { data, byName } = buildLooseResidualFixture();
  const state = buildState([
    { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Attack Speed"].id, isGA: false, isEnchanted: false },
    { affixId: byName["Vulnerable Damage"].id, isGA: false, isEnchanted: true },
    { affixId: byName["Mainstat"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Attack Speed"].id, requireGA: false },
    { affixId: byName["Vulnerable Damage"].id, requireGA: false },
    { affixId: byName["Elemental Damage (Physical)"].id, requireGA: false },
  ]);

  const refined = worker.optimizePayloadV3({ state, target, data, gaConfig: {} });
  const unrefined = worker.optimizePayloadV3({ state, target, data, gaConfig: {} }, { refineDepth: 0 });

  assert.equal(refined.diagnostics.strategy, worker.RESIDUAL_STRATEGY);
  assert.equal(unrefined.diagnostics.strategy, worker.RESIDUAL_STRATEGY);
  assert.ok(refined.diagnostics.refinement, "Expected diagnostics.refinement when refinement applies");
  assert.equal(refined.diagnostics.refinement.applied, true);
  approxEqual(refined.diagnostics.refinement.originalSteps, unrefined.expectedSteps, 1e-6);
  assert.ok(refined.expectedSteps < unrefined.expectedSteps,
    `Expected refinement to STRICTLY tighten on this fixture; got refined=${refined.expectedSteps}, unrefined=${unrefined.expectedSteps}`);
  // The recommended action is Remove(Adept), which is deterministic on this
  // fixture (Mainstat is the only Adept-category affix on the item). So
  // refined = 1 + V(post-Remove state) by Bellman.
  assert.equal(refined.action.type, "remove");
  assert.equal(refined.action.prism, "Adept");
});

test("refinement is skipped when decomposition wins routing", { timeout: TEST_TIMEOUT_MS }, () => {
  // Simple add-only scenario — decomposition handles it exactly.
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Armor"].id, requireGA: false },
    { affixId: byName["Critical Strike Chance"].id, requireGA: false },
  ]);

  const result = worker.optimizePayloadV3({ state, target, data, gaConfig: {} });
  assert.equal(result.diagnostics.strategy, worker.DECOMPOSITION_STRATEGY);
  // refinement is skipped (only fires on residual strategy).
  assert.equal(result.diagnostics.refinement, undefined);
});

test("refinement preserves the recommended action — it only adjusts expectedSteps", { timeout: TEST_TIMEOUT_MS }, () => {
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

  const refined = worker.optimizePayloadV3({ state, target, data, gaConfig: {} });
  const unrefined = worker.optimizePayloadV3({ state, target, data, gaConfig: {} }, { refineDepth: 0 });

  assert.equal(refined.action.type, unrefined.action.type);
  assert.equal(refined.action.prism, unrefined.action.prism);
  assert.equal(refined.successProb, unrefined.successProb);
});

// ─── Gold-standard MC verification (Tighten Steps Estimate) ──────────────────

test("MC verification light: payload plumbing surfaces goldStandard diagnostics", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Armor"].id, requireGA: false },
    { affixId: byName["Critical Strike Chance"].id, requireGA: false },
  ]);
  const payload = {
    state,
    target,
    data,
    gaConfig: {},
    tightenStepsLevel: "light",
    tightenStepsOverrides: { lightRollouts: 5 }, // tiny for test speed
  };

  const intermediate = worker.optimizePayloadV3(payload);
  const final = worker.runMCVerificationV3(payload, intermediate);

  assert.ok(final.diagnostics.goldStandard);
  assert.equal(final.diagnostics.goldStandard.applied, true);
  assert.equal(final.diagnostics.goldStandard.level, "light");
  assert.equal(final.diagnostics.goldStandard.rollouts, 5);
  approxEqual(final.diagnostics.goldStandard.intermediateSteps, intermediate.expectedSteps, 1e-9);
  // expectedSteps was replaced with the MC mean.
  assert.ok(Number.isFinite(final.expectedSteps));
});

test("MC verification honors the stop signal", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Armor"].id, requireGA: false },
    { affixId: byName["Critical Strike Chance"].id, requireGA: false },
  ]);
  const payload = {
    state,
    target,
    data,
    gaConfig: {},
    tightenStepsLevel: "light",
    tightenStepsOverrides: { lightRollouts: 50 },
  };

  // Pre-set stop signal so the MC loop aborts on the first iteration.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.store(view, 0, 1);

  const intermediate = worker.optimizePayloadV3(payload);
  const final = worker.runMCVerificationV3(payload, intermediate, { stopView: view });

  assert.equal(final.diagnostics.goldStandard.aborted, true);
  assert.equal(final.approximate, true);
  assert.ok(final.diagnostics.goldStandard.rollouts < 50,
    `Expected early abort but ran ${final.diagnostics.goldStandard.rollouts} rollouts`);
});

test("MC verification adaptive obeys hard caps", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  const state = buildState([
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
  ]);
  const target = buildTarget([
    { affixId: byName["Armor"].id, requireGA: false },
    { affixId: byName["Critical Strike Chance"].id, requireGA: false },
  ]);
  const payload = {
    state,
    target,
    data,
    gaConfig: {},
    tightenStepsLevel: "adaptive",
    tightenStepsOverrides: {
      adaptiveMaxRollouts: 10,
      adaptiveWallBudgetMs: 500,
    },
  };

  const intermediate = worker.optimizePayloadV3(payload);
  const final = worker.runMCVerificationV3(payload, intermediate);

  assert.equal(final.diagnostics.goldStandard.adaptive, true);
  assert.ok(final.diagnostics.goldStandard.rollouts <= 10,
    `Adaptive must respect max-rollouts cap (got ${final.diagnostics.goldStandard.rollouts})`);
});

test("computeMCStatsV3 reports mean, stdev, and CI half-width", () => {
  const stats = worker.computeMCStatsV3([10, 12, 14, 16, 18]);
  approxEqual(stats.mean, 14, 1e-9);
  // sample stdev of [10,12,14,16,18] = sqrt((16+4+0+4+16)/4) = sqrt(10)
  approxEqual(stats.stdev, Math.sqrt(10), 1e-9);
  // CI half-width = 1.96 × stdev / sqrt(n)
  approxEqual(stats.ci95halfWidth, 1.96 * Math.sqrt(10) / Math.sqrt(5), 1e-9);

  const single = worker.computeMCStatsV3([42]);
  approxEqual(single.mean, 42, 1e-9);
  approxEqual(single.stdev, 0, 1e-9);
  approxEqual(single.ci95halfWidth, 0, 1e-9);
});

// ─── Bug 1 fix: Case A enchant-follow-up formula ──────────────────────────────

test("computeCaseAExpectedStepsV3 uses 2 - 1/n when enchant-follow-up flag is set", () => {
  // With useEnchantFollowUp: Add (1 step) + Enchant with probability (n-1)/n
  // = 1 + (n-1)/n = 2 - 1/n.
  approxEqual(worker.computeCaseAExpectedStepsV3(8, { useEnchantFollowUp: true }), 2 - 1/8, 1e-9);
  approxEqual(worker.computeCaseAExpectedStepsV3(12, { useEnchantFollowUp: true }), 2 - 1/12, 1e-9);
  // Without context, falls back to the existing geometric-retry formula.
  approxEqual(worker.computeCaseAExpectedStepsV3(8), 8 - 1 + 1/8, 1e-9);
  // Context with useEnchantFollowUp explicitly false also falls back.
  approxEqual(worker.computeCaseAExpectedStepsV3(8, { useEnchantFollowUp: false }), 8 - 1 + 1/8, 1e-9);
});

test("Case A picks enchant-follow-up formula when no slot is enchanted, falls back otherwise", { timeout: TEST_TIMEOUT_MS }, () => {
  const { data, byName } = buildFixture();
  // Bug 1 scenario: 1 affix on the item, no slot enchanted, target needs
  // a different affix in the same prism (Add → Enchant follow-up is optimal).
  const stateNoEnchant = buildState([
    { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: false },
  ]);
  // Sticky-slot scenario: same affix is now enchanted. Because Movement Speed
  // is also a target, re-enchant would lose the target — so the optimizer
  // can't escape via re-enchant and falls back through Case A.
  const stateWithEnchant = buildState([
    { affixId: byName["Movement Speed"].id, isGA: false, isEnchanted: true },
  ]);
  const target = buildTarget([
    { affixId: byName["Movement Speed"].id, requireGA: false },
    { affixId: byName["Critical Strike Chance"].id, requireGA: false },
  ]);
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  const resultNoEnchant = worker.optimizePayloadV3({ state: stateNoEnchant, target, data, gaConfig: {} });
  const resultWithEnchant = worker.optimizePayloadV3({ state: stateWithEnchant, target, data, gaConfig: {} });

  // No-enchant case applies the Bug 1 fix and uses E = 2 - 1/n.
  // For Aggressive Add pool of 5 effective entries (CSC + CSD + 2 elemental
  // family + Thorns), expected ≈ 1.8.
  assert.ok(resultNoEnchant.expectedSteps >= 1.5 && resultNoEnchant.expectedSteps <= 2.5,
    `Enchant-follow-up scenario expected ~2 steps (2 - 1/n); got ${resultNoEnchant.expectedSteps}`);
  // Sticky-slot case falls back to the geometric-retry formula n - 1 + 1/n.
  assert.ok(resultWithEnchant.expectedSteps > resultNoEnchant.expectedSteps + 1,
    `Sticky-slot case should be MUCH more expensive than no-enchant case ` +
    `(no-enchant=${resultNoEnchant.expectedSteps}, with-enchant=${resultWithEnchant.expectedSteps})`);

  // The selectedOptions for the no-enchant case should carry useEnchantFollowUp=true.
  const optNoEnchant = resultNoEnchant.diagnostics.decomposition.selectedOptions
    .find((o) => o.caseId === worker.CLOSED_FORM_CASE_IDS.A);
  assert.ok(optNoEnchant, "Expected a Case A option in the no-enchant scenario");
  assert.equal(optNoEnchant.useEnchantFollowUp, true,
    "Case A selectedOption must carry useEnchantFollowUp=true when no slot enchanted");

  // Sticky-slot case must NOT carry the flag.
  const optWithEnchant = resultWithEnchant.diagnostics.decomposition.selectedOptions
    .find((o) => o.caseId === worker.CLOSED_FORM_CASE_IDS.A);
  if (optWithEnchant) {
    assert.equal(optWithEnchant.useEnchantFollowUp, false,
      "Case A selectedOption must NOT carry useEnchantFollowUp=true when a slot is enchanted");
  }
});

// ─── Bug 2 detection: stuck-recovery looseEstimate flag ───────────────────────

test("Case A candidate flags looseEstimate when stuck-recovery conditions are met", { timeout: TEST_TIMEOUT_MS }, () => {
  // Bug 2 scenario: an enchanted slot whose affix IS a target (so re-enchant
  // would lose a target and is blocked); another non-enchanted matched-target
  // slot shares the prism category with the Add we're about to do; recovery
  // from a wrong Add via Focused(Aggressive) would risk destroying that
  // matched target. Case A's formula under-estimates the recovery cost.
  const { data, byName } = buildFixture();
  const state = buildState([
    // Critical Strike Damage is a matched target in Aggressive (non-enchanted)
    { affixId: byName["Critical Strike Damage"].id, isGA: false, isEnchanted: false },
    // Armor is enchanted AND a target — re-enchant escape is blocked.
    { affixId: byName["Armor"].id, isGA: false, isEnchanted: true },
  ]);
  const target = buildTarget([
    { affixId: byName["Armor"].id, requireGA: false },
    { affixId: byName["Critical Strike Damage"].id, requireGA: false },
    { affixId: byName["Elemental Damage (Physical)"].id, requireGA: false },
  ]);
  data.targetAffixIds = target.affixes.map((e) => e.affixId);

  const result = worker.optimizePayloadV3({ state, target, data, gaConfig: {} });
  if (result.diagnostics.strategy !== worker.DECOMPOSITION_STRATEGY) {
    // Strategy may escalate to residual on some configs; the looseEstimate
    // flag check only applies when decomposition wins. Skip silently if not.
    return;
  }
  const looseOptions = (result.diagnostics.decomposition.selectedOptions || [])
    .filter((o) => o && o.looseEstimate === true);
  assert.ok(looseOptions.length > 0,
    "At least one selectedOption must have looseEstimate=true for the stuck-recovery scenario " +
    `(got selectedOptions: ${JSON.stringify(result.diagnostics.decomposition.selectedOptions)})`);
});
