# Business Requirements

## Product Scope

This repository does not model the entire Horadric Cube system described in [Horadric_Cube_D4_Guide.md](../Horadric_Cube_D4_Guide.md). The product scope is narrower: it is a browser-only optimizer for the affix-modification workflow implemented by [d4cubeoptimv3.html](../d4cubeoptimv3.html) and [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).

The optimizer must help a player answer one question honestly: given the current item state and a desired target state, what is the best next cube action to take?

## Required User Workflow

- The user must be able to enter a current item with a concrete gear slot or `Any`, current affixes, Greater Affix flags, and Enchanted flags in [d4cubeoptimv3.html](../d4cubeoptimv3.html).
- The user must be able to describe a target item with desired affixes plus `Require GA` and `Needs Improvement` flags in [d4cubeoptimv3.html](../d4cubeoptimv3.html).
- The optimizer must recommend one next action at a time, not a hidden full sequence. The user applies the in-game outcome manually and reruns the tool.
- The supported action family is the current affix-modification slice only: Add Affix, Remove Affix, Chaotic Reroll, Focused Reroll, and Enchant. These actions are surfaced through the shared action model in [d4cubeoptim-worker.js](../d4cubeoptim-worker.js) and used by v3 in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).
- The product must stay browser-first and static: no build step, no bundled dependency chain, and no required backend service.

## Required Correctness And Honesty Rules

- The solver objective must remain lexicographic: maximize eventual success probability first, then minimize expected cube steps among success-optimal policies. The current contract lives in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).
- Impossible targets must be rejected explicitly instead of receiving a fake success estimate. Feasibility failures `F1` through `F7` are part of the product contract in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) and are covered by [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js).
- `Require GA` is only valid for affixes that are already Greater Affixes on the source item. The UI enforces that rule in [d4cubeoptimv3.html](../d4cubeoptimv3.html), and residual/GA logic depends on it in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) and [d4cubeoptimv2-worker.js](../d4cubeoptimv2-worker.js).
- Concrete gear slots must prune impossible affixes, while `Any` must preserve the unrestricted pool. The legality source of truth is [gear-slot-legality.js](../gear-slot-legality.js), derived from [gear_to_affix.md](../gear_to_affix.md).
- Solver limits must be surfaced honestly. If decomposition or residual solving cannot finish within the supported exact budget, the product should report that limit instead of pretending to know the answer. The current residual-limit behavior is visible in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js), [d4cubeoptimv3.html](../d4cubeoptimv3.html), and [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js).
- The product must expose structured diagnostics for feasibility, decomposition, ILP, and residual solving so the UI can explain why a recommendation exists or why the solver stopped.

## Required User-Facing Outputs

- A recommended next action, or an explicit reason no safe or exact recommendation is available.
- Eventual success probability for the current best policy.
- Expected steps under the lexicographic objective used by v3.
- Structured diagnostics that distinguish feasibility stop, decomposition plus ILP, and residual LAO* routing.
- Explicit GA-risk context for the current recommendation in the browser UI.
- Candidate actions and enough diagnostic detail for the user to understand when the solver is blocked by legality or budget rather than by infeasibility.

## Required Product Modes And Constraints

- The UI must expose `Target GA Strict` versus flexible mode in [d4cubeoptimv3.html](../d4cubeoptimv3.html), and the shared action model in [d4cubeoptim-worker.js](../d4cubeoptim-worker.js) must continue to honor that distinction.
- Thinking Time must widen the residual search budget, but it is not a wall-clock cutoff for exact routes. Current budget behavior is implemented in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) and explained in [d4cubeoptimv3.html](../d4cubeoptimv3.html).
- The browser worker contract must remain stable enough that [d4cubeoptimv3.html](../d4cubeoptimv3.html) can render results without special-case interpretation.

## Explicit Non-Goals

- This product does not currently optimize Transfiguration, Unique rerolls, 3-to-1 transmutation, Charm crafting, or the other broader cube recipes described in [Horadric_Cube_D4_Guide.md](../Horadric_Cube_D4_Guide.md).
- It does not currently model gold cost, crafting materials, affix value thresholds, slot-specific empirical roll weights, or class-specific legality beyond the shared legality table.
- It does not promise an unbounded exact residual solver. Larger residual cases may still stop at explicit solver limits.

## Supporting References

- Current feature and phase summary: [CHANGES.md](../CHANGES.md)
- Requested v3 capability mapping: [v2-improvement-notes/requirement-matrix.md](../v2-improvement-notes/requirement-matrix.md)
- Deferred business/product follow-ups: [v2-improvement-notes/open-issues.md](../v2-improvement-notes/open-issues.md) and [v2-improvement-notes/next-steps.md](../v2-improvement-notes/next-steps.md)
