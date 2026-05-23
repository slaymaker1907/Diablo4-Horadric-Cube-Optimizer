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