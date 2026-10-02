import type { Logger } from '../../utils/logger.js';

export interface ParetoPoint {
  experimentId: string;
  candidateId: string;
  architectureId: string;
  feasible: boolean;
  isParetoOptimal: boolean;
  dimensions: Record<string, number>; // dimension -> raw value
  normalizedScores: Record<string, number>; // dimension -> 0-100
  regret: number; // normalized regret vs best feasible
}

export interface ParetoResult {
  points: ParetoPoint[];
  frontierIds: string[];
  dominatedIds: string[];
}

/**
 * Check if point A dominates point B.
 * A dominates B if A is at least as good in all dimensions and strictly better in at least one.
 * All dimensions are normalized scores (higher = better).
 */
function dominates(a: Record<string, number>, b: Record<string, number>, dims: string[]): boolean {
  let strictlyBetterInOne = false;
  for (const dim of dims) {
    const aVal = a[dim] ?? 0;
    const bVal = b[dim] ?? 0;
    if (aVal < bVal) return false; // A is worse in this dimension
    if (aVal > bVal) strictlyBetterInOne = true;
  }
  return strictlyBetterInOne;
}

/**
 * Compute the Pareto frontier from a set of experiment results.
 * Only feasible (all gates passed) points are considered for the frontier.
 */
export function computePareto(
  points: ParetoPoint[],
  dimensions: string[],
  logger: Logger,
): ParetoResult {
  const feasible = points.filter(p => p.feasible);
  const infeasible = points.filter(p => !p.feasible);

  // Mark infeasible points as not Pareto optimal
  for (const p of infeasible) {
    p.isParetoOptimal = false;
  }

  // Find Pareto frontier among feasible points
  for (let i = 0; i < feasible.length; i++) {
    let isDominated = false;
    for (let j = 0; j < feasible.length; j++) {
      if (i === j) continue;
      if (dominates(feasible[j]!.normalizedScores, feasible[i]!.normalizedScores, dimensions)) {
        isDominated = true;
        break;
      }
    }
    feasible[i]!.isParetoOptimal = !isDominated;
  }

  // Compute regret vs best feasible candidate
  if (feasible.length > 0) {
    // Find best score in each dimension
    const bestScores: Record<string, number> = {};
    for (const dim of dimensions) {
      bestScores[dim] = Math.max(...feasible.map(p => p.normalizedScores[dim] ?? 0));
    }

    // Compute normalized regret for each point
    for (const p of [...feasible, ...infeasible]) {
      let totalRegret = 0;
      for (const dim of dimensions) {
        const best = bestScores[dim] ?? 100;
        const actual = p.normalizedScores[dim] ?? 0;
        totalRegret += Math.max(0, best - actual);
      }
      p.regret = Math.round((totalRegret / dimensions.length) * 100) / 100;
    }
  }

  const frontierIds = feasible.filter(p => p.isParetoOptimal).map(p => p.experimentId);
  const dominatedIds = feasible.filter(p => !p.isParetoOptimal).map(p => p.experimentId);

  logger.info({
    totalPoints: points.length,
    feasible: feasible.length,
    frontier: frontierIds.length,
    dominated: dominatedIds.length,
  }, 'Pareto computation complete');

  return {
    points: [...feasible, ...infeasible],
    frontierIds,
    dominatedIds,
  };
}
