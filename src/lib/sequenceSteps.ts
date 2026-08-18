import type { EvaluatorParams, SequenceStep } from './practiceBlocks';
import { scaleNoteSequence } from './scaleSequence';
import { noteNameToMidi } from './pitchNaming';
import { fingeringFor } from './fingering';

// ─────────────────────────────────────────────────────────────
// One resolver for every click-paced drill.
//
// The runner has to know which note to put on screen at beat i, and the
// evaluator has to know which note beat i was supposed to be. Those must be the
// same list — if they ever drift, the app grades a player against notes it never
// showed them. So both call this, and nothing else derives the sequence.
// ─────────────────────────────────────────────────────────────

/** Slow enough for a beginner to place each finger cleanly between clicks. */
export const DEFAULT_SEQUENCE_BPM = 60;

/**
 * Bounds every paced drill's click actually runs at.
 *
 * These live here rather than in the runner screen because generators write
 * tempo into their own instruction copy. When the two disagreed, a drill printed
 * "the click marks each note (190 BPM)" while the click played at 132 — so the
 * arithmetic the exercise explained to the player was simply wrong.
 */
export const MIN_SEQUENCE_BPM = 34;
export const MAX_SEQUENCE_BPM = 132;

export function clampSequenceBpm(bpm: number): number {
  return Math.max(MIN_SEQUENCE_BPM, Math.min(MAX_SEQUENCE_BPM, Math.round(bpm)));
}

/**
 * The paced note sequence a take expects, or [] when the drill isn't paced.
 * `scale` is kept as the derived-from-a-name special case so plans persisted
 * before generated sequences existed still run.
 */
export function sequenceStepsFor(params: EvaluatorParams | undefined): SequenceStep[] {
  if (!params) return [];
  if (params.evaluatorId === 'sequence') return params.steps;
  if (params.evaluatorId === 'scale') {
    // Scale steps are derived from a name rather than authored, so they get
    // their fingering here. A bare "B3" on screen leaves a beginner hunting for
    // the note; "2nd finger, G string" tells them where to put their hand.
    return scaleNoteSequence(params.scaleName, params.rootMidiNote).map((note) => {
      const midi = noteNameToMidi(note);
      return { note, annotation: midi != null ? fingeringFor(midi)?.label : undefined };
    });
  }
  return [];
}

/** Just the note names, in order — what the evaluator grades against. */
export function expectedNotesFor(params: EvaluatorParams | undefined): string[] {
  return sequenceStepsFor(params).map((step) => step.note);
}

/** Click tempo for a paced take. */
export function sequenceBpmFor(params: EvaluatorParams | undefined): number {
  return params?.evaluatorId === 'sequence' ? params.bpm : DEFAULT_SEQUENCE_BPM;
}
