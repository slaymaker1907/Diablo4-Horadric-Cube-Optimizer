# Business Requirements

## Product Scope

This optimizer is a browser-only tool for the affix-modification workflow of the Horadric Cube in Diablo IV. It is implemented in [d4cubeoptimv3.html](../d4cubeoptimv3.html) and [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).

The optimizer helps a player answer one question: given the current item state and a desired target state, what is the best next cube action to take?

For game mechanics (prism categories, cube operations, GA rules, Enchantress behavior), see [game-mechanics.md](game-mechanics.md).

## Required User Workflow

- The user enters a current item with a concrete gear slot or `Any`, a concrete character class or `Any`, up to four current affixes, Greater Affix (GA) flags, and an Enchanted flag for the enchantress-modified affix.
- The Class selector narrows the Adept-prism skill pool to the chosen class's specific and general skills, plus class-agnostic skills (Mainstat, `to All Skills`, `to Basic / Core / Defensive Skills`). `Any` keeps every class's skills in the pool.
- The user describes a target item with desired affixes and optional `Needs Improvement` flags.
- The optimizer recommends one next action at a time. The user applies the in-game result manually and reruns.
- The supported action family is the affix-modification slice only: Add Affix, Remove Affix, Chaotic Reroll, Focused Reroll, and Enchant. These are modeled in [d4cubeoptim-worker.js](../d4cubeoptim-worker.js) and used by v3 in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).
- The product must stay browser-first and static: no build step, no bundled dependency chain, no required backend service.

## Required Correctness And Honesty Rules

- The solver objective must remain lexicographic: maximize eventual success probability first, then minimize expected cube steps among success-optimal policies.
- GA preservation is always-on: any GA on a current affix that maps to a target affix is implicitly protected. The optimizer never recommends actions that risk losing a protected GA, and explicitly rejects plans where preservation is impossible.
- GAs can never be acquired through cube or Enchantress operations — only preserved. Enchanting to a different affix always produces non-GA output. The `requireGA` field does not exist; implicit protection via `gaRequiredCounts` is the sole mechanism.
- Impossible targets must be rejected with explicit feasibility failures (`F4` through `F7`) rather than a fake success estimate.
- Concrete gear slots must prune impossible affixes; `Any` preserves the full pool. The legality source of truth is [gear-slot-legality.js](../gear-slot-legality.js).
- Solver limits must be surfaced honestly. If decomposition or residual solving cannot finish within budget, the product reports that limit explicitly with an approximate best-so-far result where possible.
- The product must expose structured diagnostics for feasibility, decomposition, ILP, and residual solving so the UI can explain why a recommendation exists or why the solver stopped.
- Some affixes require **different prisms per operation type** (Add, Focused Reroll, Chaotic Reroll, Remove). The optimizer models per-operation category overrides (`operationCategories` on affix objects) so each operation uses the mechanically correct prism pool. The canonical example is Thorns, which uses Aggressive for Add, Protector for Focused/Chaotic Reroll, and Pragmatic for Remove. See [game-mechanics.md](game-mechanics.md#known-mechanical-edge-cases).

## Required User-Facing Outputs

- A recommended next action, or an explicit reason no safe or exact recommendation is available.
- Eventual success probability (P(Success, GA Preserved)) for the current best policy.
- Expected cube steps under the lexicographic objective. This counts steps until a terminal outcome — success or GA-break failure — not steps until success alone.
- Structured diagnostics distinguishing feasibility stop, decomposition + ILP, and residual LAO* routing.
- Explicit GA-risk context for the current recommendation.
- Candidate actions and diagnostic detail sufficient to understand when the solver is blocked by legality or budget rather than infeasibility.

## Required Product Modes And Constraints

- GA preservation is always-on (`strictMode: true` is always sent from the UI). There is no toggle.
- Thinking Time widens the residual search budget but is not a wall-clock cutoff for exact routes. `timeMs = 0` uses the largest configured budget.
- The browser worker contract must remain stable enough that [d4cubeoptimv3.html](../d4cubeoptimv3.html) can render results without special-case interpretation.

## Required User-Facing Warnings

- When Class is set to `Any`, the UI must display a note that the rolling pool includes every class's skills and that probabilities are smaller than what a real character would experience. Setting Class to the player's character class narrows the pool to that class's specific and general skills.

## Explicit Non-Goals

- This product does not optimize Transfiguration, Unique rerolls, 3-to-1 transmutation, charm crafting, amalgamation, or other broader cube recipes.
- It does not model gold cost, crafting material quantities, affix value thresholds, slot-specific empirical roll weights, or class-specific legality beyond the shared legality table in [gear-slot-legality.js](../gear-slot-legality.js).
- It does not promise an unbounded exact residual solver. Larger residual cases may stop at explicit solver limits and return approximate results.

## Supporting References

- Game mechanics (prisms, operations, GA rules): [game-mechanics.md](game-mechanics.md)
- Current feature and phase summary: [CHANGES.md](../CHANGES.md)
- Capability mapping: [v2-improvement-notes/requirement-matrix.md](../v2-improvement-notes/requirement-matrix.md)
- Deferred follow-ups: [v2-improvement-notes/open-issues.md](../v2-improvement-notes/open-issues.md) and [v2-improvement-notes/next-steps.md](../v2-improvement-notes/next-steps.md)
