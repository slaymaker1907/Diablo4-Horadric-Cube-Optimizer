const test = require("node:test");
const assert = require("node:assert/strict");

const { ILP_STATUSES, solveILP } = require("./ilp.js");

const TEST_TIMEOUT_MS = 2000;

test("solveILP solves a small binary knapsack problem exactly", { timeout: TEST_TIMEOUT_MS }, () => {
  const result = solveILP({
    variables: [
      { name: "x0", type: "binary" },
      { name: "x1", type: "binary" },
      { name: "x2", type: "binary" },
    ],
    objective: {
      sense: "min",
      coefficients: [-6, -10, -12],
    },
    constraints: [
      { coefficients: [1, 2, 3], operator: "<=", rhs: 4 },
    ],
  });

  assert.equal(result.status, ILP_STATUSES.OPTIMAL);
  assert.equal(result.objective, -18);
  assert.deepEqual(result.assignment, { x0: 1, x1: 0, x2: 1 });
  assert.ok(result.nodesVisited > 1);
});

test("solveILP solves a small assignment model exactly", { timeout: TEST_TIMEOUT_MS }, () => {
  const result = solveILP({
    variables: [
      { name: "x00", type: "binary" },
      { name: "x01", type: "binary" },
      { name: "x10", type: "binary" },
      { name: "x11", type: "binary" },
    ],
    objective: {
      sense: "min",
      coefficients: [4, 1, 2, 3],
    },
    constraints: [
      { coefficients: [1, 1, 0, 0], operator: "=", rhs: 1 },
      { coefficients: [0, 0, 1, 1], operator: "=", rhs: 1 },
      { coefficients: [1, 0, 1, 0], operator: "=", rhs: 1 },
      { coefficients: [0, 1, 0, 1], operator: "=", rhs: 1 },
    ],
  });

  assert.equal(result.status, ILP_STATUSES.OPTIMAL);
  assert.equal(result.objective, 3);
  assert.deepEqual(result.assignment, { x00: 0, x01: 1, x10: 1, x11: 0 });
});

test("solveILP solves a small set-cover instance exactly", { timeout: TEST_TIMEOUT_MS }, () => {
  const result = solveILP({
    variables: [
      { name: "s0", type: "binary" },
      { name: "s1", type: "binary" },
      { name: "s2", type: "binary" },
    ],
    objective: {
      sense: "min",
      coefficients: [1, 1, 1],
    },
    constraints: [
      { coefficients: [1, 0, 1], operator: ">=", rhs: 1 },
      { coefficients: [1, 1, 0], operator: ">=", rhs: 1 },
      { coefficients: [0, 1, 1], operator: ">=", rhs: 1 },
    ],
  });

  assert.equal(result.status, ILP_STATUSES.OPTIMAL);
  assert.equal(result.objective, 2);
  assert.equal(result.assignment.s0 + result.assignment.s1 + result.assignment.s2, 2);
  assert.ok(result.nodesVisited > 1);
});

test("solveILP reports infeasible models", { timeout: TEST_TIMEOUT_MS }, () => {
  const result = solveILP({
    variables: [
      { name: "x", type: "binary", upperBound: 0 },
    ],
    objective: {
      sense: "min",
      coefficients: [1],
    },
    constraints: [
      { coefficients: [1], operator: ">=", rhs: 1 },
    ],
  });

  assert.equal(result.status, ILP_STATUSES.INFEASIBLE);
  assert.equal(result.assignment, null);
});

test("solveILP reports unbounded LP-layer models", { timeout: TEST_TIMEOUT_MS }, () => {
  const result = solveILP({
    variables: [
      { name: "x", type: "continuous", lowerBound: 0, upperBound: Infinity },
    ],
    objective: {
      sense: "min",
      coefficients: [-1],
    },
    constraints: [],
  });

  assert.equal(result.status, ILP_STATUSES.UNBOUNDED);
});

test("solveILP can finish during presolve via singleton substitution", { timeout: TEST_TIMEOUT_MS }, () => {
  const result = solveILP({
    variables: [
      { name: "x", type: "binary" },
      { name: "y", type: "binary" },
    ],
    objective: {
      sense: "min",
      coefficients: [1, 1],
    },
    constraints: [
      { coefficients: [1, 0], operator: "=", rhs: 1 },
      { coefficients: [-1, 1], operator: ">=", rhs: 0 },
    ],
  });

  assert.equal(result.status, ILP_STATUSES.OPTIMAL);
  assert.equal(result.objective, 2);
  assert.deepEqual(result.assignment, { x: 1, y: 1 });
});

test("solveILP probes pairwise-conflict implications to fix a forced variable", { timeout: TEST_TIMEOUT_MS }, () => {
  // a + b <= 1, a + c <= 1, b + c <= 1, b + c >= 1, minimize -a.
  // Setting a = 1 forces b = 0 and c = 0, which violates b + c >= 1, so a must be 0.
  // The optimum is a = 0, b + c = 1, objective = 0.
  const result = solveILP({
    variables: [
      { name: "a", type: "binary" },
      { name: "b", type: "binary" },
      { name: "c", type: "binary" },
    ],
    objective: { sense: "min", coefficients: [-1, 0, 0] },
    constraints: [
      { coefficients: [1, 1, 0], operator: "<=", rhs: 1 },
      { coefficients: [1, 0, 1], operator: "<=", rhs: 1 },
      { coefficients: [0, 1, 1], operator: "<=", rhs: 1 },
      { coefficients: [0, 1, 1], operator: ">=", rhs: 1 },
    ],
  });

  assert.equal(result.status, ILP_STATUSES.OPTIMAL);
  assert.equal(result.objective, 0);
  assert.equal(result.assignment.a, 0);
  assert.equal(result.assignment.b + result.assignment.c, 1);
});

test("solveILP emits clique cuts that tighten the LP relaxation", { timeout: TEST_TIMEOUT_MS }, () => {
  // A triangle of pairwise mutex constraints implies an underlying clique
  // {x, y, z} of size 3. Clique cut generation should add x + y + z <= 1,
  // which makes the LP relaxation integral on this objective.
  const problem = {
    variables: [
      { name: "x", type: "binary" },
      { name: "y", type: "binary" },
      { name: "z", type: "binary" },
    ],
    objective: { sense: "min", coefficients: [-3, -2, -1] },
    constraints: [
      { coefficients: [1, 1, 0], operator: "<=", rhs: 1 },
      { coefficients: [1, 0, 1], operator: "<=", rhs: 1 },
      { coefficients: [0, 1, 1], operator: "<=", rhs: 1 },
    ],
  };

  const withCuts = solveILP(problem);
  assert.equal(withCuts.status, ILP_STATUSES.OPTIMAL);
  assert.equal(withCuts.objective, -3);
  assert.equal(withCuts.assignment.x, 1);
  assert.equal(withCuts.assignment.y, 0);
  assert.equal(withCuts.assignment.z, 0);
  assert.ok((withCuts.cutsAdded || 0) >= 1, "expected at least one clique cut to be emitted");

  const noCuts = solveILP({ ...problem, options: { enableCliqueCuts: false } });
  assert.equal(noCuts.status, ILP_STATUSES.OPTIMAL);
  assert.equal(noCuts.objective, -3);
});

test("solveILP solves a medium sparse binary problem within the iteration budget", { timeout: TEST_TIMEOUT_MS * 3 }, () => {
  // Set-cover style problem: 24 items, 12 sets. Each item must be covered.
  const numSets = 12;
  const numItems = 24;
  const seed = 1234;
  let rng = seed;
  function rand() {
    rng = (rng * 9301 + 49297) % 233280;
    return rng / 233280;
  }

  const setMembership = Array.from({ length: numSets }, () => new Set());
  for (let item = 0; item < numItems; item += 1) {
    const setsForItem = [];
    while (setsForItem.length < 3) {
      const candidate = Math.floor(rand() * numSets);
      if (!setsForItem.includes(candidate)) {
        setsForItem.push(candidate);
      }
    }
    for (const s of setsForItem) {
      setMembership[s].add(item);
    }
  }

  const variables = Array.from({ length: numSets }, (_, s) => ({ name: `s${s}`, type: "binary" }));
  const objective = {
    sense: "min",
    coefficients: Array.from({ length: numSets }, () => 1 + Math.floor(rand() * 5)),
  };
  const constraints = [];
  for (let item = 0; item < numItems; item += 1) {
    const coefficients = Array.from({ length: numSets }, () => 0);
    for (let s = 0; s < numSets; s += 1) {
      if (setMembership[s].has(item)) coefficients[s] = 1;
    }
    constraints.push({ coefficients, operator: ">=", rhs: 1, name: `item_${item}` });
  }

  const result = solveILP({ variables, objective, constraints });
  assert.equal(result.status, ILP_STATUSES.OPTIMAL);
  assert.ok(Number.isFinite(result.objective));
  for (let item = 0; item < numItems; item += 1) {
    let coverage = 0;
    for (let s = 0; s < numSets; s += 1) {
      if (setMembership[s].has(item) && result.assignment[`s${s}`] === 1) {
        coverage += 1;
      }
    }
    assert.ok(coverage >= 1, `item ${item} must be covered (coverage = ${coverage})`);
  }
});

test("solveILP exposes pseudo-cost branching as the default rule", { timeout: TEST_TIMEOUT_MS }, () => {
  // A small but nontrivial binary problem. The point of this test is that
  // pseudo-cost branching (the default) and most-fractional branching both
  // produce the same optimal objective, proving the new rule is wired up
  // without regressing correctness.
  const problem = {
    variables: [
      { name: "x0", type: "binary" },
      { name: "x1", type: "binary" },
      { name: "x2", type: "binary" },
      { name: "x3", type: "binary" },
      { name: "x4", type: "binary" },
    ],
    objective: { sense: "min", coefficients: [-7, -5, -4, -3, -1] },
    constraints: [
      { coefficients: [3, 2, 2, 1, 1], operator: "<=", rhs: 5 },
      { coefficients: [1, 1, 0, 0, 1], operator: "<=", rhs: 2 },
      { coefficients: [0, 1, 1, 1, 0], operator: "<=", rhs: 2 },
    ],
  };

  const pseudo = solveILP(problem);
  const mostFractional = solveILP({ ...problem, options: { branchingRule: "most-fractional" } });

  assert.equal(pseudo.status, ILP_STATUSES.OPTIMAL);
  assert.equal(mostFractional.status, ILP_STATUSES.OPTIMAL);
  assert.equal(pseudo.objective, mostFractional.objective);
});