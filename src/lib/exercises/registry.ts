import type { PracticeBlock } from '../practiceBlocks';
import type { PracticeEvidenceKind } from '../practiceEvidence';
import type { ExerciseContext, ExerciseGenerator } from './types';
import { generateArpeggioCycle } from './arpeggioCycle';
import { generateExtractedFigure } from './extractedFigure';
import { generateFingerPattern } from './fingerPattern';
import { generateShiftingLadder } from './shiftingLadder';
import { generateCrossingWave } from './crossingWave';
import { generateBowDistribution } from './bowDistribution';
import { generateArticulation } from './articulation';
import { generateTrillChain } from './trillChain';
import { generateRhythmicAcceleration } from './rhythmicAcceleration';
import { generateVibratoControl } from './vibratoControl';
import { generateEtudeFragment } from './etudeFragment';

// ─────────────────────────────────────────────────────────────
// Exercise routing.
//
// One drill per moment. The plan has room for three or four blocks total, so
// giving a single finding two of them costs another finding its drill — worse
// targeting overall, and it defeats the evidence-folding in buildPracticeBlocks
// that exists precisely so corroborating findings converge on one exercise.
//
// Each kind gets an ordered candidate list and the first generator that can
// actually build something wins. A generator returns null when the moment
// doesn't carry what it needs (a shifting ladder with no from/to position), so
// the order is a preference, not an assumption.
//
// Recurring issues route differently. An issue the player has met three weeks
// running does not need the isolation drill again — they have done it. It needs
// the technique put back into a line, which is what an étude fragment is for.
// ─────────────────────────────────────────────────────────────

/** Sessions an issue must recur across before isolation stops being the answer. */
const RECURRENCE_FOR_MUSICAL_SETTING = 3;

export type ExerciseFamily =
  | 'arpeggio_cycle'
  | 'figure_loop'
  | 'finger_pattern'
  | 'shifting_ladder'
  | 'crossing_wave'
  | 'bow_distribution'
  | 'articulation'
  | 'trill_chain'
  | 'acceleration'
  | 'vibrato_control'
  | 'etude_fragment';

export const GENERATORS: Record<ExerciseFamily, ExerciseGenerator> = {
  arpeggio_cycle: generateArpeggioCycle,
  figure_loop: generateExtractedFigure,
  finger_pattern: generateFingerPattern,
  shifting_ladder: generateShiftingLadder,
  crossing_wave: generateCrossingWave,
  bow_distribution: generateBowDistribution,
  articulation: generateArticulation,
  trill_chain: generateTrillChain,
  acceleration: generateRhythmicAcceleration,
  vibrato_control: generateVibratoControl,
  etude_fragment: generateEtudeFragment,
};

/** Candidate families per evidence kind, best-first. */
const ROUTES: Partial<Record<PracticeEvidenceKind, ExerciseFamily[]>> = {
  figure_crossing: ['crossing_wave', 'etude_fragment'],
  figure_shift: ['shifting_ladder', 'etude_fragment'],
  figure_intonation: ['arpeggio_cycle', 'figure_loop'],
  figure_sequence: ['figure_loop', 'arpeggio_cycle'],
  figure_speed: ['acceleration', 'finger_pattern'],
  figure_ornament: ['trill_chain', 'finger_pattern'],
  vibrato: ['vibrato_control'],
  bow_pattern: ['bow_distribution', 'articulation'],
  // `tone` is deliberately absent. A thin or scratchy tone is a force/speed
  // problem, and practiceBlocks already routes it to a fault-specific drill
  // (toneFaultBlock) that targets exactly the fault classifyFrames named.
  // Articulation is about the *character* of a stroke's start and end, which is
  // a different question — sending a scratchy tone there would replace the right
  // medicine with a plausible-sounding wrong one.
};

/** Kinds where a recurring issue is better served by music than by isolation. */
const MUSICAL_SETTING_KINDS = new Set<PracticeEvidenceKind>([
  'figure_crossing',
  'figure_shift',
]);

function candidatesFor(ctx: ExerciseContext): ExerciseFamily[] {
  const families = ROUTES[ctx.evidence.kind] ?? [];
  const recurring = ctx.evidence.sessionCount >= RECURRENCE_FOR_MUSICAL_SETTING;
  if (recurring && MUSICAL_SETTING_KINDS.has(ctx.evidence.kind) && families.includes('etude_fragment')) {
    return ['etude_fragment', ...families.filter((f) => f !== 'etude_fragment')];
  }
  return families;
}

/**
 * The generated drill for this moment, or [] when the kind has no generated
 * family — the caller then falls back to the deterministic blocks in
 * practiceBlocks.ts, which still cover every metric.
 *
 * Returns at most one block. See the header note on why.
 */
export function generateExercises(ctx: ExerciseContext): PracticeBlock[] {
  for (const family of candidatesFor(ctx)) {
    const block = GENERATORS[family](ctx);
    if (block) return [block];
  }
  return [];
}

/** True when this evidence kind has any generated drill at all. */
export function hasGeneratedExercise(kind: PracticeEvidenceKind): boolean {
  return (ROUTES[kind]?.length ?? 0) > 0;
}

export type { ExerciseContext, ExerciseGenerator } from './types';
