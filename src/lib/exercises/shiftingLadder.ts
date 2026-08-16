import type { PracticeBlock } from '../practiceBlocks';
import { buildSequenceBlock, tempoFor, type ExerciseContext } from './types';
import {
  OPEN_MIDI,
  POSITION_ORDER,
  fingerLabel,
  midiFor,
  positionLabel,
  toPositionName,
  type PositionName,
  type ViolinString,
} from './fingerboard';
import { resolveKey, snapToKey } from './theory';
import { midiToNoteName } from '../pitchNaming';

// ─────────────────────────────────────────────────────────────
// Family 4 — Shifting ladder (Ševčík Op. 8 in spirit)
//
// A shift goes wrong for one of two reasons: the hand doesn't know how far it
// is going, or it arrives and then corrects. Both are invisible inside a piece,
// because by the time you hear the landing you are already two notes past it.
//
// The ladder isolates it: one finger, one string, the same journey over and
// over, with the note before and after so the approach and the landing are both
// in the take. It climbs through the intermediate positions first and only then
// does the full jump, because a hand that can't find third can't find fifth.
// ─────────────────────────────────────────────────────────────

function ladderPositions(from: PositionName, to: PositionName): PositionName[] {
  const fromIndex = POSITION_ORDER.indexOf(from);
  const toIndex = POSITION_ORDER.indexOf(to);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
    return [from, to];
  }
  const step = toIndex > fromIndex ? 1 : -1;
  const rungs: PositionName[] = [];
  for (let i = fromIndex; i !== toIndex + step; i += step) rungs.push(POSITION_ORDER[i]);
  return rungs;
}

export function generateShiftingLadder(ctx: ExerciseContext): PracticeBlock | null {
  const { target } = ctx.evidence;
  const str = (target.string ?? target.strings?.[0]) as ViolinString | undefined;
  if (!str || !(str in OPEN_MIDI)) return null;

  const from = toPositionName(target.fromPosition);
  const to = toPositionName(target.toPosition);
  if (from === to) return null;
  // This drill IS the shift, so there is no first-position version of it. When
  // the player hasn't been taught to shift, decline and let the next candidate
  // (an étude fragment, which can stay put) take the slot.
  if (ctx.canShift === false) return null;

  const key = resolveKey(target.keyName);
  // The shift's own finger when we know it; 1st finger otherwise, because that
  // is the finger a shift is measured from even when another one lands.
  const finger = target.finger && target.finger > 0 ? target.finger : 1;

  const rungs = ladderPositions(from, to);
  const midis: number[] = [];
  const annotations: string[] = [];

  // Anchor: the open string, so the ear has a reference the shift is measured
  // against rather than only the note it just left.
  midis.push(OPEN_MIDI[str]);
  annotations.push(`open ${str} — your reference`);

  for (const position of rungs) {
    const midi = snapToKey(midiFor(str, position, finger), key);
    midis.push(midi);
    annotations.push(
      position === from
        ? `${fingerLabel(finger)}, ${positionLabel(position)} — start here`
        : `shift to ${positionLabel(position)}`,
    );
  }

  // Back down the ladder, which is the direction most players never practise.
  for (let i = rungs.length - 2; i >= 0; i--) {
    const midi = snapToKey(midiFor(str, rungs[i], finger), key);
    midis.push(midi);
    annotations.push(`back to ${positionLabel(rungs[i])}`);
  }

  if (midis.length < 4) return null;

  const steps = midis.map((midi, i) => ({
    note: midiToNoteName(midi),
    annotation: annotations[i],
  }));

  const journey = `${positionLabel(from)} → ${positionLabel(to)}`;

  return buildSequenceBlock({
    ctx,
    slug: 'shifting_ladder',
    type: 'shifting_ladder',
    title: `${str} string shift ladder`,
    subtitle: journey,
    reason: ctx.evidence.reason,
    bridge: `The shift that missed in the piece was ${journey} on the ${str} string. Here it is on its own, climbing through ${rungs.map(positionLabel).join(' → ')} and back, with the open ${str} first so your ear has something to measure the landing against.`,
    steps,
    // A shift needs time to be prepared silently, so this runs slower than the
    // other sequence drills regardless of intensity.
    bpm: Math.max(44, tempoFor(ctx.intensity) - 16),
    estimatedMinutes: 6,
    instructions: [
      `Before recording: play the open ${str}, then find ${positionLabel(to)} with your ${fingerLabel(finger)} and check it against the open string. Do that three or four times until the distance feels known rather than guessed.`,
      'On the take, one note per click. During the click before each shift, release the thumb and let the hand travel — arrive early and wait, rather than shifting on the beat.',
      'Do not correct after the note sounds. A landing that slides into tune still counts as a missed shift; the aim is to arrive there.',
    ],
    successSummary: `Climb and descend the ladder on the ${str} string, landing all but one rung in tune.`,
    fallbackCriteria: `If note detection is uncertain, shift between ${positionLabel(from)} and ${positionLabel(to)} silently — bow off the string — and check each landing against the open ${str} before adding sound.`,
    coachPromptContext: `Coach a ${journey} shifting ladder on the ${str} string with the ${fingerLabel(finger)}. Focus on silent preparation and arriving early, not on pressure. Evidence: ${ctx.evidence.evidenceSummary}`,
    target: {
      metricKey: 'pitchAccuracy',
      string: str,
      finger,
      // Both from the same note. Taking `noteName` from the evidence while
      // `midiNote` came from the drill is what made the reference-pitch panel
      // announce one note and play another.
      midiNote: midis[1],
      noteName: midiToNoteName(midis[1]),
      startSeconds: target.startSeconds,
      endSeconds: target.endSeconds,
    },
  });
}
