import type { SkillLevel } from '../../types/user';
import type { RankedPracticeEvidence } from '../practiceRanking';
import type {
  CoachIntensity,
  PracticeBlock,
  PracticeBlockType,
  PracticeEvidenceRef,
  SequenceStep,
} from '../practiceBlocks';
import { stepAnnotation, stringForMidi, type ViolinString } from './fingerboard';
import { planFingering } from './fingeringPlan';
import { passMarkFor } from '../sequenceScore';
import { midiToNoteName } from '../pitchNaming';

// ─────────────────────────────────────────────────────────────
// The exercise generator contract.
//
// A generator takes a musical moment and returns a runnable drill whose notes
// come from that moment. The old library was 48 prose blobs keyed by metric,
// so the best it could ever do was pick the least-wrong paragraph. A generator
// can produce the arpeggio of the chord the player actually fumbled, on the
// string they fumbled it on.
//
// The `reason` a generator writes is not decoration. It is the sentence that
// makes the drill make sense, and it must trace back to the evidence — never a
// generic description of the exercise type.
// ─────────────────────────────────────────────────────────────

export interface ExerciseContext {
  evidence: RankedPracticeEvidence;
  intensity: CoachIntensity;
  skillLevel?: SkillLevel;
  /**
   * Whether the player has been taught to shift. False keeps every generated
   * drill in first position — see useTechniqueSkillStore for why the default
   * is "assume not".
   */
  canShift?: boolean;
}

export type ExerciseGenerator = (ctx: ExerciseContext) => PracticeBlock | null;

/**
 * Cents tolerance by coach intensity.
 *
 * The earlier ladder (8/10/12) demanded better-than-professional accuracy: the
 * just-noticeable difference for pitch is roughly 5–10 cents, and real violin
 * playing — vibrato included — swings ±20–30. A gate a player cannot clear no
 * matter how well they play teaches them the app is broken, not that they are
 * out of tune. 25 cents is a quarter of a semitone: audibly off, but reachable.
 */
export function centsFor(intensity: CoachIntensity): number {
  return intensity === 'advanced' ? 15 : intensity === 'balanced' ? 20 : 25;
}

/** Click tempo by coach intensity, for drills that don't set their own. */
export function tempoFor(intensity: CoachIntensity): number {
  return intensity === 'advanced' ? 76 : intensity === 'balanced' ? 66 : 56;
}

export function evidenceRef(evidence: RankedPracticeEvidence): PracticeEvidenceRef {
  return {
    evidenceId: evidence.id,
    title: evidence.title,
    reason: evidence.evidenceSummary,
    sourceSessionId: evidence.sourceSessionId,
    startSeconds: evidence.target.startSeconds,
    endSeconds: evidence.target.endSeconds,
  };
}

/**
 * Turns MIDI notes into annotated steps with a real fingering plan.
 *
 * Not a per-note lookup: the whole sequence is planned together so shifts land
 * where a teacher would put them rather than on whichever note first fails to
 * fit. See fingeringPlan.ts.
 */
export function stepsFromMidi(
  midis: number[],
  options: {
    preferString?: ViolinString;
    /** False keeps the plan in first position. */
    allowShifting?: boolean;
    annotate?: (midi: number, index: number, str: ViolinString) => string | undefined;
  } = {},
): SequenceStep[] {
  const plan = planFingering(midis, {
    preferString: options.preferString,
    allowShifting: options.allowShifting,
  });
  return plan.notes.map((note, index) => {
    const custom = options.annotate?.(note.midi, index, note.string);
    return {
      note: note.noteName,
      // A custom annotation never overrides a shift: knowing the hand has to
      // move is more important than any label the generator wanted here.
      annotation: note.isShift ? note.annotation : (custom ?? note.annotation),
    };
  });
}

/** True when this note sequence cannot be played without leaving first position. */
export function needsShifting(midis: number[], preferString?: ViolinString): boolean {
  return planFingering(midis, { preferString }).requiresShifting;
}

export interface BuildSequenceBlockArgs {
  ctx: ExerciseContext;
  /** Block id suffix; combined with the evidence id so progress keys stay stable. */
  slug: string;
  type: PracticeBlockType;
  title: string;
  subtitle: string;
  /** Why this drill, in terms of what the player did. */
  reason: string;
  /** "This drill is that, isolated" — the sentence that bridges the two. */
  bridge: string;
  steps: SequenceStep[];
  bpm: number;
  estimatedMinutes: number;
  instructions: string[];
  successSummary: string;
  fallbackCriteria: string;
  coachPromptContext: string;
  centsThreshold?: number;
  target?: PracticeBlock['target'];
}

/**
 * Assembles a click-paced, per-note-graded PracticeBlock. Every sequence drill
 * goes through here so they share one shape: same evaluator, same live mode,
 * same evidence wiring — the runner needs no special cases.
 */
export function buildSequenceBlock(args: BuildSequenceBlockArgs): PracticeBlock {
  const { ctx, steps } = args;
  const cents = args.centsThreshold ?? centsFor(ctx.intensity);

  return {
    id: `${args.slug}:${ctx.evidence.id}`,
    type: args.type,
    title: args.title,
    subtitle: args.subtitle,
    reason: args.reason,
    bridge: args.bridge,
    estimatedMinutes: args.estimatedMinutes,
    coachIntensity: ctx.intensity,
    instructions: args.instructions,
    target: args.target ?? {
      metricKey: ctx.evidence.metricKey,
      pitchClass: ctx.evidence.target.pitchClass,
      midiNote: ctx.evidence.target.midiNote,
      noteName: ctx.evidence.target.noteName,
      string: ctx.evidence.target.string,
      finger: ctx.evidence.target.finger,
      tendency: ctx.evidence.target.tendency,
      startSeconds: ctx.evidence.target.startSeconds,
      endSeconds: ctx.evidence.target.endSeconds,
    },
    liveMode: {
      label: 'Metronome paces it; the mic grades every note',
      signals: ['pitch', 'tone'],
      requiresMic: true,
      requiresCamera: false,
      status: 'ready',
    },
    successCriteria: {
      // State the gate the take is actually judged by. This used to quote a
      // score bar, which meant a player could beat the number shown here and
      // still be told they had not passed.
      summary: `${args.successSummary} Every note within ${cents}\u00A2 to pass.`,
      repetitions: 1,
      centsThreshold: cents,
    },
    evaluator: {
      evaluatorId: 'sequence',
      steps,
      bpm: args.bpm,
      centsThreshold: cents,
      passMark: passMarkFor(ctx.intensity),
    },
    fallbackCriteria: args.fallbackCriteria,
    coachPromptContext: args.coachPromptContext,
    evidenceRefs: [evidenceRef(ctx.evidence)],
  };
}
