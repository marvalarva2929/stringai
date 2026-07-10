import type {
  MetricScore,
  MetricKey,
  SeverityBand,
  PlayerCategory,
  PostureMetrics,
  SessionAssessment,
} from '../types/analysis';
import { METRIC_META } from '../constants/metricMeta';
import type { StatisticalFinding } from './patternDetection';
import type { PhraseFeatures } from './phraseFeatures';

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
// Builder helpers
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Upper-layer evidence (L7 phrase features + L8 findings)
// ─────────────────────────────────────────────────────────────

// Which metric card a statistical finding belongs under.
const FINDING_METRIC_KEY: Record<string, MetricKey> = {
  intonation_fatigue: 'pitchAccuracy',
  finger_accuracy_gap: 'pitchAccuracy',
  pitch_tendency: 'pitchAccuracy',
  dynamic_range_narrow: 'dynamicControl',
  bow_distribution_narrow: 'bowDistribution',
  bow_zone_camping: 'bowDistribution',
  upper_bow_tone_degradation: 'toneQuality',
  tip_dynamic_ceiling: 'dynamicControl',
};

const SEVERITY_RANK: Record<StatisticalFinding['severity'], number> = {
  minor: 1,
  moderate: 2,
  significant: 3,
};

// Top findings become key observations — they carry session-specific evidence
// the canned per-severity text can't match.
function buildFindingObservations(
  findings: StatisticalFinding[],
): { metricKey: MetricKey; note: string }[] {
  return [...findings]
    .filter((f) => f.fired && FINDING_METRIC_KEY[f.testId])
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] * b.confidence - SEVERITY_RANK[a.severity] * a.confidence,
    )
    .slice(0, 2)
    .map((f) => ({ metricKey: FINDING_METRIC_KEY[f.testId], note: f.summary }));
}

// One categorical line from the phrase features (L9 rule: no raw numbers).
function buildPhraseObservation(
  features: PhraseFeatures[],
): { metricKey: MetricKey; note: string } | null {
  if (features.length < 2) return null;

  const flatShare = features.filter((f) => f.energy_shape === 'flat').length / features.length;
  if (flatShare > 0.6) {
    return {
      metricKey: 'dynamicControl',
      note: 'Most phrases stay at one dynamic level — shape each phrase with a clear rise and fall.',
    };
  }

  const withBow = features.filter((f) => f.bow_usage !== null);
  if (withBow.length >= 2) {
    const frogShare = withBow.filter((f) => f.bow_usage!.distribution === 'frog_heavy').length / withBow.length;
    const tipShare = withBow.filter((f) => f.bow_usage!.distribution === 'tip_heavy').length / withBow.length;
    if (frogShare > 0.6) {
      return {
        metricKey: 'bowDistribution',
        note: 'Playing is concentrated in the lower half of the bow across most phrases — travel out toward the tip.',
      };
    }
    if (tipShare > 0.6) {
      return {
        metricKey: 'bowDistribution',
        note: 'Playing is concentrated near the tip across most phrases — use the weight available at the frog.',
      };
    }
  }
  return null;
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

export interface AssessmentExtras {
  /** L8 statistical findings that fired. */
  findings?: StatisticalFinding[];
  /** L7 per-phrase features. */
  phraseFeatures?: PhraseFeatures[];
}

export function buildSessionAssessment(
  videoMetrics: MetricScore[],
  userCategory?: PlayerCategory,
  extras?: AssessmentExtras,
): SessionAssessment {
  // Prefer the user's self-reported goal; fall back to video-computed classification
  const category = userCategory ?? classifyPlayer(videoMetrics);
  const postureMetrics = buildPostureMetrics(videoMetrics);
  const techniqueSummary = buildTechniqueSummary(category, videoMetrics);

  // Evidence-backed observations from the upper layers lead; canned per-metric
  // text fills the remaining slots.
  const findingObs = extras?.findings ? buildFindingObservations(extras.findings) : [];
  const phraseObs = extras?.phraseFeatures ? buildPhraseObservation(extras.phraseFeatures) : null;
  const keyObservations = [
    ...findingObs,
    ...(phraseObs ? [phraseObs] : []),
    ...buildKeyObservations(videoMetrics),
  ].slice(0, 5);

  return {
    playerCategory: category,
    techniqueSummary,
    keyObservations,
    postureMetrics,
  };
}
