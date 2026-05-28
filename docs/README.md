# d4cubeoptim Docs

This folder is the curated entry point for humans and AIs working on the v3 optimizer.

## Reading Order

1. [Game Mechanics](game-mechanics.md)
2. [Business Requirements](business-requirements.md)
3. [Implementation Guide](implementation-guide.md)
4. [AGENTS.md](../AGENTS.md)
5. [CHANGES.md](../CHANGES.md)
6. [Requirement Matrix](../v2-improvement-notes/requirement-matrix.md)
7. [Open Issues](../v2-improvement-notes/open-issues.md)

## What This Product Is

- The canonical product is the browser-only v3 optimizer in [d4cubeoptimv3.html](../d4cubeoptimv3.html) backed by [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js).
- Its job is to recommend the next Horadric Cube affix-modification action needed to move a current item toward a desired target state.
- It is an iterative assistant, not a batch autoplayer: the user enters the current item, receives one recommended action, applies the in-game result manually, updates the item state, and runs again.
- Legacy v1 and v2 files remain in the repo only for shared helper behavior and historical context. New product work should target v3.

## Source Of Truth Order

- First trust the live v3 code and focused tests: [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js), [d4cubeoptimv3-worker.test.js](../d4cubeoptimv3-worker.test.js), [d4cubeoptimv3.html](../d4cubeoptimv3.html), [ilp.js](../ilp.js), and [ilp.test.js](../ilp.test.js).
- Then use this docs folder plus [AGENTS.md](../AGENTS.md) for condensed guidance.
- Use [CHANGES.md](../CHANGES.md) and the Phase 8 note set in [v2-improvement-notes](../v2-improvement-notes/) for design intent, deferred work, and handoff history.
- If markdown and code disagree, trust the current code and focused tests.

## Useful File Map

- UI and browser workflow: [d4cubeoptimv3.html](../d4cubeoptimv3.html)
- v3 orchestrator and solver stack: [d4cubeoptimv3-worker.js](../d4cubeoptimv3-worker.js)
- Shared cube action model and legality-aware pools: [d4cubeoptim-worker.js](../d4cubeoptim-worker.js)
- Residual helper semantics still reused by v3: [d4cubeoptimv2-worker.js](../d4cubeoptimv2-worker.js)
- Exact small ILP engine: [ilp.js](../ilp.js)
- Slot legality table: [gear-slot-legality.js](../gear-slot-legality.js)
- Verified affix legality source: [docs/verified-affixes.md](verified-affixes.md) (unverified leftovers in [docs/maybe-affixes.md](maybe-affixes.md))
- Game mechanics reference (prisms, operations, GA rules): [docs/game-mechanics.md](game-mechanics.md)

## Validation Shortcuts

- Focused v3 worker suite: `node --test d4cubeoptimv3-worker.test.js`
- Focused ILP suite: `node --test ilp.test.js`
- Full regression: `node --test ilp.test.js d4cubeoptim-worker.test.js d4cubeoptimv2-worker.test.js d4cubeoptimv3-worker.test.js`
- Browser smoke: run `python3 -m http.server 8123` from the repo root and open [d4cubeoptimv3.html](../d4cubeoptimv3.html)
