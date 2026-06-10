#!/usr/bin/env node
/**
 * compare-rules-vs-lao.js
 *
 * Head-to-head Monte Carlo evaluation of the rules-based solver
 * (d4cubeoptimv3-rules-solver.js) against the LAO* optimizer policy on
 * representative scenarios. Both policies run through the same shared
 * rollout engine (runPolicyMCEvaluationV3) with identical fixed budgets and
 * cube-step costing (cube ops 1, fresh enchant 0, re-enchant 0.5).
 *
 *   node scripts/compare-rules-vs-lao.js [--rollouts=N] [--max-steps=N] [--scenario=substring]
 *
 * Every run carries a hard step budget (--max-steps, default 200): rollouts
 * that would exceed it fail, exactly like a GA break. The optimizer arm uses
 * the production hybrid (decomposition gate / budget DP with policy-table
 * replay); the rules arm evaluates the unmodified stationary rules policy
 * under the same budget.
 *
 * Reports per scenario and policy:
 *   mean ± CI95 cube steps, success-only mean, success rate, dead /
 *   budget-exceeded / capped counts, wall ms — and a lexicographic verdict.
 *
 * Does NOT touch any project files — pure read-only measurement.
 */

"use strict";

const worker = require("../d4cubeoptimv3-worker.js");
const rulesSolver = require("../d4cubeoptimv3-rules-solver.js");
const config = require("../config.js");
const slotLegality = require("../gear-slot-legality.js");

const DAMAGE_TYPES = config.DAMAGE_TYPES;

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

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildRealCatalog() {
  const map = Object.create(null);
  function addEntry(categoryName, entry) {
    const baseName = typeof entry === "string" ? entry : entry.name;
    const family = typeof entry === "string" ? "" : String(entry.family || "");
    const familyRollWeight = typeof entry === "string" ? 0 : Number(entry.familyRollWeight) || 0;
    const className = typeof entry === "string" ? "" : String(entry.class || "");
    const expandedNames =
      baseName === "Elemental Damage" ? DAMAGE_TYPES.map((t) => `Elemental Damage (${t})`)
        : baseName === "Specific Resistance" ? DAMAGE_TYPES.map((t) => `Specific Resistance (${t})`)
        : [baseName];
    for (const name of expandedNames) {
      const id = slugify(name);
      if (!map[id]) {
        map[id] = {
          id, name, categories: [],
          gearSlots: slotLegality.getLegalGearSlotsForAffixName(name),
          family, rollWeight: 1,
        };
        if (familyRollWeight > 0) map[id].familyRollWeight = familyRollWeight;
        if (className) map[id].class = className;
      }
      if (familyRollWeight > 0) map[id].familyRollWeight = familyRollWeight;
      if (className) map[id].class = className;
      if (family) map[id].family = family;
      if (!map[id].categories.includes(categoryName)) map[id].categories.push(categoryName);
    }
  }
  for (const [categoryName, entries] of Object.entries(config.CATEGORY_TO_AFFIX_NAMES)) {
    for (const entry of entries) addEntry(categoryName, entry);
  }
  for (const [affixName, ops] of Object.entries(config.OPERATION_CATEGORY_OVERRIDES)) {
    const id = slugify(affixName);
    if (map[id]) {
      map[id].operationCategories = Object.fromEntries(
        Object.entries(ops).map(([op, cats]) => [op, cats.slice()])
      );
    }
  }
  const affixes = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  return {
    affixes,
    byName: Object.fromEntries(affixes.map((a) => [a.name, a])),
    categories: Object.fromEntries(Object.keys(config.CATEGORY_TO_AFFIX_NAMES).map((cat) =>
      [cat, affixes.filter((a) => a.categories.includes(cat)).map((a) => a.id)])),
  };
}

const catalog = buildRealCatalog();
const affixId = (name) => {
  const a = catalog.byName[name];
  if (!a) throw new Error(`Affix not found: ${name}`);
  return a.id;
};

function makePayload(scenario, rollouts, maxSteps) {
  const data = {
    affixes: catalog.affixes,
    categories: catalog.categories,
    gearSlots: slotLegality.GEAR_SLOTS,
    classes: config.CLASSES,
    targetAffixIds: [],
    maxAffixSlots: 4,
  };
  const state = {
    gearSlot: scenario.gearSlot,
    class: scenario.class,
    isLegendary: !!scenario.isLegendary,
    affixes: scenario.current.map((s) => ({
      affixId: affixId(s.name), isGA: !!s.isGA, isEnchanted: !!s.isEnchanted,
    })),
  };
  const target = {
    affixes: scenario.target.map((name) => ({
      affixId: affixId(name), requireGA: false, needsImprovement: false,
    })),
  };
  data.targetAffixIds = target.affixes.map((e) => e.affixId);
  return {
    state, target, data,
    gaConfig: {
      currentGAAffixes: (scenario.gaAffixes || []).map((name) => affixId(name)),
      unsatisfactoryAffixIds: [],
      strictMode: true,
      sacrificeAffixId: "",
    },
    timeMs: 30000,
    maxSteps,
    includeRolloutData: true,
    tightenStepsLevel: "heavy",
    tightenStepsOverrides: { heavyRollouts: rollouts },
  };
}

const SCENARIOS = [
  {
    name: "Spiritborn Amulet (4 affixes, enchanted slot)",
    gearSlot: "Amulet", class: "Spiritborn",
    current: [
      { name: "Movement Speed" },
      { name: "Attack Speed" },
      { name: "Vulnerable Damage", isEnchanted: true },
      { name: "Mainstat" },
    ],
    target: ["Movement Speed", "Attack Speed", "Vulnerable Damage", "Elemental Damage (Physical)"],
  },
  {
    name: "Spiritborn Amulet (3 affixes, post-Remove)",
    gearSlot: "Amulet", class: "Spiritborn",
    current: [
      { name: "Movement Speed" },
      { name: "Attack Speed" },
      { name: "Vulnerable Damage", isEnchanted: true },
    ],
    target: ["Movement Speed", "Attack Speed", "Vulnerable Damage", "Elemental Damage (Physical)"],
  },
  {
    name: "Sorcerer Helm (cooldown setup)",
    gearSlot: "Helm", class: "Sorceror",
    current: [
      { name: "Maximum Life" },
      { name: "Armor" },
      { name: "All Resistance" },
      { name: "Mainstat" },
    ],
    target: ["Maximum Life", "Cooldown Reduction", "Maximum Resource", "All Resistance"],
  },
  {
    name: "Necromancer Amulet (Macabre skill target, residual-heavy)",
    gearSlot: "Amulet", class: "Necromancer",
    current: [
      { name: "All Resistance" },
      { name: "Maximum Life" },
      { name: "Mainstat", isEnchanted: true },
    ],
    target: ["All Resistance", "Maximum Life", "Maximum Resource", "to Macabre Skills"],
  },
  {
    name: "GA protection (GA Maximum Life on Helm)",
    gearSlot: "Helm", class: "Sorceror",
    current: [
      { name: "Maximum Life", isGA: true },
      { name: "Dodge Chance" },
      { name: "Lucky Hit Chance" },
    ],
    target: ["Maximum Life", "Cooldown Reduction", "Maximum Resource", "Armor"],
    gaAffixes: ["Maximum Life"],
  },
  {
    name: "Legendary lockout (no Remove available)",
    gearSlot: "Amulet", class: "Spiritborn",
    isLegendary: true,
    current: [
      { name: "Movement Speed" },
      { name: "Attack Speed" },
      { name: "Critical Strike Chance" },
      { name: "Critical Strike Damage" },
    ],
    target: ["Movement Speed", "Attack Speed", "Cooldown Reduction", "Maximum Resource"],
  },
  {
    name: "Legendary + GA lockout (Ring, user-reported)",
    gearSlot: "Ring", class: "Sorceror",
    isLegendary: true,
    current: [
      { name: "Mainstat" },
      { name: "Life on Hit" },
      { name: "Lucky Hit Chance" },
      { name: "Critical Strike Damage", isGA: true },
    ],
    target: ["Mainstat", "All Damage", "Vulnerable Damage", "Critical Strike Damage"],
    gaAffixes: ["Critical Strike Damage"],
  },
  {
    name: "Enchant finisher (3 matched + 1 junk, one missing)",
    gearSlot: "Amulet", class: "Spiritborn",
    current: [
      { name: "Movement Speed" },
      { name: "Attack Speed" },
      { name: "Maximum Resource" },
      { name: "Thorns" },
    ],
    target: ["Movement Speed", "Attack Speed", "Maximum Resource", "Cooldown Reduction"],
  },
  {
    name: "Dual-category routing (Max Life + {Pragmatic target, Life Regen, Armor})",
    gearSlot: "Amulet", class: "Spiritborn",
    current: [
      { name: "Maximum Life" },
      { name: "Critical Strike Chance" },
      { name: "Critical Strike Damage" },
    ],
    target: ["Maximum Life", "Cooldown Reduction", "Life Regeneration", "Armor"],
  },
];

// Optimizer arm: runMCVerificationV3 picks the right replay regime itself —
// stationary cache for gated decomposition results, budget-DP policy-table
// replay (per abstract state x remaining budget) for budget results.
function evaluateOptimizer(payload, intermediate) {
  const t0 = Date.now();
  const verified = worker.runMCVerificationV3(payload, intermediate, { useCubeStepCosts: true });
  const gs = verified.diagnostics && verified.diagnostics.goldStandard;
  if (!gs) return null;
  const stats = {
    mean: gs.mean,
    ci95halfWidth: gs.ci95halfWidth,
    successMean: gs.successMean,
    successRate: gs.successRate,
    deadRolloutCount: gs.deadRolloutCount,
    cappedRolloutCount: gs.cappedRolloutCount,
    budgetExceededRolloutCount: gs.budgetExceededRolloutCount,
    policyTableMisses: gs.policyTableMisses,
    rollouts: gs.rollouts,
  };
  stats.scriptWallMs = Date.now() - t0;
  return stats;
}

function fmt(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(d);
}

function pct(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

function evaluatePolicy(payload, policyFn, env) {
  const t0 = Date.now();
  const stats = worker.runPolicyMCEvaluationV3(payload, policyFn, {
    env,
    useCubeStepCosts: true,
  });
  stats.scriptWallMs = Date.now() - t0;
  return stats;
}

function printRow(label, stats) {
  console.log(
    `  ${label.padEnd(7)}` +
    ` mean=${fmt(stats.mean).padStart(8)} ±${fmt(stats.ci95halfWidth).padStart(6)}` +
    `  successMean=${fmt(stats.successMean).padStart(8)}` +
    `  success=${pct(stats.successRate).padStart(6)}` +
    `  dead=${String(stats.deadRolloutCount).padStart(3)}` +
    `  overBudget=${String(stats.budgetExceededRolloutCount).padStart(3)}` +
    `  capped=${String(stats.cappedRolloutCount).padStart(3)}` +
    `  wallMs=${String(stats.scriptWallMs).padStart(7)}`
  );
}

function verdict(lao, rules) {
  // Lexicographic objective: P(success) first, then steps. Step means are
  // only comparable when both policies succeed at (nearly) the same rate —
  // failed/stuck rollouts condition the means on different outcomes.
  const lines = [];
  const successGap = rules.successRate - lao.successRate;
  if (Math.abs(successGap) > 0.02) {
    if (successGap < 0) {
      lines.push(`success: RULES WORSE (${pct(rules.successRate)} vs ${pct(lao.successRate)})`);
    } else {
      lines.push(`success: rules better (${pct(rules.successRate)} vs ${pct(lao.successRate)})`);
    }
    lines.push("steps: not comparable (success rates differ; means condition on different outcomes)");
  } else {
    const laoLo = lao.mean - lao.ci95halfWidth;
    const laoHi = lao.mean + lao.ci95halfWidth;
    const rulesLo = rules.mean - rules.ci95halfWidth;
    const rulesHi = rules.mean + rules.ci95halfWidth;
    if (rulesLo > laoHi) {
      lines.push(`steps: RULES WORSE (CI-separated; +${fmt(rules.mean - lao.mean)} mean cube steps)`);
    } else if (rulesHi < laoLo) {
      lines.push(`steps: rules better (CI-separated; ${fmt(rules.mean - lao.mean)} mean cube steps)`);
    } else {
      lines.push("steps: tie (overlapping CIs)");
    }
  }
  if (rules.deadRolloutCount > lao.deadRolloutCount) {
    lines.push(`GA/dead: RULES WORSE (${rules.deadRolloutCount} vs ${lao.deadRolloutCount} dead rollouts)`);
  } else if (rules.deadRolloutCount < lao.deadRolloutCount) {
    lines.push(`GA/dead: rules better (${rules.deadRolloutCount} vs ${lao.deadRolloutCount} dead rollouts)`);
  }
  if (rules.budgetExceededRolloutCount !== lao.budgetExceededRolloutCount) {
    lines.push(`over budget: rules=${rules.budgetExceededRolloutCount} vs optimizer=${lao.budgetExceededRolloutCount}`);
  }
  if (rules.cappedRolloutCount !== lao.cappedRolloutCount) {
    lines.push(`capped: rules=${rules.cappedRolloutCount} vs lao=${lao.cappedRolloutCount}`);
  }
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  const rolloutsArg = args.find((a) => a.startsWith("--rollouts="));
  const maxStepsArg = args.find((a) => a.startsWith("--max-steps="));
  const filterArg = args.find((a) => a.startsWith("--scenario="));
  const rollouts = rolloutsArg ? Math.max(10, Number(rolloutsArg.split("=")[1]) || 0) : 400;
  const maxSteps = maxStepsArg
    ? worker.normalizeMaxStepsV3(Number(maxStepsArg.split("=")[1]))
    : worker.DEFAULT_MAX_STEPS;
  const filter = filterArg ? filterArg.split("=").slice(1).join("=").toLowerCase() : "";

  const regressions = [];

  for (const scenario of SCENARIOS) {
    if (filter && !scenario.name.toLowerCase().includes(filter)) continue;
    console.log("=".repeat(88));
    console.log(`${scenario.name}  (rollouts=${rollouts}, maxSteps=${maxSteps}, cube-step costing)`);
    console.log("=".repeat(88));

    const payload = makePayload(scenario, rollouts, maxSteps);
    const intermediate = worker.optimizePayloadV3(payload);
    let laoStats = null;
    if (!intermediate || !intermediate.action) {
      const residual = intermediate && intermediate.diagnostics && intermediate.diagnostics.residual;
      console.log(
        `  LAO* headline: NO ACTION (strategy=${intermediate && intermediate.diagnostics ? intermediate.diagnostics.strategy : "n/a"}` +
        `${residual && residual.status ? `, residual=${residual.status}` : ""}) — rules evaluated standalone.`
      );
    } else {
      console.log(
        `  LAO* headline: strategy=${intermediate.diagnostics.strategy},` +
        ` action=${JSON.stringify(intermediate.action)}, expectedSteps=${fmt(intermediate.expectedSteps)}`
      );
      laoStats = evaluateOptimizer(payload, intermediate);
    }

    const rulesPolicy = rulesSolver.createRulesPolicyV3(payload, helpers);
    const rootPick = rulesSolver.selectRulesActionV3(
      payload.state, payload.target, rulesPolicy.env, helpers
    );
    console.log(
      `  Rules headline: rule=${rootPick ? rootPick.ruleName : "(none)"},` +
      ` action=${JSON.stringify(rootPick ? rootPick.action : null)}`
    );
    const rulesStats = evaluatePolicy(payload, rulesPolicy, rulesPolicy.env);

    if (laoStats) printRow("LAO*", laoStats);
    printRow("rules", rulesStats);
    if (laoStats) {
      for (const line of verdict(laoStats, rulesStats)) {
        console.log(`  -> ${line}`);
        if (line.includes("RULES WORSE")) {
          regressions.push(`${scenario.name}: ${line}`);
        }
      }
    } else if (rulesStats.successRate > 0) {
      console.log(`  -> rules better: LAO* produced no policy; rules succeed in ${pct(rulesStats.successRate)} of rollouts.`);
    } else {
      console.log("  -> both stuck: LAO* produced no policy and rules never succeeded.");
    }
    console.log("");
  }

  console.log("=".repeat(88));
  if (regressions.length === 0) {
    console.log("No CI-separated rules regressions.");
  } else {
    console.log("Rules regressions:");
    for (const r of regressions) console.log(`  - ${r}`);
    process.exitCode = 1;
  }
}

main();
