import type { PlayerCategory } from '../types/analysis';
import type { PracticeEvidence, PracticeEvidenceKind } from './practiceEvidence';

export interface RankedPracticeEvidence extends PracticeEvidence {
  rankScore: number;
}

export interface PracticeRankingOptions {
  playerCategory?: PlayerCategory | null;
}

// Musical moments sit above the bare pitch-class finding they usually subsume.
// "C# was flat 4 of 9 times" and "the G arpeggio kept landing under the third"
// can describe the very same notes; the second is the better thing to practise,
// and it comes with a drill that has actual notes in it. A moment only reaches
// this tier when it carries a measured contrast — priority, computed in
// musicalMoments.ts, is where an uncorroborated one loses ground.
const KIND_BASE: Record<PracticeEvidenceKind, number> = {
  figure_crossing: 132,
  figure_shift: 130,
  figure_intonation: 128,
  figure_sequence: 126,
  figure_speed: 124,
  figure_ornament: 118,
  pitch_note: 120,
  pitch_tendency: 112,
  intonation_stability: 106,
  vibrato: 96,
  bow_pattern: 92,
  rhythm: 86,
  tone: 82,
  phrase: 78,
  metric_fallback: 62,
};

const FOUNDATION_METRICS = new Set([
  'pitchAccuracy',
  'intonationStability',
  'toneQuality',
  'bowPlacement',
  'bowAngle',
  'bowArmLevel',
  'leftHandWrist',
  'posture',
]);

const REFINEMENT_KINDS = new Set<PracticeEvidenceKind>([
  'phrase',
  'vibrato',
  'bow_pattern',
  'pitch_tendency',
  'figure_sequence',
  'figure_ornament',
  'figure_speed',
]);

export function rankPracticeEvidence(
  evidence: PracticeEvidence[],
  options: PracticeRankingOptions = {},
): RankedPracticeEvidence[] {
  const category = options.playerCategory ?? 'foundation';

  return evidence
    .map((item) => {
      let score = KIND_BASE[item.kind] + item.priority * 0.55 + item.confidence * 18;

      if (category === 'foundation' && FOUNDATION_METRICS.has(item.metricKey)) score += 12;
      if (category === 'refinement' && REFINEMENT_KINDS.has(item.kind)) score += 12;

      if (item.supportsLive && item.measurementAvailable) score += 8;
      if (!item.measurementAvailable) score -= 30;
      if (item.kind === 'metric_fallback') score -= 12;

      return { ...item, rankScore: Math.round(score * 10) / 10 };
    })
    .sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.title.localeCompare(b.title);
    });
}
