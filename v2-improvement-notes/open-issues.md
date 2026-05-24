# Open Issues

## Known Gaps

- Thinking Time now widens the residual solver budget in [d4cubeoptimv3.html](../d4cubeoptimv3.html), but it still is not a wall-clock cutoff for the exact solver paths.
- Full-catalog residual cases can still hit the largest configured abstract-state budget and surface `State Limit`; the UI now exposes that clearly, but the underlying sparse-expansion follow-up is still deferred.

## Watch Items

- Revisit the exact interpretation of protected affixes in F4 when the decomposition layer is implemented.
- Extend F5 further if later work adds class-specific legality or weighted per-slot roll tables beyond the current shared slot-legality filter.
- Keep discretionary Case `E` enchant opt-in until the global assignment layer can model the shared one-shot enchant resource explicitly.
- The Phase 3 ILP layer supports continuous variables in the LP relaxation only; if Phase 4 ever needs general integers, that will require explicit new work rather than silent reuse.
- The Phase 5 residual solver still expands a full abstract graph up front, so even with the larger Thinking Time budgets it remains bounded by the configured 4096-state / 1048576-iteration maximums; larger residuals will need a sparser expansion strategy if they become common.

## Resolved Post-Phase 8

- The public diagnostics contract and strategy labels were reviewed for freeze; no rename was required, and the current worker statuses remain the baseline contract.
- The 1,048,576-iteration residual cap was identified as algorithm-bound (not budget-bound): the Phase 1 convergence condition `maxDelta < epsilon AND policy-signature-match` could loop forever when values converged but tied actions caused policy-signature oscillation. Resolved by replacing the joint condition with plain `maxDelta < epsilon` in both Phase 1 and Phase 2, matching the v2 exact solver. The Amulet benchmark case (formerly documented in AGENTS.md as iteration-bound) now solves to `OPTIMAL` in well under the default budget.