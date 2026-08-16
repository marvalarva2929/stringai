import {
  OPEN_MIDI,
  POSITION_BASE,
  POSITION_ORDER,
  fingerFor,
  fingerLabel,
  positionLabel,
  stringForMidi,
  type PositionName,
  type ViolinString,
} from './fingerboard';
import { midiToNoteName } from '../pitchNaming';

/** Low to high, so "the next string up" is just the next index. */
const STRING_ORDER: ViolinString[] = ['G', 'D', 'A', 'E'];

// ─────────────────────────────────────────────────────────────
// Where the shift goes.
//
// Labelling each note with the lowest position that reaches it is correct
// note-by-note and wrong as fingering. It shifts at the last possible moment —
// the note that finally doesn't fit — which is exactly what a teacher spends
// lessons training out of a student. It also says nothing about *how* to get
// there, so a drill would hand you "4th finger, D · 3rd position" with no hint
// that a shift just happened.
//
// Two rules do most of the work, and both are standard pedagogy:
//
//   Shift early. Once a passage is committed to a higher position, move at the
//   earliest note that can already be played up there, not at the note that
//   forces it. You arrive with time in hand instead of lunging.
//
//   Shift on a strong finger. The 1st, 2nd and 3rd fingers can carry a shift
//   and guide the hand; landing a shift on the 4th finger is a stretch onto the
//   weakest finger and lands out of tune. Where there is a choice, arrive on 1.
//
//   Cross before you shift. A one-octave scale needs no position change at all
//   — you take the top half on the next string up. Forcing the whole sequence
//   onto one string and shifting instead is a fingering no teacher would give,
//   and it was inventing shifts for passages that plainly don't need one.
//
// The plan also names the guide finger, because "shift to 3rd position" is not
// an instruction — "1st finger slides up to G" is.
// ─────────────────────────────────────────────────────────────

export interface PlannedNote {
  midi: number;
  noteName: string;
  string: ViolinString;
  position: PositionName;
  /** 0 = open string. */
  finger: number;
  /** True on the note where the hand moves to a new position. */
  isShift: boolean;
  /** Position left behind, on a shift note. */
  fromPosition?: PositionName;
  /** Short on-screen instruction for this note. */
  annotation: string;
}

export interface FingeringPlanOptions {
  /** Where to start. A hint, not a cage — see `lockToString`. */
  preferString?: ViolinString;
  /**
   * Keep every note on `preferString`, shifting rather than crossing. For
   * drills that are *about* one string (a shift ladder, a finger pattern);
   * wrong for anything melodic, which should cross.
   */
  lockToString?: boolean;
  /**
   * When false the plan never leaves first position: notes out of reach are
   * reported so the caller can choose a different register rather than
   * silently asking a student for a position they have not been taught.
   */
  allowShifting?: boolean;
}

export interface FingeringPlan {
  notes: PlannedNote[];
  /** Distinct positions used, in order of first appearance. */
  positions: PositionName[];
  shiftCount: number;
  /** True when any note needed a position above first. */
  requiresShifting: boolean;
  /**
   * Notes that could not be played under the constraints (first position only,
   * say). Empty when the plan covers the whole sequence.
   */
  unreachable: number[];
}

/** Arriving here is a stretch onto the weakest finger — avoid landing a shift on it. */
const WEAK_ARRIVAL_FINGER = 4;

function reachable(midi: number, str: ViolinString, position: PositionName): boolean {
  return fingerFor(midi, str, position) != null;
}

/** Positions that can play this note on this string, lowest first. */
function positionsFor(midi: number, str: ViolinString): PositionName[] {
  return POSITION_ORDER.filter((position) => reachable(midi, str, position));
}

function describe(note: PlannedNote): string {
  if (note.finger === 0) return `open ${note.string}`;
  const finger = fingerLabel(note.finger);
  if (!note.isShift) {
    return note.position === 'first'
      ? `${finger}, ${note.string} string`
      : `${finger}, ${note.string} · ${positionLabel(note.position)}`;
  }
  const direction = POSITION_ORDER.indexOf(note.position)
    > POSITION_ORDER.indexOf(note.fromPosition ?? 'first') ? 'up' : 'back';
  return `SHIFT ${direction} to ${positionLabel(note.position)} — ${finger} slides to ${note.noteName}`;
}

/**
 * Fingering for a sequence of notes, with shifts placed where a teacher would
 * put them rather than where the notes force them.
 */
export function planFingering(
  midis: number[],
  options: FingeringPlanOptions = {},
): FingeringPlan {
  const allowShifting = options.allowShifting ?? true;
  const lock = options.lockToString ?? false;

  const notes: PlannedNote[] = [];
  const unreachable: number[] = [];
  let currentString: ViolinString = options.preferString
    ?? stringForMidi(midis[0] ?? OPEN_MIDI.D);
  let currentPosition: PositionName = 'first';
  // Earliest note that could already have been played in the next position up,
  // so a later forced shift can be pulled back to it.
  let earliestShiftIndex: number | null = null;
  let pendingPosition: PositionName | null = null;

  /** Strings this note can be played on, nearest to the current one first. */
  const stringChoices = (midi: number): ViolinString[] => {
    if (lock) return [currentString];
    const here = STRING_ORDER.indexOf(currentString);
    return [...STRING_ORDER]
      .filter((str) => midi >= OPEN_MIDI[str])
      .sort((a, b) =>
        Math.abs(STRING_ORDER.indexOf(a) - here) - Math.abs(STRING_ORDER.indexOf(b) - here));
  };

  for (const midi of midis) {
    // An open string is free: no position, no crossing cost.
    const openString = STRING_ORDER.find((str) => OPEN_MIDI[str] === midi);
    if (openString && (!lock || openString === currentString)) {
      notes.push(makeNote(midi, openString, currentPosition, 0, false));
      continue;
    }

    // Every playable (string, position) for this note, ranked the way a
    // violinist chooses: don't move the hand if you don't have to; if you must,
    // prefer the lowest position that reaches the note over staying high on a
    // different string. Ranking rather than a chain of ifs is what stops a
    // descending passage from crossing down while stranded in 7th position.
    const candidates: { str: ViolinString; position: PositionName; finger: number }[] = [];
    for (const str of stringChoices(midi)) {
      for (const position of positionsFor(midi, str)) {
        const finger = fingerFor(midi, str, position);
        if (finger != null) candidates.push({ str, position, finger });
      }
    }

    if (candidates.length === 0) {
      unreachable.push(midi);
      notes.push(makeNote(midi, currentString, currentPosition, 1, false));
      continue;
    }

    const here = STRING_ORDER.indexOf(currentString);
    const currentIndex = POSITION_ORDER.indexOf(currentPosition);
    const rank = (c: { str: ViolinString; position: PositionName; finger: number }) => {
      const movesHand = c.position !== currentPosition;
      const crosses = c.str !== currentString;
      // Crossing DOWN to a lower string while the hand is still up the
      // fingerboard is the one "free" option that isn't: a descending passage
      // has to come back down eventually, and staying high to avoid one shift
      // just means an uglier one later. Treated as costly as moving the hand,
      // which lets the lower position win the next tiebreak.
      const strandedHigh = crosses
        && STRING_ORDER.indexOf(c.str) < here
        && c.position !== 'first';
      return [
        movesHand || strandedHigh ? 1 : 0,                    // stay put if you truly can
        // Where the hand IS moving, what it lands on outranks how far it goes.
        // A shift onto the 4th finger is a stretch onto the weakest one and
        // lands out of tune; better to travel less far and arrive on 1, 2 or 3.
        c.finger === WEAK_ARRIVAL_FINGER && movesHand ? 1 : 0,
        POSITION_ORDER.indexOf(c.position),                   // then prefer low positions
        crosses ? Math.abs(STRING_ORDER.indexOf(c.str) - here) : 0,
      ];
    };
    const usable = allowShifting
      ? candidates
      : candidates.filter((c) => c.position === 'first');
    if (usable.length === 0) {
      // First position only, and this note isn't in it.
      unreachable.push(midi);
      const fallback = candidates[0];
      notes.push(makeNote(midi, fallback.str, fallback.position, fallback.finger, false));
      currentString = fallback.str;
      continue;
    }

    const best = usable.slice().sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return 0;
    })[0];

    if (best.position === currentPosition) {
      notes.push(makeNote(midi, best.str, best.position, best.finger, false));
      currentString = best.str;
      // Remember how early the hand could already have moved up, so a shift
      // forced later can be pulled back to here.
      const higher = positionsFor(midi, best.str).filter(
        (p) => POSITION_ORDER.indexOf(p) > currentIndex,
      );
      if (higher.length > 0 && earliestShiftIndex == null) {
        earliestShiftIndex = notes.length - 1;
        pendingPosition = higher[0];
      } else if (higher.length === 0) {
        earliestShiftIndex = null;
        pendingPosition = null;
      }
      continue;
    }

    // The hand has to move. Shift as early as the passage allows.
    const shiftAt = earliestShiftIndex != null && pendingPosition === best.position
      ? earliestShiftIndex
      : notes.length;

    if (shiftAt < notes.length) {
      for (let k = shiftAt; k < notes.length; k++) {
        const existing = notes[k];
        if (existing.finger === 0) continue;
        const refingered = fingerFor(existing.midi, existing.string, best.position);
        if (refingered == null) continue;
        notes[k] = makeNote(
          existing.midi, existing.string, best.position, refingered,
          k === shiftAt, currentPosition,
        );
      }
    }

    notes.push(makeNote(
      midi, best.str, best.position, best.finger,
      // Starting the drill in a position isn't a shift — there was no hand
      // there to move.
      shiftAt === notes.length && notes.length > 0,
      currentPosition,
    ));
    currentString = best.str;
    currentPosition = best.position;
    earliestShiftIndex = null;
    pendingPosition = null;
  }

  const positions: PositionName[] = [];
  for (const note of notes) {
    if (!positions.includes(note.position)) positions.push(note.position);
  }

  return {
    notes,
    positions,
    shiftCount: notes.filter((n) => n.isShift).length,
    requiresShifting: positions.some((p) => p !== 'first'),
    unreachable,
  };
}

function makeNote(
  midi: number,
  str: ViolinString,
  position: PositionName,
  finger: number,
  isShift: boolean,
  fromPosition?: PositionName,
): PlannedNote {
  const note: PlannedNote = {
    midi,
    noteName: midiToNoteName(midi),
    string: str,
    position,
    finger,
    isShift,
    fromPosition: isShift ? fromPosition : undefined,
    annotation: '',
  };
  note.annotation = describe(note);
  return note;
}

/** Highest note playable in first position on a string, for range checks. */
export function firstPositionCeiling(str: ViolinString): number {
  return OPEN_MIDI[str] + POSITION_BASE.first + 6;
}
