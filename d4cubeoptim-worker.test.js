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

function buildOneMissingOffensiveFixture() {
  const damageTypes = ["Physical", "Fire", "Cold", "Shadow", "Lightning", "Poison"];
  const elementalTypedAffixes = damageTypes.map((type) => ({
    name: `Elemental Damage (${type})`,
    family: "elemental-damage",
    rollWeight: 1 / damageTypes.length,
  }));
  const specificResistanceTypedAffixes = damageTypes.map((type) => ({
    name: `Specific Resistance (${type})`,
    family: "specific-resistance",
    rollWeight: 1 / damageTypes.length,
  }));

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
      ...elementalTypedAffixes,
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
      ...specificResistanceTypedAffixes,
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
      ...specificResistanceTypedAffixes,
    ],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  const currentState = {
    isLegendary: false,
    enchantressAvailable: false,
    gearSlot: "Any",
    affixes: [
      { affixId: byName["Critical Strike Chance"].id, isGA: false, isEnchanted: false },
      { affixId: byName["Armor"].id, isGA: true, isEnchanted: false },
      { affixId: byName["Vulnerable Damage"].id, isGA: true, isEnchanted: false },
      { affixId: byName["Elemental Damage (Physical)"].id, isGA: false, isEnchanted: false },
    ],
  };

  const target = {
    affixes: [
      { affixId: byName["Critical Strike Chance"].id, requireGA: false },
      { affixId: byName["Critical Strike Damage"].id, requireGA: false },
      { affixId: byName["Vulnerable Damage"].id, requireGA: true },
      { affixId: byName["Elemental Damage (Physical)"].id, requireGA: false },
    ],
  };

  const data = {
    affixes,
    categories,
    targetAffixIds: target.affixes.map((entry) => entry.affixId),
  };

  return { data, currentState, target, byName };
}

function buildLegendarySingleMissingBridgeFixture() {
  const { data, byName } = buildOneMissingOffensiveFixture();
  const currentState = {
    isLegendary: true,
    enchantressAvailable: false,
    gearSlot: "Any",
    affixes: [
      { affixId: byName["Armor"].id, isGA: false, isEnchanted: false },
      { affixId: byName["Critical Strike Chance"].id, isGA: true, isEnchanted: false },
      { affixId: byName["Critical Strike Damage"].id, isGA: true, isEnchanted: false },
      { affixId: byName["Maximum Life"].id, isGA: true, isEnchanted: false },
    ],
  };

  const target = {
    affixes: [
      { affixId: byName["Evade grants Movement Speed"].id, requireGA: false },
      { affixId: byName["Critical Strike Chance"].id, requireGA: true },
      { affixId: byName["Critical Strike Damage"].id, requireGA: true },
      { affixId: byName["Maximum Life"].id, requireGA: false },
    ],
  };

  return {
    data: {
      affixes: data.affixes,
      categories: data.categories,
      targetAffixIds: target.affixes.map((entry) => entry.affixId),
    },
    currentState,
    target,
    byName,
  };
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

test("target-required GA blocks risky category actions in strict mode", () => {
  const { data, currentState } = buildFixture();
  const target = {
    affixes: [
      { affixId: "armor", requireGA: true },
      { affixId: "movement-speed", requireGA: false },
    ],
  };
  const env = worker.buildEnv(data, {
    currentGAAffixes: ["armor"],
    strictMode: true,
    sacrificeAffixId: "",
  }, target);

  const actions = worker.getValidActions(currentState, target, env);
  const protectorActions = actions.filter((action) => action.prism === "Protector");

  assert.ok(protectorActions.some((action) => action.type === "add"));
  assert.ok(!protectorActions.some((action) => action.type === "remove"));
  assert.ok(!protectorActions.some((action) => action.type === "chaotic"));
  assert.ok(!protectorActions.some((action) => action.type === "focused"));
});

test("target-required GA keeps risky category actions available in flexible mode", () => {
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
  assert.ok(protectorActions.some((action) => action.type === "remove"));
  assert.ok(protectorActions.some((action) => action.type === "chaotic"));
  assert.ok(protectorActions.some((action) => action.type === "focused"));
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

test("exact small-state estimates replace the old overestimate on the evade-charge scenario", () => {
  const { data, currentState, target, byName } = buildEvadeScenarioFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [byName["All Resistance"].id, byName["Armor"].id],
    strictMode: true,
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

  approxEqual(worker.heuristicRemainingSteps(currentState, target, env), 13, 1e-6);
  approxEqual(worker.heuristicRemainingSteps(chromaticState, target, env), 14, 1e-6);
  approxEqual(worker.heuristicRemainingSteps(pragmaticMissState, target, env), 13, 1e-6);
  assert.equal(worker.getExactSmallStateSummary(currentState, target, env).diagnostics.strategy, "exact-small-state");
});

test("flexible mode ranks chaotic protector first in the legendary bridge case when Maximum Life GA is required", () => {
  const { data, currentState, byName } = buildLegendarySingleMissingBridgeFixture();
  const target = {
    affixes: [
      { affixId: byName["Evade grants Movement Speed"].id, requireGA: false },
      { affixId: byName["Critical Strike Chance"].id, requireGA: true },
      { affixId: byName["Critical Strike Damage"].id, requireGA: true },
      { affixId: byName["Maximum Life"].id, requireGA: true },
    ],
  };
  const result = worker.optimizeScenario({
    state: currentState,
    target,
    data: {
      ...data,
      targetAffixIds: target.affixes.map((entry) => entry.affixId),
    },
    gaConfig: {
      currentGAAffixes: [
        byName["Critical Strike Chance"].id,
        byName["Critical Strike Damage"].id,
        byName["Maximum Life"].id,
      ],
      strictMode: false,
      sacrificeAffixId: "",
    },
    timeMs: 100,
  });

  assert.equal(result.iterations, 0);
  assert.equal(result.diagnostics.strategy, "exact-small-state");
  assert.deepEqual(result.action, {
    type: "chaotic",
    prism: "Protector",
  });
  assert.equal(result.diagnostics.solvedStates, 3810);
  approxEqual(result.successProb, 0.2977609998267527, 1e-6);
  approxEqual(result.expectedSteps, 14.979332345152072, 1e-6);
  assert.deepEqual(result.oneStepRisk.map((entry) => entry.name), ["Maximum Life"]);
  approxEqual(result.oneStepRisk[0].risk, 0.5, 1e-6);

  const topTwo = result.diagnostics.candidateActions.slice(0, 2);
  assert.deepEqual(topTwo.map((entry) => entry.action), [
    { type: "chaotic", prism: "Protector" },
    { type: "focused", prism: "Protector" },
  ]);
  assert.ok(topTwo[0].successProb > topTwo[1].successProb);
});

test("strict mode reports no safe action in the legendary bridge case when Maximum Life GA is required", () => {
  const { data, currentState, byName } = buildLegendarySingleMissingBridgeFixture();
  const target = {
    affixes: [
      { affixId: byName["Evade grants Movement Speed"].id, requireGA: false },
      { affixId: byName["Critical Strike Chance"].id, requireGA: true },
      { affixId: byName["Critical Strike Damage"].id, requireGA: true },
      { affixId: byName["Maximum Life"].id, requireGA: true },
    ],
  };

  const result = worker.optimizeScenario({
    state: currentState,
    target,
    data: {
      ...data,
      targetAffixIds: target.affixes.map((entry) => entry.affixId),
    },
    gaConfig: {
      currentGAAffixes: [
        byName["Critical Strike Chance"].id,
        byName["Critical Strike Damage"].id,
        byName["Maximum Life"].id,
      ],
      strictMode: true,
      sacrificeAffixId: "",
    },
    timeMs: 100,
  });

  assert.equal(result.iterations, 0);
  assert.equal(result.diagnostics.strategy, "exact-small-state");
  assert.equal(result.action, null);
  assert.equal(result.successProb, 0);
  assert.match(result.diagnostics.reason, /No safe action preserves all required GAs/);
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

  approxEqual(worker.immediateSuccessHint(currentState, focusedAggressive, env, target), 1, 1e-6);
  approxEqual(worker.immediateStepHint(currentState, focusedAggressive, env, target), 18, 1e-6);
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

test("exact small-state solver ranks remove above chaotic and focused in the one-missing offensive scenario", () => {
  const { data, currentState, target, byName } = buildOneMissingOffensiveFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [byName["Armor"].id, byName["Vulnerable Damage"].id],
    strictMode: true,
    sacrificeAffixId: "",
  }, target);

  const summary = worker.getExactSmallStateSummary(currentState, target, env);

  assert.ok(summary);
  assert.equal(summary.diagnostics.strategy, "exact-small-state");
  assert.equal(summary.diagnostics.solvedStates, 72);
  assert.deepEqual(summary.action, {
    type: "remove",
    prism: "Protector",
  });
  approxEqual(summary.successProb, 1 / 7);
  approxEqual(summary.expectedSteps, 18 / 7);

  const topThree = summary.diagnostics.candidateActions.slice(0, 3);
  assert.deepEqual(topThree.map((entry) => entry.action), [
    { type: "remove", prism: "Protector" },
    { type: "chaotic", prism: "Protector" },
    { type: "focused", prism: "Protector" },
  ]);
  approxEqual(topThree[0].expectedSteps, 18 / 7);
  approxEqual(topThree[1].expectedSteps, 3.266343825665949);
  approxEqual(topThree[2].expectedSteps, 25 / 7);
});

test("optimizeScenario uses the exact small-state fast path for the one-missing offensive scenario", () => {
  const { data, currentState, target, byName } = buildOneMissingOffensiveFixture();

  const result = worker.optimizeScenario({
    state: currentState,
    target,
    data,
    gaConfig: {
      currentGAAffixes: [byName["Armor"].id, byName["Vulnerable Damage"].id],
      strictMode: true,
      sacrificeAffixId: "",
    },
    timeMs: 100,
  });

  assert.equal(result.iterations, 0);
  assert.equal(result.diagnostics.strategy, "exact-small-state");
  assert.deepEqual(result.action, {
    type: "remove",
    prism: "Protector",
  });
  approxEqual(result.successProb, 1 / 7);
  approxEqual(result.expectedSteps, 18 / 7);
});

test("exact small-state solver handles the legendary single-missing bridge scenario", () => {
  const { data, currentState, target, byName } = buildLegendarySingleMissingBridgeFixture();
  const env = worker.buildEnv(data, {
    currentGAAffixes: [
      byName["Critical Strike Chance"].id,
      byName["Critical Strike Damage"].id,
      byName["Maximum Life"].id,
    ],
    strictMode: true,
    sacrificeAffixId: "",
  }, target);

  const summary = worker.getExactSmallStateSummary(currentState, target, env);

  assert.ok(summary);
  assert.equal(summary.diagnostics.strategy, "exact-small-state");
  assert.equal(summary.diagnostics.solvedStates, 1330);
  assert.deepEqual(summary.action, {
    type: "focused",
    prism: "Protector",
  });
  assert.ok(summary.successProb > 0.99);
  approxEqual(summary.expectedSteps, 25.447136616631404, 1e-6);

  const topTwo = summary.diagnostics.candidateActions.slice(0, 2);
  assert.deepEqual(topTwo.map((entry) => entry.action), [
    { type: "focused", prism: "Protector" },
    { type: "chaotic", prism: "Protector" },
  ]);
  assert.ok(topTwo[0].successProb > topTwo[1].successProb);
  assert.ok(topTwo[1].expectedSteps < topTwo[0].expectedSteps);
  assert.deepEqual(summary.oneStepRisk.map((entry) => entry.name), ["Maximum Life"]);
  approxEqual(summary.oneStepRisk[0].risk, 0.45, 1e-6);
});

test("optimizeScenario uses the exact fast path for the legendary single-missing bridge scenario", () => {
  const { data, currentState, target, byName } = buildLegendarySingleMissingBridgeFixture();

  const result = worker.optimizeScenario({
    state: currentState,
    target,
    data,
    gaConfig: {
      currentGAAffixes: [
        byName["Critical Strike Chance"].id,
        byName["Critical Strike Damage"].id,
        byName["Maximum Life"].id,
      ],
      strictMode: true,
      sacrificeAffixId: "",
    },
    timeMs: 100,
  });

  assert.equal(result.iterations, 0);
  assert.equal(result.diagnostics.strategy, "exact-small-state");
  assert.deepEqual(result.action, {
    type: "focused",
    prism: "Protector",
  });
  assert.ok(result.successProb > 0.99);
  approxEqual(result.expectedSteps, 25.447136616631404, 1e-6);
  assert.deepEqual(result.oneStepRisk.map((entry) => entry.name), ["Maximum Life"]);
  approxEqual(result.oneStepRisk[0].risk, 0.45, 1e-6);
});
