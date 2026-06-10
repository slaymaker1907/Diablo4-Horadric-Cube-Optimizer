const test = require("node:test");
const assert = require("node:assert/strict");

const worker = require("./d4cubeoptimv3-worker.js");
const rulesSolver = require("./d4cubeoptimv3-rules-solver.js");

const helpers = {
  buildEnv: worker.buildEnv,
  getValidActions: worker.getValidActions,
  getActionOutcomes: worker.getActionOutcomes,
  getEligibleByCategory: worker.getEligibleByCategory,
  getCategoryAffixesForState: worker.getCategoryAffixesForState,
  getCategoryWeightTotal: worker.getCategoryWeightTotal,
  getEffectiveAffixRollWeight: worker.getEffectiveAffixRollWeight,
  buildFamilyCountsForPool: worker.buildFamilyCountsForPool,
  isTerminal: worker.isTerminal,
  stateKey: worker.stateKey,
  actionKey: worker.actionKey,
};

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
      const familyRollWeight = typeof entry === "string" ? 0 : Number(entry.familyRollWeight);
      const id = normalizeName(name);

      if (!byId.has(id)) {
        byId.set(id, { id, name, categories: [], family, rollWeight: 1 });
        if (Number.isFinite(familyRollWeight) && familyRollWeight > 0) {
          byId.get(id).familyRollWeight = familyRollWeight;
        }
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

// Routing fixture: Life Regeneration is dual-category (Pragmatic + Protector),
// Maximum Life / Armor are Protector-only, Mainstat lives in both Aggressive
// (large pool) and Adept (small pool).
function buildRoutingFixture() {
  const categoryToNames = {
    Aggressive: [
      "Mainstat",
      "Critical Strike Chance",
      "Critical Strike Damage",
      "Vulnerable Damage",
      "Weapon Damage",
      "Attack Speed",
    ],
    Pragmatic: [
      "Movement Speed",
      "Maximum Evade Charges",
      "Life Regeneration",
      "Cooldown Reduction",
    ],
    Protector: [
      "Armor",
      "Maximum Life",
      "Life Regeneration",
      "Damage Reduction",
    ],
    Adept: [
      "Mainstat",
      { name: "to Basic Skills", family: "class-agnostic-general", familyRollWeight: 1 },
      { name: "to Core Skills", family: "class-agnostic-general", familyRollWeight: 1 },
    ],
  };

  const { affixes, byName, categories } = buildCatalogFixture(categoryToNames);
  return {
    data: { affixes, categories, targetAffixIds: [], maxAffixSlots: 4 },
    byName,
  };
}

function buildState(affixes, options = {}) {
  const state = {
    gearSlot: options.gearSlot || "Any",
    class: options.class || "Any",
    isLegendary: !!options.isLegendary,
    affixes: affixes.map((entry) => ({
      affixId: entry.affixId,
      isGA: !!entry.isGA,
      isEnchanted: !!entry.isEnchanted,
    })),
  };
  if (Array.isArray(options.unsatisfactoryAffixIds)) {
    state.unsatisfactoryAffixIds = options.unsatisfactoryAffixIds.slice();
  }
  return state;
}

function buildTarget(affixIds) {
  return { affixes: affixIds.map((affixId) => ({ affixId })) };
}

function select(fixture, state, target, gaConfig = {}) {
  const env = helpers.buildEnv(fixture.data, gaConfig, target);
  return rulesSolver.selectRulesActionV3(state, target, env, helpers);
}

const ID = {
  mainstat: "mainstat",
  csc: "critical-strike-chance",
  csd: "critical-strike-damage",
  vd: "vulnerable-damage",
  wd: "weapon-damage",
  as: "attack-speed",
  ms: "movement-speed",
  mec: "maximum-evade-charges",
  lifeRegen: "life-regeneration",
  cdr: "cooldown-reduction",
  armor: "armor",
  maxLife: "maximum-life",
  dr: "damage-reduction",
};

// ───────────────────────── R1: finisher enchant ─────────────────────────

test("R1 finisher-enchant: one missing target, junk slot enchants to it", () => {
  const fixture = buildRoutingFixture();
  const state = buildState([
    { affixId: ID.maxLife },
    { affixId: ID.armor },
    { affixId: ID.ms },
    { affixId: ID.csc }, // junk
  ]);
  const target = buildTarget([ID.maxLife, ID.armor, ID.ms, ID.lifeRegen]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "finisher-enchant");
  assert.equal(result.action.type, "enchant");
  assert.equal(result.action.sourceIndex, 3);
  assert.equal(result.action.targetAffixId, ID.lifeRegen);
});

test("R1 finisher-enchant: re-enchants the existing non-GA enchanted slot", () => {
  const fixture = buildRoutingFixture();
  const state = buildState([
    { affixId: ID.maxLife },
    { affixId: ID.armor },
    { affixId: ID.csc, isEnchanted: true }, // enchanted junk
  ]);
  const target = buildTarget([ID.maxLife, ID.armor, ID.lifeRegen]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "finisher-enchant");
  assert.equal(result.action.type, "enchant");
  assert.equal(result.action.sourceIndex, 2);
  assert.equal(result.action.targetAffixId, ID.lifeRegen);
});

test("R1 finisher-enchant: unsatisfactory target counts as missing and is fixed by same-affix re-enchant", () => {
  const fixture = buildRoutingFixture();
  const state = buildState(
    [{ affixId: ID.maxLife }],
    { unsatisfactoryAffixIds: [ID.maxLife] }
  );
  const target = buildTarget([ID.maxLife]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "finisher-enchant");
  assert.equal(result.action.type, "enchant");
  assert.equal(result.action.sourceIndex, 0);
  assert.equal(result.action.targetAffixId, ID.maxLife);
});

// ───────────────────────── R2: routing-aware add ─────────────────────────

test("R2 routing-add tier 1: add-only target (Armor) claims the free slot", () => {
  const fixture = buildRoutingFixture();
  // Max Life (matched) poisons the Protector focused pool, so Armor is
  // add-only; Movement Speed / Life Regen route through safe Pragmatic.
  const state = buildState([
    { affixId: ID.maxLife },
    { affixId: ID.csc }, // junk
    { affixId: ID.vd },  // junk
  ]);
  const target = buildTarget([ID.maxLife, ID.ms, ID.lifeRegen, ID.armor]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "routing-add");
  assert.equal(result.action.type, "add");
  assert.equal(result.action.prism, "Protector");
});

test("R2 routing-add tier 2: seeds the safe Pragmatic focused-farm", () => {
  const fixture = buildRoutingFixture();
  // Armor satisfied; remaining missing targets (Movement Speed, Life Regen)
  // both route through Pragmatic, where focused is safe (no on-item affix in
  // the Pragmatic pool, none matched).
  const state = buildState([
    { affixId: ID.maxLife },
    { affixId: ID.armor },
    { affixId: ID.csc }, // junk
  ]);
  const target = buildTarget([ID.maxLife, ID.armor, ID.ms, ID.lifeRegen]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "routing-add");
  assert.equal(result.action.type, "add");
  assert.equal(result.action.prism, "Pragmatic");
});

test("R2 routing-add: Mainstat steered through the small Adept pool, not Aggressive", () => {
  const fixture = buildRoutingFixture();
  const state = buildState([
    { affixId: ID.maxLife },
  ]);
  const target = buildTarget([ID.maxLife, ID.mainstat]);

  const result = select(fixture, state, target);
  assert.ok(result);
  // Single missing target with no junk slot to enchant: R1 cannot fire, R2
  // adds. Adept pool = Mainstat + 1 skill family (share 1/2); Aggressive
  // pool = Mainstat + 5 singles (share 1/6).
  assert.equal(result.ruleName, "routing-add");
  assert.equal(result.action.type, "add");
  assert.equal(result.action.prism, "Adept");
});

test("R2 routing-add: enchant is never chosen with two or more targets missing", () => {
  const fixture = buildRoutingFixture();
  const state = buildState([
    { affixId: ID.maxLife },
    { affixId: ID.csc }, // junk — an enchant source exists
  ]);
  const target = buildTarget([ID.maxLife, ID.ms, ID.lifeRegen]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.notEqual(result.action.type, "enchant");
});

// ───────────────────────── R3: safe focused reroll ─────────────────────────

test("R3 safe-focused: farms the seeded Pragmatic slot, never touches Protector", () => {
  const fixture = buildRoutingFixture();
  // Item full; Pragmatic junk (Maximum Evade Charges) shares the Pragmatic
  // pool with both missing targets; Protector pool holds matched affixes.
  const state = buildState([
    { affixId: ID.maxLife },
    { affixId: ID.armor },
    { affixId: ID.mec }, // Pragmatic junk (the seed)
    { affixId: ID.csc }, // Aggressive junk
  ]);
  const target = buildTarget([ID.maxLife, ID.armor, ID.ms, ID.lifeRegen]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "safe-focused");
  assert.equal(result.action.type, "focused");
  assert.equal(result.action.prism, "Pragmatic");
});

// ───────────────────────── R4: targeted remove ─────────────────────────

test("R4 targeted-remove: full item, junk-only prism removal", () => {
  const fixture = buildRoutingFixture();
  // Missing targets live in Pragmatic only; no Pragmatic affix on item, so
  // no safe focused route is open — remove Aggressive junk to free a slot.
  const state = buildState([
    { affixId: ID.maxLife },
    { affixId: ID.armor },
    { affixId: ID.csc }, // junk
    { affixId: ID.vd },  // junk
  ]);
  const target = buildTarget([ID.maxLife, ID.armor, ID.ms, ID.lifeRegen]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "targeted-remove");
  assert.equal(result.action.type, "remove");
  assert.equal(result.action.prism, "Aggressive");
});

test("risky-focused: shared-category junk + missing target beats risky remove", () => {
  const fixture = buildRoutingFixture();
  // Item full, enchant spent on matched Movement Speed. Missing CSD lives in
  // Aggressive together with junk (CSC) AND matched Attack Speed — no
  // deterministic remove exists, so the steered focused reroll wins.
  const state = buildState([
    { affixId: ID.ms, isEnchanted: true },
    { affixId: ID.as },
    { affixId: ID.maxLife },
    { affixId: ID.csc }, // junk
  ]);
  const target = buildTarget([ID.ms, ID.as, ID.maxLife, ID.csd]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "risky-focused");
  assert.equal(result.action.type, "focused");
  assert.equal(result.action.prism, "Aggressive");
});

test("risky-remove: junk only clearable through pools shared with matched affixes", () => {
  const fixture = buildRoutingFixture();
  // Junk (Maximum Evade Charges, Damage Reduction) shares every removal pool
  // with a matched affix, and the missing targets (Aggressive) are not in
  // any junk-bearing focused pool — risky remove is the least-bad option.
  const state = buildState([
    { affixId: ID.maxLife },
    { affixId: ID.ms },
    { affixId: ID.mec }, // Pragmatic junk
    { affixId: ID.dr },  // Protector junk
  ]);
  const target = buildTarget([ID.maxLife, ID.ms, ID.csc, ID.csd]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "risky-remove");
  assert.equal(result.action.type, "remove");
  // Pragmatic and Protector tie at 1/2 junk fraction; name order breaks it.
  assert.equal(result.action.prism, "Pragmatic");
});

// ───────────────────────── R5: chaotic fallback ─────────────────────────

test("R5 chaotic-fallback: Legendary item cannot remove, narrows chaotic to junk", () => {
  const fixture = buildRoutingFixture();
  const state = buildState([
    { affixId: ID.maxLife },
    { affixId: ID.armor },
    { affixId: ID.csc }, // junk
    { affixId: ID.vd },  // junk
  ], { isLegendary: true });
  const target = buildTarget([ID.maxLife, ID.armor, ID.ms, ID.lifeRegen]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "chaotic-fallback");
  assert.equal(result.action.type, "chaotic");
  assert.equal(result.action.prism, "Aggressive");
});

// ───────────────────────── Rescue enchant ─────────────────────────

test("rescue-enchant: add-only target with a GA-polluted category is enchanted in", () => {
  const fixture = buildRoutingFixture();
  // GA Max Life poisons Protector entirely: focused/remove/chaotic Protector
  // pools all touch the protected GA, so junk fished into Protector while
  // hunting Armor could never be cleared. The rules spend the enchant on
  // Armor immediately instead of blind-fishing (mirrors the LAO* play).
  const state = buildState([
    { affixId: ID.maxLife, isGA: true },
    { affixId: ID.csc }, // junk
    { affixId: ID.vd },  // junk
  ]);
  const target = buildTarget([ID.maxLife, ID.ms, ID.cdr, ID.armor]);
  const gaConfig = { currentGAAffixes: [ID.maxLife], strictMode: true };

  const result = select(fixture, state, target, gaConfig);
  assert.ok(result);
  assert.equal(result.ruleName, "rescue-enchant");
  assert.equal(result.action.type, "enchant");
  assert.equal(result.action.targetAffixId, ID.armor);
  assert.equal(result.action.sourceIndex, 1);
});

test("rescue-enchant marks the GA instead when two targets are blocked by it (Legendary lockout)", () => {
  const fixture = buildRoutingFixture();
  // Legendary + full item: Remove and Add are gone. The protected GA (CSC)
  // sits in every Aggressive cube pool, so BOTH missing targets (CSD, VD —
  // Aggressive-only) are pollution-blocked. Rescuing one of them would leave
  // the other unreachable (junk landing in Aggressive could never be
  // cleared); the same-affix enchant-mark on the GA slot unpollutes
  // Aggressive for both. Mirrors the user-reported Ring scenario.
  const state = buildState([
    { affixId: ID.mainstat },        // matched
    { affixId: ID.mec },             // Pragmatic junk
    { affixId: ID.dr },              // Protector junk
    { affixId: ID.csc, isGA: true }, // protected GA, matched
  ], { isLegendary: true });
  const target = buildTarget([ID.mainstat, ID.csd, ID.vd, ID.csc]);
  const gaConfig = { currentGAAffixes: [ID.csc], strictMode: true };

  const result = select(fixture, state, target, gaConfig);
  assert.ok(result);
  assert.equal(result.ruleName, "rescue-enchant");
  assert.equal(result.action.type, "enchant");
  assert.equal(result.action.sourceIndex, 3);
  assert.equal(result.action.targetAffixId, ID.csc); // same-affix Phase-1 mark
});

test("rescue-enchant does not fire when the add-only category is cleanable", () => {
  const fixture = buildRoutingFixture();
  // Same shape but the Max Life is NOT a GA: Protector junk stays removable,
  // so Armor is ordinary add-only and tier-1 routing-add claims the slot.
  const state = buildState([
    { affixId: ID.maxLife },
    { affixId: ID.csc },
    { affixId: ID.vd },
  ]);
  const target = buildTarget([ID.maxLife, ID.ms, ID.cdr, ID.armor]);

  const result = select(fixture, state, target);
  assert.ok(result);
  assert.equal(result.ruleName, "routing-add");
  assert.equal(result.action.prism, "Protector");
});

// ───────────────────────── R6: GA-preserve enchant-mark ─────────────────────────

test("R6 ga-preserve-enchant-mark: locks the GA slot to unblock its category", () => {
  const fixture = buildRoutingFixture();
  // Protected GA (Critical Strike Chance) shares Aggressive with all three
  // junk slots: every remove/chaotic/focused Aggressive pool touches the GA,
  // so no cube action can clear junk until the GA slot is enchant-marked.
  const state = buildState([
    { affixId: ID.csc, isGA: true },
    { affixId: ID.csd }, // junk
    { affixId: ID.vd },  // junk
    { affixId: ID.wd },  // junk
  ]);
  const target = buildTarget([ID.csc, ID.ms, ID.lifeRegen, ID.armor]);
  const gaConfig = { currentGAAffixes: [ID.csc], strictMode: true };

  const result = select(fixture, state, target, gaConfig);
  assert.ok(result);
  assert.equal(result.ruleName, "ga-preserve-enchant-mark");
  assert.equal(result.action.type, "enchant");
  assert.equal(result.action.sourceIndex, 0);
  assert.equal(result.action.targetAffixId, ID.csc);
});

test("rules never pick an action outside getValidActions (GA safety inherited)", () => {
  const fixture = buildRoutingFixture();
  const state = buildState([
    { affixId: ID.csc, isGA: true },
    { affixId: ID.csd },
    { affixId: ID.vd },
    { affixId: ID.wd },
  ]);
  const target = buildTarget([ID.csc, ID.ms, ID.lifeRegen, ID.armor]);
  const gaConfig = { currentGAAffixes: [ID.csc], strictMode: true };

  const env = helpers.buildEnv(fixture.data, gaConfig, target);
  const result = rulesSolver.selectRulesActionV3(state, target, env, helpers);
  assert.ok(result);
  const validKeys = new Set(
    worker.getValidActions(state, target, env).map((a) => worker.actionKey(a))
  );
  assert.ok(validKeys.has(worker.actionKey(result.action)));
});

// ───────────────────────── Invariants / totality fuzz ─────────────────────────

test("policy totality fuzz: defined and valid on random reachable states", () => {
  const fixture = buildRoutingFixture();
  const allIds = Object.values(ID);
  const target = buildTarget([ID.maxLife, ID.ms, ID.lifeRegen, ID.armor]);
  const env = helpers.buildEnv(fixture.data, {}, target);

  let rng = 1234567;
  const rand = () => {
    // xorshift32 — deterministic fuzz.
    rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
    return ((rng >>> 0) / 0xffffffff);
  };

  for (let i = 0; i < 300; i++) {
    const count = 1 + Math.floor(rand() * 4);
    const picked = [];
    const used = new Set();
    while (picked.length < count) {
      const id = allIds[Math.floor(rand() * allIds.length)];
      if (!used.has(id)) {
        used.add(id);
        picked.push({ affixId: id });
      }
    }
    if (picked.length > 0 && rand() < 0.3) {
      picked[0].isEnchanted = true;
    }
    const state = buildState(picked, { isLegendary: rand() < 0.3 });

    const term = worker.isTerminal(state, target, env);
    if (term.terminal) {
      continue;
    }
    const validActions = worker.getValidActions(state, target, env);
    const result = rulesSolver.selectRulesActionV3(state, target, env, helpers);
    if (validActions.length === 0) {
      assert.equal(result, null);
      continue;
    }
    assert.ok(result, `no action selected for ${worker.stateKey(state)}`);
    const validKeys = new Set(validActions.map((a) => worker.actionKey(a)));
    assert.ok(
      validKeys.has(worker.actionKey(result.action)),
      `invalid action ${worker.actionKey(result.action)} for ${worker.stateKey(state)}`
    );
  }
});

test("no deterministic enchant cycles: policy-driven walk terminates or progresses", () => {
  const fixture = buildRoutingFixture();
  const target = buildTarget([ID.maxLife, ID.ms, ID.lifeRegen, ID.armor]);
  const payload = {
    state: buildState([{ affixId: ID.csc }, { affixId: ID.vd }]),
    target,
    data: fixture.data,
    gaConfig: {},
  };
  const policyFn = rulesSolver.createRulesPolicyV3(payload, helpers);
  const env = policyFn.env;

  let state = payload.state;
  let enchantStreak = 0;
  for (let step = 0; step < 500; step++) {
    const term = worker.isTerminal(state, target, env);
    if (term.terminal) {
      assert.ok(term.success);
      return;
    }
    const action = policyFn(state);
    assert.ok(action, `policy stuck at ${worker.stateKey(state)}`);
    if (action.type === "enchant") {
      enchantStreak++;
      assert.ok(enchantStreak <= 2, "policy loops on enchant actions");
    } else {
      enchantStreak = 0;
    }
    const outcomes = worker.getActionOutcomes(state, action, env);
    assert.ok(outcomes.length > 0, `no outcomes for ${worker.actionKey(action)}`);
    // Deterministically follow the most probable outcome.
    let best = outcomes[0];
    for (const outcome of outcomes) {
      if (outcome.probability > best.probability) best = outcome;
    }
    state = best.state;
  }
});

// ───────────────────────── MC smoke ─────────────────────────

test("runPolicyMCEvaluationV3 with the rules policy: feasible scenario succeeds", () => {
  const fixture = buildRoutingFixture();
  const payload = {
    state: buildState([{ affixId: ID.maxLife }]),
    target: buildTarget([ID.maxLife, ID.ms, ID.lifeRegen]),
    data: fixture.data,
    gaConfig: {},
    tightenStepsLevel: "light",
    tightenStepsOverrides: { lightRollouts: 60 },
  };
  const policyFn = rulesSolver.createRulesPolicyV3(payload, helpers);
  const stats = worker.runPolicyMCEvaluationV3(payload, policyFn, { env: policyFn.env });

  assert.ok(stats);
  assert.equal(stats.rollouts, 60);
  assert.ok(Number.isFinite(stats.mean) && stats.mean > 0);
  assert.equal(stats.deadRolloutCount, 0);
  assert.equal(stats.cappedRolloutCount, 0);
  assert.equal(stats.successRate, 1);
});

test("runPolicyMCEvaluationV3 honors cube-step costing (enchants are free)", () => {
  const fixture = buildRoutingFixture();
  // One missing target + junk slot: rules finish via add? No — R1 enchants
  // the junk slot immediately (deterministic, 0 cube cost).
  const payload = {
    state: buildState([
      { affixId: ID.maxLife },
      { affixId: ID.armor },
      { affixId: ID.ms },
      { affixId: ID.csc },
    ]),
    target: buildTarget([ID.maxLife, ID.armor, ID.ms, ID.lifeRegen]),
    data: fixture.data,
    gaConfig: {},
    tightenStepsLevel: "light",
    tightenStepsOverrides: { lightRollouts: 20 },
  };
  const policyFn = rulesSolver.createRulesPolicyV3(payload, helpers);

  const transitions = worker.runPolicyMCEvaluationV3(payload, policyFn, { env: policyFn.env });
  assert.equal(transitions.mean, 1); // one enchant transition

  const cubeCosts = worker.runPolicyMCEvaluationV3(payload, policyFn, {
    env: policyFn.env,
    useCubeStepCosts: true,
  });
  assert.equal(cubeCosts.mean, 0); // fresh enchant costs 0 cube steps
});
