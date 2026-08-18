import type { PracticeBlock } from '../practiceBlocks';
import { buildSequenceBlock, tempoFor, type ExerciseContext } from './types';
import {
  OPEN_MIDI,
  fingerLabel,
  midiFor,
  positionLabel,
  stringForMidi,
  toPositionName,
  type PositionName,
  type ViolinString,
} from './fingerboard';
import { resolveKey, snapToKey } from './theory';
import { midiToNoteName } from '../pitchNaming';

// ─────────────────────────────────────────────────────────────
// Family 3 — Schradieck-style finger patterns
//
// Fixed position, no shifting, no string crossing: nothing left to blame but
// the fingers. Schradieck's insight was that the hard part of fast playing is
// not speed but *independence* — the 3rd finger that only moves when the 2nd
// gets out of the way is what collapses a run.
//
// The permutations are chosen so every finger has to follow every other one,
// which is the whole point; a pattern that only ever goes 1-2-3-4 rehearses the
// one ordering the hand is already good at.
// ─────────────────────────────────────────────────────────────

/** Every ordering that makes a finger follow a finger it doesn't usually follow. */
const PERMUTATIONS: number[][] = [
  [1, 2, 1, 3, 1, 4],
  [2, 1, 3, 1, 4, 1],
  [1, 3, 2, 4, 3, 1],
  [4, 3, 2, 1, 2, 3],
];

function patternFor(intensity: ExerciseContext['intensity']): number[] {
  // A guided player gets the two-finger alternations only; more permutations
  // is more to remember, and forgetting the pattern mid-take fails the drill
  // for a reason that has nothing to do with the fingers.
  if (intensity === 'guided') return PERMUTATIONS[0];
  if (intensity === 'balanced') return [...PERMUTATIONS[0], ...PERMUTATIONS[1]];
  return [...PERMUTATIONS[0], ...PERMUTATIONS[2], ...PERMUTATIONS[3]];
}

export function generateFingerPattern(ctx: ExerciseContext): PracticeBlock | null {
  const { target } = ctx.evidence;
  const anchorMidi = target.midiSequence?.[0] ?? target.midiNote ?? OPEN_MIDI.D;
  const str = (target.string ?? target.strings?.[0]) as ViolinString | undefined
    ?? stringForMidi(anchorMidi);
  if (!(str in OPEN_MIDI)) return null;

  const position: PositionName = toPositionName(target.fromPosition ?? target.toPosition);
  const key = resolveKey(target.keyName);
  const fingers = patternFor(ctx.intensity);

  const steps = fingers.map((finger, i) => {
    const midi = snapToKey(midiFor(str, position, finger), key);
    const previous = i > 0 ? fingers[i - 1] : null;
    // Naming which finger *lifts* is the instruction that actually changes
    // behaviour — players drop the new finger fine and leave the old one down.
    const annotation = previous == null
      ? `${fingerLabel(finger)} down`
      : previous > finger
        ? `lift ${fingerLabel(previous)} → ${fingerLabel(finger)}`
        : `${fingerLabel(finger)} down, keep ${fingerLabel(previous)}`;
    return { note: midiToNoteName(midi), annotation };
  });

  const where = `${positionLabel(position)}, ${str} string`;

  return buildSequenceBlock({
    ctx,
    slug: 'finger_pattern',
    type: 'finger_pattern',
    title: 'Finger independence pattern',
    subtitle: where,
    reason: ctx.evidence.reason,
    bridge: `Everything that could hide the problem is gone: one string, one position, no shifts. What's left is whether each finger can move without waiting for the others — which is what was collapsing in the fast passage.`,
    steps,
    bpm: tempoFor(ctx.intensity),
    estimatedMinutes: ctx.intensity === 'advanced' ? 7 : 5,
    instructions: [
      `One note per click. Hand stays in ${where} throughout.`,
      'Fingers fall from the knuckle; lift only where marked.',
    ],
    successSummary: `Play all ${steps.length} notes of the pattern evenly, keeping all but a note or two in tune.`,
    fallbackCriteria: `If note detection is uncertain, tap the pattern silently on the ${str} string and listen to the fingers hitting the fingerboard — they should sound as even as a metronome.`,
    coachPromptContext: `Coach a Schradieck-style finger-independence pattern in ${where}. Focus on lifting, evenness, and staying close to the string. Evidence: ${ctx.evidence.evidenceSummary}`,
    target: {
      metricKey: 'pitchAccuracy',
      string: str,
      midiNote: snapToKey(midiFor(str, position, 1), key),
      startSeconds: target.startSeconds,
      endSeconds: target.endSeconds,
    },
  });
}
