import {
  MetricScore,
  MetricKey,
  SeverityBand,
  PlayerCategory,
  Issue,
  PostureMetrics,
  SessionAssessment,
} from '../types/analysis';
import { EXERCISES } from '../constants/exercises';
import { METRIC_META } from '../constants/metricMeta';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

// Metrics that represent foundational form (posture + bow arm mechanics)
const FORM_METRIC_KEYS: MetricKey[] = [
  'posture',
  'leftHandWrist',
  'bowPlacement',
  'bowAngle',
  'bowArmLevel',
];

// ─────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────

export function classifyPlayer(videoMetrics: MetricScore[]): PlayerCategory {
  const formMetrics = videoMetrics.filter(
    (m) => FORM_METRIC_KEYS.includes(m.key) && m.measurementQuality !== 'unavailable',
  );
  if (formMetrics.length === 0) return 'refinement';

  const criticalCount = formMetrics.filter((m) => m.score < 50).length;
  const avgScore =
    formMetrics.reduce((s, m) => s + m.score, 0) / formMetrics.length;

  // Two or more critical issues, OR average form score below 62 → foundation work needed
  if (criticalCount >= 2 || avgScore < 62) return 'foundation';
  return 'refinement';
}

// ─────────────────────────────────────────────────────────────
// Observation text
// ─────────────────────────────────────────────────────────────

const METRIC_OBSERVATION: Partial<Record<MetricKey, Record<SeverityBand, string>>> = {
  posture: {
    excellent: 'Shoulders and head well-balanced throughout.',
    good: 'Posture mostly correct — minor adjustments at times.',
    needs_attention: 'Shoulder or head alignment needs attention.',
    critical: 'Significant posture issues throughout the session.',
  },
  leftHandWrist: {
    excellent: 'Left wrist well-aligned throughout.',
    good: 'Wrist position mostly correct.',
    needs_attention: 'Left wrist collapsing on some notes.',
    critical: 'Wrist collapse is persistent — address this first.',
  },
  bowPlacement: {
    excellent: 'Bow consistently in the ideal contact zone.',
    good: 'Bow placement mostly correct.',
    needs_attention: 'Bow drifting from the optimal contact point.',
    critical: 'Bow is frequently out of the correct zone.',
  },
  bowAngle: {
    excellent: 'Bow well-aligned with the strings.',
    good: 'Bow angle mostly perpendicular.',
    needs_attention: 'Bow angle deviating — aim for more perpendicular.',
    critical: 'Significant bow angle issues throughout.',
  },
  bowArmLevel: {
    excellent: 'Elbow adjusting well for string crossings.',
    good: 'Arm level mostly adapting for string changes.',
    needs_attention: 'Arm height not fully adjusting for string crossings.',
    critical: 'Arm stays at one height regardless of string.',
  },
  bowDistribution: {
    excellent: 'Using the full bow length effectively.',
    good: 'Good bow usage — mostly the full length.',
    needs_attention: 'Mostly using the middle section of the bow.',
    critical: 'Very limited bow movement throughout.',
  },
};

// ─────────────────────────────────────────────────────────────
// Issue data
// ─────────────────────────────────────────────────────────────

const ISSUE_INFO: Partial<Record<MetricKey, { title: string; description: string }>> = {
  posture: {
    title: 'Body alignment',
    description: 'Uneven shoulders or tilted head adds tension and limits bow freedom.',
  },
  leftHandWrist: {
    title: 'Left wrist position',
    description: 'Wrist collapse locks up finger independence and builds long-term tension.',
  },
  bowPlacement: {
    title: 'Bow contact point',
    description: 'Bow drifting from the sweet spot produces a thin, unfocused tone.',
  },
  bowAngle: {
    title: 'Bow angle',
    description: 'A tilted bow reduces contact quality and makes tone inconsistent.',
  },
  bowArmLevel: {
    title: 'Bow arm height',
    description: 'Arm not adjusting for string crossings causes noisy, imprecise transitions.',
  },
  bowDistribution: {
    title: 'Bow distribution',
    description: 'Using only the middle of the bow limits dynamic range and expressiveness.',
  },
};

// ─────────────────────────────────────────────────────────────
// Builder helpers
// ─────────────────────────────────────────────────────────────

function buildIssues(
  metrics: MetricScore[],
  scoreThreshold: number,
  maxIssues: number,
): Issue[] {
  return metrics
    .filter(
      (m) =>
        FORM_METRIC_KEYS.includes(m.key) &&
        m.measurementQuality !== 'unavailable' &&
        m.score < scoreThreshold,
    )
    .sort((a, b) => a.score - b.score)
    .slice(0, maxIssues)
    .flatMap((m) => {
      const info = ISSUE_INFO[m.key];
      if (!info) return [];
      const exercises = EXERCISES.filter((e) => e.metricKey === m.key);
      const preferred = m.score < 50 ? 'beginner' : 'intermediate';
      const exercise =
        exercises.find((e) => e.difficulty === preferred) ??
        exercises.find((e) => e.difficulty === 'beginner') ??
        exercises[0];
      const issue: Issue = {
        metricKey: m.key,
        title: info.title,
        description: info.description,
        exercise: exercise
          ? {
              id: exercise.id,
              title: exercise.title,
              duration: exercise.duration,
              instructions: exercise.instructions,
            }
          : undefined,
      };
      return [issue];
    });
}

function buildTechniqueSummary(
  category: PlayerCategory,
  videoMetrics: MetricScore[],
): string {
  const formMetrics = videoMetrics.filter(
    (m) => FORM_METRIC_KEYS.includes(m.key) && m.measurementQuality !== 'unavailable',
  );
  const sorted = [...formMetrics].sort((a, b) => a.score - b.score);
  const worst = sorted[0];

  if (category === 'foundation') {
    if (worst && worst.score < 50) {
      const label = METRIC_META[worst.key]?.label?.toLowerCase() ?? 'technique';
      return (
        `Before worrying about advanced technique, let's build a stronger foundation. ` +
        `Your ${label} needs the most attention — getting this right will unlock faster ` +
        `progress across everything else.`
      );
    }
    return (
      `Before worrying about advanced technique, let's build a stronger foundation. ` +
      `Addressing these core habits now will protect you from developing compensations ` +
      `that become much harder to fix later.`
    );
  }

  // Refinement
  if (!worst || worst.score >= 80) {
    return (
      `You have good fundamentals. Keep working on consistency — the next level is ` +
      `applying these skills under pressure, during your most demanding passages.`
    );
  }
  const label = METRIC_META[worst.key]?.label?.toLowerCase() ?? 'technique';
  return (
    `You have good fundamentals. Here's what to refine next: your ${label} is the ` +
    `biggest opportunity for improvement — addressing it will have the most noticeable ` +
    `impact on your playing right now.`
  );
}

function buildKeyObservations(
  videoMetrics: MetricScore[],
): { metricKey: MetricKey; note: string }[] {
  return videoMetrics
    .filter(
      (m) =>
        FORM_METRIC_KEYS.includes(m.key) &&
        m.measurementQuality !== 'unavailable' &&
        METRIC_OBSERVATION[m.key],
    )
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map((m) => ({
      metricKey: m.key,
      note: METRIC_OBSERVATION[m.key]![m.severity] ?? '',
    }));
}

function buildPostureMetrics(videoMetrics: MetricScore[]): PostureMetrics {
  const available = videoMetrics.filter((m) => m.measurementQuality !== 'unavailable');
  const get = (key: MetricKey) =>
    available.find((m) => m.key === key)?.score ?? 75;
  const posture = get('posture');
  const wrist = get('leftHandWrist');
  const armLevel = get('bowArmLevel');
  const scored = [posture, wrist, armLevel];
  return {
    avgShoulderAlignment: posture,
    avgHeadPosition: posture,
    avgElbowLevel: armLevel,
    avgWristPosture: wrist,
    overallFormScore: Math.round(scored.reduce((a, b) => a + b, 0) / scored.length),
  };
}

// ─────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────

export function buildSessionAssessment(
  videoMetrics: MetricScore[],
  userCategory?: PlayerCategory,
): SessionAssessment {
  // Prefer the user's self-reported goal; fall back to video-computed classification
  const category = userCategory ?? classifyPlayer(videoMetrics);
  const postureMetrics = buildPostureMetrics(videoMetrics);
  const techniqueSummary = buildTechniqueSummary(category, videoMetrics);
  const keyObservations = buildKeyObservations(videoMetrics);

  // Foundation: surface issues below 75 (broader net)
  // Refinement: surface issues below 82 (higher bar — only meaningful gaps)
  const foundationIssues = buildIssues(videoMetrics, 75, 3);
  const refinementIssues = buildIssues(videoMetrics, 82, 3);

  return {
    playerCategory: category,
    techniqueSummary,
    keyObservations,
    foundationIssues,
    refinementIssues,
    postureMetrics,
  };
}
