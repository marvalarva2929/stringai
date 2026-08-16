import { midiToNoteName } from '../pitchNaming';

// ─────────────────────────────────────────────────────────────
// Violin fingerboard model.
//
// Every generated exercise has to answer three questions before it can put a
// note on screen: which string, which position, which finger. NoteEvent's
// `positionGroup` can't answer them — it buckets by absolute pitch, so G4 reads
// as "first position" whether it was played with a 4th finger in first position
// on the D string or a 1st finger in fifth position on the G string. That is
// fine for describing a session and useless for prescribing a drill.
//
// This model is string-relative, which is the only way a shifting ladder or a
// crossing wave can name notes the player can actually find.
// ─────────────────────────────────────────────────────────────

export type ViolinString = 'G' | 'D' | 'A' | 'E';

export const STRINGS: ViolinString[] = ['G', 'D', 'A', 'E'];

export const OPEN_MIDI: Record<ViolinString, number> = { G: 55, D: 62, A: 69, E: 76 };

export type PositionName = 'first' | 'third' | 'fifth' | 'seventh';

/**
 * Semitones above the open string at which each position's 1st finger sits.
 * G string: 1st→A3 (+2), 3rd→C4 (+5), 5th→D4 (+7), 7th→F4 (+10).
 */
export const POSITION_BASE: Record<PositionName, number> = {
  first: 2,
  third: 5,
  fifth: 7,
  seventh: 10,
};

export const POSITION_ORDER: PositionName[] = ['first', 'third', 'fifth', 'seventh'];

/** Highest note this model will ask for on a string — 7th position, 4th finger. */
const MAX_SEMITONES_ABOVE_OPEN = 16;

export function isPlayableOn(str: ViolinString, midi: number): boolean {
  const semis = midi - OPEN_MIDI[str];
  return semis >= 0 && semis <= MAX_SEMITONES_ABOVE_OPEN;
}

/**
 * The string a note is most likely played on: the highest string it fits
 * comfortably on, which is how violinists actually choose in first position.
 * `prefer` wins whenever the note is genuinely reachable there — a crossing
 * drill needs to keep both of its strings even when one could be avoided.
 */
export function stringForMidi(midi: number, prefer?: ViolinString): ViolinString {
  if (prefer && isPlayableOn(prefer, midi)) return prefer;
  for (const str of [...STRINGS].reverse()) {
    if (isPlayableOn(str, midi)) return str;
  }
  return 'G';
}

/**
 * Which position puts this note under a finger most naturally on this string.
 *
 * Lowest position that reaches it, which is what a violinist actually does:
 * G4 on the D string is the 3rd finger in first position, not the 1st finger in
 * third position. Searching from the top instead used to return the latter,
 * so a first-position drill labelled its own notes "3rd position" and
 * "5th position" while telling the player not to shift.
 */
export function positionForMidi(midi: number, str: ViolinString): PositionName {
  const semis = midi - OPEN_MIDI[str];
  for (const position of POSITION_ORDER) {
    const base = POSITION_BASE[position];
    if (semis >= base && semis <= base + 6) return position;
  }
  return 'first';
}

/**
 * Finger for a note, given the string and the hand position. 0 = open.
 * Returns null when the note is out of reach of that hand position, which the
 * generators treat as "don't ask for this note here".
 */
export function fingerFor(midi: number, str: ViolinString, position: PositionName): number | null {
  const semis = midi - OPEN_MIDI[str];
  if (semis === 0 && position === 'first') return 0;
  const above = semis - POSITION_BASE[position];
  if (above < 0 || above > 6) return null;
  if (above <= 0) return 1;
  if (above <= 2) return 2;
  if (above <= 4) return 3;
  return 4;
}

/** MIDI note for a finger in a position on a string. */
export function midiFor(str: ViolinString, position: PositionName, finger: number): number {
  if (finger === 0) return OPEN_MIDI[str];
  // Whole steps between fingers, which is the neutral major-ish hand frame the
  // drills start from; generators that need a specific key snap to it after.
  const offsets = [0, 0, 2, 4, 5];
  return OPEN_MIDI[str] + POSITION_BASE[position] + offsets[Math.min(finger, 4)];
}

const POSITION_LABEL: Record<PositionName, string> = {
  first: '1st position',
  third: '3rd position',
  fifth: '5th position',
  seventh: '7th position',
};

export function positionLabel(position: PositionName): string {
  return POSITION_LABEL[position];
}

const FINGER_LABEL = ['open', '1st finger', '2nd finger', '3rd finger', '4th finger'];

export function fingerLabel(finger: number): string {
  return FINGER_LABEL[Math.max(0, Math.min(4, finger))];
}

/**
 * The on-screen hint for one step of a drill: "3rd finger, A string". Kept
 * short deliberately — it sits under a big note name during a live take and
 * has to be readable at a glance with a violin under the chin.
 */
export function stepAnnotation(midi: number, str: ViolinString, position?: PositionName): string {
  const pos = position ?? positionForMidi(midi, str);
  const finger = fingerFor(midi, str, pos);
  if (finger === 0) return `open ${str}`;
  if (finger == null) return `${str} string`;
  return pos === 'first'
    ? `${fingerLabel(finger)}, ${str} string`
    : `${fingerLabel(finger)}, ${str} · ${positionLabel(pos)}`;
}

/** Parses a positionGroup from NoteEvent into this model's vocabulary. */
export function toPositionName(group?: string | null): PositionName {
  if (group === 'third') return 'third';
  if (group === 'fifth') return 'fifth';
  if (group === 'higher') return 'seventh';
  return 'first';
}

export { midiToNoteName };
