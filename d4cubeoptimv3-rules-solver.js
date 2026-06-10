// ====================================================================
// d4cubeoptimv3-rules-solver.js — secondary, purely rules-based solver.
//
// An ordered list of plain-JS heuristic rules maps a concrete item state
// directly to the next cube/enchant action — no search, no value iteration.
// Evaluated against the LAO* optimizer with the shared Monte Carlo rollout
// engine (runPolicyMCEvaluationV3 in d4cubeoptimv3-worker.js).
//
// The module deliberately imports nothing: every worker helper it needs is
// dependency-injected through a `helpers` object (see REQUIRED_HELPERS).
// This keeps it loadable both via require() in Node and importScripts() in
// the browser worker without circular dependencies.
//
// GA handling keeps the model's hard constraints: every action the rules
// return comes from helpers.getValidActions(...) output, which already
// blocks anything that could lose a protected GA, enforces enchant
// legality, and applies the Adept focused-reroll lockout.
//
// ── Extending the rule set ──────────────────────────────────────────
// RULES_V3 is a plain array evaluated top-to-bottom; the first rule whose
// `when(ctx)` returns true AND whose `pick(ctx)` returns a valid action
// wins. To add a rule, push/splice an object:
//
//   {
//     name: "my-rule",
//     when(ctx) { return /* cheap predicate over ctx */; },
//     pick(ctx) { return /* an action from ctx.validActions, or null */; },
//   }
//
// `pick` may return null to fall through to later rules. Returned actions
// MUST be members of ctx.validActions (selectRulesActionV3 enforces this
// by actionKey and skips the rule otherwise). See buildRulesContext for
// everything available on ctx. Keep rules GENERAL — no affix-specific
// logic; route decisions through categories, weights, and slot classes.
// ====================================================================

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.d4cubeoptimRulesSolver = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Helper functions that must be injected from the v3 worker. */
  const REQUIRED_HELPERS = [
    "buildEnv",
    "getValidActions",
    "getActionOutcomes",
    "getEligibleByCategory",
    "getCategoryAffixesForState",
    "getCategoryWeightTotal",
    "getEffectiveAffixRollWeight",
    "buildFamilyCountsForPool",
    "isTerminal",
    "stateKey",
    "actionKey",
  ];

  function assertHelpers(helpers) {
    for (const name of REQUIRED_HELPERS) {
      if (!helpers || typeof helpers[name] !== "function") {
        throw new Error(`d4cubeoptimRulesSolver: missing helper "${name}"`);
      }
    }
  }

  function cloneStateShallow(state) {
    return {
      ...state,
      affixes: (state.affixes || []).map((entry) => ({ ...entry })),
    };
  }

  const CUBE_ACTION_TYPES = new Set(["add", "remove", "focused", "chaotic"]);

  // ──────────────────────────────────────────────────────────────────
  // Context
  // ──────────────────────────────────────────────────────────────────

  /**
   * Classify the state against the target and precompute the per-category /
   * per-target statistics the rules score with.
   *
   * Terms:
   *   matched  — slot holds a still-needed target affix (and it is not
   *              flagged unsatisfactory).
   *   junk     — slot affix is neither matched nor a protected GA.
   *   missing  — target affix not (satisfactorily) on the item; affixes in
   *              state.unsatisfactoryAffixIds count as missing.
   *
   * Routing: for each missing target, which categories can produce it via
   * add / focused, whether each focused route is SAFE (its eligible pool is
   * junk-only, so farming it cannot disturb wanted affixes), and whether it
   * is OPEN (fireable now) or SEEDABLE (pool empty; an add into the category
   * opens it). A target with no safe focused route is ADD-ONLY.
   */
  function buildRulesContext(state, target, env, helpers) {
    assertHelpers(helpers);

    const validActions = helpers.getValidActions(state, target, env) || [];
    const validActionKeys = new Map();
    for (const action of validActions) {
      validActionKeys.set(helpers.actionKey(action), action);
    }

    const targetCounts = Object.create(null);
    for (const entry of (target && Array.isArray(target.affixes)) ? target.affixes : []) {
      if (entry && entry.affixId) {
        targetCounts[entry.affixId] = (targetCounts[entry.affixId] || 0) + 1;
      }
    }

    const unsatisfactoryIds = new Set(
      Array.isArray(state.unsatisfactoryAffixIds) ? state.unsatisfactoryAffixIds : []
    );

    const gaRequiredCounts = env.gaRequiredCounts || {};
    const slots = (state.affixes || []).map((entry, index) => {
      const inTarget = (targetCounts[entry.affixId] || 0) > 0;
      const unsatisfactory = unsatisfactoryIds.has(entry.affixId);
      const matched = inTarget && !unsatisfactory;
      const protectedGA = !!entry.isGA && (gaRequiredCounts[entry.affixId] || 0) > 0;
      return {
        index,
        affixId: entry.affixId,
        isGA: !!entry.isGA,
        isEnchanted: !!entry.isEnchanted,
        matched,
        protectedGA,
        junk: !matched && !protectedGA,
      };
    });

    const enchantedIndex = slots.findIndex((slot) => slot.isEnchanted);
    const junkSlots = slots.filter((slot) => slot.junk);

    const presentCounts = Object.create(null);
    for (const slot of slots) {
      presentCounts[slot.affixId] = (presentCounts[slot.affixId] || 0) + 1;
    }

    // Missing target instances. An on-item copy flagged unsatisfactory does
    // not satisfy the target.
    const missingTargets = [];
    for (const [affixId, required] of Object.entries(targetCounts)) {
      const satisfactory = unsatisfactoryIds.has(affixId)
        ? 0
        : (presentCounts[affixId] || 0);
      for (let i = satisfactory; i < required; i++) {
        missingTargets.push(affixId);
      }
    }
    const missingIds = Array.from(new Set(missingTargets));

    const ctx = {
      state,
      target,
      env,
      helpers,
      validActions,
      validActionKeys,
      targetCounts,
      unsatisfactoryIds,
      slots,
      junkSlots,
      enchantedIndex,
      missingTargets,
      missingIds,
      _poolCache: new Map(),
      _eligibleCache: new Map(),
    };

    ctx.routes = computeRoutes(ctx);
    return ctx;
  }

  /** Result pool for (category, op): { list, total, familyCounts, weightById }. */
  function getOpPool(ctx, categoryName, op) {
    const key = `${categoryName}|${op}`;
    if (ctx._poolCache.has(key)) {
      return ctx._poolCache.get(key);
    }
    const { state, env, helpers } = ctx;
    const list = helpers.getCategoryAffixesForState(state, env, categoryName, op) || [];
    const total = helpers.getCategoryWeightTotal(state, env, categoryName, op) || 0;
    const familyCounts = helpers.buildFamilyCountsForPool(list);
    const weightById = new Map();
    for (const affix of list) {
      weightById.set(affix.id, helpers.getEffectiveAffixRollWeight(affix, familyCounts));
    }
    const pool = { list, total, familyCounts, weightById };
    ctx._poolCache.set(key, pool);
    return pool;
  }

  /** Eligible on-item sources for (category, op), with slot classification. */
  function getEligible(ctx, categoryName, op) {
    const key = `${categoryName}|${op}`;
    if (ctx._eligibleCache.has(key)) {
      return ctx._eligibleCache.get(key);
    }
    const raw = ctx.helpers.getEligibleByCategory(ctx.state, ctx.env, categoryName, op) || [];
    const eligible = raw.map(({ entry, index }) => ({ entry, index, slot: ctx.slots[index] }));
    ctx._eligibleCache.set(key, eligible);
    return eligible;
  }

  /** Share of the (category, op) result pool held by the given missing ids. */
  function missingWeightShare(ctx, categoryName, op, ids) {
    const pool = getOpPool(ctx, categoryName, op);
    if (pool.total <= 0) {
      return 0;
    }
    let weight = 0;
    for (const id of ids) {
      weight += pool.weightById.get(id) || 0;
    }
    return weight / pool.total;
  }

  /** True when farming focused(category) cannot disturb a wanted affix. */
  function isFocusedCategorySafe(ctx, categoryName) {
    return getEligible(ctx, categoryName, "focused").every(({ slot }) => slot && slot.junk);
  }

  /**
   * True when junk parked in this category is effectively permanent: Remove
   * is unusable (Legendary item, or a protected GA sits in the category's
   * remove pool) AND Chaotic is unusable for the same GA reason. Fishing a
   * polluted category accumulates junk that nothing can clear.
   *
   * `excludeIndex` evaluates pollution as if that slot were enchant-marked
   * (enchanted slots are invisible to cube pools).
   */
  function isCategoryPolluted(ctx, categoryName, excludeIndex) {
    const removeBlocked = ctx.state.isLegendary
      || getEligible(ctx, categoryName, "remove").some(({ slot, index }) => (
        index !== excludeIndex && slot && slot.protectedGA
      ));
    if (!removeBlocked) {
      return false;
    }
    const chaoticBlocked =
      getEligible(ctx, categoryName, "chaotic").some(({ slot, index }) => (
        index !== excludeIndex && slot && slot.protectedGA
      ));
    return chaoticBlocked;
  }

  function hasValidAction(ctx, action) {
    return ctx.validActionKeys.has(ctx.helpers.actionKey(action));
  }

  function getValidActionByShape(ctx, action) {
    return ctx.validActionKeys.get(ctx.helpers.actionKey(action)) || null;
  }

  function computeRoutes(ctx) {
    const routes = Object.create(null);
    for (const id of ctx.missingIds) {
      const addCategories = [];
      const focusedCategories = [];
      const safeFocusedCategories = [];

      // Routes describe POTENTIAL acquisition paths, not just this turn's
      // legal moves: an add route exists whenever the category's add pool
      // contains the target, even while the item is full (a removal frees
      // the slot later). Current-fullness gating belongs to the add rule.
      for (const categoryName of ctx.env.categoryNames) {
        if (getOpPool(ctx, categoryName, "add").weightById.has(id)) {
          addCategories.push(categoryName);
        }

        if (!getOpPool(ctx, categoryName, "focused").weightById.has(id)) {
          continue;
        }
        focusedCategories.push(categoryName);

        if (!isFocusedCategorySafe(ctx, categoryName)) {
          continue;
        }
        const eligible = getEligible(ctx, categoryName, "focused");
        const open = eligible.length > 0
          && hasValidAction(ctx, { type: "focused", prism: categoryName });
        // Seeding only helps when the pool is empty (a non-empty pool with no
        // valid focused action means the prism is blocked outright, e.g. the
        // Adept Mainstat lockout) and the category's add pool is non-empty.
        const seedable = eligible.length === 0
          && getOpPool(ctx, categoryName, "add").list.length > 0;
        if (open || seedable) {
          safeFocusedCategories.push(categoryName);
        }
      }

      routes[id] = {
        addCategories,
        focusedCategories,
        safeFocusedCategories,
        addOnly: safeFocusedCategories.length === 0,
      };
    }
    return routes;
  }

  /** Matched-target instance count for an arbitrary (successor) state. */
  function countMatchedTargets(ctx, state) {
    const present = Object.create(null);
    for (const entry of state.affixes || []) {
      if (entry && entry.affixId) {
        present[entry.affixId] = (present[entry.affixId] || 0) + 1;
      }
    }
    let matched = 0;
    for (const [affixId, required] of Object.entries(ctx.targetCounts)) {
      matched += Math.min(present[affixId] || 0, required);
    }
    return matched;
  }

  /** Deterministic comparison helpers: larger score first, then name order. */
  function pickBest(candidates, scoreFns) {
    let best = null;
    for (const candidate of candidates) {
      if (!best) { best = candidate; continue; }
      let decided = false;
      for (const fn of scoreFns) {
        const a = fn(candidate);
        const b = fn(best);
        if (a > b) { best = candidate; decided = true; break; }
        if (a < b) { decided = true; break; }
      }
      if (!decided && candidate.name < best.name) {
        best = candidate;
      }
    }
    return best;
  }

  // ──────────────────────────────────────────────────────────────────
  // Rules (ordered, first match wins)
  // ──────────────────────────────────────────────────────────────────

  const RULES_V3 = [
    {
      // Exactly one target missing and an enchant sets it directly: the
      // sticky enchant is reserved precisely for this finisher (plus the
      // GA-preserve mark below). Deterministic, ~0 cost, terminal next.
      name: "finisher-enchant",
      when(ctx) {
        return ctx.missingTargets.length === 1;
      },
      pick(ctx) {
        const missingId = ctx.missingTargets[0];
        const candidates = ctx.validActions.filter((action) => (
          action.type === "enchant" && action.targetAffixId === missingId
        ));
        if (candidates.length === 0) {
          return null;
        }
        // Prefer the existing enchanted slot (the only legal source once one
        // exists); otherwise the lowest junk source index for determinism.
        candidates.sort((a, b) => a.sourceIndex - b.sourceIndex);
        const fromEnchanted = candidates.find((a) => a.sourceIndex === ctx.enchantedIndex);
        return fromEnchanted || candidates[0];
      },
    },

    {
      // Rescue enchant: some missing target has no sane stochastic route —
      // it is enchant-only (no add category at all), or it is add-only and
      // every add category for it is polluted (junk landed while fishing
      // could never be cleared because a protected GA blocks the category's
      // remove/chaotic pools).
      //
      // The single sticky enchant is allocated by what it is worth most for:
      //   1. An enchant-only target — nothing else can ever produce it, so
      //      the enchant is already spoken for.
      //   2. When TWO OR MORE targets are pollution-blocked and a same-affix
      //      enchant-mark of the polluting protected GA would unblock at
      //      least two of them, mark the GA instead: enchanted slots are
      //      invisible to cube pools, so one mark unpollutes the categories
      //      for every blocked target, where a rescue saves only one.
      //   3. Otherwise rescue the single most-blocked target directly.
      // With one missing target the finisher above already covers it.
      name: "rescue-enchant",
      when(ctx) {
        return ctx.missingTargets.length >= 2;
      },
      pick(ctx) {
        const enchantOnlyIds = [];
        const pollutedIds = [];
        for (const id of ctx.missingIds) {
          const route = ctx.routes[id];
          if (!route.addOnly) {
            continue;
          }
          if (route.addCategories.length === 0) {
            enchantOnlyIds.push(id);
          } else if (route.addCategories.every((name) => isCategoryPolluted(ctx, name))) {
            pollutedIds.push(id);
          }
        }
        if (enchantOnlyIds.length === 0 && pollutedIds.length === 0) {
          return null;
        }

        const rescueAction = (ids) => {
          // Hardest target first: lowest total add-pool share, then id.
          const ordered = ids
            .map((id) => ({
              id,
              share: ctx.routes[id].addCategories.reduce(
                (sum, name) => sum + missingWeightShare(ctx, name, "add", [id]), 0
              ),
            }))
            .sort((a, b) => a.share - b.share || (a.id < b.id ? -1 : 1));
          for (const { id } of ordered) {
            const candidates = ctx.validActions.filter((action) => (
              action.type === "enchant" && action.targetAffixId === id
            ));
            if (candidates.length === 0) {
              continue;
            }
            candidates.sort((a, b) => a.sourceIndex - b.sourceIndex);
            const fromEnchanted = candidates.find((a) => a.sourceIndex === ctx.enchantedIndex);
            return fromEnchanted || candidates[0];
          }
          return null;
        };

        // 1. Enchant-only targets own the enchant outright (a GA mark would
        //    make them permanently unreachable).
        if (enchantOnlyIds.length > 0) {
          return rescueAction(enchantOnlyIds);
        }

        // 2. GA mark when it unblocks more targets than a rescue would save.
        let bestMark = null;
        if (ctx.enchantedIndex < 0) {
          for (const slot of ctx.slots) {
            if (!slot.protectedGA || slot.isEnchanted) {
              continue;
            }
            const markAction = getValidActionByShape(ctx, {
              type: "enchant",
              sourceIndex: slot.index,
              targetAffixId: slot.affixId,
            });
            if (!markAction) {
              continue;
            }
            const unblocked = pollutedIds.filter((id) => (
              ctx.routes[id].addCategories.some(
                (name) => !isCategoryPolluted(ctx, name, slot.index)
              )
            )).length;
            if (!bestMark || unblocked > bestMark.unblocked) {
              bestMark = { action: markAction, unblocked };
            }
          }
        }
        if (bestMark && bestMark.unblocked >= 2) {
          return bestMark.action;
        }

        // 3. Direct rescue; fall back to a partially-unblocking mark when no
        //    rescue enchant is legal for any blocked target.
        const rescue = rescueAction(pollutedIds);
        if (rescue) {
          return rescue;
        }
        return bestMark && bestMark.unblocked >= 1 ? bestMark.action : null;
      },
    },

    {
      // Routing-aware add. Tier 1: targets with no safe focused route get
      // first claim on free slots (their adds are the only safe way in).
      // Tier 2: fish/seed the safe focused category with the most missing-
      // target weight — even a junk landing opens a safe focused farm.
      name: "routing-add",
      when(ctx) {
        return ctx.state.affixes.length < 4 && ctx.missingTargets.length > 0;
      },
      pick(ctx) {
        const addOnlyIds = ctx.missingIds.filter((id) => ctx.routes[id].addOnly);

        // Tier 1 — add-only targets.
        const tier1Categories = new Set();
        for (const id of addOnlyIds) {
          for (const categoryName of ctx.routes[id].addCategories) {
            tier1Categories.add(categoryName);
          }
        }
        const tier1 = Array.from(tier1Categories)
          .map((name) => ({
            name,
            share: missingWeightShare(ctx, name, "add", addOnlyIds),
          }))
          .filter((candidate) => candidate.share > 0);
        if (tier1.length > 0) {
          const best = pickBest(tier1, [(c) => c.share]);
          return getValidActionByShape(ctx, { type: "add", prism: best.name });
        }

        // Tier 2 — safe focused farms (open or seedable).
        const tier2Categories = new Set();
        for (const id of ctx.missingIds) {
          for (const categoryName of ctx.routes[id].safeFocusedCategories) {
            tier2Categories.add(categoryName);
          }
        }
        const tier2 = Array.from(tier2Categories)
          .filter((name) => hasValidAction(ctx, { type: "add", prism: name }))
          .map((name) => ({
            name,
            addShare: missingWeightShare(ctx, name, "add", ctx.missingIds),
            farmShare: missingWeightShare(ctx, name, "focused", ctx.missingIds),
          }));
        if (tier2.length > 0) {
          const best = pickBest(tier2, [(c) => c.addShare, (c) => c.farmShare]);
          return getValidActionByShape(ctx, { type: "add", prism: best.name });
        }

        // Fallback — plain best direct-hit add.
        const plain = ctx.env.categoryNames
          .filter((name) => hasValidAction(ctx, { type: "add", prism: name }))
          .map((name) => ({
            name,
            share: missingWeightShare(ctx, name, "add", ctx.missingIds),
          }))
          .filter((candidate) => candidate.share > 0);
        if (plain.length > 0) {
          const best = pickBest(plain, [(c) => c.share]);
          return getValidActionByShape(ctx, { type: "add", prism: best.name });
        }
        return null;
      },
    },

    {
      // Safe focused reroll: farm an open junk-only prism that can land a
      // missing target. Closes automatically once a wanted affix lands in
      // the category (the pool stops being junk-only).
      name: "safe-focused",
      when(ctx) {
        return ctx.missingTargets.length > 0;
      },
      pick(ctx) {
        const candidates = ctx.env.categoryNames
          .filter((name) => (
            hasValidAction(ctx, { type: "focused", prism: name })
            && isFocusedCategorySafe(ctx, name)
            && getEligible(ctx, name, "focused").length > 0
          ))
          .map((name) => ({
            name,
            share: missingWeightShare(ctx, name, "focused", ctx.missingIds),
            eligibleCount: getEligible(ctx, name, "focused").length,
          }))
          .filter((candidate) => candidate.share > 0);
        if (candidates.length === 0) {
          return null;
        }
        const best = pickBest(candidates, [(c) => c.share / c.eligibleCount]);
        return getValidActionByShape(ctx, { type: "focused", prism: best.name });
      },
    },

    {
      // Item full and a prism can remove junk DETERMINISTICALLY (its eligible
      // pool is 100% junk); routing-add then re-fires on the freed slot.
      // Remove + steered add beats chaotic whenever Remove exists (chaotic's
      // add-side draws from a random category in this model).
      name: "targeted-remove",
      when(ctx) {
        return ctx.state.affixes.length >= 4
          && ctx.missingTargets.length > 0
          && ctx.junkSlots.length > 0
          && !ctx.state.isLegendary;
      },
      pick(ctx) {
        const candidates = ctx.env.categoryNames
          .filter((name) => hasValidAction(ctx, { type: "remove", prism: name }))
          .map((name) => {
            const eligible = getEligible(ctx, name, "remove");
            const junkCount = eligible.filter(({ slot }) => slot && slot.junk).length;
            return {
              name,
              junkFraction: eligible.length > 0 ? junkCount / eligible.length : 0,
              eligibleCount: eligible.length,
            };
          })
          .filter((candidate) => candidate.junkFraction === 1);
        if (candidates.length === 0) {
          return null;
        }
        const best = pickBest(candidates, [(c) => -c.eligibleCount]);
        return getValidActionByShape(ctx, { type: "remove", prism: best.name });
      },
    },

    {
      // Risky focused reroll: a junk affix shares a focused category with a
      // missing target, but a matched (non-GA — getValidActions guarantees
      // protected GAs never appear in these pools) affix shares the pool.
      // Compared with the risky-remove alternative the collateral odds are
      // the same, but the steered add-side can land the target every step —
      // so this dominates remove+add whenever no deterministic remove exists.
      // If the reroll does knock out a matched affix, the pool usually turns
      // junk-only and safe-focused takes over to farm both back.
      name: "risky-focused",
      when(ctx) {
        return ctx.missingTargets.length > 0 && ctx.junkSlots.length > 0;
      },
      pick(ctx) {
        const candidates = ctx.env.categoryNames
          .filter((name) => hasValidAction(ctx, { type: "focused", prism: name }))
          .map((name) => {
            const eligible = getEligible(ctx, name, "focused");
            const junkCount = eligible.filter(({ slot }) => slot && slot.junk).length;
            return {
              name,
              junkCount,
              junkFraction: eligible.length > 0 ? junkCount / eligible.length : 0,
              eligibleCount: eligible.length,
              share: missingWeightShare(ctx, name, "focused", ctx.missingIds),
            };
          })
          .filter((candidate) => candidate.share > 0 && candidate.junkCount > 0);
        if (candidates.length === 0) {
          return null;
        }
        const best = pickBest(candidates, [
          (c) => c.junkFraction,
          (c) => c.share / c.eligibleCount,
        ]);
        return getValidActionByShape(ctx, { type: "focused", prism: best.name });
      },
    },

    {
      // Risky remove: junk must go but every junk-bearing prism also exposes
      // a matched (non-GA) affix to the uniform removal. Last resort before
      // chaotic; a lost matched affix costs steps, not the run.
      name: "risky-remove",
      when(ctx) {
        return ctx.state.affixes.length >= 4
          && ctx.missingTargets.length > 0
          && ctx.junkSlots.length > 0
          && !ctx.state.isLegendary;
      },
      pick(ctx) {
        const candidates = ctx.env.categoryNames
          .filter((name) => hasValidAction(ctx, { type: "remove", prism: name }))
          .map((name) => {
            const eligible = getEligible(ctx, name, "remove");
            const junkCount = eligible.filter(({ slot }) => slot && slot.junk).length;
            return {
              name,
              junkFraction: eligible.length > 0 ? junkCount / eligible.length : 0,
              eligibleCount: eligible.length,
            };
          })
          .filter((candidate) => candidate.junkFraction > 0);
        if (candidates.length === 0) {
          return null;
        }
        const best = pickBest(candidates, [
          (c) => c.junkFraction,
          (c) => -c.eligibleCount,
        ]);
        return getValidActionByShape(ctx, { type: "remove", prism: best.name });
      },
    },

    {
      // Chaotic fallback: junk must go but Remove is unavailable (Legendary
      // item, or every junk-bearing remove prism is GA-blocked). Narrow the
      // random removal to junk with the prism choice; the add-side is a
      // random category either way.
      name: "chaotic-fallback",
      when(ctx) {
        return ctx.state.affixes.length >= 4
          && ctx.missingTargets.length > 0
          && ctx.junkSlots.length > 0;
      },
      pick(ctx) {
        const candidates = ctx.env.categoryNames
          .filter((name) => hasValidAction(ctx, { type: "chaotic", prism: name }))
          .map((name) => {
            const eligible = getEligible(ctx, name, "chaotic");
            const junkCount = eligible.filter(({ slot }) => slot && slot.junk).length;
            return {
              name,
              junkFraction: eligible.length > 0 ? junkCount / eligible.length : 0,
              eligibleCount: eligible.length,
            };
          })
          .filter((candidate) => candidate.junkFraction > 0);
        if (candidates.length === 0) {
          return null;
        }
        const best = pickBest(candidates, [
          (c) => c.junkFraction,
          (c) => -c.eligibleCount,
        ]);
        return getValidActionByShape(ctx, { type: "chaotic", prism: best.name });
      },
    },

    {
      // GA-preserve enchant-mark: a protected GA is blocking the prisms we
      // need (nothing above fired). A same-affix enchant locks the GA slot
      // (cube ops skip enchanted slots), unblocking its category. This is
      // the sanctioned GA-preservation use of the sticky enchant; with one
      // missing target the finisher wins instead.
      name: "ga-preserve-enchant-mark",
      when(ctx) {
        return ctx.enchantedIndex < 0 && ctx.missingTargets.length >= 2;
      },
      pick(ctx) {
        for (const slot of ctx.slots) {
          if (!slot.protectedGA || slot.isEnchanted) {
            continue;
          }
          const action = getValidActionByShape(ctx, {
            type: "enchant",
            sourceIndex: slot.index,
            targetAffixId: slot.affixId,
          });
          if (!action) {
            continue;
          }
          // Only spend the mark when it actually unblocks a cube action.
          const hypothetical = cloneStateShallow(ctx.state);
          hypothetical.affixes[slot.index].isEnchanted = true;
          const beforeKeys = new Set(
            ctx.validActions
              .filter((a) => CUBE_ACTION_TYPES.has(a.type))
              .map((a) => ctx.helpers.actionKey(a))
          );
          const after = ctx.helpers.getValidActions(hypothetical, ctx.target, ctx.env) || [];
          const unblocks = after.some((a) => (
            CUBE_ACTION_TYPES.has(a.type) && !beforeKeys.has(ctx.helpers.actionKey(a))
          ));
          if (unblocks) {
            return action;
          }
        }
        return null;
      },
    },

    {
      // Greedy totality fallback: maximize the one-step probability of
      // increasing the matched-target count. Enchants are excluded (they are
      // reserved for the finisher / GA mark) unless nothing else exists.
      name: "greedy-fallback",
      when() {
        return true;
      },
      pick(ctx) {
        let candidates = ctx.validActions.filter((action) => action.type !== "enchant");
        if (candidates.length === 0) {
          candidates = ctx.validActions;
        }
        if (candidates.length === 0) {
          return null;
        }
        const baseMatched = countMatchedTargets(ctx, ctx.state);
        let best = null;
        let bestScore = -1;
        let bestKey = "";
        for (const action of candidates) {
          const outcomes = ctx.helpers.getActionOutcomes(ctx.state, action, ctx.env) || [];
          if (outcomes.length === 0) {
            continue;
          }
          let score = 0;
          for (const outcome of outcomes) {
            if (countMatchedTargets(ctx, outcome.state) > baseMatched) {
              score += outcome.probability;
            }
          }
          const key = ctx.helpers.actionKey(action);
          if (score > bestScore || (score === bestScore && key < bestKey)) {
            best = action;
            bestScore = score;
            bestKey = key;
          }
        }
        return best;
      },
    },
  ];

  // ──────────────────────────────────────────────────────────────────
  // Selection / policy
  // ──────────────────────────────────────────────────────────────────

  /**
   * Run the rule list against a concrete state.
   *
   * @returns {{ action: Object, ruleName: string } | null} The chosen action
   *   (always a member of getValidActions output) and the rule that fired,
   *   or null when the state has no valid actions / no rule applies.
   */
  function selectRulesActionV3(state, target, env, helpers, rules) {
    const ctx = buildRulesContext(state, target, env, helpers);
    if (ctx.validActions.length === 0) {
      return null;
    }
    for (const rule of (rules || RULES_V3)) {
      if (!rule.when(ctx)) {
        continue;
      }
      const action = rule.pick(ctx);
      if (!action) {
        continue;
      }
      // Invariant: only ever return actions the model considers valid.
      const valid = ctx.validActionKeys.get(helpers.actionKey(action));
      if (valid) {
        return { action: valid, ruleName: rule.name };
      }
    }
    return null;
  }

  /**
   * Build a memoized `policyFn(state) -> action|null` for the MC rollout
   * engine (runPolicyMCEvaluationV3). Also records the rule that fired per
   * state key on `policyFn.ruleNames` for diagnostics.
   */
  function createRulesPolicyV3(payload, helpers, rules) {
    assertHelpers(helpers);
    const env = helpers.buildEnv(payload.data || {}, payload.gaConfig || {}, payload.target || {});
    const cache = new Map();
    const ruleNames = new Map();
    // The worker's stateKey omits unsatisfactory markers; include them here so
    // marker-bearing and cleared states never share a memo entry.
    const memoKey = (state) => helpers.stateKey(state) + "#U" + (
      Array.isArray(state.unsatisfactoryAffixIds)
        ? state.unsatisfactoryAffixIds.slice().sort().join(",")
        : ""
    );
    const policyFn = (state) => {
      const key = memoKey(state);
      if (cache.has(key)) {
        return cache.get(key);
      }
      const result = selectRulesActionV3(state, payload.target, env, helpers, rules);
      cache.set(key, result ? result.action : null);
      ruleNames.set(key, result ? result.ruleName : null);
      return cache.get(key);
    };
    policyFn.env = env;
    policyFn.ruleNames = ruleNames;
    return policyFn;
  }

  return {
    REQUIRED_HELPERS,
    RULES_V3,
    buildRulesContext,
    selectRulesActionV3,
    createRulesPolicyV3,
  };
});
