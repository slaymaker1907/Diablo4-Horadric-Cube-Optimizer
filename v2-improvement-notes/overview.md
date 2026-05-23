# v3 Implementation Overview

This folder is the repo-local handoff record for the v3 hybrid solver effort.

Primary reference plan:
- [original-plan.md](original-plan.md)

Current implementation status:
- Phase 0 complete.
- Phase 1 complete.
- Phase 2 complete.
- Phase 3 complete.
- Phase 4 complete.
- Phase 5 complete.
- Phase 6 complete.
- Phase 7 complete.
- Phase 8 complete.

Current architecture status:
- [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) exists, enforces feasibility checks F1 through F7, and contains the Phase 2 closed-form Case A through G helpers.
- Decomposition-safe cases now route through the v3 closed-form engine plus [ilp.js](../ilp.js).
- Residual-only cases now route through the abstract-state residual solver in [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js) instead of the temporary v2 fallback.
- The top-level v3 worker contract now always includes structured `feasibility`, `decomposition`, `ilp`, and `residual` diagnostics so later UI work can render a single stable schema.
- [ilp.js](../ilp.js) now implements the exact small-problem ILP layer for Phase 3 and is wired into the Phase 4 assignment-and-ordering model.
- [d4cubeoptimv3.html](../d4cubeoptimv3.html) now renders the stable worker diagnostics contract directly in the browser and uses `WORKER_VERSION = 2026-05-23-v3-slot-legality`.
- [requirement-matrix.md](requirement-matrix.md) maps the requested v3 features to implementation and validation evidence.

Use [progress.md](progress.md) for completed work, [next-steps.md](next-steps.md) for the exact next actions, [decisions.md](decisions.md) for architecture decisions, and [open-issues.md](open-issues.md) for known unresolved problems.