import type { PracticeBlock, SequenceStep } from '../practiceBlocks';
import { buildSequenceBlock, stepsFromMidi, tempoFor, type ExerciseContext } from './types';
import { stringForMidi, type ViolinString } from './fingerboard';
import { midiToNoteName } from '../pitchNaming';

// ─────────────────────────────────────────────────────────────
// Family 2 — Extracted figure loop
//
// The most direct drill there is: the player's own notes, taken out of the
// piece and looped. No transfer problem, because there is nothing to transfer —
// it *is* the passage.
//
// The variation is rhythmic rather than melodic. Playing the same notes with
// the accents moved is what stops the hand from memorising one groove and
// forces it to actually know each note; it is also the oldest trick in the
// practice-room book, which is a point in its favour.
// ─────────────────────────────────────────────────────────────

export type RhythmVariant = 'straight' | 'long_short' | 'short_long';

const VARIANT_LABEL: Record<RhythmVariant, string> = {
  straight: 'even',
  long_short: 'long–short',
  short_long: 'short–long',
};

/**
 * A rhythm variant is expressed as annotations rather than as note durations:
 * the evaluator grades one note per click, so changing the clicks would change
 * what "on time" means. Telling the player to lean on alternating notes gets
 * the practice benefit without lying to the grader.
 */
function applyVariant(steps: SequenceStep[], variant: RhythmVariant): SequenceStep[] {
  if (variant === 'straight') return steps;
  return steps.map((step, i) => {
    const isLong = variant === 'long_short' ? i % 2 === 0 : i % 2 === 1;
    return { ...step, annotation: `${isLong ? 'lean on this' : 'light'} · ${step.annotation ?? ''}`.trim() };
  });
}

/** Repeat a figure until there are enough notes to judge, without dragging. */
const MIN_STEPS = 6;
const MAX_STEPS = 16;

function loop(midis: number[]): number[] {
  if (midis.length === 0) return [];
  const out = [...midis];
  while (out.length < MIN_STEPS) out.push(...midis);
  return out.slice(0, MAX_STEPS);
}

export function generateExtractedFigure(ctx: ExerciseContext): PracticeBlock | null {
  const { target } = ctx.evidence;
  const source = target.midiSequence ?? [];
  if (source.length < 2) return null;

  const midis = loop(source);
  const preferString = target.strings?.[0] as ViolinString | undefined;
  const variant: RhythmVariant = ctx.intensity === 'guided' ? 'straight' : 'long_short';

  const baseSteps = stepsFromMidi(midis, { preferString, allowShifting: ctx.canShift });
  const steps = applyVariant(baseSteps, variant);
  const repeats = Math.round(midis.length / source.length);

  const figureName = target.noteSequence?.join(' ') ?? 'the flagged figure';

  return buildSequenceBlock({
    ctx,
    slug: 'figure_loop',
    type: 'figure_loop',
    title: 'Your own figure, looped',
    subtitle: `${source.length} notes · ${VARIANT_LABEL[variant]}`,
    reason: ctx.evidence.reason,
    bridge: `These are the exact notes you played — ${figureName} — pulled out of the piece and repeated ${repeats}×${variant === 'straight' ? '' : ` with a ${VARIANT_LABEL[variant]} accent so the hand can't coast on one groove`}. Nothing to transfer: fix it here and it is fixed there.`,
    steps,
    bpm: tempoFor(ctx.intensity),
    estimatedMinutes: 5,
    instructions: [
      `The figure is ${figureName}. Play it once slowly on your own before recording.`,
      variant === 'straight'
        ? 'On the take, one note per click, with a clear stop between notes.'
        : `On the take, one note per click, leaning on the notes marked "lean on this" — the ${VARIANT_LABEL[variant]} pattern.`,
      'If a note keeps missing, stop and place the finger silently before the bow moves.',
    ],
    successSummary: `Play the figure through cleanly, keeping all but a note or two in tune.`,
    fallbackCriteria: 'If note detection is uncertain, play the figure slowly against a tuner and only count attempts that settle before the bow moves.',
    coachPromptContext: `Coach the player's own extracted figure (${figureName}). Keep the feedback about this exact passage. Evidence: ${ctx.evidence.evidenceSummary}`,
    target: {
      metricKey: 'pitchAccuracy',
      // Name and pitch from the same note — see shiftingLadder.ts.
      midiNote: source[0],
      string: preferString ?? stringForMidi(source[0]),
      noteName: midiToNoteName(source[0]),
      startSeconds: target.startSeconds,
      endSeconds: target.endSeconds,
    },
  });
}
