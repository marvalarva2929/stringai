import type { PracticeBlock } from '../practiceBlocks';
import { buildSequenceBlock, tempoFor, type ExerciseContext } from './types';
import { OPEN_MIDI, STRINGS, stepAnnotation, type ViolinString } from './fingerboard';
import { resolveKey, snapToKey } from './theory';
import { midiToNoteName } from '../pitchNaming';

// ─────────────────────────────────────────────────────────────
// Family 5 — String-crossing wave
//
// For the bump and the drift that show up whenever the arm has to change level.
// The drill rocks between the exact two strings the player fumbled — adjacent
// or skipped, because a skipped pair is a different arm movement and drilling
// D–A does nothing for a G–A leap.
//
// It starts on open strings deliberately. With no left hand involved, every
// remaining error belongs to the bow arm, which is where the problem is.
// ─────────────────────────────────────────────────────────────

const isViolinString = (s: string): s is ViolinString => STRINGS.includes(s as ViolinString);

/**
 * The two strings to rock between.
 *
 * Reads the crossings the player actually made. Taking the outer edges of
 * `strings` — every string the passage touched — is what produced a G–E drill
 * for someone whose playing only ever crossed G to D: those are the extremes of
 * the range, not a crossing that happened.
 */
function parsePair(target: ExerciseContext['evidence']['target']): [ViolinString, ViolinString] | null {
  for (const pair of target.stringPairs ?? []) {
    const [low, high] = pair.split('-');
    if (isViolinString(low) && isViolinString(high) && low !== high) {
      return OPEN_MIDI[low] < OPEN_MIDI[high] ? [low, high] : [high, low];
    }
  }

  // Older evidence has no pair list. Two strings can only have crossed each
  // other, so that case is safe; three or more is ambiguous and the drill is
  // better declined than guessed.
  const strings = [...new Set((target.strings ?? []).filter(isViolinString))];
  if (strings.length === 2) {
    const sorted = strings.sort((a, b) => OPEN_MIDI[a] - OPEN_MIDI[b]);
    return [sorted[0], sorted[1]];
  }
  return null;
}

function gapLabel(low: ViolinString, high: ViolinString): string {
  const distance = STRINGS.indexOf(high) - STRINGS.indexOf(low);
  if (distance <= 1) return 'adjacent strings';
  return distance === 2 ? 'a skipped string' : 'two skipped strings';
}

export function generateCrossingWave(ctx: ExerciseContext): PracticeBlock | null {
  const pair = parsePair(ctx.evidence.target);
  if (!pair) return null;
  const [low, high] = pair;
  if (low === high) return null;

  const key = resolveKey(ctx.evidence.target.keyName);
  const advanced = ctx.intensity === 'advanced';

  // Two halves. Open strings first — the arm alone. Then the same rocking with
  // one stopped note per string, which is where the arm change usually starts
  // dragging the left hand out of tune.
  const openMidis = [OPEN_MIDI[low], OPEN_MIDI[high], OPEN_MIDI[low], OPEN_MIDI[high]];
  const stoppedLow = snapToKey(OPEN_MIDI[low] + 2, key);
  const stoppedHigh = snapToKey(OPEN_MIDI[high] + 2, key);
  const fingeredMidis = advanced
    ? [OPEN_MIDI[low], stoppedHigh, stoppedLow, OPEN_MIDI[high], stoppedLow, stoppedHigh]
    : [OPEN_MIDI[low], stoppedHigh, OPEN_MIDI[low], stoppedHigh];

  const midis = [...openMidis, ...fingeredMidis];
  // The wave alternates by construction, so the string a step belongs to is its
  // position in the pattern — not something to re-derive from pitch. Inferring
  // it from pitch would put a stopped low-string note back on the high string
  // and quietly turn the crossing drill into a one-string drill.
  const stringAt = (i: number): ViolinString => (i % 2 === 0 ? low : high);

  const steps = midis.map((midi, i) => {
    const str = stringAt(i);
    const crossed = i > 0 && stringAt(i - 1) !== str;
    return {
      note: midiToNoteName(midi),
      annotation: crossed ? `cross to ${str}` : stepAnnotation(midi, str),
    };
  });

  const pairLabel = `${low}→${high}`;

  return buildSequenceBlock({
    ctx,
    slug: 'crossing_wave',
    type: 'crossing_wave',
    title: `${pairLabel} crossing wave`,
    subtitle: `${gapLabel(low, high)} · open then stopped`,
    reason: ctx.evidence.reason,
    bridge: `Same two strings you were crossing in the piece, ${gapLabel(low, high)}. The first four notes are open, so anything uneven is the bow arm and nothing else; then one finger goes down and you find out whether the arm change is dragging the left hand with it.`,
    steps,
    bpm: tempoFor(ctx.intensity),
    estimatedMinutes: advanced ? 6 : 5,
    instructions: [
      `One note per click, crossing between ${low} and ${high}.`,
      'Change arm level from the shoulder before the bow arrives.',
    ],
    successSummary: `Rock between ${low} and ${high} for all ${steps.length} notes, keeping every note in tune and every crossing clean.`,
    fallbackCriteria: `If note detection is uncertain, play open ${low} and ${high} alternating slowly and listen for the click at the change — that sound is the whole target.`,
    coachPromptContext: `Coach a ${pairLabel} string-crossing drill. Focus on arm level changing ahead of the bow, not on the left hand. Evidence: ${ctx.evidence.evidenceSummary}`,
    target: {
      metricKey: 'bowSmoothness',
      string: low,
      midiNote: OPEN_MIDI[low],
      startSeconds: ctx.evidence.target.startSeconds,
      endSeconds: ctx.evidence.target.endSeconds,
    },
  });
}
