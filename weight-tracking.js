(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
  root.d4cubeoptimWeightTracking = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ─────────────────────────────────────────────────────────────────────────
  // Outcome tracking + Bayesian weight learning.
  //
  // Single source of truth for the affix-roll weight model, shared by the
  // browser (live tracking + export, via <script src>) and Node (the learning
  // script + tests, via require). Catalog-based — no worker dependency — so both
  // sides agree by construction. The model is Plackett–Luce / conditional-logit
  // (the cube's eligible pool varies per draw), estimated by the MM/Zermelo
  // update with a Gamma prior whose mode sits at the current baseline weight:
  //
  //   W_u  ←  (a_u − 1 + wins_u) / (b_u + exposure_u)
  //   exposure_u = Σ_{t : u ∈ S_t}  1 / (Σ_{v ∈ S_t} poolWeight_v)
  //
  // with  b_u = κ ,  a_u − 1 = κ·W⁰_u  (so prior mode = baseline W⁰_u).
  //
  // "wins" and "exposure computed under the FIXED baseline weights" are purely
  // additive across draws and across exports, so the browser maintains them
  // incrementally and merging is trivial; that additive form is the one-shot
  // (single-iteration) estimate. The Node script can iterate to convergence
  // (recomputing exposure with the current iterate) for a tighter result.
  // ─────────────────────────────────────────────────────────────────────────

  // Weak default: pseudo-exposure κ. Exposure accrues ≈ 1/P per eligible draw
  // (P = pool weight ≈ 5–50), so κ = 0.5 makes the baseline worth only a few
  // real draws — data dominates quickly. Tunable via the script's
  // --prior-strength flag.
  const PRIOR_STRENGTH_DEFAULT = 0.5;

  // ── Learning units ─────────────────────────────────────────────────────────
  // Each affix maps to exactly one "learning unit" that carries one tied weight:
  //   - "single"      : a plain affix (no family). Weight is its rollWeight.
  //   - "family"      : a familyRollWeight family (skills, skill-multipliers).
  //                     Weight is the family TOTAL (familyRollWeight). The family
  //                     contributes exactly this total to any pool regardless of
  //                     how many members are eligible, split uniformly. Skill
  //                     families are pooled across classes (one weight for all).
  //   - "tiedSubtype" : elemental-damage / specific-resistance. Each of the N
  //                     subtypes carries an equal per-member rollWeight, so the
  //                     family contributes N · perMember and stays uniform within
  //                     (fire = physical). The learned unit weight is the family
  //                     TOTAL; per-member = total / N.
  function learningUnitForAffix(affix) {
    if (!affix) {
      return null;
    }
    const family = affix.family ? String(affix.family) : "";
    const frw = Number(affix.familyRollWeight);
    if (family && Number.isFinite(frw) && frw > 0) {
      return { key: "family:" + family, kind: "family", family };
    }
    if (family) {
      return { key: "tied:" + family, kind: "tiedSubtype", family };
    }
    return { key: "affix:" + affix.id, kind: "single", family: "" };
  }

  // Index the catalog for fast lookup. `catalog` is { affixes: [...] } or an
  // array of affix entries. Each entry: { id, name, categories, gearSlots,
  // family, rollWeight, familyRollWeight?, class?, operationCategories? }.
  function indexCatalog(catalog) {
    const affixes = Array.isArray(catalog) ? catalog : (catalog && catalog.affixes) || [];
    const byId = Object.create(null);
    const familyTotalMembers = Object.create(null);
    for (const affix of affixes) {
      if (!affix || !affix.id) {
        continue;
      }
      byId[affix.id] = affix;
      const fam = affix.family ? String(affix.family) : "";
      if (fam) {
        familyTotalMembers[fam] = (familyTotalMembers[fam] || 0) + 1;
      }
    }
    return { affixes, byId, familyTotalMembers };
  }

  function totalMembersForFamily(index, family) {
    return index.familyTotalMembers[family] || 0;
  }

  function positiveOr1(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function firstFamilyMember(index, family) {
    for (const affix of index.affixes) {
      if (affix && affix.family === family) {
        return affix;
      }
    }
    return null;
  }

  // The unit's current TOTAL effective weight (W⁰_u) as encoded by the catalog —
  // i.e. the present baseline the prior is anchored to. With a pristine catalog
  // (every rollWeight = 1, familyRollWeight = 1) this is 1 for single/family and
  // the member count for a tied subtype; once LEARNED_WEIGHTS have been applied
  // it reflects the learned totals, so repeated learning rounds refine on top of
  // the prior baseline rather than resetting to 1.
  function unitTotalWeightFromCatalog(index, unitKey) {
    // Tolerate being handed a catalog wrapper ({ affixes, __wtIndex }) instead of
    // a built index.
    if (index && !index.byId) {
      index = index.__wtIndex || indexCatalog(index);
    }
    const unit = unitFromKey(unitKey);
    if (unit.kind === "single") {
      const id = unitKey.slice("affix:".length);
      return positiveOr1(index.byId[id] && index.byId[id].rollWeight);
    }
    if (unit.kind === "family") {
      const member = firstFamilyMember(index, unit.family);
      return positiveOr1(member && member.familyRollWeight);
    }
    // tiedSubtype: family total = sum of member per-member rollWeights.
    let total = 0;
    for (const affix of index.affixes) {
      if (affix && affix.family === unit.family) {
        total += positiveOr1(affix.rollWeight);
      }
    }
    return total || 1;
  }

  // Back-compat alias: the unit's baseline total weight from the catalog.
  function baselineUnitWeight(unit, index) {
    if (!unit) {
      return 1;
    }
    const key = unit.key || (unit.kind === "single" ? null : (unit.kind === "family" ? "family:" + unit.family : "tied:" + unit.family));
    if (!key) {
      return 1;
    }
    return unitTotalWeightFromCatalog(index, key);
  }

  // Categories an affix belongs to under a given operation (mirrors the worker's
  // getAffixCategoriesForOp: operationCategories override, else default).
  function categoriesForOp(affix, op) {
    if (affix && op && affix.operationCategories && Array.isArray(affix.operationCategories[op])) {
      return affix.operationCategories[op];
    }
    return affix && Array.isArray(affix.categories) ? affix.categories : [];
  }

  function affixSupportsSlot(affix, gearSlot) {
    // "Any" is the default/unspecified slot: the worker applies NO slot narrowing
    // (it uses the full category pool), so every affix is eligible.
    if (!gearSlot || gearSlot === "Any") {
      return true;
    }
    const slots = affix && affix.gearSlots;
    if (!Array.isArray(slots) || slots.length === 0) {
      return true; // null / empty == any slot
    }
    return slots.includes("Any") || slots.includes(gearSlot);
  }

  function affixSupportsClass(affix, className) {
    if (!className || className === "Any") {
      return true;
    }
    const c = affix && affix.class;
    return !c || c === "Any" || c === className;
  }

  // The pool of affixes eligible as the DESTINATION of a within-category draw,
  // mirroring the worker's getCategoryAffixesForState + the family-uniqueness
  // exclusion applied in getActionOutcomes.
  //
  //   beforeItem : { gearSlot, class, affixes: [{affixId, isGA, isEnchanted}] }
  //   op         : "add" | "focused" | "chaotic"
  //   category   : the prism/destination category
  //   sourceIndex: slot being rerolled (focused/chaotic); null for add
  function eligibleDestinationAffixes(beforeItem, op, category, sourceIndex, index) {
    const gearSlot = beforeItem.gearSlot || "Any";
    const className = beforeItem.class || "Any";

    // Families present on the OTHER affixes (the source slot is replaced for
    // focused/chaotic, so its family does not block the destination).
    const presentFamilies = new Set();
    (beforeItem.affixes || []).forEach((entry, idx) => {
      if (sourceIndex != null && idx === sourceIndex) {
        return;
      }
      const a = entry && entry.affixId ? index.byId[entry.affixId] : null;
      if (a && a.family) {
        presentFamilies.add(String(a.family));
      }
    });

    const out = [];
    for (const affix of index.affixes) {
      if (!categoriesForOp(affix, op).includes(category)) {
        continue;
      }
      if (!affixSupportsSlot(affix, gearSlot) || !affixSupportsClass(affix, className)) {
        continue;
      }
      // Family-uniqueness: a destination whose family already sits on another
      // (non-source) slot is excluded (matches violatesFamilyUniqueness).
      if (affix.family && presentFamilies.has(String(affix.family))) {
        continue;
      }
      out.push(affix);
    }
    return out;
  }

  // Group an affix list into learning units, recording how many members of each
  // unit are eligible in this pool (inPoolCount).
  function unitsFromAffixList(affixes, index) {
    const map = new Map();
    for (const affix of affixes) {
      const unit = learningUnitForAffix(affix);
      if (!unit) {
        continue;
      }
      let entry = map.get(unit.key);
      if (!entry) {
        entry = {
          key: unit.key,
          kind: unit.kind,
          family: unit.family,
          inPoolCount: 0,
          totalMembers: unit.kind === "tiedSubtype" ? totalMembersForFamily(index, unit.family) : 0,
        };
        map.set(unit.key, entry);
      }
      entry.inPoolCount += 1;
    }
    return Array.from(map.values());
  }

  // Resolve the within-category draw's destination category.
  //   add / focused : the prism category.
  //   chaotic       : the category the RESULT landed in (category is chosen
  //                   uniformly, independent of weights, so condition on it).
  //                   Ambiguous only if the result affix is eligible in more
  //                   than one category under "chaotic".
  function resolveDrawCategory(op, prism, resultAffix, beforeItem, index, sourceIndex) {
    if (op === "add" || op === "focused") {
      return { ok: true, category: prism };
    }
    if (op === "chaotic") {
      const cats = categoriesForOp(resultAffix, "chaotic").filter((cat) => {
        // The category must actually be able to produce this affix for this
        // slot/class (it always can if the affix lists it, given slot/class ok).
        return affixSupportsSlot(resultAffix, beforeItem.gearSlot || "Any")
          && affixSupportsClass(resultAffix, beforeItem.class || "Any");
      });
      if (cats.length === 1) {
        return { ok: true, category: cats[0] };
      }
      if (cats.length === 0) {
        return { ok: false, reason: "chaotic result has no eligible category" };
      }
      return { ok: false, reason: "chaotic result is ambiguous across categories: " + cats.join(",") };
    }
    return { ok: false, reason: "non-informative op: " + op };
  }

  // Compute one draw's contribution to the statistics.
  //
  // Returns { informative:false, reason } for remove/enchant or unresolvable
  // chaotic results, else:
  //   { informative:true, category, winner:<unitKey>,
  //     eligibleUnits:[{ key, kind, inPoolCount, totalMembers }] }
  function computeDrawContribution(beforeItem, op, prism, resultAffixId, catalog) {
    if (op === "remove" || op === "enchant") {
      return { informative: false, reason: "non-informative op: " + op };
    }
    const index = catalog && catalog.__wtIndex ? catalog.__wtIndex : indexCatalog(catalog);
    const resultAffix = resultAffixId ? index.byId[resultAffixId] : null;
    if (!resultAffix) {
      return { informative: false, reason: "unknown result affix: " + resultAffixId };
    }

    const sourceIndex = (op === "focused" || op === "chaotic")
      ? (Number.isInteger(beforeItem.sourceIndex) ? beforeItem.sourceIndex : null)
      : null;

    const resolved = resolveDrawCategory(op, prism, resultAffix, beforeItem, index, sourceIndex);
    if (!resolved.ok) {
      return { informative: false, reason: resolved.reason };
    }

    const pool = eligibleDestinationAffixes(beforeItem, op, resolved.category, sourceIndex, index);
    if (pool.length === 0) {
      return { informative: false, reason: "empty eligible pool" };
    }

    const eligibleUnits = unitsFromAffixList(pool, index);
    const winnerUnit = learningUnitForAffix(resultAffix);
    if (!winnerUnit || !eligibleUnits.some((u) => u.key === winnerUnit.key)) {
      // The recorded result is not in the reconstructed pool — pool mismatch
      // (e.g. stale catalog). Skip rather than corrupt the stats.
      return { informative: false, reason: "result not in eligible pool: " + resultAffixId };
    }

    return {
      informative: true,
      category: resolved.category,
      winner: winnerUnit.key,
      eligibleUnits,
    };
  }

  // Effective pool weight of a unit given a unit→weight map W (falls back to
  // baseline). single/family → W_u. tiedSubtype → inPoolCount · W_u/totalMembers.
  function unitPoolWeight(unitEntry, W, index) {
    const w = W && Number.isFinite(W[unitEntry.key])
      ? W[unitEntry.key]
      : unitTotalWeightFromCatalog(index, unitEntry.key);
    if (unitEntry.kind === "tiedSubtype") {
      const total = unitEntry.totalMembers || totalMembersForFamily(index, unitEntry.family) || 1;
      return (unitEntry.inPoolCount * w) / total;
    }
    return w;
  }

  // Add a draw's contribution to additive baseline stats:
  //   stats[unitKey] = { wins, exposure }   (exposure under the FIXED baseline)
  function accumulateStats(stats, contribution, catalog) {
    if (!contribution || !contribution.informative) {
      return stats;
    }
    const index = catalog && catalog.__wtIndex ? catalog.__wtIndex : indexCatalog(catalog);
    let poolTotal = 0;
    for (const u of contribution.eligibleUnits) {
      poolTotal += unitPoolWeight(u, null, index); // null W => baseline
    }
    if (!(poolTotal > 0)) {
      return stats;
    }
    for (const u of contribution.eligibleUnits) {
      const s = stats[u.key] || (stats[u.key] = { wins: 0, exposure: 0 });
      s.exposure += 1 / poolTotal;
    }
    const ws = stats[contribution.winner] || (stats[contribution.winner] = { wins: 0, exposure: 0 });
    ws.wins += 1;
    return stats;
  }

  // Additive merge of two stats maps (same baseline / modelVersion required).
  function mergeStats(a, b) {
    const out = Object.create(null);
    for (const src of [a || {}, b || {}]) {
      for (const key of Object.keys(src)) {
        const s = out[key] || (out[key] = { wins: 0, exposure: 0 });
        s.wins += Number(src[key].wins) || 0;
        s.exposure += Number(src[key].exposure) || 0;
      }
    }
    return out;
  }

  // One-shot weights from additive baseline stats (== a single MM iteration).
  // Returns { unitWeights: {key: W_u}, units: {key: {kind, family, baseline, W, wins, exposure}} }.
  function deriveWeights(stats, catalog, opts) {
    const index = catalog && catalog.__wtIndex ? catalog.__wtIndex : indexCatalog(catalog);
    const kappa = opts && Number.isFinite(opts.priorStrength) ? opts.priorStrength : PRIOR_STRENGTH_DEFAULT;
    const unitWeights = Object.create(null);
    const units = Object.create(null);
    for (const key of Object.keys(stats || {})) {
      const unit = unitFromKey(key);
      const w0 = baselineUnitWeight(unit, index);
      const wins = Number(stats[key].wins) || 0;
      const exposure = Number(stats[key].exposure) || 0;
      const W = (kappa * w0 + wins) / (kappa + exposure);
      unitWeights[key] = W;
      units[key] = { kind: unit.kind, family: unit.family, baseline: w0, W, wins, exposure };
    }
    return { unitWeights, units, priorStrength: kappa };
  }

  // Iterate the MM update to convergence over precomputed contributions.
  // `contributions` = array of computeDrawContribution results (informative).
  function iterateWeights(contributions, catalog, opts) {
    const index = catalog && catalog.__wtIndex ? catalog.__wtIndex : indexCatalog(catalog);
    const kappa = opts && Number.isFinite(opts.priorStrength) ? opts.priorStrength : PRIOR_STRENGTH_DEFAULT;
    const maxIters = opts && Number.isFinite(opts.maxIters) ? opts.maxIters : 200;
    const tol = opts && Number.isFinite(opts.tol) ? opts.tol : 1e-9;

    // Wins are constant across iterations; precompute. Also collect every unit
    // key that appears, with its baseline.
    const wins = Object.create(null);
    const baseline = Object.create(null);
    const informative = contributions.filter((c) => c && c.informative);
    for (const c of informative) {
      for (const u of c.eligibleUnits) {
        if (baseline[u.key] === undefined) {
          baseline[u.key] = unitTotalWeightFromCatalog(index, u.key);
        }
      }
      wins[c.winner] = (wins[c.winner] || 0) + 1;
    }

    // Initialise W at baseline.
    let W = Object.create(null);
    for (const key of Object.keys(baseline)) {
      W[key] = baseline[key];
    }

    let iters = 0;
    for (; iters < maxIters; iters++) {
      const exposure = Object.create(null);
      for (const c of informative) {
        let poolTotal = 0;
        for (const u of c.eligibleUnits) {
          poolTotal += unitPoolWeight(u, W, index);
        }
        if (!(poolTotal > 0)) {
          continue;
        }
        for (const u of c.eligibleUnits) {
          exposure[u.key] = (exposure[u.key] || 0) + 1 / poolTotal;
        }
      }
      const next = Object.create(null);
      let maxDelta = 0;
      for (const key of Object.keys(baseline)) {
        const w0 = baseline[key];
        const n = wins[key] || 0;
        const e = exposure[key] || 0;
        const w = (kappa * w0 + n) / (kappa + e);
        next[key] = w;
        maxDelta = Math.max(maxDelta, Math.abs(w - W[key]));
      }
      W = next;
      if (maxDelta < tol) {
        iters++;
        break;
      }
    }

    const units = Object.create(null);
    for (const key of Object.keys(baseline)) {
      const unit = unitFromKey(key);
      units[key] = { kind: unit.kind, family: unit.family, baseline: baseline[key], W: W[key], wins: wins[key] || 0 };
    }
    return { unitWeights: W, units, iterations: iters, priorStrength: kappa };
  }

  // Recover a partial unit descriptor from a unit key.
  function unitFromKey(key) {
    if (key.startsWith("family:")) {
      return { kind: "family", family: key.slice("family:".length), key };
    }
    if (key.startsWith("tied:")) {
      return { kind: "tiedSubtype", family: key.slice("tied:".length), key };
    }
    return { kind: "single", family: "", key };
  }

  // Apply a unit→weight map onto a list/array of catalog affix entries in place,
  // setting per-affix rollWeight / familyRollWeight. Used by both the browser
  // catalog builder and the Node catalog builders so learned weights take effect
  // identically. `learnedWeights` is { unitKey: W_u } (family TOTAL for families /
  // tied subtypes); tiedSubtype members get W_u / totalMembers each.
  function applyLearnedWeights(affixes, learnedWeights) {
    if (!learnedWeights || typeof learnedWeights !== "object") {
      return affixes;
    }
    const index = indexCatalog(affixes);
    for (const affix of index.affixes) {
      const unit = learningUnitForAffix(affix);
      if (!unit) {
        continue;
      }
      const w = learnedWeights[unit.key];
      if (!Number.isFinite(w) || w <= 0) {
        continue;
      }
      if (unit.kind === "family") {
        affix.familyRollWeight = w;
      } else if (unit.kind === "tiedSubtype") {
        const total = totalMembersForFamily(index, unit.family) || 1;
        affix.rollWeight = w / total;
      } else {
        affix.rollWeight = w;
      }
    }
    return affixes;
  }

  // Build the per-unit baseline snapshot for an export's `initialWeights`.
  function buildInitialWeights(catalog) {
    const index = catalog && catalog.__wtIndex ? catalog.__wtIndex : indexCatalog(catalog);
    const seen = new Map();
    for (const affix of index.affixes) {
      const unit = learningUnitForAffix(affix);
      if (!unit || seen.has(unit.key)) {
        if (unit && seen.has(unit.key)) {
          seen.get(unit.key).members.push(affix.id);
        }
        continue;
      }
      seen.set(unit.key, {
        key: unit.key,
        kind: unit.kind,
        family: unit.family,
        baseline: baselineUnitWeight(unit, index),
        members: [affix.id],
      });
    }
    return Array.from(seen.values());
  }

  return {
    PRIOR_STRENGTH_DEFAULT,
    learningUnitForAffix,
    indexCatalog,
    baselineUnitWeight,
    unitTotalWeightFromCatalog,
    computeDrawContribution,
    unitPoolWeight,
    accumulateStats,
    mergeStats,
    deriveWeights,
    iterateWeights,
    applyLearnedWeights,
    buildInitialWeights,
    unitFromKey,
  };
});
