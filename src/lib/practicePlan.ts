import { MetricKey } from '../types/analysis';
import { MetricHistoryEntry } from '../store/useAnalysisStore';
import { Exercise, exercisesForMetric } from '../constants/exercises';
import { METRIC_META } from '../constants/metricMeta';

export interface WeakArea {
  metricKey: MetricKey;
  avgScore: number;
  sessionCount: number;
  exercises: Exercise[];
}

export interface PracticePlan {
  sessionCount: number;
  weakAreas: WeakArea[];
  allMetricAverages: Partial<Record<MetricKey, number>>;
}

export function computePracticePlan(
  metricHistory: MetricHistoryEntry[],
  sessionWindow = 5,
): PracticePlan {
  const recent = metricHistory.slice(0, sessionWindow);

  if (recent.length === 0) {
    return { sessionCount: 0, weakAreas: [], allMetricAverages: {} };
  }

  // Accumulate scores per metric key across sessions
  const accumulator = new Map<MetricKey, number[]>();
  for (const entry of recent) {
    for (const score of entry.scores) {
      const arr = accumulator.get(score.key) ?? [];
      arr.push(score.score);
      accumulator.set(score.key, arr);
    }
  }

  // Average each metric and build the full map
  const allMetricAverages: Partial<Record<MetricKey, number>> = {};
  for (const [key, scores] of accumulator.entries()) {
    allMetricAverages[key] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  // Priority score: lower average = higher priority; more sessions = more confidence
  const prioritized = [...accumulator.entries()]
    .map(([key, scores]) => {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      // Weight by recency: metrics that appear in every session are more reliable
      const consistency = scores.length / recent.length;
      const priority = (100 - avg) * consistency;
      return { key, avg, priority, sessionCount: scores.length };
    })
    .sort((a, b) => b.priority - a.priority);

  // Top 3 weak areas that have at least one exercise defined
  const weakAreas: WeakArea[] = prioritized
    .filter((m) => m.avg < 85) // Only surface metrics that genuinely need work
    .slice(0, 3)
    .map((m) => {
      const exs = exercisesForMetric(m.key);
      // Pick one beginner and one intermediate exercise (or best available)
      const beginner = exs.find((e) => e.difficulty === 'beginner');
      const intermediate = exs.find((e) => e.difficulty === 'intermediate');
      const selected: Exercise[] = [];
      if (beginner) selected.push(beginner);
      if (intermediate && intermediate !== beginner) selected.push(intermediate);
      if (selected.length === 0 && exs.length > 0) selected.push(exs[0]);
      return {
        metricKey: m.key,
        avgScore: Math.round(m.avg),
        sessionCount: m.sessionCount,
        exercises: selected,
      };
    });

  return {
    sessionCount: recent.length,
    weakAreas,
    allMetricAverages,
  };
}

export function metricLabel(key: MetricKey): string {
  return METRIC_META[key]?.label ?? key;
}

export function metricIcon(key: MetricKey): string {
  return METRIC_META[key]?.icon ?? '🎵';
}
