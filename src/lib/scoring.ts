import type { MetricScore } from '../types/analysis';

/**
 * How the single headline score is derived from the per-metric scores.
 *
 * Pure and dependency-free (no supabase, no expo modules) so it can be
 * unit-tested in plain Node, matching the convention in entitlements.ts. It is
 * re-exported from services/analysis.ts, which is where callers historically
 * import it from — keep that alias.
 */

/**
 * Bow and posture scoring isn't reliable enough to move a headline number yet,
 * so their weights are dropped before the overall score is computed. They still
 * get their own cards — this only keeps them out of the one figure the user
 * reads as a verdict.
 */
export const HIDDEN_SCORE_KEYS = new Set<string>([
  'bowSmoothness', 'bowPlacement', 'bowAngle', 'bowDistribution',
  'posture', 'leftHandWrist', 'bowArmLevel',
]);

/** `weights` with the unreliable keys removed. */
export function activeScoreWeights(weights: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(weights).filter(([k]) => !HIDDEN_SCORE_KEYS.has(k)));
}

/**
 * Weighted mean of the measured metrics. Metrics the device couldn't measure at
 * all are skipped entirely rather than scored as zero — a phone without bow
 * tracking must not drag the number down for a performance it never saw.
 */
export function computeOverallScore(
  audioMetrics: MetricScore[],
  videoMetrics: MetricScore[],
  weights: Record<string, number>,
): number {
  const all = [...audioMetrics, ...videoMetrics];
  let total = 0;
  let weightSum = 0;

  for (const metric of all) {
    if (metric.measurementQuality === 'unavailable') continue;
    const w = weights[metric.key] ?? 0;
    total += metric.score * w;
    weightSum += w;
  }

  return weightSum > 0 ? Math.round(total / weightSum) : 0;
}
