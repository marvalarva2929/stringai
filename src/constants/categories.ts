import type { MetricKey, SeverityBand } from '../types/analysis';

// ─────────────────────────────────────────────────────────────
// Skill categories — the user-facing grouping of the 13 MetricKeys.
//
// This is the vocabulary the results carousel already speaks, hoisted here so
// the Progress screen and piece detail speak it too. A player who sees
// "Bow Technique" after a session should see "Bow Technique" on their trends,
// not four separate bow metrics.
// ─────────────────────────────────────────────────────────────

export type CategoryId =
  | 'intonation'
  | 'vibrato'
  | 'tone'
  | 'dynamics'
  | 'bow'
  | 'posture'
  | 'rhythm';

export interface CategorySpec {
  id: CategoryId;
  label: string;
  keys: MetricKey[];
}

export const CATEGORIES: CategorySpec[] = [
  { id: 'intonation', label: 'Intonation',   keys: ['pitchAccuracy', 'intonationStability'] },
  { id: 'vibrato',    label: 'Vibrato',      keys: ['vibrato'] },
  { id: 'tone',       label: 'Tone Quality', keys: ['toneQuality'] },
  { id: 'dynamics',   label: 'Dynamics',     keys: ['dynamicControl'] },
  { id: 'bow',        label: 'Bow Technique', keys: ['bowSmoothness', 'bowPlacement', 'bowAngle', 'bowDistribution'] },
  { id: 'posture',    label: 'Posture',      keys: ['posture', 'leftHandWrist', 'bowArmLevel'] },
  { id: 'rhythm',     label: 'Rhythm',       keys: ['rhythmAccuracy'] },
];

/** Display order on the Progress screen. Deliberately stable: people scan for
 *  the same row each visit, so sorting by "biggest mover" would cost more than
 *  it gains. Movement is conveyed by the direction chip instead. */
export const CATEGORY_ORDER: CategoryId[] = [
  'intonation', 'tone', 'rhythm', 'vibrato', 'dynamics', 'bow', 'posture',
];

export const CATEGORY_BY_ID: Record<CategoryId, CategorySpec> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c]),
) as Record<CategoryId, CategorySpec>;

/** Every metric key that belongs to some category, for reverse lookup. */
export function categoryForMetric(key: MetricKey): CategoryId | null {
  return CATEGORIES.find((c) => c.keys.includes(key))?.id ?? null;
}

// ─────────────────────────────────────────────────────────────
// Real-unit headline figures
//
// `MetricScore.occurrenceRate` is NOT uniformly a measurement. For toneQuality,
// rhythmAccuracy and the pose/bow metrics it is a genuine fraction (of session
// time, of notes, of frames). For pitchAccuracy, vibrato and dynamicControl it
// is computed as `1 - score/100` — the internal score restated. Rendering that
// as "84% of notes in tune" would invent a unit that was never measured.
//
// So each category declares where its user-facing number legitimately comes
// from. `none` means there is no honest real unit available and the row falls
// back to a qualitative band.
// ─────────────────────────────────────────────────────────────

export type CategoryUnitSource =
  /** Read a genuinely-measured figure captured on MetricHistoryEntry.headline. */
  | { from: 'headline'; field: 'inTuneRate' | 'onGridRate' | 'cleanToneRate' }
  /** Mean of (1 - occurrenceRate) across the category's measured metrics. */
  | { from: 'occurrenceRate' }
  /** No honest real unit — show the qualitative band instead. */
  | { from: 'none' };

export interface CategoryUnit {
  source: CategoryUnitSource;
  /** Copy that follows the percentage, e.g. "in tune" → "84% in tune". */
  suffix: string;
}

export const CATEGORY_UNITS: Record<CategoryId, CategoryUnit> = {
  intonation: { source: { from: 'headline', field: 'inTuneRate' },    suffix: 'in tune' },
  rhythm:     { source: { from: 'headline', field: 'onGridRate' },    suffix: 'on the grid' },
  tone:       { source: { from: 'headline', field: 'cleanToneRate' }, suffix: 'clean' },
  bow:        { source: { from: 'occurrenceRate' },                   suffix: 'in the zone' },
  posture:    { source: { from: 'occurrenceRate' },                   suffix: 'held steady' },
  // occurrenceRate for both of these is `1 - score/100`, so there is nothing
  // real to show a percentage of. Qualitative band only.
  vibrato:    { source: { from: 'none' }, suffix: '' },
  dynamics:   { source: { from: 'none' }, suffix: '' },
};

/** Plain-language stand-in for a score, used wherever a real unit isn't
 *  available. Bands match severityFromScore's 90/70/50 thresholds. */
export function qualitativeBand(severity: SeverityBand): string {
  switch (severity) {
    case 'excellent':      return 'excellent';
    case 'good':           return 'solid';
    case 'needs_attention': return 'developing';
    case 'critical':       return 'needs work';
  }
}
