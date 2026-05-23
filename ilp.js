/**
 * ilp.js
 *
 * Exact small-problem ILP solver for the v3 hybrid worker.
 *
 * Scope:
 * - linear minimization
 * - binary branch-and-bound
 * - continuous variables in the LP relaxation layer
 * - two-phase simplex for LP relaxations
 */

const ILP_STATUSES = Object.freeze({
  OPTIMAL: "OPTIMAL",
  INFEASIBLE: "INFEASIBLE",
  UNBOUNDED: "UNBOUNDED",
  ITERATION_LIMIT: "ITERATION_LIMIT",
});

const DEFAULT_ILP_OPTIONS = Object.freeze({
  iterationLimit: 0,
  feasibilityTolerance: 1e-9,
  optimalityTolerance: 1e-9,
  integralityTolerance: 1e-9,
  presolvePassLimit: 32,
  branchingRule: "most-fractional",
  enableRoundingHeuristic: true,
});

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function approximatelyEqual(left, right, tolerance) {
  return Math.abs(left - right) <= tolerance;
}

function clamp(value, lower, upper) {
  return Math.min(Math.max(value, lower), upper);
}

function sanitizeValue(value, lower, upper, tolerance) {
  if (approximatelyEqual(value, lower, tolerance)) {
    return lower;
  }
  if (approximatelyEqual(value, upper, tolerance)) {
    return upper;
  }
  return clamp(value, lower, upper);
}

function inferVariableCount(problem) {
  let variableCount = 0;

  if (problem && Array.isArray(problem.variables)) {
    variableCount = Math.max(variableCount, problem.variables.length);
  }
  if (problem && Array.isArray(problem.variableNames)) {
    variableCount = Math.max(variableCount, problem.variableNames.length);
  }
  if (problem && problem.objective && Array.isArray(problem.objective.coefficients)) {
    variableCount = Math.max(variableCount, problem.objective.coefficients.length);
  }
  if (problem && Array.isArray(problem.constraints)) {
    for (const constraint of problem.constraints) {
      if (constraint && Array.isArray(constraint.coefficients)) {
        variableCount = Math.max(variableCount, constraint.coefficients.length);
      }
    }
  }

  return variableCount;
}

function normalizeCoefficients(rawCoefficients, variableCount) {
  const source = Array.isArray(rawCoefficients) ? rawCoefficients : [];
  const coefficients = Array.from({ length: variableCount }, (_, index) => {
    const value = Number(source[index] || 0);
    if (!Number.isFinite(value)) {
      throw new Error(`Coefficient at index ${index} must be finite.`);
    }
    return value;
  });

  return coefficients;
}

function normalizeOptions(problem) {
  const input = problem && problem.options && typeof problem.options === "object"
    ? problem.options
    : {};

  const iterationLimit = Number(input.iterationLimit);
  const feasibilityTolerance = Number(input.feasibilityTolerance);
  const optimalityTolerance = Number(input.optimalityTolerance);
  const integralityTolerance = Number(input.integralityTolerance);
  const presolvePassLimit = Number(input.presolvePassLimit);

  return {
    iterationLimit: Number.isFinite(iterationLimit) && iterationLimit > 0
      ? Math.floor(iterationLimit)
      : 0,
    feasibilityTolerance: Number.isFinite(feasibilityTolerance) && feasibilityTolerance > 0
      ? feasibilityTolerance
      : DEFAULT_ILP_OPTIONS.feasibilityTolerance,
    optimalityTolerance: Number.isFinite(optimalityTolerance) && optimalityTolerance > 0
      ? optimalityTolerance
      : DEFAULT_ILP_OPTIONS.optimalityTolerance,
    integralityTolerance: Number.isFinite(integralityTolerance) && integralityTolerance > 0
      ? integralityTolerance
      : DEFAULT_ILP_OPTIONS.integralityTolerance,
    presolvePassLimit: Number.isFinite(presolvePassLimit) && presolvePassLimit > 0
      ? Math.floor(presolvePassLimit)
      : DEFAULT_ILP_OPTIONS.presolvePassLimit,
    branchingRule: input.branchingRule === "most-fractional"
      ? input.branchingRule
      : DEFAULT_ILP_OPTIONS.branchingRule,
    enableRoundingHeuristic: input.enableRoundingHeuristic !== false,
  };
}

function normalizeProblem(problem) {
  if (!problem || typeof problem !== "object") {
    throw new Error("solveILP expects a problem object.");
  }

  const variableCount = inferVariableCount(problem);
  const options = normalizeOptions(problem);
  const objective = problem.objective && typeof problem.objective === "object"
    ? problem.objective
    : { coefficients: [] };
  const objectiveSense = String(objective.sense || "min").trim().toLowerCase();

  if (objectiveSense !== "min") {
    throw new Error("The current solver supports linear minimization only.");
  }

  const variableNames = Array.from({ length: variableCount }, (_, index) => {
    const explicitName = Array.isArray(problem.variableNames) ? problem.variableNames[index] : "";
    const variable = Array.isArray(problem.variables) ? problem.variables[index] : null;
    if (variable && typeof variable.name === "string" && variable.name.trim()) {
      return variable.name.trim();
    }
    if (typeof explicitName === "string" && explicitName.trim()) {
      return explicitName.trim();
    }
    return `x${index}`;
  });

  const variableTypes = [];
  const lowerBounds = [];
  const upperBounds = [];

  for (let index = 0; index < variableCount; index += 1) {
    const variable = Array.isArray(problem.variables) ? problem.variables[index] : null;
    const type = String(variable && variable.type ? variable.type : "binary").trim().toLowerCase();

    if (type !== "binary" && type !== "continuous") {
      throw new Error(`Unsupported variable type at index ${index}: ${type}`);
    }

    const defaultLowerBound = 0;
    const defaultUpperBound = type === "binary" ? 1 : Infinity;
    const lowerBound = variable && Object.prototype.hasOwnProperty.call(variable, "lowerBound")
      ? Number(variable.lowerBound)
      : defaultLowerBound;
    const upperBound = variable && Object.prototype.hasOwnProperty.call(variable, "upperBound")
      ? Number(variable.upperBound)
      : defaultUpperBound;

    if (!Number.isFinite(lowerBound)) {
      throw new Error(`Lower bound at index ${index} must be finite.`);
    }
    if (!Number.isFinite(upperBound) && upperBound !== Infinity) {
      throw new Error(`Upper bound at index ${index} must be finite or Infinity.`);
    }
    if (lowerBound > upperBound + options.feasibilityTolerance) {
      throw new Error(`Variable bounds are inconsistent at index ${index}.`);
    }

    variableTypes.push(type);
    lowerBounds.push(lowerBound);
    upperBounds.push(upperBound);
  }

  const constraints = Array.isArray(problem.constraints) ? problem.constraints.map((constraint, constraintIndex) => {
    const coefficients = normalizeCoefficients(constraint && constraint.coefficients, variableCount);
    const operator = String(constraint && constraint.operator ? constraint.operator : "<=").trim();
    const rhs = Number(constraint && constraint.rhs);
    const name = constraint && typeof constraint.name === "string" ? constraint.name : `c${constraintIndex}`;

    if (!Number.isFinite(rhs)) {
      throw new Error(`Constraint ${name} must have a finite rhs.`);
    }
    if (operator !== "<=" && operator !== ">=" && operator !== "=") {
      throw new Error(`Unsupported operator for constraint ${name}: ${operator}`);
    }

    return {
      coefficients,
      lower: operator === ">=" || operator === "=" ? rhs : -Infinity,
      upper: operator === "<=" || operator === "=" ? rhs : Infinity,
      name,
    };
  }) : [];

  return {
    variableNames,
    variableTypes,
    lowerBounds,
    upperBounds,
    objectiveCoefficients: normalizeCoefficients(objective.coefficients, variableCount),
    objectiveConstant: Number.isFinite(Number(objective.constant)) ? Number(objective.constant) : 0,
    constraints,
    options,
    rawProblem: problem,
  };
}

function collapseBinaryBounds(lowerBound, upperBound, tolerance) {
  const canBeZero = lowerBound <= tolerance;
  const canBeOne = upperBound >= 1 - tolerance;

  if (!canBeZero && !canBeOne) {
    return { infeasible: true };
  }
  if (!canBeZero) {
    return { lowerBound: 1, upperBound: 1, changed: !approximatelyEqual(lowerBound, 1, tolerance) || !approximatelyEqual(upperBound, 1, tolerance) };
  }
  if (!canBeOne) {
    return { lowerBound: 0, upperBound: 0, changed: !approximatelyEqual(lowerBound, 0, tolerance) || !approximatelyEqual(upperBound, 0, tolerance) };
  }

  return {
    lowerBound: approximatelyEqual(lowerBound, 0, tolerance) ? 0 : lowerBound,
    upperBound: approximatelyEqual(upperBound, 1, tolerance) ? 1 : upperBound,
    changed: false,
  };
}

function createWorkingProblem(normalized) {
  return {
    originalVariableNames: normalized.variableNames.slice(),
    originalVariableTypes: normalized.variableTypes.slice(),
    fixedValues: Array.from({ length: normalized.variableNames.length }, () => null),
    activeToOriginal: Array.from({ length: normalized.variableNames.length }, (_, index) => index),
    variableNames: normalized.variableNames.slice(),
    variableTypes: normalized.variableTypes.slice(),
    lowerBounds: normalized.lowerBounds.slice(),
    upperBounds: normalized.upperBounds.slice(),
    objectiveCoefficients: normalized.objectiveCoefficients.slice(),
    objectiveConstant: normalized.objectiveConstant,
    constraints: normalized.constraints.map((constraint) => ({
      coefficients: constraint.coefficients.slice(),
      lower: constraint.lower,
      upper: constraint.upper,
      name: constraint.name,
    })),
  };
}

function substituteFixedVariable(problem, activeIndex, value) {
  const originalIndex = problem.activeToOriginal[activeIndex];
  problem.fixedValues[originalIndex] = value;
  problem.objectiveConstant += problem.objectiveCoefficients[activeIndex] * value;

  for (const constraint of problem.constraints) {
    const coefficient = constraint.coefficients[activeIndex] || 0;
    if (coefficient !== 0) {
      if (Number.isFinite(constraint.lower)) {
        constraint.lower -= coefficient * value;
      }
      if (Number.isFinite(constraint.upper)) {
        constraint.upper -= coefficient * value;
      }
    }
    constraint.coefficients.splice(activeIndex, 1);
  }

  problem.activeToOriginal.splice(activeIndex, 1);
  problem.variableNames.splice(activeIndex, 1);
  problem.variableTypes.splice(activeIndex, 1);
  problem.lowerBounds.splice(activeIndex, 1);
  problem.upperBounds.splice(activeIndex, 1);
  problem.objectiveCoefficients.splice(activeIndex, 1);
}

function analyzeConstraintRange(constraint, lowerBounds, upperBounds) {
  let minValue = 0;
  let maxValue = 0;
  const nonzeroIndexes = [];

  for (let index = 0; index < constraint.coefficients.length; index += 1) {
    const coefficient = constraint.coefficients[index] || 0;
    if (coefficient === 0) {
      continue;
    }

    nonzeroIndexes.push(index);

    if (coefficient >= 0) {
      minValue += coefficient * lowerBounds[index];
      maxValue += coefficient * upperBounds[index];
    } else {
      minValue += coefficient * upperBounds[index];
      maxValue += coefficient * lowerBounds[index];
    }
  }

  return { minValue, maxValue, nonzeroIndexes };
}

function tightenConstraintBounds(problem, constraint, options) {
  const analysis = analyzeConstraintRange(constraint, problem.lowerBounds, problem.upperBounds);
  const tolerance = options.feasibilityTolerance;
  let changed = false;

  if (Number.isFinite(constraint.lower) && analysis.maxValue < constraint.lower - tolerance) {
    return { infeasible: true };
  }
  if (Number.isFinite(constraint.upper) && analysis.minValue > constraint.upper + tolerance) {
    return { infeasible: true };
  }

  if (Number.isFinite(constraint.lower) && analysis.minValue >= constraint.lower - tolerance) {
    constraint.lower = -Infinity;
    changed = true;
  }
  if (Number.isFinite(constraint.upper) && analysis.maxValue <= constraint.upper + tolerance) {
    constraint.upper = Infinity;
    changed = true;
  }

  if (!Number.isFinite(constraint.lower) && !Number.isFinite(constraint.upper)) {
    return { changed, redundant: true };
  }

  if (analysis.nonzeroIndexes.length === 0) {
    if (
      (Number.isFinite(constraint.lower) && 0 < constraint.lower - tolerance)
      || (Number.isFinite(constraint.upper) && 0 > constraint.upper + tolerance)
    ) {
      return { infeasible: true };
    }
    return { changed: true, redundant: true };
  }

  for (const variableIndex of analysis.nonzeroIndexes) {
    const coefficient = constraint.coefficients[variableIndex];
    const lowerBound = problem.lowerBounds[variableIndex];
    const upperBound = problem.upperBounds[variableIndex];
    const minContribution = coefficient >= 0 ? coefficient * lowerBound : coefficient * upperBound;
    const maxContribution = coefficient >= 0 ? coefficient * upperBound : coefficient * lowerBound;
    const minOthers = analysis.minValue - minContribution;
    const maxOthers = analysis.maxValue - maxContribution;
    let candidateLower = lowerBound;
    let candidateUpper = upperBound;

    if (Number.isFinite(constraint.upper)) {
      if (coefficient > tolerance) {
        candidateUpper = Math.min(candidateUpper, (constraint.upper - minOthers) / coefficient);
      } else if (coefficient < -tolerance) {
        candidateLower = Math.max(candidateLower, (constraint.upper - minOthers) / coefficient);
      }
    }

    if (Number.isFinite(constraint.lower)) {
      if (coefficient > tolerance) {
        candidateLower = Math.max(candidateLower, (constraint.lower - maxOthers) / coefficient);
      } else if (coefficient < -tolerance) {
        candidateUpper = Math.min(candidateUpper, (constraint.lower - maxOthers) / coefficient);
      }
    }

    if (candidateLower > candidateUpper + tolerance) {
      return { infeasible: true };
    }

    if (problem.variableTypes[variableIndex] === "binary") {
      const collapsed = collapseBinaryBounds(candidateLower, candidateUpper, options.integralityTolerance);
      if (collapsed.infeasible) {
        return { infeasible: true };
      }
      candidateLower = collapsed.lowerBound;
      candidateUpper = collapsed.upperBound;
    }

    if (candidateLower > problem.lowerBounds[variableIndex] + tolerance) {
      problem.lowerBounds[variableIndex] = candidateLower;
      changed = true;
    }
    if (candidateUpper < problem.upperBounds[variableIndex] - tolerance) {
      problem.upperBounds[variableIndex] = candidateUpper;
      changed = true;
    }
  }

  return { changed };
}

function presolveProblem(normalized, options) {
  const problem = createWorkingProblem(normalized);
  const notes = [];

  for (let index = 0; index < problem.variableNames.length; index += 1) {
    if (problem.variableTypes[index] === "binary") {
      const collapsed = collapseBinaryBounds(problem.lowerBounds[index], problem.upperBounds[index], options.integralityTolerance);
      if (collapsed.infeasible) {
        return { status: ILP_STATUSES.INFEASIBLE, note: "Binary bounds are infeasible during presolve.", problem, notes };
      }
      problem.lowerBounds[index] = collapsed.lowerBound;
      problem.upperBounds[index] = collapsed.upperBound;
    }
  }

  for (let pass = 0; pass < options.presolvePassLimit; pass += 1) {
    let changed = false;

    for (let index = problem.variableNames.length - 1; index >= 0; index -= 1) {
      if (approximatelyEqual(problem.lowerBounds[index], problem.upperBounds[index], options.feasibilityTolerance)) {
        substituteFixedVariable(problem, index, problem.lowerBounds[index]);
        changed = true;
        notes.push("Applied fixed-variable elimination.");
      }
    }

    for (let constraintIndex = problem.constraints.length - 1; constraintIndex >= 0; constraintIndex -= 1) {
      const result = tightenConstraintBounds(problem, problem.constraints[constraintIndex], options);
      if (result.infeasible) {
        return { status: ILP_STATUSES.INFEASIBLE, note: `Presolve proved constraint ${problem.constraints[constraintIndex].name} infeasible.`, problem, notes };
      }
      if (result.redundant) {
        problem.constraints.splice(constraintIndex, 1);
        changed = true;
        notes.push("Removed a redundant constraint during presolve.");
        continue;
      }
      if (result.changed) {
        changed = true;
      }
    }

    if (!changed) {
      return { status: null, note: "Presolve stabilized.", problem, notes };
    }
  }

  notes.push("Presolve reached its pass limit and stopped with the reduced model.");
  return { status: null, note: "Presolve pass limit reached.", problem, notes };
}

function buildLPRelaxation(problem, lowerBounds, upperBounds, options) {
  const variableCount = problem.variableNames.length;
  const rows = [];
  let objectiveOffset = problem.objectiveConstant;

  for (let index = 0; index < variableCount; index += 1) {
    const lowerBound = lowerBounds[index];
    const upperBound = upperBounds[index];
    if (lowerBound > upperBound + options.feasibilityTolerance) {
      return { status: ILP_STATUSES.INFEASIBLE };
    }
    objectiveOffset += problem.objectiveCoefficients[index] * lowerBound;
  }

  for (let index = 0; index < variableCount; index += 1) {
    const shiftedUpperBound = upperBounds[index] - lowerBounds[index];
    if (Number.isFinite(shiftedUpperBound)) {
      const coefficients = Array.from({ length: variableCount }, (_, column) => (column === index ? 1 : 0));
      rows.push({ coefficients, relation: "<=", rhs: shiftedUpperBound, name: `ub_${problem.variableNames[index]}` });
    }
  }

  for (const constraint of problem.constraints) {
    let shift = 0;
    for (let index = 0; index < variableCount; index += 1) {
      shift += constraint.coefficients[index] * lowerBounds[index];
    }

    if (Number.isFinite(constraint.upper)) {
      rows.push({
        coefficients: constraint.coefficients.slice(),
        relation: "<=",
        rhs: constraint.upper - shift,
        name: `${constraint.name}_upper`,
      });
    }
    if (Number.isFinite(constraint.lower)) {
      rows.push({
        coefficients: constraint.coefficients.map((coefficient) => -coefficient),
        relation: "<=",
        rhs: shift - constraint.lower,
        name: `${constraint.name}_lower`,
      });
    }
  }

  const normalizedRows = [];
  for (const row of rows) {
    let coefficients = row.coefficients.slice();
    let relation = row.relation;
    let rhs = row.rhs;

    if (rhs < -options.feasibilityTolerance) {
      coefficients = coefficients.map((coefficient) => -coefficient);
      relation = relation === "<=" ? ">=" : "<=";
      rhs = -rhs;
    }

    const allZero = coefficients.every((coefficient) => Math.abs(coefficient) <= options.feasibilityTolerance);
    if (allZero) {
      if (relation === "<=" && rhs >= -options.feasibilityTolerance) {
        continue;
      }
      if (relation === ">=" && rhs <= options.feasibilityTolerance) {
        continue;
      }
      return { status: ILP_STATUSES.INFEASIBLE };
    }

    normalizedRows.push({ coefficients, relation, rhs, name: row.name });
  }

  return {
    status: null,
    variableCount,
    rows: normalizedRows,
    objectiveCoefficients: problem.objectiveCoefficients.map((coefficient) => -coefficient),
    objectiveOffset,
    lowerBounds,
    upperBounds,
  };
}

function buildSimplexTableau(lp) {
  const rowCount = lp.rows.length;
  const variableCount = lp.variableCount;
  let totalColumns = variableCount;

  for (const row of lp.rows) {
    if (row.relation === "<=") {
      totalColumns += 1;
    } else if (row.relation === ">=") {
      totalColumns += 2;
    } else {
      totalColumns += 1;
    }
  }

  const rhsColumn = totalColumns;
  const rows = Array.from({ length: rowCount }, () => Array.from({ length: totalColumns + 1 }, () => 0));
  const basis = Array.from({ length: rowCount }, () => -1);
  const artificialColumns = [];
  let nextColumn = variableCount;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = lp.rows[rowIndex];
    for (let columnIndex = 0; columnIndex < variableCount; columnIndex += 1) {
      rows[rowIndex][columnIndex] = row.coefficients[columnIndex] || 0;
    }

    if (row.relation === "<=") {
      rows[rowIndex][nextColumn] = 1;
      basis[rowIndex] = nextColumn;
      nextColumn += 1;
    } else if (row.relation === ">=") {
      rows[rowIndex][nextColumn] = -1;
      nextColumn += 1;
      rows[rowIndex][nextColumn] = 1;
      basis[rowIndex] = nextColumn;
      artificialColumns.push(nextColumn);
      nextColumn += 1;
    } else {
      rows[rowIndex][nextColumn] = 1;
      basis[rowIndex] = nextColumn;
      artificialColumns.push(nextColumn);
      nextColumn += 1;
    }

    rows[rowIndex][rhsColumn] = row.rhs;
  }

  return { rows, basis, artificialColumns, variableCount };
}

function computeReducedCosts(rows, basis, costs) {
  const totalColumns = rows.length === 0 ? costs.length : rows[0].length - 1;
  const rhsColumn = totalColumns;
  const reducedCosts = costs.slice();
  let objectiveValue = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const basicColumn = basis[rowIndex];
    const basicCost = costs[basicColumn] || 0;
    if (basicCost === 0) {
      continue;
    }

    objectiveValue += basicCost * rows[rowIndex][rhsColumn];
    for (let columnIndex = 0; columnIndex < totalColumns; columnIndex += 1) {
      reducedCosts[columnIndex] -= basicCost * rows[rowIndex][columnIndex];
    }
  }

  return { reducedCosts, objectiveValue };
}

function pivotTableau(rows, pivotRow, pivotColumn) {
  const rhsColumn = rows[0].length - 1;
  const pivotValue = rows[pivotRow][pivotColumn];

  for (let columnIndex = 0; columnIndex <= rhsColumn; columnIndex += 1) {
    rows[pivotRow][columnIndex] /= pivotValue;
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (rowIndex === pivotRow) {
      continue;
    }

    const factor = rows[rowIndex][pivotColumn];
    if (factor === 0) {
      continue;
    }

    for (let columnIndex = 0; columnIndex <= rhsColumn; columnIndex += 1) {
      rows[rowIndex][columnIndex] -= factor * rows[pivotRow][columnIndex];
    }
  }
}

function runSimplex(rows, basis, costs, options, state) {
  const totalColumns = rows.length === 0 ? costs.length : rows[0].length - 1;
  const rhsColumn = totalColumns;

  while (true) {
    if (options.iterationLimit > 0 && state.iterations >= options.iterationLimit) {
      return { status: ILP_STATUSES.ITERATION_LIMIT };
    }

    const { reducedCosts, objectiveValue } = computeReducedCosts(rows, basis, costs);
    const basisSet = new Set(basis);
    let enteringColumn = -1;

    for (let columnIndex = 0; columnIndex < totalColumns; columnIndex += 1) {
      if (basisSet.has(columnIndex)) {
        continue;
      }
      if (reducedCosts[columnIndex] > options.optimalityTolerance) {
        enteringColumn = columnIndex;
        break;
      }
    }

    if (enteringColumn === -1) {
      return { status: ILP_STATUSES.OPTIMAL, objectiveValue };
    }

    let leavingRow = -1;
    let bestRatio = Infinity;
    let bestBasisColumn = Infinity;

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const coefficient = rows[rowIndex][enteringColumn];
      if (coefficient <= options.feasibilityTolerance) {
        continue;
      }

      const ratio = rows[rowIndex][rhsColumn] / coefficient;
      if (
        ratio < bestRatio - options.feasibilityTolerance
        || (
          approximatelyEqual(ratio, bestRatio, options.feasibilityTolerance)
          && basis[rowIndex] < bestBasisColumn
        )
      ) {
        bestRatio = ratio;
        bestBasisColumn = basis[rowIndex];
        leavingRow = rowIndex;
      }
    }

    if (leavingRow === -1) {
      return { status: ILP_STATUSES.UNBOUNDED };
    }

    pivotTableau(rows, leavingRow, enteringColumn);
    basis[leavingRow] = enteringColumn;
    state.iterations += 1;
  }
}

function removeArtificialColumns(rows, basis, artificialColumns, options) {
  if (artificialColumns.length === 0) {
    return { rows, basis, artificialColumns: [] };
  }

  const rhsColumn = rows[0].length - 1;
  const artificialSet = new Set(artificialColumns);
  const droppedRows = new Set();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (!artificialSet.has(basis[rowIndex])) {
      continue;
    }

    let enteringColumn = -1;
    for (let columnIndex = 0; columnIndex < rhsColumn; columnIndex += 1) {
      if (artificialSet.has(columnIndex)) {
        continue;
      }
      if (Math.abs(rows[rowIndex][columnIndex]) > options.feasibilityTolerance) {
        enteringColumn = columnIndex;
        break;
      }
    }

    if (enteringColumn >= 0) {
      pivotTableau(rows, rowIndex, enteringColumn);
      basis[rowIndex] = enteringColumn;
      continue;
    }

    if (Math.abs(rows[rowIndex][rhsColumn]) <= options.feasibilityTolerance) {
      droppedRows.add(rowIndex);
      continue;
    }

    return { infeasible: true };
  }

  const keptColumns = [];
  const columnMap = new Map();
  for (let columnIndex = 0; columnIndex < rhsColumn; columnIndex += 1) {
    if (artificialSet.has(columnIndex)) {
      continue;
    }
    columnMap.set(columnIndex, keptColumns.length);
    keptColumns.push(columnIndex);
  }

  const keptRows = [];
  const nextBasis = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (droppedRows.has(rowIndex)) {
      continue;
    }
    keptRows.push(keptColumns.map((columnIndex) => rows[rowIndex][columnIndex]).concat(rows[rowIndex][rhsColumn]));
    nextBasis.push(columnMap.get(basis[rowIndex]));
  }

  return { rows: keptRows, basis: nextBasis, artificialColumns: [] };
}

function extractPrimalValues(rows, basis, columnCount) {
  const rhsColumn = rows.length === 0 ? columnCount : rows[0].length - 1;
  const values = Array.from({ length: columnCount }, () => 0);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const basicColumn = basis[rowIndex];
    if (basicColumn >= 0 && basicColumn < columnCount) {
      values[basicColumn] = rows[rowIndex][rhsColumn];
    }
  }
  return values;
}

function solveLPRelaxation(problem, lowerBounds, upperBounds, options, state) {
  const lp = buildLPRelaxation(problem, lowerBounds, upperBounds, options);
  if (lp.status) {
    return { status: lp.status };
  }

  if (lp.variableCount === 0) {
    return {
      status: ILP_STATUSES.OPTIMAL,
      objective: lp.objectiveOffset,
      values: [],
    };
  }

  const simplexModel = buildSimplexTableau(lp);
  const phaseOneCosts = Array.from({ length: simplexModel.rows.length === 0 ? lp.variableCount : simplexModel.rows[0].length - 1 }, () => 0);
  for (const artificialColumn of simplexModel.artificialColumns) {
    phaseOneCosts[artificialColumn] = -1;
  }

  const phaseOne = runSimplex(simplexModel.rows, simplexModel.basis, phaseOneCosts, options, state);
  if (phaseOne.status === ILP_STATUSES.ITERATION_LIMIT) {
    return { status: ILP_STATUSES.ITERATION_LIMIT };
  }
  if (phaseOne.status === ILP_STATUSES.UNBOUNDED) {
    return { status: ILP_STATUSES.INFEASIBLE };
  }
  if (phaseOne.objectiveValue < -options.feasibilityTolerance) {
    return { status: ILP_STATUSES.INFEASIBLE };
  }

  const noArtificials = removeArtificialColumns(simplexModel.rows, simplexModel.basis, simplexModel.artificialColumns, options);
  if (noArtificials.infeasible) {
    return { status: ILP_STATUSES.INFEASIBLE };
  }

  const phaseTwoCosts = Array.from({ length: noArtificials.rows.length === 0 ? lp.variableCount : noArtificials.rows[0].length - 1 }, (_, columnIndex) => (
    columnIndex < lp.variableCount ? lp.objectiveCoefficients[columnIndex] : 0
  ));

  const phaseTwo = runSimplex(noArtificials.rows, noArtificials.basis, phaseTwoCosts, options, state);
  if (phaseTwo.status !== ILP_STATUSES.OPTIMAL) {
    return { status: phaseTwo.status };
  }

  const shiftedValues = extractPrimalValues(noArtificials.rows, noArtificials.basis, lp.variableCount);
  const values = shiftedValues.map((value, index) => sanitizeValue(value + lowerBounds[index], lowerBounds[index], upperBounds[index], options.feasibilityTolerance));

  return {
    status: ILP_STATUSES.OPTIMAL,
    objective: lp.objectiveOffset - phaseTwo.objectiveValue,
    values,
  };
}

function computeObjective(problem, values) {
  let objective = problem.objectiveConstant;
  for (let index = 0; index < values.length; index += 1) {
    objective += problem.objectiveCoefficients[index] * values[index];
  }
  return objective;
}

function computeTotalViolation(problem, values, lowerBounds, upperBounds) {
  let violation = 0;

  for (let index = 0; index < values.length; index += 1) {
    if (values[index] < lowerBounds[index]) {
      violation += lowerBounds[index] - values[index];
    }
    if (values[index] > upperBounds[index]) {
      violation += values[index] - upperBounds[index];
    }
  }

  for (const constraint of problem.constraints) {
    let lhs = 0;
    for (let index = 0; index < values.length; index += 1) {
      lhs += constraint.coefficients[index] * values[index];
    }
    if (Number.isFinite(constraint.lower) && lhs < constraint.lower) {
      violation += constraint.lower - lhs;
    }
    if (Number.isFinite(constraint.upper) && lhs > constraint.upper) {
      violation += lhs - constraint.upper;
    }
  }

  return violation;
}

function isFeasibleAssignment(problem, values, lowerBounds, upperBounds, options) {
  return computeTotalViolation(problem, values, lowerBounds, upperBounds) <= options.feasibilityTolerance;
}

function buildRoundedHeuristicCandidate(problem, lpValues, lowerBounds, upperBounds, options) {
  if (!options.enableRoundingHeuristic) {
    return null;
  }

  const values = lpValues.map((value, index) => {
    if (problem.variableTypes[index] === "binary") {
      return value >= 0.5 ? 1 : 0;
    }
    return sanitizeValue(value, lowerBounds[index], upperBounds[index], options.feasibilityTolerance);
  });

  if (isFeasibleAssignment(problem, values, lowerBounds, upperBounds, options)) {
    return { values, objective: computeObjective(problem, values) };
  }

  const mutableIndexes = [];
  for (let index = 0; index < values.length; index += 1) {
    if (problem.variableTypes[index] !== "binary") {
      continue;
    }
    if (approximatelyEqual(lowerBounds[index], upperBounds[index], options.feasibilityTolerance)) {
      continue;
    }
    mutableIndexes.push(index);
  }

  for (let attempt = 0; attempt < mutableIndexes.length * 4; attempt += 1) {
    const currentViolation = computeTotalViolation(problem, values, lowerBounds, upperBounds);
    if (currentViolation <= options.feasibilityTolerance) {
      return { values, objective: computeObjective(problem, values) };
    }

    let bestMove = null;

    for (const index of mutableIndexes) {
      for (const targetValue of [0, 1]) {
        if (values[index] === targetValue) {
          continue;
        }
        const candidate = values.slice();
        candidate[index] = targetValue;
        const nextViolation = computeTotalViolation(problem, candidate, lowerBounds, upperBounds);
        const nextObjective = computeObjective(problem, candidate);

        if (
          !bestMove
          || nextViolation < bestMove.violation - options.feasibilityTolerance
          || (
            approximatelyEqual(nextViolation, bestMove.violation, options.feasibilityTolerance)
            && nextObjective < bestMove.objective - options.optimalityTolerance
          )
        ) {
          bestMove = { index, targetValue, violation: nextViolation, objective: nextObjective };
        }
      }
    }

    if (!bestMove || bestMove.violation >= currentViolation - options.feasibilityTolerance) {
      break;
    }

    values[bestMove.index] = bestMove.targetValue;
  }

  if (isFeasibleAssignment(problem, values, lowerBounds, upperBounds, options)) {
    return { values, objective: computeObjective(problem, values) };
  }

  return null;
}

function findMostFractionalBinaryVariable(problem, values, lowerBounds, upperBounds, options) {
  let bestIndex = -1;
  let bestFractionality = -1;

  for (let index = 0; index < values.length; index += 1) {
    if (problem.variableTypes[index] !== "binary") {
      continue;
    }
    if (approximatelyEqual(lowerBounds[index], upperBounds[index], options.feasibilityTolerance)) {
      continue;
    }

    const value = sanitizeValue(values[index], lowerBounds[index], upperBounds[index], options.feasibilityTolerance);
    const fractionality = Math.min(Math.abs(value), Math.abs(1 - value));
    if (fractionality <= options.integralityTolerance) {
      continue;
    }
    if (fractionality > bestFractionality + options.integralityTolerance) {
      bestFractionality = fractionality;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function expandAssignment(problem, values, options) {
  const allValues = problem.fixedValues.slice();
  for (let index = 0; index < problem.activeToOriginal.length; index += 1) {
    const originalIndex = problem.activeToOriginal[index];
    allValues[originalIndex] = values[index];
  }

  for (let index = 0; index < allValues.length; index += 1) {
    if (allValues[index] == null) {
      allValues[index] = 0;
    }
    if (problem.originalVariableTypes[index] === "binary") {
      allValues[index] = allValues[index] >= 0.5 ? 1 : 0;
    } else if (!Number.isFinite(allValues[index])) {
      allValues[index] = 0;
    } else if (approximatelyEqual(allValues[index], 0, options.feasibilityTolerance)) {
      allValues[index] = 0;
    }
  }

  return {
    values: allValues,
    assignment: Object.fromEntries(problem.originalVariableNames.map((name, index) => [name, allValues[index]])),
  };
}

function buildResult(status, problem, rawProblem, state, values, objective, bestBound, note, certificate = null) {
  const expanded = values ? expandAssignment(problem, values, state.options) : { assignment: null, values: null };
  return {
    status,
    objective: Number.isFinite(objective) ? objective : null,
    assignment: expanded.assignment,
    values: expanded.values,
    bestBound: Number.isFinite(bestBound) ? bestBound : null,
    nodesVisited: state.nodesVisited,
    iterations: state.iterations,
    certificate,
    note,
    problem: rawProblem || null,
  };
}

function solvePresolvedProblem(problem, rawProblem, options) {
  const state = {
    iterations: 0,
    nodesVisited: 0,
    options,
  };

  if (problem.variableNames.length === 0) {
    return buildResult(
      ILP_STATUSES.OPTIMAL,
      problem,
      rawProblem,
      state,
      [],
      problem.objectiveConstant,
      problem.objectiveConstant,
      "Solved entirely during presolve."
    );
  }

  let incumbent = null;
  const queue = [{
    lowerBounds: problem.lowerBounds.slice(),
    upperBounds: problem.upperBounds.slice(),
    lowerBound: -Infinity,
    depth: 0,
  }];

  while (queue.length > 0) {
    let bestNodeIndex = 0;
    for (let index = 1; index < queue.length; index += 1) {
      if (queue[index].lowerBound < queue[bestNodeIndex].lowerBound - options.optimalityTolerance) {
        bestNodeIndex = index;
      }
    }

    const node = queue.splice(bestNodeIndex, 1)[0];
    state.nodesVisited += 1;

    const relaxation = solveLPRelaxation(problem, node.lowerBounds, node.upperBounds, options, state);
    if (relaxation.status === ILP_STATUSES.ITERATION_LIMIT) {
      const queueBestBound = queue.length > 0 ? Math.min(...queue.map((entry) => entry.lowerBound)) : Infinity;
      const bestBound = Number.isFinite(queueBestBound)
        ? queueBestBound
        : incumbent
          ? incumbent.objective
          : null;
      return buildResult(
        ILP_STATUSES.ITERATION_LIMIT,
        problem,
        rawProblem,
        state,
        incumbent ? incumbent.values : null,
        incumbent ? incumbent.objective : null,
        bestBound,
        "Search hit iterationLimit before proving optimality."
      );
    }
    if (relaxation.status === ILP_STATUSES.INFEASIBLE) {
      continue;
    }
    if (relaxation.status === ILP_STATUSES.UNBOUNDED) {
      return buildResult(
        ILP_STATUSES.UNBOUNDED,
        problem,
        rawProblem,
        state,
        null,
        null,
        null,
        "The LP relaxation is unbounded, so the current model is not well-posed."
      );
    }

    if (incumbent && relaxation.objective >= incumbent.objective - options.optimalityTolerance) {
      continue;
    }

    const heuristic = buildRoundedHeuristicCandidate(problem, relaxation.values, node.lowerBounds, node.upperBounds, options);
    if (heuristic && (!incumbent || heuristic.objective < incumbent.objective - options.optimalityTolerance)) {
      incumbent = heuristic;
    }

    const branchingIndex = findMostFractionalBinaryVariable(problem, relaxation.values, node.lowerBounds, node.upperBounds, options);
    if (branchingIndex === -1) {
      incumbent = {
        values: relaxation.values,
        objective: relaxation.objective,
      };
      continue;
    }

    const downBounds = node.upperBounds.slice();
    downBounds[branchingIndex] = 0;
    if (node.lowerBounds[branchingIndex] <= 0 + options.feasibilityTolerance) {
      queue.push({
        lowerBounds: node.lowerBounds.slice(),
        upperBounds: downBounds,
        lowerBound: relaxation.objective,
        depth: node.depth + 1,
      });
    }

    const upBounds = node.lowerBounds.slice();
    upBounds[branchingIndex] = 1;
    if (node.upperBounds[branchingIndex] >= 1 - options.feasibilityTolerance) {
      queue.push({
        lowerBounds: upBounds,
        upperBounds: node.upperBounds.slice(),
        lowerBound: relaxation.objective,
        depth: node.depth + 1,
      });
    }
  }

  if (!incumbent) {
    return buildResult(
      ILP_STATUSES.INFEASIBLE,
      problem,
      rawProblem,
      state,
      null,
      null,
      null,
      "Presolve and branch-and-bound proved the model infeasible."
    );
  }

  return buildResult(
    ILP_STATUSES.OPTIMAL,
    problem,
    rawProblem,
    state,
    incumbent.values,
    incumbent.objective,
    incumbent.objective,
    "Solved with presolve, two-phase simplex relaxations, and branch-and-bound."
  );
}

function solveILP(problem) {
  const normalized = normalizeProblem(problem);
  const presolved = presolveProblem(normalized, normalized.options);
  if (presolved.status === ILP_STATUSES.INFEASIBLE) {
    return buildResult(
      ILP_STATUSES.INFEASIBLE,
      presolved.problem,
      normalized.rawProblem,
      { iterations: 0, nodesVisited: 0, options: normalized.options },
      null,
      null,
      null,
      presolved.note
    );
  }

  return solvePresolvedProblem(presolved.problem, normalized.rawProblem, normalized.options);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ILP_STATUSES,
    DEFAULT_ILP_OPTIONS,
    solveILP,
  };
}

if (typeof self !== "undefined") {
  self.solveILP = solveILP;
}