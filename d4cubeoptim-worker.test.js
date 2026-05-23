const test = require("node:test");
const assert = require("node:assert/strict");

const worker = require("./d4cubeoptim-worker.js");

function approxEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `Expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function sumProbabilities(outcomes, predicate) {
  return outcomes.reduce((sum, outcome) => (
    predicate(outcome) ? sum + outcome.probability : sum
  ), 0);
}

function buildFixture() {
  const affixes = [
    { id: "armor", name: "Armor", categories: ["Protector"] },
    { id: "life-on-hit", name: "Life on Hit", categories: ["Protector"] },
    { id: "life-on-kill", name: "Life on Kill", categories: ["Protector"] },
    { id: "all-resistance", name: "All Resistance", categories: ["Protector"] },
    { id: "movement-speed", name: "Movement Speed", categories: ["Pragmatic"] },
    { id: "maximum-evade-charges", name: "Maximum Evade Charges", categories: ["Pragmatic"] },
  ];

  const data = {
    affixes,
    categories: {
      Protector: ["armor", "life-on-hit", "life-on-kill", "all-resistance"],
      Pragmatic: ["movement-speed", "maximum-evade-charges"],
    },
    targetAffixIds: ["movement-speed", "maximum-evade-charges"],
  };

  const currentState = {
    isLegendary: false,
    enchantressAvailable: true,
    gearSlot: "Any",
    affixes: [
      { affixId: "armor", isGA: true, isEnchanted: false },
      { affixId: "life-on-hit", isGA: false, isEnchanted: false },
    ],
  };

  const target = {
    affixes: [
      { affixId: "movement-speed", requireGA: false },
      { affixId: "maximum-evade-charges", requireGA: false },
    ],
  };

  return { data, currentState, target };
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
    for (const name of names) {
      const id = normalizeName(name);
      if (!byId.has(id)) {
        byId.set(id, { id, name, categories: [] });
      }
      byId.get(id).categories.push(category);
    }
  }

  const affixes = Array.from(byId.values());
  const byName = Object.fromEntries(affixes.map((affix) => [affix.name, affix]));
  const categories = Object.fromEntries(
    Object.entries(categoryToNames).map(([category, names]) => [
      category,
      names.map((name) => byName[name].id),
    ])
  );

  return { affixes, byName, categories };
}

function buildEvadeScenarioFixture() {
  const categoryToNames = {
    Aggressive: [
      "Vulnerable Damage",
      "DoT Damage",
      "All Damage",
      "Elemental Damage",
      "Thorns",
    ],
    Pragmatic: [
      "Barrier Generation",
      "Cooldown Reduction",
      "Fortify Generation",
      "Healing Received",
      "Impairment Reduction",
      "Life Regeneration",
      "Lucky Hit Chance",
      "Movement Speed",
      "Potion Capacity",
      "Thorns",
      "Maximum Evade Charges",
      "Attacks reduce Evade Cooldown",
      "Evade grants Movement Speed",
    ],
    Protector: [
      "Armor",
      "Damage Reduction",
      "Dodge Chance",
      "Fortify Generation",
      "Life on Hit",
      "Life on Kill",
      "Life Regeneration",
      "Maximum Life",
      "All Resistance",
      "Specific Resistances",
    ],
    Resourceful: [
      "Lucky Hit Chance restore Resource",
      "Maximum Resource",
      "Resource Cost Reduction",
      "Resource on Kill",
      "Resource Regeneration",
    ],
    Adept: [
      "Mainstat",
      "Skill Ranks",
    ],
    Chromatic: [
      "Specific Resistances",
    ],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);

  const currentState = {
    isLegendary: false,
    enchantressAvailable: false,
    gearSlot: "Any",
    affixes: [
      { affixId: byName["All Resistance"].id, isGA: true, isEnchanted: false },
      { affixId: byName["Armor"].id, isGA: true, isEnchanted: false },
      { affixId: byName["Life on Kill"].id, isGA: false, isEnchanted: true },
    ],
  };

  const target = {
    affixes: [
      { affixId: byName["Maximum Evade Charges"].id, requireGA: false },
      { affixId: byName["Armor"].id, requireGA: false },
      { affixId: byName["All Resistance"].id, requireGA: true },
      { affixId: byName["Life on Kill"].id, requireGA: false },
    ],
  };

  const data = {
    affixes,
    categories,
    targetAffixIds: target.affixes.map((entry) => entry.affixId),
  };

  return { data, currentState, target, byName };
}

function buildLegendaryAggressiveBridgeFixture() {
  const fixture = buildEvadeScenarioFixture();
  fixture.currentState = {
    ...fixture.currentState,
    isLegendary: true,
    affixes: fixture.currentState.affixes.concat([
      { affixId: fixture.byName["All Damage"].id, isGA: false, isEnchanted: false },
    ]),
  };
  return fixture;
}

test("focused reroll randomly selects source within the prism category", () => {
  const { data, currentState, target } = buildFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: ["armor"],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const outcomes = worker.getActionOutcomes(currentState, {
    type: "focused",
    prism: "Protector",
  }, env);

  assert.ok(outcomes.length > 0);
  approxEqual(sumProbabilities(outcomes, () => true), 1);

  const gaSurvivesProbability = sumProbabilities(outcomes, (outcome) => outcome.state.affixes[0].isGA);
  const gaTouchedProbability = sumProbabilities(outcomes, (outcome) => !outcome.state.affixes[0].isGA);

  approxEqual(gaSurvivesProbability, 0.5);
  approxEqual(gaTouchedProbability, 0.5);
});

test("target-required GA blocks risky category actions even when strict mode is off", () => {
  const { data, currentState } = buildFixture();
  const target = {
    affixes: [
      { affixId: "armor", requireGA: true },
      { affixId: "movement-speed", requireGA: false },
    ],
  };
  const env = worker.buildEnv(data, {
    currentGAAffixes: ["armor"],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const actions = worker.getValidActions(currentState, target, env);
  const protectorActions = actions.filter((action) => action.prism === "Protector");

  assert.ok(protectorActions.some((action) => action.type === "add"));
  assert.ok(!protectorActions.some((action) => action.type === "remove"));
  assert.ok(!protectorActions.some((action) => action.type === "chaotic"));
  assert.ok(!protectorActions.some((action) => action.type === "focused"));
});

test("source GAs not required by the target do not block risky category actions", () => {
  const { data, currentState, target } = buildFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: ["armor"],
    strictMode: true,
    sacrificeAffixId: "",
  }, target);

  const actions = worker.getValidActions(currentState, target, env);
  const protectorActions = actions.filter((action) => action.prism === "Protector");

  assert.ok(protectorActions.some((action) => action.type === "remove"));
  assert.ok(protectorActions.some((action) => action.type === "chaotic"));
  assert.ok(protectorActions.some((action) => action.type === "focused"));
});

test("root action chooser keeps under-explored actions alive", () => {
  const underExplored = {
    action: { type: "add", prism: "Pragmatic" },
    visits: 2,
    totalScore: -10,
    successMass: 0.2,
  };

  const node = {
    visits: 1000,
    actions: {
      a: {
        action: { type: "add", prism: "Protector" },
        visits: 120,
        totalScore: 800,
        successMass: 100,
      },
      b: underExplored,
      c: {
        action: { type: "add", prism: "Chromatic" },
        visits: 130,
        totalScore: 820,
        successMass: 110,
      },
    },
  };

  const chosen = worker.chooseAction(node, true);
  assert.equal(chosen, underExplored);
});

test("root summary prefers the safer action before the shorter one", () => {
  const { data, currentState, target } = buildFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: ["armor"],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  function buildActionStats(action, visits, successProb, expectedSteps) {
    const successMass = visits * successProb;
    return {
      action,
      visits,
      totalScore: 0,
      totalCubeStepsAll: visits * expectedSteps,
      successMass,
      weightedSteps: successMass * expectedSteps,
      weightedStepsSq: successMass * expectedSteps * expectedSteps,
      outcomeVisits: Object.create(null),
    };
  }

  const saferFocused = { type: "focused", prism: "Protector" };
  const fasterChaotic = { type: "chaotic", prism: "Protector" };
  const rootKey = worker.stateKey(currentState);
  const tree = {
    rootKey,
    nodes: {
      [rootKey]: {
        state: worker.cloneState(currentState),
        visits: 534,
        actions: {
          [worker.actionKey(saferFocused)]: buildActionStats(saferFocused, 505, 0.884, 41.08),
          [worker.actionKey(fasterChaotic)]: buildActionStats(fasterChaotic, 29, 0.7326, 23.27),
        },
      },
    },
  };

  const summary = worker.summarizeRoot(tree, rootKey, env, target);

  assert.deepEqual(summary.action, saferFocused);
  assert.deepEqual(summary.diagnostics.candidateActions.map((candidate) => candidate.action), [
    saferFocused,
    fasterChaotic,
  ]);
});

test("focused probability breakdown reports both random sources and within-category outcomes", () => {
  const { data, currentState, target } = buildFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: ["armor"],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const breakdown = worker.getActionProbabilityBreakdown(currentState, {
    type: "focused",
    prism: "Protector",
  }, env);

  const armorSource = breakdown.sources.find((entry) => entry.label === "Armor");
  const lifeOnHitSource = breakdown.sources.find((entry) => entry.label === "Life on Hit");
  const armorOutcome = breakdown.outcomes.find((entry) => entry.label === "Armor");
  const lifeOnKillOutcome = breakdown.outcomes.find((entry) => entry.label === "Life on Kill");
  const noChangeOutcome = breakdown.outcomes.find((entry) => entry.label === "No change");

  assert.ok(armorSource);
  assert.ok(lifeOnHitSource);
  assert.ok(armorOutcome);
  assert.ok(lifeOnKillOutcome);
  assert.ok(noChangeOutcome);
  approxEqual(armorSource.probability, 0.5);
  approxEqual(lifeOnHitSource.probability, 0.5);
  approxEqual(armorOutcome.probability, 0.125);
  approxEqual(lifeOnKillOutcome.probability, 0.25);
  approxEqual(noChangeOutcome.probability, 0.25);
});

test("chaotic reroll can land in the same category and even the same affix", () => {
  const { data, currentState, target } = buildFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: ["armor"],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const outcomes = worker.getActionOutcomes(currentState, {
    type: "chaotic",
    prism: "Protector",
  }, env);

  const sameAffixExists = outcomes.some((outcome) => outcome.state.affixes.some((entry) => entry.affixId === "armor" && !entry.isGA));
  const sameCategoryExists = outcomes.some((outcome) => outcome.state.affixes.some((entry) => entry.affixId === "life-on-kill"));
  const pragmaticExists = outcomes.some((outcome) => outcome.state.affixes.some((entry) => entry.affixId === "movement-speed"));

  assert.ok(sameAffixExists);
  assert.ok(sameCategoryExists);
  assert.ok(pragmaticExists);
  approxEqual(sumProbabilities(outcomes, () => true), 1);
});

test("weighted subtype affixes split a single roll budget across typed outcomes", () => {
  const affixes = [
    { id: "armor", name: "Armor", categories: ["Protector"] },
    { id: "all-resistance", name: "All Resistance", categories: ["Protector"] },
    { id: "specific-resistance-physical", name: "Specific Resistance (Physical)", categories: ["Protector"], rollWeight: 1 / 6 },
    { id: "specific-resistance-fire", name: "Specific Resistance (Fire)", categories: ["Protector"], rollWeight: 1 / 6 },
    { id: "specific-resistance-cold", name: "Specific Resistance (Cold)", categories: ["Protector"], rollWeight: 1 / 6 },
    { id: "specific-resistance-shadow", name: "Specific Resistance (Shadow)", categories: ["Protector"], rollWeight: 1 / 6 },
    { id: "specific-resistance-lightning", name: "Specific Resistance (Lightning)", categories: ["Protector"], rollWeight: 1 / 6 },
    { id: "specific-resistance-poison", name: "Specific Resistance (Poison)", categories: ["Protector"], rollWeight: 1 / 6 },
  ];

  const data = {
    affixes,
    categories: {
      Protector: affixes.map((entry) => entry.id),
    },
    targetAffixIds: ["specific-resistance-fire"],
  };

  const state = {
    isLegendary: false,
    enchantressAvailable: true,
    gearSlot: "Any",
    affixes: [],
  };

  const target = {
    affixes: [{ affixId: "specific-resistance-fire", requireGA: false }],
  };

  const env = worker.buildEnv(data, {
    currentGAAffixes: [],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const outcomes = worker.getActionOutcomes(state, {
    type: "add",
    prism: "Protector",
  }, env);

  approxEqual(sumProbabilities(outcomes, () => true), 1);

  const typedMass = sumProbabilities(
    outcomes,
    (outcome) => outcome.state.affixes[0].affixId.startsWith("specific-resistance-")
  );
  const fireMass = sumProbabilities(
    outcomes,
    (outcome) => outcome.state.affixes[0].affixId === "specific-resistance-fire"
  );

  approxEqual(typedMass, 1 / 3);
  approxEqual(fireMass, 1 / 18);
});

test("typed families enforce one-affix-per-family on item outcomes", () => {
  const affixes = [
    { id: "armor", name: "Armor", categories: ["Protector"] },
    { id: "specific-resistance-fire", name: "Specific Resistance (Fire)", categories: ["Protector"], family: "specific-resistance", rollWeight: 0.5 },
    { id: "specific-resistance-cold", name: "Specific Resistance (Cold)", categories: ["Protector"], family: "specific-resistance", rollWeight: 0.5 },
  ];

  const data = {
    affixes,
    categories: {
      Protector: affixes.map((entry) => entry.id),
    },
    targetAffixIds: ["armor"],
  };

  const state = {
    isLegendary: false,
    enchantressAvailable: true,
    gearSlot: "Any",
    affixes: [{ affixId: "specific-resistance-fire", isGA: false, isEnchanted: false }],
  };

  const target = {
    affixes: [{ affixId: "armor", requireGA: false }],
  };

  const env = worker.buildEnv(data, {
    currentGAAffixes: [],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const outcomes = worker.getActionOutcomes(state, {
    type: "add",
    prism: "Protector",
  }, env);

  approxEqual(sumProbabilities(outcomes, () => true), 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].state.affixes[1].affixId, "armor");
});

test("unwanted elemental subtypes collapse into one state bucket", () => {
  const affixes = [
    { id: "weapon-damage", name: "Weapon Damage", categories: ["Aggressive"] },
    { id: "elemental-damage-fire", name: "Elemental Damage (Fire)", categories: ["Aggressive"], family: "elemental-damage", rollWeight: 1 / 6 },
    { id: "elemental-damage-cold", name: "Elemental Damage (Cold)", categories: ["Aggressive"], family: "elemental-damage", rollWeight: 1 / 6 },
    { id: "elemental-damage-shadow", name: "Elemental Damage (Shadow)", categories: ["Aggressive"], family: "elemental-damage", rollWeight: 1 / 6 },
    { id: "elemental-damage-lightning", name: "Elemental Damage (Lightning)", categories: ["Aggressive"], family: "elemental-damage", rollWeight: 1 / 6 },
    { id: "elemental-damage-poison", name: "Elemental Damage (Poison)", categories: ["Aggressive"], family: "elemental-damage", rollWeight: 1 / 6 },
    { id: "elemental-damage-physical", name: "Elemental Damage (Physical)", categories: ["Aggressive"], family: "elemental-damage", rollWeight: 1 / 6 },
  ];

  const data = {
    affixes,
    categories: {
      Aggressive: affixes.map((entry) => entry.id),
    },
    targetAffixIds: ["elemental-damage-fire"],
  };

  const state = {
    isLegendary: false,
    enchantressAvailable: true,
    gearSlot: "Any",
    affixes: [],
  };

  const target = {
    affixes: [{ affixId: "elemental-damage-fire", requireGA: false }],
  };

  const env = worker.buildEnv(data, {
    currentGAAffixes: [],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const outcomes = worker.getActionOutcomes(state, {
    type: "add",
    prism: "Aggressive",
  }, env);

  approxEqual(sumProbabilities(outcomes, () => true), 1);
  assert.equal(outcomes.length, 3);

  const ids = outcomes.map((outcome) => outcome.state.affixes[0].affixId).sort();
  assert.deepEqual(ids, ["elemental-damage-fire", "elemental-damage-other", "weapon-damage"]);

  const fireMass = sumProbabilities(outcomes, (outcome) => outcome.state.affixes[0].affixId === "elemental-damage-fire");
  const otherMass = sumProbabilities(outcomes, (outcome) => outcome.state.affixes[0].affixId === "elemental-damage-other");
  approxEqual(fireMass, 1 / 12);
  approxEqual(otherMass, 5 / 12);
});

test("probability breakdown reflects filtered family-duplicate outcomes", () => {
  const affixes = [
    { id: "armor", name: "Armor", categories: ["Protector"] },
    { id: "specific-resistance-fire", name: "Specific Resistance (Fire)", categories: ["Protector"], family: "specific-resistance", rollWeight: 0.5 },
    { id: "specific-resistance-cold", name: "Specific Resistance (Cold)", categories: ["Protector"], family: "specific-resistance", rollWeight: 0.5 },
  ];

  const data = {
    affixes,
    categories: {
      Protector: affixes.map((entry) => entry.id),
    },
    targetAffixIds: ["armor"],
  };

  const state = {
    isLegendary: false,
    enchantressAvailable: true,
    gearSlot: "Any",
    affixes: [{ affixId: "specific-resistance-fire", isGA: false, isEnchanted: false }],
  };

  const target = {
    affixes: [{ affixId: "armor", requireGA: false }],
  };

  const env = worker.buildEnv(data, {
    currentGAAffixes: [],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const breakdown = worker.getActionProbabilityBreakdown(state, {
    type: "add",
    prism: "Protector",
  }, env);

  assert.deepEqual(breakdown.outcomes, [{ label: "Armor", probability: 1 }]);
});

test("worker reports impossible target GA requirements that were not GA on the source", () => {
  const { data, currentState, target } = buildFixture();
  target.affixes[0].requireGA = true;
  const env = worker.buildEnv(data, {
    currentGAAffixes: ["armor"],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const rootKey = worker.stateKey(currentState);
  const tree = {
    rootKey,
    nodes: {
      [rootKey]: worker.createNode(currentState),
    },
  };
  const summary = worker.summarizeRoot(tree, rootKey, env, target);

  assert.equal(worker.heuristicSuccessProbability(currentState, target, env), 0);
  assert.deepEqual(worker.isTerminal(currentState, target, env), {
    terminal: true,
    success: false,
  });
  assert.equal(summary.action, null);
  assert.match(summary.diagnostics.reason, /Impossible target/);
});

test("heuristic remaining steps models the direct pragmatic retry loop for the evade-charge scenario", () => {
  const { data, currentState, target, byName } = buildEvadeScenarioFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [byName["All Resistance"].id, byName["Armor"].id],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const chromaticState = worker.getActionOutcomes(currentState, {
    type: "add",
    prism: "Chromatic",
  }, env)[0].state;

  const pragmaticMissState = worker.getActionOutcomes(currentState, {
    type: "add",
    prism: "Pragmatic",
  }, env).find((outcome) => !worker.isTerminal(outcome.state, target, env).success).state;

  assert.equal(worker.heuristicRemainingSteps(currentState, target, env), 25);
  assert.equal(worker.heuristicRemainingSteps(chromaticState, target, env), 26);
  assert.equal(worker.heuristicRemainingSteps(pragmaticMissState, target, env), 13);
});

test("rules resolver prefers pragmatic add when one target affix is missing", () => {
  const { data, currentState, target, byName } = buildEvadeScenarioFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [byName["All Resistance"].id, byName["Armor"].id],
    strictMode: false,
    sacrificeAffixId: "",
    rulesEnabled: true,
  }, target);

  const actions = worker.getValidActions(currentState, target, env);
  const decision = worker.resolveRuleAction(currentState, target, env, actions);

  assert.ok(decision);
  assert.equal(decision.rule, "single-missing-add");
  assert.deepEqual(decision.action, {
    type: "add",
    prism: "Pragmatic",
  });
});

test("simulateFromNode applies rules-first action while still updating parent stats", () => {
  const { data, currentState, target, byName } = buildEvadeScenarioFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [byName["All Resistance"].id, byName["Armor"].id],
    strictMode: false,
    sacrificeAffixId: "",
    rulesEnabled: true,
  }, target);

  const rootKey = worker.stateKey(currentState);
  const tree = {
    rootKey,
    nodes: {
      [rootKey]: worker.createNode(currentState),
    },
  };

  worker.simulateFromNode(tree, rootKey, env, target, 6, 6, 2);

  const root = tree.nodes[rootKey];
  const pragmaticAddKey = worker.actionKey({
    type: "add",
    prism: "Pragmatic",
  });

  assert.equal(root.visits, 1);
  assert.equal(root.actions[pragmaticAddKey].visits, 1);
  assert.ok(Object.values(root.actions).some((entry) => entry.visits === 0));
});

test("root summary reports rules-first diagnostics before MCTS visits", () => {
  const { data, currentState, target, byName } = buildEvadeScenarioFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [byName["All Resistance"].id, byName["Armor"].id],
    strictMode: false,
    sacrificeAffixId: "",
    rulesEnabled: true,
  }, target);

  const rootKey = worker.stateKey(currentState);
  const tree = {
    rootKey,
    nodes: {
      [rootKey]: worker.createNode(currentState),
    },
  };

  const summary = worker.summarizeRoot(tree, rootKey, env, target);

  assert.deepEqual(summary.action, {
    type: "add",
    prism: "Pragmatic",
  });
  assert.equal(summary.diagnostics.strategy, "rules-first");
  assert.equal(summary.diagnostics.rule.rule, "single-missing-add");
});

test("heuristic-guided unvisited chooser prefers pragmatic add when maximum evade charges is the only missing target affix", () => {
  const { data, currentState, target, byName } = buildEvadeScenarioFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [byName["All Resistance"].id, byName["Armor"].id],
    strictMode: false,
    sacrificeAffixId: "",
  }, target);

  const node = worker.createNode(currentState);
  worker.getValidActions(currentState, target, env)
    .filter((action) => action.type === "add")
    .forEach((action) => {
      node.actions[worker.actionKey(action)] = {
        action,
        visits: 0,
        totalScore: 0,
        totalCubeStepsAll: 0,
        successMass: 0,
        weightedSteps: 0,
        weightedStepsSq: 0,
        outcomeVisits: Object.create(null),
      };
    });

  const chosen = worker.chooseAction(node, true, env, target);
  assert.deepEqual(chosen.action, {
    type: "add",
    prism: "Pragmatic",
  });

  const pragmatic = node.actions[worker.actionKey({ type: "add", prism: "Pragmatic" })].action;
  const aggressive = node.actions[worker.actionKey({ type: "add", prism: "Aggressive" })].action;
  assert.ok(worker.immediateStepHint(currentState, pragmatic, env, target) < worker.immediateStepHint(currentState, aggressive, env, target));
  assert.ok(worker.immediateSuccessHint(currentState, pragmatic, env, target) + 1e-9 >= worker.immediateSuccessHint(currentState, aggressive, env, target));
});

test("focused aggressive reroll can bridge into pragmatic through thorns on a full legendary item", () => {
  const { data, currentState, target, byName } = buildLegendaryAggressiveBridgeFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [byName["All Resistance"].id, byName["Armor"].id],
    strictMode: false,
    sacrificeAffixId: byName["Armor"].id,
  }, target);

  const outcomes = worker.getActionOutcomes(currentState, {
    type: "focused",
    prism: "Aggressive",
  }, env);

  const thornsOutcome = outcomes.find((outcome) => outcome.state.affixes[3].affixId === byName["Thorns"].id);
  assert.ok(thornsOutcome);
  approxEqual(thornsOutcome.probability, 0.2);

  const nextActions = worker.getValidActions(thornsOutcome.state, target, env);
  assert.ok(nextActions.some((action) => action.type === "focused" && action.prism === "Pragmatic"));
  assert.ok(nextActions.some((action) => action.type === "chaotic" && action.prism === "Pragmatic"));
});

test("bridge-aware hints recognize guaranteed focused chains on the legendary aggressive bridge scenario", () => {
  const { data, currentState, target, byName } = buildLegendaryAggressiveBridgeFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [byName["All Resistance"].id, byName["Armor"].id],
    strictMode: false,
    sacrificeAffixId: byName["Armor"].id,
  }, target);

  const focusedAggressive = {
    type: "focused",
    prism: "Aggressive",
  };

  const thornsState = worker.getActionOutcomes(currentState, focusedAggressive, env)
    .find((outcome) => outcome.state.affixes[3].affixId === byName["Thorns"].id)
    .state;

  assert.deepEqual(worker.getGuaranteedFocusedBridgeEstimate(currentState, target, env), {
    successProb: 1,
    expectedSteps: 18,
  });
  assert.deepEqual(worker.getGuaranteedFocusedBridgeEstimate(thornsState, target, env), {
    successProb: 1,
    expectedSteps: 13,
  });

  approxEqual(worker.immediateSuccessHint(currentState, focusedAggressive, env, target), 1);
  approxEqual(worker.immediateStepHint(currentState, focusedAggressive, env, target), 18);
});

test("heuristic-guided chooser prefers the focused aggressive bridge after chain tuning", () => {
  const { data, currentState, target, byName } = buildLegendaryAggressiveBridgeFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [byName["All Resistance"].id, byName["Armor"].id],
    strictMode: false,
    sacrificeAffixId: byName["Armor"].id,
  }, target);

  const node = worker.createNode(currentState);
  worker.getValidActions(currentState, target, env).forEach((action) => {
    node.actions[worker.actionKey(action)] = {
      action,
      visits: 0,
      totalScore: 0,
      totalCubeStepsAll: 0,
      successMass: 0,
      weightedSteps: 0,
      weightedStepsSq: 0,
      outcomeVisits: Object.create(null),
    };
  });

  const chosen = worker.chooseAction(node, true, env, target);
  assert.deepEqual(chosen.action, {
    type: "focused",
    prism: "Aggressive",
  });
});
