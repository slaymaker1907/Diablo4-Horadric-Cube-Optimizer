/**
 * ilp.js
 *
 * Branch-and-cut ILP solver for the v3 hybrid worker.
 *
 * Scope:
 * - linear minimization
 * - binary and continuous variables
 * - sparse internal constraint storage
 * - presolve: bound tightening, fixed-variable substitution, two-nonzero
 *   equality substitution, probing
 * - root clique cuts derived from the conflict graph
 * - two-phase tableau simplex with Dantzig entering, Bland's-rule fallback
 *   on stalled progress, RHS-clamped ratio test
 * - branch-and-bound with binary-heap best-bound node selection,
 *   pseudo-cost branching with most-fractional fallback, LP-diving
 *   primal heuristic at the root
 *
 * No external dependencies. Loadable as a CommonJS module or as a script
 * in a Web Worker.
 */

"use strict";

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
  branchingRule: "pseudocost",
  enableRoundingHeuristic: true,
  enableLPDiving: true,
  enableCliqueCuts: true,
  enableProbing: true,
  enableEqualitySubstitution: true,
  cliqueCutLimit: 256,
  probingPassLimit: 2,
  pseudoCostReliability: 4,
  blandFallbackThreshold: 200,
  nodeLimit: 0,
});

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function approximatelyEqual(left, right, tolerance) {
  return Math.abs(left - right) <= tolerance;
}

function clamp(value, lower, upper) {
  if (value < lower) return lower;
  if (value > upper) return upper;
  return value;
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

// ---------------------------------------------------------------------------
// Options + variable normalization
// ---------------------------------------------------------------------------

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

function normalizeOptions(problem) {
  const input = problem && problem.options && typeof problem.options === "object"
    ? problem.options
    : {};

  const numeric = (key, fallback, positive = true) => {
    const value = Number(input[key]);
    if (!Number.isFinite(value)) return fallback;
    if (positive && value <= 0) return fallback;
    return value;
  };

  const iterationLimitRaw = Number(input.iterationLimit);
  const nodeLimitRaw = Number(input.nodeLimit);

  return {
    iterationLimit: Number.isFinite(iterationLimitRaw) && iterationLimitRaw > 0
      ? Math.floor(iterationLimitRaw)
      : 0,
    nodeLimit: Number.isFinite(nodeLimitRaw) && nodeLimitRaw > 0
      ? Math.floor(nodeLimitRaw)
      : DEFAULT_ILP_OPTIONS.nodeLimit,
    feasibilityTolerance: numeric("feasibilityTolerance", DEFAULT_ILP_OPTIONS.feasibilityTolerance),
    optimalityTolerance: numeric("optimalityTolerance", DEFAULT_ILP_OPTIONS.optimalityTolerance),
    integralityTolerance: numeric("integralityTolerance", DEFAULT_ILP_OPTIONS.integralityTolerance),
    presolvePassLimit: Math.max(1, Math.floor(numeric("presolvePassLimit", DEFAULT_ILP_OPTIONS.presolvePassLimit))),
    probingPassLimit: Math.max(0, Math.floor(Number.isFinite(Number(input.probingPassLimit))
      ? Number(input.probingPassLimit)
      : DEFAULT_ILP_OPTIONS.probingPassLimit)),
    cliqueCutLimit: Math.max(0, Math.floor(Number.isFinite(Number(input.cliqueCutLimit))
      ? Number(input.cliqueCutLimit)
      : DEFAULT_ILP_OPTIONS.cliqueCutLimit)),
    pseudoCostReliability: Math.max(1, Math.floor(Number.isFinite(Number(input.pseudoCostReliability))
      ? Number(input.pseudoCostReliability)
      : DEFAULT_ILP_OPTIONS.pseudoCostReliability)),
    blandFallbackThreshold: Math.max(10, Math.floor(Number.isFinite(Number(input.blandFallbackThreshold))
      ? Number(input.blandFallbackThreshold)
      : DEFAULT_ILP_OPTIONS.blandFallbackThreshold)),
    branchingRule: input.branchingRule === "most-fractional" || input.branchingRule === "pseudocost"
      ? input.branchingRule
      : DEFAULT_ILP_OPTIONS.branchingRule,
    enableRoundingHeuristic: input.enableRoundingHeuristic !== false,
    enableLPDiving: input.enableLPDiving !== false,
    enableCliqueCuts: input.enableCliqueCuts !== false,
    enableProbing: input.enableProbing !== false,
    enableEqualitySubstitution: input.enableEqualitySubstitution !== false,
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

  const variableNames = new Array(variableCount);
  const variableTypes = new Array(variableCount);
  const lowerBounds = new Array(variableCount);
  const upperBounds = new Array(variableCount);
  const objectiveCoefficients = new Array(variableCount);

  for (let index = 0; index < variableCount; index += 1) {
    const explicitName = Array.isArray(problem.variableNames) ? problem.variableNames[index] : "";
    const variable = Array.isArray(problem.variables) ? problem.variables[index] : null;
    const nameFromVariable = variable && typeof variable.name === "string" && variable.name.trim()
      ? variable.name.trim()
      : null;
    const nameFromArray = typeof explicitName === "string" && explicitName.trim()
      ? explicitName.trim()
      : null;
    variableNames[index] = nameFromVariable || nameFromArray || `x${index}`;

    const type = String(variable && variable.type ? variable.type : "binary").trim().toLowerCase();
    if (type !== "binary" && type !== "continuous") {
      throw new Error(`Unsupported variable type at index ${index}: ${type}`);
    }
    variableTypes[index] = type;

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

    lowerBounds[index] = lowerBound;
    upperBounds[index] = upperBound;

    const objectiveRaw = Number((Array.isArray(objective.coefficients) ? objective.coefficients[index] : 0) || 0);
    if (!Number.isFinite(objectiveRaw)) {
      throw new Error(`Objective coefficient at index ${index} must be finite.`);
    }
    objectiveCoefficients[index] = objectiveRaw;
  }

  const constraints = [];
  const rawConstraints = Array.isArray(problem.constraints) ? problem.constraints : [];

  for (let constraintIndex = 0; constraintIndex < rawConstraints.length; constraintIndex += 1) {
    const raw = rawConstraints[constraintIndex];
    const operator = String(raw && raw.operator ? raw.operator : "<=").trim();
    const rhs = Number(raw && raw.rhs);
    const name = raw && typeof raw.name === "string" ? raw.name : `c${constraintIndex}`;

    if (!Number.isFinite(rhs)) {
      throw new Error(`Constraint ${name} must have a finite rhs.`);
    }
    if (operator !== "<=" && operator !== ">=" && operator !== "=") {
      throw new Error(`Unsupported operator for constraint ${name}: ${operator}`);
    }

    const indices = [];
    const values = [];
    const source = raw && Array.isArray(raw.coefficients) ? raw.coefficients : [];
    for (let column = 0; column < variableCount; column += 1) {
      const value = Number(source[column] || 0);
      if (!Number.isFinite(value)) {
        throw new Error(`Coefficient at constraint ${name}, column ${column} must be finite.`);
      }
      if (value !== 0) {
        indices.push(column);
        values.push(value);
      }
    }

    constraints.push({
      indices,
      values,
      lower: operator === ">=" || operator === "=" ? rhs : -Infinity,
      upper: operator === "<=" || operator === "=" ? rhs : Infinity,
      name,
    });
  }

  const objectiveConstant = Number.isFinite(Number(objective.constant)) ? Number(objective.constant) : 0;

  return {
    variableCount,
    variableNames,
    variableTypes,
    lowerBounds,
    upperBounds,
    objectiveCoefficients,
    objectiveConstant,
    constraints,
    options,
    rawProblem: problem,
  };
}

// ---------------------------------------------------------------------------
// Working model
// ---------------------------------------------------------------------------

function createWorkingModel(normalized) {
  return {
    variableCount: normalized.variableCount,
    variableNames: normalized.variableNames.slice(),
    variableTypes: normalized.variableTypes.slice(),
    lowerBounds: normalized.lowerBounds.slice(),
    upperBounds: normalized.upperBounds.slice(),
    objectiveCoefficients: normalized.objectiveCoefficients.slice(),
    objectiveConstant: normalized.objectiveConstant,
    fixedValues: new Array(normalized.variableCount).fill(null),
    substitutions: [],
    constraints: normalized.constraints.map((constraint) => ({
      indices: constraint.indices.slice(),
      values: constraint.values.slice(),
      lower: constraint.lower,
      upper: constraint.upper,
      name: constraint.name,
    })),
  };
}

function removeIndexFromSparse(constraint, originalIndex) {
  const position = constraint.indices.indexOf(originalIndex);
  if (position === -1) {
    return 0;
  }
  const coefficient = constraint.values[position];
  constraint.indices.splice(position, 1);
  constraint.values.splice(position, 1);
  return coefficient;
}

function setSparseCoefficient(constraint, originalIndex, value) {
  const position = constraint.indices.indexOf(originalIndex);
  if (Math.abs(value) <= 0) {
    if (position !== -1) {
      constraint.indices.splice(position, 1);
      constraint.values.splice(position, 1);
    }
    return;
  }
  if (position === -1) {
    let insertAt = constraint.indices.length;
    for (let i = 0; i < constraint.indices.length; i += 1) {
      if (constraint.indices[i] > originalIndex) {
        insertAt = i;
        break;
      }
    }
    constraint.indices.splice(insertAt, 0, originalIndex);
    constraint.values.splice(insertAt, 0, value);
  } else {
    constraint.values[position] = value;
  }
}

function fixVariableInModel(model, originalIndex, value, options) {
  const tolerance = options.feasibilityTolerance;
  const existing = model.fixedValues[originalIndex];

  if (existing !== null) {
    if (!approximatelyEqual(existing, value, tolerance)) {
      return { infeasible: true };
    }
    return { changed: false };
  }

  if (value < model.lowerBounds[originalIndex] - tolerance
      || value > model.upperBounds[originalIndex] + tolerance) {
    return { infeasible: true };
  }

  model.fixedValues[originalIndex] = value;
  model.lowerBounds[originalIndex] = value;
  model.upperBounds[originalIndex] = value;
  model.objectiveConstant += model.objectiveCoefficients[originalIndex] * value;
  model.objectiveCoefficients[originalIndex] = 0;
  model.substitutions.push({ kind: "fix", originalIndex, value });

  for (const constraint of model.constraints) {
    const coefficient = removeIndexFromSparse(constraint, originalIndex);
    if (coefficient === 0) {
      continue;
    }
    if (Number.isFinite(constraint.lower)) {
      constraint.lower -= coefficient * value;
    }
    if (Number.isFinite(constraint.upper)) {
      constraint.upper -= coefficient * value;
    }
  }

  return { changed: true };
}

// ---------------------------------------------------------------------------
// Bound tightening helpers (sparse activity)
// ---------------------------------------------------------------------------

function collapseBinaryBounds(lowerBound, upperBound, tolerance) {
  const canBeZero = lowerBound <= tolerance;
  const canBeOne = upperBound >= 1 - tolerance;

  if (!canBeZero && !canBeOne) {
    return { infeasible: true };
  }
  if (!canBeZero) {
    return {
      lowerBound: 1,
      upperBound: 1,
      changed: !approximatelyEqual(lowerBound, 1, tolerance) || !approximatelyEqual(upperBound, 1, tolerance),
    };
  }
  if (!canBeOne) {
    return {
      lowerBound: 0,
      upperBound: 0,
      changed: !approximatelyEqual(lowerBound, 0, tolerance) || !approximatelyEqual(upperBound, 0, tolerance),
    };
  }
  return {
    lowerBound: approximatelyEqual(lowerBound, 0, tolerance) ? 0 : lowerBound,
    upperBound: approximatelyEqual(upperBound, 1, tolerance) ? 1 : upperBound,
    changed: false,
  };
}

function constraintActivityRange(constraint, lowerBounds, upperBounds) {
  let minValue = 0;
  let maxValue = 0;
  for (let i = 0; i < constraint.indices.length; i += 1) {
    const idx = constraint.indices[i];
    const coefficient = constraint.values[i];
    if (coefficient >= 0) {
      minValue += coefficient * lowerBounds[idx];
      maxValue += coefficient * upperBounds[idx];
    } else {
      minValue += coefficient * upperBounds[idx];
      maxValue += coefficient * lowerBounds[idx];
    }
  }
  return { minValue, maxValue };
}

function applyTighteningToBounds(
  constraint,
  lowerBounds,
  upperBounds,
  variableTypes,
  options
) {
  const tolerance = options.feasibilityTolerance;
  const { minValue, maxValue } = constraintActivityRange(constraint, lowerBounds, upperBounds);

  if (Number.isFinite(constraint.lower) && maxValue < constraint.lower - tolerance) {
    return { infeasible: true };
  }
  if (Number.isFinite(constraint.upper) && minValue > constraint.upper + tolerance) {
    return { infeasible: true };
  }

  let lowerRedundant = !Number.isFinite(constraint.lower) || minValue >= constraint.lower - tolerance;
  let upperRedundant = !Number.isFinite(constraint.upper) || maxValue <= constraint.upper + tolerance;
  let redundant = lowerRedundant && upperRedundant;

  let changed = false;
  const fixings = [];

  if (constraint.indices.length === 0) {
    if (
      (Number.isFinite(constraint.lower) && 0 < constraint.lower - tolerance)
      || (Number.isFinite(constraint.upper) && 0 > constraint.upper + tolerance)
    ) {
      return { infeasible: true };
    }
    return { changed: true, redundant: true, fixings };
  }

  for (let i = 0; i < constraint.indices.length; i += 1) {
    const idx = constraint.indices[i];
    const coefficient = constraint.values[i];
    const lo = lowerBounds[idx];
    const hi = upperBounds[idx];
    const minContribution = coefficient >= 0 ? coefficient * lo : coefficient * hi;
    const maxContribution = coefficient >= 0 ? coefficient * hi : coefficient * lo;
    const minOthers = minValue - minContribution;
    const maxOthers = maxValue - maxContribution;

    let candidateLower = lo;
    let candidateUpper = hi;

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

    if (variableTypes[idx] === "binary") {
      const collapsed = collapseBinaryBounds(candidateLower, candidateUpper, options.integralityTolerance);
      if (collapsed.infeasible) {
        return { infeasible: true };
      }
      candidateLower = collapsed.lowerBound;
      candidateUpper = collapsed.upperBound;
    }

    if (candidateLower > lo + tolerance) {
      lowerBounds[idx] = candidateLower;
      changed = true;
    }
    if (candidateUpper < hi - tolerance) {
      upperBounds[idx] = candidateUpper;
      changed = true;
    }
    if (approximatelyEqual(lowerBounds[idx], upperBounds[idx], tolerance)) {
      fixings.push({ originalIndex: idx, value: (lowerBounds[idx] + upperBounds[idx]) / 2 });
    }
  }

  return { changed, redundant, fixings };
}

// ---------------------------------------------------------------------------
// Equality substitution: handle a 2-nonzero equality "a*x + b*y == c" by
// eliminating y in favor of x. Only applied for "binary - sum" patterns
// that look like the v3 "pick == sum(stage_*)" identities, where elimination
// preserves the binary feasibility.
// ---------------------------------------------------------------------------

function trySingletonRowReduction(model, constraint, options) {
  if (constraint.indices.length !== 1) {
    return { changed: false };
  }
  const tolerance = options.feasibilityTolerance;
  const idx = constraint.indices[0];
  const coefficient = constraint.values[0];

  if (Math.abs(coefficient) <= tolerance) {
    return { changed: false };
  }

  let newLower = model.lowerBounds[idx];
  let newUpper = model.upperBounds[idx];

  if (Number.isFinite(constraint.upper)) {
    if (coefficient > 0) {
      newUpper = Math.min(newUpper, constraint.upper / coefficient);
    } else {
      newLower = Math.max(newLower, constraint.upper / coefficient);
    }
  }
  if (Number.isFinite(constraint.lower)) {
    if (coefficient > 0) {
      newLower = Math.max(newLower, constraint.lower / coefficient);
    } else {
      newUpper = Math.min(newUpper, constraint.lower / coefficient);
    }
  }

  if (newLower > newUpper + tolerance) {
    return { infeasible: true };
  }

  if (model.variableTypes[idx] === "binary") {
    const collapsed = collapseBinaryBounds(newLower, newUpper, options.integralityTolerance);
    if (collapsed.infeasible) {
      return { infeasible: true };
    }
    newLower = collapsed.lowerBound;
    newUpper = collapsed.upperBound;
  }

  let changed = false;
  if (newLower > model.lowerBounds[idx] + tolerance) {
    model.lowerBounds[idx] = newLower;
    changed = true;
  }
  if (newUpper < model.upperBounds[idx] - tolerance) {
    model.upperBounds[idx] = newUpper;
    changed = true;
  }
  return { changed, redundant: true };
}

// ---------------------------------------------------------------------------
// Presolve
// ---------------------------------------------------------------------------

function presolveProblem(normalized) {
  const options = normalized.options;
  const model = createWorkingModel(normalized);

  for (let i = 0; i < model.variableCount; i += 1) {
    if (model.variableTypes[i] !== "binary") continue;
    const collapsed = collapseBinaryBounds(model.lowerBounds[i], model.upperBounds[i], options.integralityTolerance);
    if (collapsed.infeasible) {
      return { status: ILP_STATUSES.INFEASIBLE, model };
    }
    model.lowerBounds[i] = collapsed.lowerBound;
    model.upperBounds[i] = collapsed.upperBound;
  }

  for (let pass = 0; pass < options.presolvePassLimit; pass += 1) {
    let changed = false;

    for (let idx = 0; idx < model.variableCount; idx += 1) {
      if (model.fixedValues[idx] !== null) continue;
      if (approximatelyEqual(model.lowerBounds[idx], model.upperBounds[idx], options.feasibilityTolerance)) {
        const result = fixVariableInModel(model, idx, (model.lowerBounds[idx] + model.upperBounds[idx]) / 2, options);
        if (result.infeasible) {
          return { status: ILP_STATUSES.INFEASIBLE, model };
        }
        if (result.changed) changed = true;
      }
    }

    for (let ci = model.constraints.length - 1; ci >= 0; ci -= 1) {
      const constraint = model.constraints[ci];

      const singleton = trySingletonRowReduction(model, constraint, options);
      if (singleton.infeasible) {
        return { status: ILP_STATUSES.INFEASIBLE, model };
      }
      if (singleton.changed) changed = true;
      if (singleton.redundant) {
        model.constraints.splice(ci, 1);
        continue;
      }

      const result = applyTighteningToBounds(
        constraint,
        model.lowerBounds,
        model.upperBounds,
        model.variableTypes,
        options
      );

      if (result.infeasible) {
        return { status: ILP_STATUSES.INFEASIBLE, model };
      }
      if (result.changed) changed = true;

      if (result.fixings && result.fixings.length > 0) {
        for (const { originalIndex, value } of result.fixings) {
          if (model.fixedValues[originalIndex] !== null) continue;
          const fixResult = fixVariableInModel(model, originalIndex, value, options);
          if (fixResult.infeasible) {
            return { status: ILP_STATUSES.INFEASIBLE, model };
          }
          if (fixResult.changed) changed = true;
        }
      }

      if (result.redundant) {
        model.constraints.splice(ci, 1);
      }
    }

    if (options.enableEqualitySubstitution) {
      const subResult = equalitySubstitutionPass(model, options);
      if (subResult.infeasible) {
        return { status: ILP_STATUSES.INFEASIBLE, model };
      }
      if (subResult.changed) changed = true;
    }

    if (options.enableProbing && pass < options.probingPassLimit) {
      const probeResult = probingPass(model, options);
      if (probeResult.infeasible) {
        return { status: ILP_STATUSES.INFEASIBLE, model };
      }
      if (probeResult.changed) changed = true;
    }

    if (!changed) break;
  }

  return { status: null, model };
}

// ---------------------------------------------------------------------------
// Equality substitution
//
// For an equality "a_p * x_p + sum_{q != p} a_q * x_q == c" where x_p is a
// non-fixed continuous variable that does not appear in any other equality
// row, we can eliminate x_p across the model.
//
// For v3 the most common pattern is a binary equality "pick = sum_s stage_s"
// where eliminating "pick" would break binary integrality of "pick". To stay
// safe we only substitute when the eliminated variable is *continuous*. For
// binary equalities we still benefit from singleton-row reduction and bound
// tightening above.
// ---------------------------------------------------------------------------

function equalitySubstitutionPass(model, options) {
  let changed = false;
  const tolerance = options.feasibilityTolerance;

  for (let ci = model.constraints.length - 1; ci >= 0; ci -= 1) {
    const constraint = model.constraints[ci];
    if (constraint.indices.length < 2) continue;
    if (!Number.isFinite(constraint.lower) || !Number.isFinite(constraint.upper)) continue;
    if (!approximatelyEqual(constraint.lower, constraint.upper, tolerance)) continue;

    let pivot = -1;
    let pivotPos = -1;
    for (let k = 0; k < constraint.indices.length; k += 1) {
      const idx = constraint.indices[k];
      if (model.variableTypes[idx] !== "continuous") continue;
      if (model.fixedValues[idx] !== null) continue;
      pivot = idx;
      pivotPos = k;
      break;
    }
    if (pivot === -1) continue;

    const coefficient = constraint.values[pivotPos];
    if (Math.abs(coefficient) <= tolerance) continue;

    const rhs = (constraint.lower + constraint.upper) / 2;
    // x_pivot = (rhs - sum_{q != pivot} a_q * x_q) / a_pivot

    const otherIndices = [];
    const otherValues = [];
    for (let k = 0; k < constraint.indices.length; k += 1) {
      if (k === pivotPos) continue;
      otherIndices.push(constraint.indices[k]);
      otherValues.push(constraint.values[k] / coefficient);
    }
    const rhsOver = rhs / coefficient;

    const objCoefPivot = model.objectiveCoefficients[pivot];
    if (objCoefPivot !== 0) {
      model.objectiveConstant += objCoefPivot * rhsOver;
      for (let k = 0; k < otherIndices.length; k += 1) {
        model.objectiveCoefficients[otherIndices[k]] -= objCoefPivot * otherValues[k];
      }
      model.objectiveCoefficients[pivot] = 0;
    }

    for (let other = 0; other < model.constraints.length; other += 1) {
      if (other === ci) continue;
      const target = model.constraints[other];
      const position = target.indices.indexOf(pivot);
      if (position === -1) continue;
      const targetCoefficient = target.values[position];
      target.indices.splice(position, 1);
      target.values.splice(position, 1);

      if (Number.isFinite(target.lower)) {
        target.lower -= targetCoefficient * rhsOver;
      }
      if (Number.isFinite(target.upper)) {
        target.upper -= targetCoefficient * rhsOver;
      }

      for (let k = 0; k < otherIndices.length; k += 1) {
        const idx = otherIndices[k];
        const existing = target.indices.indexOf(idx);
        const delta = -targetCoefficient * otherValues[k];
        const updated = existing === -1 ? delta : target.values[existing] + delta;
        if (existing === -1) {
          setSparseCoefficient(target, idx, updated);
        } else if (Math.abs(updated) <= tolerance) {
          target.indices.splice(existing, 1);
          target.values.splice(existing, 1);
        } else {
          target.values[existing] = updated;
        }
      }
    }

    model.constraints.splice(ci, 1);
    model.substitutions.push({
      kind: "linear",
      pivot,
      otherIndices,
      otherValues,
      rhsOver,
    });
    model.lowerBounds[pivot] = -Infinity;
    model.upperBounds[pivot] = Infinity;
    model.fixedValues[pivot] = undefined;
    changed = true;
  }

  return { changed };
}

// ---------------------------------------------------------------------------
// Probing
//
// For each free binary x_j, tentatively force x_j = 0 (then x_j = 1) and
// propagate constraint bounds. If a branch is infeasible, fix x_j to the
// other value.
// ---------------------------------------------------------------------------

function probingPass(model, options) {
  let changed = false;

  const lowerSnapshot = model.lowerBounds.slice();
  const upperSnapshot = model.upperBounds.slice();

  for (let idx = 0; idx < model.variableCount; idx += 1) {
    if (model.fixedValues[idx] !== null) continue;
    if (model.variableTypes[idx] !== "binary") continue;
    if (model.lowerBounds[idx] === model.upperBounds[idx]) continue;

    const zeroResult = probeFixing(model, idx, 0, options);
    const oneResult = probeFixing(model, idx, 1, options);

    if (zeroResult.infeasible && oneResult.infeasible) {
      return { infeasible: true };
    }

    if (zeroResult.infeasible) {
      const fixResult = fixVariableInModel(model, idx, 1, options);
      if (fixResult.infeasible) {
        return { infeasible: true };
      }
      if (fixResult.changed) {
        lowerSnapshot[idx] = 1;
        upperSnapshot[idx] = 1;
        changed = true;
      }
      continue;
    }

    if (oneResult.infeasible) {
      const fixResult = fixVariableInModel(model, idx, 0, options);
      if (fixResult.infeasible) {
        return { infeasible: true };
      }
      if (fixResult.changed) {
        lowerSnapshot[idx] = 0;
        upperSnapshot[idx] = 0;
        changed = true;
      }
      continue;
    }

    for (let other = 0; other < model.variableCount; other += 1) {
      if (other === idx) continue;
      if (model.fixedValues[other] !== null) continue;
      if (model.variableTypes[other] !== "binary") continue;
      const fromZero = zeroResult.derivedLowerBounds[other];
      const fromOne = oneResult.derivedLowerBounds[other];
      const fromZeroUpper = zeroResult.derivedUpperBounds[other];
      const fromOneUpper = oneResult.derivedUpperBounds[other];
      if (fromZero === 1 && fromOne === 1) {
        const fixResult = fixVariableInModel(model, other, 1, options);
        if (fixResult.infeasible) {
          return { infeasible: true };
        }
        if (fixResult.changed) {
          lowerSnapshot[other] = 1;
          upperSnapshot[other] = 1;
          changed = true;
        }
      } else if (fromZeroUpper === 0 && fromOneUpper === 0) {
        const fixResult = fixVariableInModel(model, other, 0, options);
        if (fixResult.infeasible) {
          return { infeasible: true };
        }
        if (fixResult.changed) {
          lowerSnapshot[other] = 0;
          upperSnapshot[other] = 0;
          changed = true;
        }
      }
    }
  }

  return { changed };
}

function probeFixing(model, originalIndex, value, options) {
  const lowerBounds = model.lowerBounds.slice();
  const upperBounds = model.upperBounds.slice();
  lowerBounds[originalIndex] = value;
  upperBounds[originalIndex] = value;

  for (let pass = 0; pass < 4; pass += 1) {
    let changedThisPass = false;
    for (const constraint of model.constraints) {
      const result = applyTighteningToBounds(
        constraint,
        lowerBounds,
        upperBounds,
        model.variableTypes,
        options
      );
      if (result.infeasible) {
        return { infeasible: true };
      }
      if (result.changed) changedThisPass = true;
    }
    if (!changedThisPass) break;
  }

  return {
    infeasible: false,
    derivedLowerBounds: lowerBounds,
    derivedUpperBounds: upperBounds,
  };
}

// ---------------------------------------------------------------------------
// Clique cuts
//
// We build a binary-variable conflict graph: an edge (i, j) means that some
// constraint forces x_i + x_j <= 1. We then derive maximal cliques by
// greedy extension from each existing pairwise/clique constraint, and emit
// the larger ones as new constraints if they are not already present.
// ---------------------------------------------------------------------------

function buildConflictGraph(model) {
  const variableCount = model.variableCount;
  const adjacency = new Array(variableCount);
  for (let i = 0; i < variableCount; i += 1) {
    adjacency[i] = new Set();
  }

  function recordEdge(a, b) {
    if (a === b) return;
    if (model.variableTypes[a] !== "binary" || model.variableTypes[b] !== "binary") return;
    if (model.fixedValues[a] !== null || model.fixedValues[b] !== null) return;
    adjacency[a].add(b);
    adjacency[b].add(a);
  }

  for (const constraint of model.constraints) {
    if (!Number.isFinite(constraint.upper)) continue;
    if (constraint.indices.length < 2) continue;

    // Check whether all participating variables are binary unfixed and whether
    // every pair would violate the upper bound when both = 1.
    let allBinary = true;
    const binaryIndices = [];
    const binaryCoefs = [];
    for (let k = 0; k < constraint.indices.length; k += 1) {
      const idx = constraint.indices[k];
      if (model.variableTypes[idx] !== "binary" || model.fixedValues[idx] !== null) {
        allBinary = false;
        break;
      }
      if (constraint.values[k] < 0) {
        allBinary = false;
        break;
      }
      binaryIndices.push(idx);
      binaryCoefs.push(constraint.values[k]);
    }
    if (!allBinary) continue;

    for (let p = 0; p < binaryIndices.length; p += 1) {
      for (let q = p + 1; q < binaryIndices.length; q += 1) {
        if (binaryCoefs[p] + binaryCoefs[q] > constraint.upper + 1e-9) {
          recordEdge(binaryIndices[p], binaryIndices[q]);
        }
      }
    }
  }

  return adjacency;
}

function extendClique(adjacency, seedIndices) {
  const clique = new Set(seedIndices);
  let extended = true;
  while (extended) {
    extended = false;
    let bestCandidate = -1;
    let bestDegree = -1;
    for (let v = 0; v < adjacency.length; v += 1) {
      if (clique.has(v)) continue;
      if (adjacency[v].size === 0) continue;
      let connectedToAll = true;
      for (const u of clique) {
        if (!adjacency[v].has(u)) {
          connectedToAll = false;
          break;
        }
      }
      if (connectedToAll && adjacency[v].size > bestDegree) {
        bestCandidate = v;
        bestDegree = adjacency[v].size;
      }
    }
    if (bestCandidate !== -1) {
      clique.add(bestCandidate);
      extended = true;
    }
  }
  return Array.from(clique).sort((a, b) => a - b);
}

function generateCliqueCuts(model, options) {
  if (!options.enableCliqueCuts) {
    return [];
  }
  const adjacency = buildConflictGraph(model);
  const existing = new Set();
  for (const constraint of model.constraints) {
    if (!Number.isFinite(constraint.upper)) continue;
    if (constraint.indices.length < 2) continue;
    const allUnit = constraint.values.every((v) => v === 1) && constraint.upper === 1;
    if (allUnit) {
      const key = constraint.indices.slice().sort((a, b) => a - b).join(",");
      existing.add(key);
    }
  }

  const cuts = [];
  const emitted = new Set();
  const variableCount = model.variableCount;

  // Seed from explicit pairwise <= 1 constraints
  for (const constraint of model.constraints) {
    if (cuts.length >= options.cliqueCutLimit) break;
    if (!Number.isFinite(constraint.upper) || constraint.upper > 1.5) continue;
    if (constraint.indices.length < 2) continue;
    if (!constraint.values.every((v) => Math.abs(v - 1) <= 1e-9)) continue;

    const expanded = extendClique(adjacency, constraint.indices);
    if (expanded.length <= constraint.indices.length) continue;
    const key = expanded.join(",");
    if (existing.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    cuts.push({
      indices: expanded,
      values: expanded.map(() => 1),
      lower: -Infinity,
      upper: 1,
      name: `clique_${cuts.length}`,
    });
  }

  // Seed from high-degree nodes
  for (let v = 0; v < variableCount; v += 1) {
    if (cuts.length >= options.cliqueCutLimit) break;
    if (adjacency[v].size < 2) continue;
    const expanded = extendClique(adjacency, [v]);
    if (expanded.length < 3) continue;
    const key = expanded.join(",");
    if (existing.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    cuts.push({
      indices: expanded,
      values: expanded.map(() => 1),
      lower: -Infinity,
      upper: 1,
      name: `clique_${cuts.length}`,
    });
  }

  return cuts;
}

// ---------------------------------------------------------------------------
// LP relaxation build (sparse -> dense tableau)
//
// We map free variables (model.fixedValues[i] === null) to LP columns
// 0..k-1 via a freeToOriginal map. The LP applies x' = x - lb shifting so
// every LP variable has a [0, ub - lb] range and a >= 0 simplex domain.
// ---------------------------------------------------------------------------

function buildLPMatrix(model, lowerBounds, upperBounds, options) {
  const freeToOriginal = [];
  const originalToFree = new Array(model.variableCount).fill(-1);

  for (let idx = 0; idx < model.variableCount; idx += 1) {
    if (model.fixedValues[idx] !== null) continue;
    if (lowerBounds[idx] > upperBounds[idx] + options.feasibilityTolerance) {
      return { status: ILP_STATUSES.INFEASIBLE };
    }
    originalToFree[idx] = freeToOriginal.length;
    freeToOriginal.push(idx);
  }

  const variableCount = freeToOriginal.length;
  let objectiveOffset = model.objectiveConstant;
  const lpLowerBounds = new Array(variableCount);
  const lpUpperBounds = new Array(variableCount);
  const lpObjective = new Array(variableCount);

  for (let j = 0; j < variableCount; j += 1) {
    const orig = freeToOriginal[j];
    lpLowerBounds[j] = lowerBounds[orig];
    lpUpperBounds[j] = upperBounds[orig];
    objectiveOffset += model.objectiveCoefficients[orig] * lpLowerBounds[j];
    lpObjective[j] = model.objectiveCoefficients[orig];
  }

  const rows = [];

  // Upper bound rows for each finite range
  for (let j = 0; j < variableCount; j += 1) {
    const shiftedUpper = lpUpperBounds[j] - lpLowerBounds[j];
    if (!Number.isFinite(shiftedUpper)) continue;
    const coefficients = new Array(variableCount).fill(0);
    coefficients[j] = 1;
    rows.push({ coefficients, relation: "<=", rhs: shiftedUpper, name: `ub_${j}` });
  }

  for (const constraint of model.constraints) {
    const coefficients = new Array(variableCount).fill(0);
    let shift = 0;
    for (let k = 0; k < constraint.indices.length; k += 1) {
      const orig = constraint.indices[k];
      const free = originalToFree[orig];
      if (free === -1) {
        continue;
      }
      coefficients[free] = constraint.values[k];
      shift += constraint.values[k] * lpLowerBounds[free];
    }

    if (Number.isFinite(constraint.upper)) {
      rows.push({
        coefficients: coefficients.slice(),
        relation: "<=",
        rhs: constraint.upper - shift,
        name: `${constraint.name}_upper`,
      });
    }
    if (Number.isFinite(constraint.lower)) {
      rows.push({
        coefficients: coefficients.map((value) => -value),
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
      coefficients = coefficients.map((value) => -value);
      relation = relation === "<=" ? ">=" : "<=";
      rhs = -rhs;
    }

    const allZero = coefficients.every((value) => Math.abs(value) <= options.feasibilityTolerance);
    if (allZero) {
      if (relation === "<=" && rhs >= -options.feasibilityTolerance) continue;
      if (relation === ">=" && rhs <= options.feasibilityTolerance) continue;
      return { status: ILP_STATUSES.INFEASIBLE };
    }

    normalizedRows.push({ coefficients, relation, rhs, name: row.name });
  }

  return {
    status: null,
    variableCount,
    freeToOriginal,
    originalToFree,
    lpLowerBounds,
    lpUpperBounds,
    rows: normalizedRows,
    objectiveCoefficients: lpObjective.map((value) => -value), // maximize -c
    objectiveOffset,
  };
}

// ---------------------------------------------------------------------------
// Simplex tableau construction
// ---------------------------------------------------------------------------

function buildSimplexTableau(lp) {
  const rowCount = lp.rows.length;
  const variableCount = lp.variableCount;
  let totalColumns = variableCount;

  for (const row of lp.rows) {
    if (row.relation === "<=") totalColumns += 1;
    else if (row.relation === ">=") totalColumns += 2;
    else totalColumns += 1;
  }

  const rhsColumn = totalColumns;
  const rows = new Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) {
    rows[i] = new Array(totalColumns + 1).fill(0);
  }
  const basis = new Array(rowCount).fill(-1);
  const artificialColumns = [];
  let nextColumn = variableCount;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = lp.rows[rowIndex];
    for (let column = 0; column < variableCount; column += 1) {
      rows[rowIndex][column] = row.coefficients[column] || 0;
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

  return { rows, basis, artificialColumns, variableCount, totalColumns };
}

// ---------------------------------------------------------------------------
// Simplex pivots / reduced costs / ratio test
// ---------------------------------------------------------------------------

function pivotTableau(rows, pivotRow, pivotColumn) {
  const rhsColumn = rows[0].length - 1;
  const pivotValue = rows[pivotRow][pivotColumn];
  const pivotRowArray = rows[pivotRow];
  const invertedPivot = 1 / pivotValue;
  for (let column = 0; column <= rhsColumn; column += 1) {
    pivotRowArray[column] *= invertedPivot;
  }
  pivotRowArray[pivotColumn] = 1;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (rowIndex === pivotRow) continue;
    const row = rows[rowIndex];
    const factor = row[pivotColumn];
    if (factor === 0) continue;
    for (let column = 0; column <= rhsColumn; column += 1) {
      row[column] -= factor * pivotRowArray[column];
    }
    row[pivotColumn] = 0;
  }
}

function computeReducedCosts(rows, basis, costs) {
  const rowCount = rows.length;
  const totalColumns = rowCount === 0 ? costs.length : rows[0].length - 1;
  const rhsColumn = totalColumns;
  const reducedCosts = costs.slice();
  let objectiveValue = 0;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const basicColumn = basis[rowIndex];
    const basicCost = costs[basicColumn] || 0;
    if (basicCost === 0) continue;

    const row = rows[rowIndex];
    objectiveValue += basicCost * row[rhsColumn];
    for (let column = 0; column < totalColumns; column += 1) {
      reducedCosts[column] -= basicCost * row[column];
    }
  }

  return { reducedCosts, objectiveValue };
}

function runSimplex(rows, basis, costs, options, state) {
  const rowCount = rows.length;
  const totalColumns = rowCount === 0 ? costs.length : rows[0].length - 1;
  const rhsColumn = totalColumns;

  let lastImprovementIteration = state.iterations;
  let bestObjectiveValue = -Infinity;
  let blandMode = false;

  while (true) {
    if (options.iterationLimit > 0 && state.iterations >= options.iterationLimit) {
      return { status: ILP_STATUSES.ITERATION_LIMIT };
    }

    const { reducedCosts, objectiveValue } = computeReducedCosts(rows, basis, costs);

    if (objectiveValue > bestObjectiveValue + options.optimalityTolerance) {
      bestObjectiveValue = objectiveValue;
      lastImprovementIteration = state.iterations;
      blandMode = false;
    } else if (state.iterations - lastImprovementIteration > options.blandFallbackThreshold) {
      blandMode = true;
    }

    const basisSet = new Set(basis);
    let enteringColumn = -1;

    if (blandMode) {
      for (let column = 0; column < totalColumns; column += 1) {
        if (basisSet.has(column)) continue;
        if (reducedCosts[column] > options.optimalityTolerance) {
          enteringColumn = column;
          break;
        }
      }
    } else {
      let bestReducedCost = options.optimalityTolerance;
      for (let column = 0; column < totalColumns; column += 1) {
        if (basisSet.has(column)) continue;
        if (reducedCosts[column] > bestReducedCost) {
          bestReducedCost = reducedCosts[column];
          enteringColumn = column;
        }
      }
    }

    if (enteringColumn === -1) {
      return { status: ILP_STATUSES.OPTIMAL, objectiveValue };
    }

    let leavingRow = -1;
    let bestRatio = Infinity;
    let bestBasisColumn = Infinity;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const coefficient = rows[rowIndex][enteringColumn];
      if (coefficient <= options.feasibilityTolerance) continue;

      const rhsValue = rows[rowIndex][rhsColumn];
      const clampedRhs = rhsValue < 0 ? 0 : rhsValue;
      const ratio = clampedRhs / coefficient;

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
    if (!artificialSet.has(basis[rowIndex])) continue;

    let enteringColumn = -1;
    for (let column = 0; column < rhsColumn; column += 1) {
      if (artificialSet.has(column)) continue;
      if (Math.abs(rows[rowIndex][column]) > options.feasibilityTolerance) {
        enteringColumn = column;
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
  for (let column = 0; column < rhsColumn; column += 1) {
    if (artificialSet.has(column)) continue;
    columnMap.set(column, keptColumns.length);
    keptColumns.push(column);
  }

  const keptRows = [];
  const nextBasis = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (droppedRows.has(rowIndex)) continue;
    const newRow = new Array(keptColumns.length + 1);
    for (let k = 0; k < keptColumns.length; k += 1) {
      newRow[k] = rows[rowIndex][keptColumns[k]];
    }
    newRow[keptColumns.length] = rows[rowIndex][rhsColumn];
    keptRows.push(newRow);
    nextBasis.push(columnMap.get(basis[rowIndex]));
  }

  return { rows: keptRows, basis: nextBasis, artificialColumns: [] };
}

function extractPrimalValues(rows, basis, columnCount) {
  const rhsColumn = rows.length === 0 ? columnCount : rows[0].length - 1;
  const values = new Array(columnCount).fill(0);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const basicColumn = basis[rowIndex];
    if (basicColumn >= 0 && basicColumn < columnCount) {
      values[basicColumn] = rows[rowIndex][rhsColumn];
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// LP relaxation entry point
// ---------------------------------------------------------------------------

function solveLPRelaxation(model, lowerBounds, upperBounds, options, state) {
  const lp = buildLPMatrix(model, lowerBounds, upperBounds, options);
  if (lp.status) {
    return { status: lp.status };
  }

  if (lp.variableCount === 0) {
    return {
      status: ILP_STATUSES.OPTIMAL,
      objective: lp.objectiveOffset,
      values: [],
      freeToOriginal: lp.freeToOriginal,
      lpLowerBounds: lp.lpLowerBounds,
    };
  }

  const tableau = buildSimplexTableau(lp);
  const phaseOneCosts = new Array(tableau.totalColumns).fill(0);
  for (const artificialColumn of tableau.artificialColumns) {
    phaseOneCosts[artificialColumn] = -1;
  }

  const phaseOne = runSimplex(tableau.rows, tableau.basis, phaseOneCosts, options, state);
  if (phaseOne.status === ILP_STATUSES.ITERATION_LIMIT) {
    return { status: ILP_STATUSES.ITERATION_LIMIT };
  }
  if (phaseOne.status === ILP_STATUSES.UNBOUNDED) {
    return { status: ILP_STATUSES.INFEASIBLE };
  }
  if (phaseOne.objectiveValue < -options.feasibilityTolerance) {
    return { status: ILP_STATUSES.INFEASIBLE };
  }

  const noArtificials = removeArtificialColumns(tableau.rows, tableau.basis, tableau.artificialColumns, options);
  if (noArtificials.infeasible) {
    return { status: ILP_STATUSES.INFEASIBLE };
  }

  const phaseTwoColumnCount = noArtificials.rows.length === 0
    ? lp.variableCount
    : noArtificials.rows[0].length - 1;
  const phaseTwoCosts = new Array(phaseTwoColumnCount);
  for (let column = 0; column < phaseTwoColumnCount; column += 1) {
    phaseTwoCosts[column] = column < lp.variableCount ? lp.objectiveCoefficients[column] : 0;
  }

  const phaseTwo = runSimplex(noArtificials.rows, noArtificials.basis, phaseTwoCosts, options, state);
  if (phaseTwo.status !== ILP_STATUSES.OPTIMAL) {
    return { status: phaseTwo.status };
  }

  const shifted = extractPrimalValues(noArtificials.rows, noArtificials.basis, lp.variableCount);
  const values = new Array(lp.variableCount);
  for (let j = 0; j < lp.variableCount; j += 1) {
    values[j] = sanitizeValue(
      shifted[j] + lp.lpLowerBounds[j],
      lp.lpLowerBounds[j],
      lp.lpUpperBounds[j],
      options.feasibilityTolerance
    );
  }

  return {
    status: ILP_STATUSES.OPTIMAL,
    objective: lp.objectiveOffset - phaseTwo.objectiveValue,
    values,
    freeToOriginal: lp.freeToOriginal,
    lpLowerBounds: lp.lpLowerBounds,
    lpUpperBounds: lp.lpUpperBounds,
  };
}

// ---------------------------------------------------------------------------
// Branching helpers
// ---------------------------------------------------------------------------

function findMostFractionalCandidate(model, values, freeToOriginal, lowerBounds, upperBounds, options) {
  let bestFreeIndex = -1;
  let bestFractionality = -1;

  for (let j = 0; j < values.length; j += 1) {
    const orig = freeToOriginal[j];
    if (model.variableTypes[orig] !== "binary") continue;
    if (lowerBounds[orig] === upperBounds[orig]) continue;
    const value = sanitizeValue(values[j], lowerBounds[orig], upperBounds[orig], options.feasibilityTolerance);
    const fractionality = Math.min(Math.abs(value), Math.abs(1 - value));
    if (fractionality <= options.integralityTolerance) continue;
    if (fractionality > bestFractionality + options.integralityTolerance) {
      bestFractionality = fractionality;
      bestFreeIndex = j;
    }
  }

  return bestFreeIndex;
}

function makePseudoCostState(variableCount) {
  return {
    down: Array.from({ length: variableCount }, () => ({ sum: 0, count: 0 })),
    up: Array.from({ length: variableCount }, () => ({ sum: 0, count: 0 })),
  };
}

function updatePseudoCost(pseudoCosts, side, originalIndex, observedDegradation, fractionalDistance) {
  if (fractionalDistance <= 0 || !Number.isFinite(observedDegradation) || observedDegradation < 0) return;
  const bucket = side === "down" ? pseudoCosts.down[originalIndex] : pseudoCosts.up[originalIndex];
  bucket.sum += observedDegradation / Math.max(fractionalDistance, 1e-9);
  bucket.count += 1;
}

function findPseudoCostCandidate(model, values, freeToOriginal, lowerBounds, upperBounds, options, pseudoCosts) {
  let bestFreeIndex = -1;
  let bestScore = -Infinity;

  for (let j = 0; j < values.length; j += 1) {
    const orig = freeToOriginal[j];
    if (model.variableTypes[orig] !== "binary") continue;
    if (lowerBounds[orig] === upperBounds[orig]) continue;
    const value = sanitizeValue(values[j], lowerBounds[orig], upperBounds[orig], options.feasibilityTolerance);
    const fractionality = Math.min(value, 1 - value);
    if (fractionality <= options.integralityTolerance) continue;

    const downDistance = value;
    const upDistance = 1 - value;

    const downBucket = pseudoCosts.down[orig];
    const upBucket = pseudoCosts.up[orig];
    const downAverage = downBucket.count > 0 ? downBucket.sum / downBucket.count : 1.0;
    const upAverage = upBucket.count > 0 ? upBucket.sum / upBucket.count : 1.0;

    if (downBucket.count < options.pseudoCostReliability || upBucket.count < options.pseudoCostReliability) {
      // Fall back to most-fractional bias for unreliable pseudo-costs
      if (fractionality > bestScore - options.integralityTolerance) {
        bestScore = fractionality;
        bestFreeIndex = j;
      }
      continue;
    }

    const downScore = downAverage * downDistance;
    const upScore = upAverage * upDistance;
    const score = Math.max(downScore * upScore, 1e-9) + 0.05 * (downScore + upScore);
    if (score > bestScore) {
      bestScore = score;
      bestFreeIndex = j;
    }
  }

  if (bestFreeIndex === -1) {
    return findMostFractionalCandidate(model, values, freeToOriginal, lowerBounds, upperBounds, options);
  }
  return bestFreeIndex;
}

// ---------------------------------------------------------------------------
// Primal feasibility helpers (operate on original-index value arrays)
// ---------------------------------------------------------------------------

function computeObjectiveForOriginal(model, valuesByOriginal) {
  let objective = model.objectiveConstant;
  for (let i = 0; i < model.variableCount; i += 1) {
    objective += model.objectiveCoefficients[i] * valuesByOriginal[i];
  }
  return objective;
}

function computeTotalViolationForOriginal(model, valuesByOriginal, lowerBounds, upperBounds) {
  let violation = 0;
  for (let i = 0; i < model.variableCount; i += 1) {
    if (valuesByOriginal[i] < lowerBounds[i]) {
      violation += lowerBounds[i] - valuesByOriginal[i];
    }
    if (valuesByOriginal[i] > upperBounds[i]) {
      violation += valuesByOriginal[i] - upperBounds[i];
    }
  }
  for (const constraint of model.constraints) {
    let lhs = 0;
    for (let k = 0; k < constraint.indices.length; k += 1) {
      lhs += constraint.values[k] * valuesByOriginal[constraint.indices[k]];
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

function isFeasibleAssignmentForOriginal(model, valuesByOriginal, lowerBounds, upperBounds, options) {
  return computeTotalViolationForOriginal(model, valuesByOriginal, lowerBounds, upperBounds) <= options.feasibilityTolerance;
}

function lpValuesToOriginal(model, lpValues, freeToOriginal, lowerBounds, upperBounds, options) {
  const out = new Array(model.variableCount);
  for (let i = 0; i < model.variableCount; i += 1) {
    if (model.fixedValues[i] !== null && model.fixedValues[i] !== undefined) {
      out[i] = model.fixedValues[i];
    } else {
      out[i] = lowerBounds[i];
    }
  }
  for (let j = 0; j < freeToOriginal.length; j += 1) {
    const orig = freeToOriginal[j];
    out[orig] = sanitizeValue(lpValues[j], lowerBounds[orig], upperBounds[orig], options.feasibilityTolerance);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

function buildRoundedHeuristicCandidate(model, lpValues, freeToOriginal, lowerBounds, upperBounds, options) {
  if (!options.enableRoundingHeuristic) {
    return null;
  }

  const valuesByOriginal = lpValuesToOriginal(model, lpValues, freeToOriginal, lowerBounds, upperBounds, options);
  for (let i = 0; i < model.variableCount; i += 1) {
    if (model.fixedValues[i] !== null && model.fixedValues[i] !== undefined) {
      continue;
    }
    if (model.variableTypes[i] === "binary") {
      valuesByOriginal[i] = valuesByOriginal[i] >= 0.5 ? 1 : 0;
    } else {
      valuesByOriginal[i] = sanitizeValue(valuesByOriginal[i], lowerBounds[i], upperBounds[i], options.feasibilityTolerance);
    }
  }

  if (isFeasibleAssignmentForOriginal(model, valuesByOriginal, lowerBounds, upperBounds, options)) {
    return { values: valuesByOriginal, objective: computeObjectiveForOriginal(model, valuesByOriginal) };
  }

  const mutableIndices = [];
  for (let i = 0; i < model.variableCount; i += 1) {
    if (model.variableTypes[i] !== "binary") continue;
    if (model.fixedValues[i] !== null && model.fixedValues[i] !== undefined) continue;
    if (approximatelyEqual(lowerBounds[i], upperBounds[i], options.feasibilityTolerance)) continue;
    mutableIndices.push(i);
  }

  for (let attempt = 0; attempt < mutableIndices.length * 4; attempt += 1) {
    const currentViolation = computeTotalViolationForOriginal(model, valuesByOriginal, lowerBounds, upperBounds);
    if (currentViolation <= options.feasibilityTolerance) {
      return { values: valuesByOriginal, objective: computeObjectiveForOriginal(model, valuesByOriginal) };
    }

    let bestMove = null;
    for (const idx of mutableIndices) {
      for (const targetValue of [0, 1]) {
        if (valuesByOriginal[idx] === targetValue) continue;
        const candidate = valuesByOriginal.slice();
        candidate[idx] = targetValue;
        const nextViolation = computeTotalViolationForOriginal(model, candidate, lowerBounds, upperBounds);
        const nextObjective = computeObjectiveForOriginal(model, candidate);
        if (
          !bestMove
          || nextViolation < bestMove.violation - options.feasibilityTolerance
          || (
            approximatelyEqual(nextViolation, bestMove.violation, options.feasibilityTolerance)
            && nextObjective < bestMove.objective - options.optimalityTolerance
          )
        ) {
          bestMove = { idx, targetValue, violation: nextViolation, objective: nextObjective };
        }
      }
    }

    if (!bestMove || bestMove.violation >= currentViolation - options.feasibilityTolerance) {
      break;
    }
    valuesByOriginal[bestMove.idx] = bestMove.targetValue;
  }

  if (isFeasibleAssignmentForOriginal(model, valuesByOriginal, lowerBounds, upperBounds, options)) {
    return { values: valuesByOriginal, objective: computeObjectiveForOriginal(model, valuesByOriginal) };
  }
  return null;
}

function lpDivingHeuristic(model, rootLowerBounds, rootUpperBounds, rootRelaxation, options, state) {
  if (!options.enableLPDiving) return null;
  if (!rootRelaxation || rootRelaxation.status !== ILP_STATUSES.OPTIMAL) return null;

  const localLowerBounds = rootLowerBounds.slice();
  const localUpperBounds = rootUpperBounds.slice();
  let relaxation = rootRelaxation;

  const maxDives = Math.min(model.variableCount, 64);

  for (let dive = 0; dive < maxDives; dive += 1) {
    const branchFree = findMostFractionalCandidate(
      model,
      relaxation.values,
      relaxation.freeToOriginal,
      localLowerBounds,
      localUpperBounds,
      options
    );
    if (branchFree === -1) {
      const valuesByOriginal = lpValuesToOriginal(
        model,
        relaxation.values,
        relaxation.freeToOriginal,
        localLowerBounds,
        localUpperBounds,
        options
      );
      for (let i = 0; i < model.variableCount; i += 1) {
        if (model.variableTypes[i] === "binary") {
          valuesByOriginal[i] = valuesByOriginal[i] >= 0.5 ? 1 : 0;
        }
      }
      if (isFeasibleAssignmentForOriginal(model, valuesByOriginal, rootLowerBounds, rootUpperBounds, options)) {
        return {
          values: valuesByOriginal,
          objective: computeObjectiveForOriginal(model, valuesByOriginal),
        };
      }
      return null;
    }

    const originalIndex = relaxation.freeToOriginal[branchFree];
    const value = relaxation.values[branchFree];
    const target = value >= 0.5 ? 1 : 0;
    localLowerBounds[originalIndex] = target;
    localUpperBounds[originalIndex] = target;

    relaxation = solveLPRelaxation(model, localLowerBounds, localUpperBounds, options, state);
    if (relaxation.status !== ILP_STATUSES.OPTIMAL) {
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Binary heap (best-bound first)
// ---------------------------------------------------------------------------

function heapLess(a, b) {
  if (a.bound !== b.bound) return a.bound < b.bound;
  if (a.depth !== b.depth) return a.depth > b.depth;
  return a.sequence < b.sequence;
}

function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heapLess(heap[i], heap[parent])) {
      const tmp = heap[i];
      heap[i] = heap[parent];
      heap[parent] = tmp;
      i = parent;
    } else {
      break;
    }
  }
}

function heapPop(heap) {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    const n = heap.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && heapLess(heap[l], heap[smallest])) smallest = l;
      if (r < n && heapLess(heap[r], heap[smallest])) smallest = r;
      if (smallest === i) break;
      const tmp = heap[i];
      heap[i] = heap[smallest];
      heap[smallest] = tmp;
      i = smallest;
    }
  }
  return top;
}

// ---------------------------------------------------------------------------
// Branch-and-bound
// ---------------------------------------------------------------------------

function solvePresolvedProblem(model, normalized, options) {
  const state = { iterations: 0, nodesVisited: 0, cutsAdded: 0, options };

  if (options.enableCliqueCuts) {
    const cuts = generateCliqueCuts(model, options);
    state.cutsAdded = cuts.length;
    for (const cut of cuts) {
      model.constraints.push(cut);
    }
  }

  if (allVariablesFixed(model)) {
    const valuesByOriginal = collectFixedValues(model);
    if (!isFeasibleAssignmentForOriginal(model, valuesByOriginal, model.lowerBounds, model.upperBounds, options)) {
      return buildResult(
        ILP_STATUSES.INFEASIBLE,
        model,
        normalized,
        state,
        null,
        null,
        null,
        "Presolve fixed every variable but the result is infeasible.",
      );
    }
    return buildResult(
      ILP_STATUSES.OPTIMAL,
      model,
      normalized,
      state,
      valuesByOriginal,
      computeObjectiveForOriginal(model, valuesByOriginal),
      computeObjectiveForOriginal(model, valuesByOriginal),
      "Solved entirely during presolve.",
    );
  }

  const pseudoCosts = makePseudoCostState(model.variableCount);
  let incumbent = null;
  let bestBound = -Infinity;
  let nodeSequence = 0;

  const rootLowerBounds = model.lowerBounds.slice();
  const rootUpperBounds = model.upperBounds.slice();
  const rootRelaxation = solveLPRelaxation(model, rootLowerBounds, rootUpperBounds, options, state);

  if (rootRelaxation.status === ILP_STATUSES.INFEASIBLE) {
    return buildResult(
      ILP_STATUSES.INFEASIBLE,
      model,
      normalized,
      state,
      null,
      null,
      null,
      "Root LP is infeasible.",
    );
  }
  if (rootRelaxation.status === ILP_STATUSES.UNBOUNDED) {
    return buildResult(
      ILP_STATUSES.UNBOUNDED,
      model,
      normalized,
      state,
      null,
      null,
      null,
      "Root LP is unbounded.",
    );
  }
  if (rootRelaxation.status === ILP_STATUSES.ITERATION_LIMIT) {
    return buildResult(
      ILP_STATUSES.ITERATION_LIMIT,
      model,
      normalized,
      state,
      null,
      null,
      null,
      "Root LP hit the iteration limit.",
    );
  }

  bestBound = rootRelaxation.objective;
  const rootHeuristic = buildRoundedHeuristicCandidate(
    model,
    rootRelaxation.values,
    rootRelaxation.freeToOriginal,
    rootLowerBounds,
    rootUpperBounds,
    options
  );
  if (rootHeuristic) {
    incumbent = rootHeuristic;
  }

  if (options.enableLPDiving) {
    const dived = lpDivingHeuristic(model, rootLowerBounds, rootUpperBounds, rootRelaxation, options, state);
    if (dived && (!incumbent || dived.objective < incumbent.objective - options.optimalityTolerance)) {
      incumbent = dived;
    }
  }

  const queue = [];
  heapPush(queue, {
    lowerBounds: rootLowerBounds,
    upperBounds: rootUpperBounds,
    bound: rootRelaxation.objective,
    parentObjective: rootRelaxation.objective,
    branchVariable: -1,
    branchDirection: null,
    branchFractionalDistance: 0,
    depth: 0,
    sequence: nodeSequence++,
    initialRelaxation: rootRelaxation,
  });

  while (queue.length > 0) {
    if (options.nodeLimit > 0 && state.nodesVisited >= options.nodeLimit) {
      return buildResult(
        ILP_STATUSES.ITERATION_LIMIT,
        model,
        normalized,
        state,
        incumbent ? incumbent.values : null,
        incumbent ? incumbent.objective : null,
        bestBound,
        "Hit node limit before proving optimality.",
      );
    }

    const node = heapPop(queue);
    state.nodesVisited += 1;

    if (incumbent && node.bound >= incumbent.objective - options.optimalityTolerance) {
      continue;
    }

    let relaxation = node.initialRelaxation;
    if (!relaxation) {
      relaxation = solveLPRelaxation(model, node.lowerBounds, node.upperBounds, options, state);
    } else {
      node.initialRelaxation = null;
    }

    if (relaxation.status === ILP_STATUSES.ITERATION_LIMIT) {
      const queueBound = queue.length > 0 ? Math.min(...queue.map((entry) => entry.bound)) : Infinity;
      return buildResult(
        ILP_STATUSES.ITERATION_LIMIT,
        model,
        normalized,
        state,
        incumbent ? incumbent.values : null,
        incumbent ? incumbent.objective : null,
        Number.isFinite(queueBound) ? queueBound : (incumbent ? incumbent.objective : null),
        "Search hit iterationLimit before proving optimality.",
      );
    }
    if (relaxation.status === ILP_STATUSES.INFEASIBLE) {
      continue;
    }
    if (relaxation.status === ILP_STATUSES.UNBOUNDED) {
      return buildResult(
        ILP_STATUSES.UNBOUNDED,
        model,
        normalized,
        state,
        null,
        null,
        null,
        "A subproblem LP became unbounded, the model is not well-posed.",
      );
    }

    // Update pseudo-costs based on this node's actual LP degradation from parent
    if (node.branchVariable >= 0 && Number.isFinite(node.parentObjective) && node.branchFractionalDistance > 0) {
      const degradation = relaxation.objective - node.parentObjective;
      updatePseudoCost(pseudoCosts, node.branchDirection, node.branchVariable, degradation, node.branchFractionalDistance);
    }

    if (incumbent && relaxation.objective >= incumbent.objective - options.optimalityTolerance) {
      continue;
    }

    const heuristic = buildRoundedHeuristicCandidate(
      model,
      relaxation.values,
      relaxation.freeToOriginal,
      node.lowerBounds,
      node.upperBounds,
      options
    );
    if (heuristic && (!incumbent || heuristic.objective < incumbent.objective - options.optimalityTolerance)) {
      incumbent = heuristic;
    }

    let branchFree = -1;
    if (options.branchingRule === "pseudocost") {
      branchFree = findPseudoCostCandidate(
        model,
        relaxation.values,
        relaxation.freeToOriginal,
        node.lowerBounds,
        node.upperBounds,
        options,
        pseudoCosts
      );
    } else {
      branchFree = findMostFractionalCandidate(
        model,
        relaxation.values,
        relaxation.freeToOriginal,
        node.lowerBounds,
        node.upperBounds,
        options
      );
    }

    if (branchFree === -1) {
      const valuesByOriginal = lpValuesToOriginal(
        model,
        relaxation.values,
        relaxation.freeToOriginal,
        node.lowerBounds,
        node.upperBounds,
        options
      );
      for (let i = 0; i < model.variableCount; i += 1) {
        if (model.variableTypes[i] === "binary") {
          valuesByOriginal[i] = valuesByOriginal[i] >= 0.5 ? 1 : 0;
        }
      }
      if (isFeasibleAssignmentForOriginal(model, valuesByOriginal, node.lowerBounds, node.upperBounds, options)) {
        const objective = computeObjectiveForOriginal(model, valuesByOriginal);
        if (!incumbent || objective < incumbent.objective - options.optimalityTolerance) {
          incumbent = { values: valuesByOriginal, objective };
        }
      }
      continue;
    }

    const branchOriginalIndex = relaxation.freeToOriginal[branchFree];
    const branchValue = relaxation.values[branchFree];
    const fractionalDistance = Math.min(branchValue, 1 - branchValue);

    // Down branch: x_b = 0
    if (node.lowerBounds[branchOriginalIndex] <= options.feasibilityTolerance) {
      const childUpperBounds = node.upperBounds.slice();
      childUpperBounds[branchOriginalIndex] = 0;
      heapPush(queue, {
        lowerBounds: node.lowerBounds.slice(),
        upperBounds: childUpperBounds,
        bound: relaxation.objective,
        parentObjective: relaxation.objective,
        branchVariable: branchOriginalIndex,
        branchDirection: "down",
        branchFractionalDistance: branchValue,
        depth: node.depth + 1,
        sequence: nodeSequence++,
        initialRelaxation: null,
      });
    }

    // Up branch: x_b = 1
    if (node.upperBounds[branchOriginalIndex] >= 1 - options.feasibilityTolerance) {
      const childLowerBounds = node.lowerBounds.slice();
      childLowerBounds[branchOriginalIndex] = 1;
      heapPush(queue, {
        lowerBounds: childLowerBounds,
        upperBounds: node.upperBounds.slice(),
        bound: relaxation.objective,
        parentObjective: relaxation.objective,
        branchVariable: branchOriginalIndex,
        branchDirection: "up",
        branchFractionalDistance: 1 - branchValue,
        depth: node.depth + 1,
        sequence: nodeSequence++,
        initialRelaxation: null,
      });
    }

    // Refresh best bound estimate
    if (queue.length > 0) {
      bestBound = queue[0].bound;
    } else if (incumbent) {
      bestBound = incumbent.objective;
    }
  }

  if (!incumbent) {
    return buildResult(
      ILP_STATUSES.INFEASIBLE,
      model,
      normalized,
      state,
      null,
      null,
      null,
      "Presolve and branch-and-bound proved the model infeasible.",
    );
  }

  return buildResult(
    ILP_STATUSES.OPTIMAL,
    model,
    normalized,
    state,
    incumbent.values,
    incumbent.objective,
    incumbent.objective,
    "Solved with presolve, cuts, two-phase simplex relaxations, and branch-and-bound.",
  );
}

function allVariablesFixed(model) {
  for (let i = 0; i < model.variableCount; i += 1) {
    if (model.fixedValues[i] === null) return false;
  }
  return true;
}

function collectFixedValues(model) {
  const out = new Array(model.variableCount);
  for (let i = 0; i < model.variableCount; i += 1) {
    out[i] = model.fixedValues[i] !== null && model.fixedValues[i] !== undefined
      ? model.fixedValues[i]
      : model.lowerBounds[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function expandSubstitutions(model, valuesByOriginal, options) {
  const out = valuesByOriginal.slice();
  for (let i = model.substitutions.length - 1; i >= 0; i -= 1) {
    const record = model.substitutions[i];
    if (record.kind === "fix") {
      out[record.originalIndex] = record.value;
    } else if (record.kind === "linear") {
      let value = record.rhsOver;
      for (let k = 0; k < record.otherIndices.length; k += 1) {
        value -= record.otherValues[k] * out[record.otherIndices[k]];
      }
      out[record.pivot] = value;
    }
  }

  for (let i = 0; i < model.variableCount; i += 1) {
    if (out[i] == null || Number.isNaN(out[i])) {
      out[i] = 0;
    }
    if (model.variableTypes[i] === "binary") {
      out[i] = out[i] >= 0.5 ? 1 : 0;
    } else if (!Number.isFinite(out[i])) {
      out[i] = 0;
    } else {
      if (approximatelyEqual(out[i], 0, options.feasibilityTolerance)) {
        out[i] = 0;
      } else if (approximatelyEqual(out[i], Math.round(out[i]), options.feasibilityTolerance)) {
        out[i] = Math.round(out[i]);
      }
    }
  }

  return out;
}

function buildResult(status, model, normalized, state, valuesByOriginal, objective, bestBound, note) {
  let assignment = null;
  let values = null;

  if (valuesByOriginal) {
    const expanded = expandSubstitutions(model, valuesByOriginal, state.options);
    values = expanded;
    assignment = {};
    for (let i = 0; i < model.variableCount; i += 1) {
      assignment[model.variableNames[i]] = expanded[i];
    }
  }

  return {
    status,
    objective: Number.isFinite(objective) ? objective : null,
    assignment,
    values,
    bestBound: Number.isFinite(bestBound) ? bestBound : null,
    nodesVisited: state.nodesVisited,
    iterations: state.iterations,
    cutsAdded: state.cutsAdded || 0,
    certificate: null,
    note,
    problem: normalized && normalized.rawProblem ? normalized.rawProblem : null,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function solveILP(problem) {
  const normalized = normalizeProblem(problem);
  const presolved = presolveProblem(normalized);

  if (presolved.status === ILP_STATUSES.INFEASIBLE) {
    return buildResult(
      ILP_STATUSES.INFEASIBLE,
      presolved.model,
      normalized,
      { iterations: 0, nodesVisited: 0, cutsAdded: 0, options: normalized.options },
      null,
      null,
      null,
      "Presolve proved the model infeasible.",
    );
  }

  return solvePresolvedProblem(presolved.model, normalized, normalized.options);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

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
