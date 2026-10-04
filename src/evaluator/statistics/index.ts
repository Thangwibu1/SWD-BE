export interface ConfidenceInterval {
  estimate: number;
  lower95: number;
  upper95: number;
  sampleSize: number;
  method: 'bootstrap-median';
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function bootstrapMedian95(values: number[], seed = 20261001, iterations = 2000): ConfidenceInterval | null {
  const clean = values.filter(Number.isFinite);
  if (clean.length === 0) return null;
  if (clean.length === 1) {
    return { estimate: clean[0]!, lower95: clean[0]!, upper95: clean[0]!, sampleSize: 1, method: 'bootstrap-median' };
  }
  const random = seededRandom(seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = Array.from({ length: clean.length }, () => clean[Math.floor(random() * clean.length)]!);
    estimates.push(median(sample));
  }
  estimates.sort((a, b) => a - b);
  return {
    estimate: median(clean),
    lower95: estimates[Math.floor(iterations * 0.025)] ?? median(clean),
    upper95: estimates[Math.min(iterations - 1, Math.floor(iterations * 0.975))] ?? median(clean),
    sampleSize: clean.length,
    method: 'bootstrap-median',
  };
}
