import {
  OPEN_MIDI,
  fingerFor,
  fingerLabel,
  positionForMidi,
  positionLabel,
  stringForMidi,
  type PositionName,
  type ViolinString,
} from './exercises/fingerboard';

// ─────────────────────────────────────────────────────────────
// Where a note lives on the instrument, for anything that shows a note name.
//
// "B3" tells a player what to call the note. "2nd finger, G string" tells them
// where to put their hand. Beginners need the second one, and every surface
// that names a note should be able to say it — so the logic lives here rather
// than only inside the exercise generators that first needed it.
// ─────────────────────────────────────────────────────────────

export interface Fingering {
  string: ViolinString;
  position: PositionName;
  /** 0 = open string. */
  finger: number;
  /** "2nd finger, G string" — or "open G". */
  label: string;
  /** Same, with the position when it isn't first — "3rd finger, A · 3rd position". */
  longLabel: string;
}

/**
 * Best-guess fingering for a MIDI note. `preferString` keeps a drill on the
 * string it is actually about — a crossing exercise must not quietly relabel
 * its low note onto the higher string just because it fits there too.
 */
export function fingeringFor(midi: number, preferString?: ViolinString): Fingering | null {
  if (!Number.isFinite(midi)) return null;
  const str = stringForMidi(Math.round(midi), preferString);
  const position = positionForMidi(Math.round(midi), str);
  const finger = fingerFor(Math.round(midi), str, position);
  if (finger == null) return null;

  const label = finger === 0 ? `open ${str}` : `${fingerLabel(finger)}, ${str} string`;
  const longLabel = finger === 0 || position === 'first'
    ? label
    : `${fingerLabel(finger)}, ${str} · ${positionLabel(position)}`;

  return { string: str, position, finger, label, longLabel };
}

/** Short form for tight spaces: "2nd · G". */
export function shortFingering(midi: number, preferString?: ViolinString): string | null {
  const fingering = fingeringFor(midi, preferString);
  if (!fingering) return null;
  return fingering.finger === 0
    ? `open ${fingering.string}`
    : `${fingering.finger} · ${fingering.string}`;
}

export { OPEN_MIDI };
export type { ViolinString, PositionName };
