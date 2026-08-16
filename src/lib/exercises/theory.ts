import { parseKeyName, type Mode } from '../musicalContext';

// ─────────────────────────────────────────────────────────────
// The theory the exercise generators need: what notes are in this key, and
// what chords does this key contain. Small on purpose — this is not a music
// theory library, it is exactly the vocabulary the drills speak.
// ─────────────────────────────────────────────────────────────

export const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  naturalMinor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
} as const;

export type ScaleQuality = keyof typeof SCALE_INTERVALS;

export interface ParsedKey {
  /** 0-11 pitch class of the tonic. */
  tonic: number;
  mode: Mode;
  /** "G major" — round-trips through parseKeyName. */
  name: string;
}

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function pitchClassName(pc: number): string {
  return PITCH_CLASS_NAMES[((pc % 12) + 12) % 12];
}

/** Falls back to D major — the violin's most idiomatic key — when unparseable. */
export function resolveKey(name?: string | null): ParsedKey {
  const parsed = parseKeyName(name) ?? { tonic: 2, mode: 'major' as Mode };
  return { ...parsed, name: `${pitchClassName(parsed.tonic)} ${parsed.mode}` };
}

/** Scale degrees of a key, as semitone offsets from the tonic. */
export function scaleOffsets(key: ParsedKey, quality?: ScaleQuality): readonly number[] {
  if (quality) return SCALE_INTERVALS[quality];
  // Minor keys use the harmonic form by default: the raised 7th is the note
  // that actually goes wrong, so a drill that omits it drills the easy version.
  return key.mode === 'major' ? SCALE_INTERVALS.major : SCALE_INTERVALS.harmonicMinor;
}

/**
 * Snap an arbitrary MIDI note to the nearest note in the key. Generators build
 * shapes from finger geometry, which is key-agnostic; this is what makes the
 * result sound like music in the piece the player was actually working on.
 */
export function snapToKey(midi: number, key: ParsedKey, quality?: ScaleQuality): number {
  const offsets = scaleOffsets(key, quality);
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const relative = ((pc - key.tonic) % 12 + 12) % 12;
  let best = offsets[0];
  let bestDist = 12;
  for (const offset of offsets) {
    const dist = Math.min(Math.abs(offset - relative), 12 - Math.abs(offset - relative));
    if (dist < bestDist) { bestDist = dist; best = offset; }
  }
  let delta = best - relative;
  if (delta > 6) delta -= 12;
  if (delta < -6) delta += 12;
  return Math.round(midi) + delta;
}

export type ChordQuality = 'major' | 'minor' | 'diminished' | 'augmented' | 'dominant7' | 'diminished7';

export const CHORD_INTERVALS: Record<ChordQuality, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  diminished: [0, 3, 6],
  augmented: [0, 4, 8],
  dominant7: [0, 4, 7, 10],
  diminished7: [0, 3, 6, 9],
};

const CHORD_SUFFIX: Record<ChordQuality, string> = {
  major: ' major',
  minor: ' minor',
  diminished: 'dim',
  augmented: 'aug',
  dominant7: '7',
  diminished7: 'dim7',
};

export interface ArpeggioSpec {
  /** Roman-numeral function within the key, e.g. "I", "V7", "vii°7". */
  degree: string;
  /** Absolute pitch class of the chord root. */
  rootPitchClass: number;
  quality: ChordQuality;
  /** "G major", "D7" — display-ready. */
  label: string;
  /** One sentence on what this chord does in the key. */
  role: string;
}

export function chordLabel(rootPitchClass: number, quality: ChordQuality): string {
  return `${pitchClassName(rootPitchClass)}${CHORD_SUFFIX[quality]}`;
}

/**
 * The seven-arpeggio cycle for a key.
 *
 * This is a *functional* cycle rather than a literal transcription of Flesch:
 * tonic in both modes, then the chords that give the key its pull — dominant
 * seventh, leading-tone diminished seventh, subdominant, submediant,
 * supertonic. The point of the drill is that the player starts hearing chord
 * tones as belonging somewhere, which is what turns an arpeggio from finger
 * geometry into musical sense. A cycle of seven tonic-rooted inversions would
 * drill the hand and teach the ear nothing.
 */
export function arpeggioCycle(key: ParsedKey): ArpeggioSpec[] {
  const t = key.tonic;
  const at = (semitones: number) => (t + semitones) % 12;
  const isMajor = key.mode === 'major';

  return [
    {
      degree: isMajor ? 'I' : 'i',
      rootPitchClass: t,
      quality: isMajor ? 'major' : 'minor',
      label: chordLabel(t, isMajor ? 'major' : 'minor'),
      role: 'home — where the key rests',
    },
    {
      degree: isMajor ? 'i' : 'I',
      rootPitchClass: t,
      quality: isMajor ? 'minor' : 'major',
      label: chordLabel(t, isMajor ? 'minor' : 'major'),
      role: 'the same root, the other colour — trains the third',
    },
    {
      degree: 'IV',
      rootPitchClass: at(5),
      quality: isMajor ? 'major' : 'minor',
      label: chordLabel(at(5), isMajor ? 'major' : 'minor'),
      role: 'the step away from home',
    },
    {
      degree: 'V7',
      rootPitchClass: at(7),
      quality: 'dominant7',
      label: chordLabel(at(7), 'dominant7'),
      role: 'the pull back — the chord that wants to resolve',
    },
    {
      degree: isMajor ? 'vi' : 'VI',
      rootPitchClass: isMajor ? at(9) : at(8),
      quality: isMajor ? 'minor' : 'major',
      label: chordLabel(isMajor ? at(9) : at(8), isMajor ? 'minor' : 'major'),
      role: 'the relative — the shadow of the tonic',
    },
    {
      degree: isMajor ? 'ii' : 'ii°',
      rootPitchClass: at(2),
      quality: isMajor ? 'minor' : 'diminished',
      label: chordLabel(at(2), isMajor ? 'minor' : 'diminished'),
      role: 'the approach to the dominant',
    },
    {
      degree: 'vii°7',
      rootPitchClass: at(11),
      quality: 'diminished7',
      label: chordLabel(at(11), 'diminished7'),
      role: 'the leading tone under tension — the hardest to hear',
    },
  ];
}

/**
 * Ascending MIDI notes of a chord starting at or above `fromMidi`, spanning
 * `octaves`, then descending back — the shape an arpeggio drill actually plays.
 */
export function arpeggioNotes(spec: ArpeggioSpec, fromMidi: number, octaves = 2): number[] {
  const intervals = CHORD_INTERVALS[spec.quality];
  // Lowest chord root at or above the starting note.
  let root = fromMidi - (((fromMidi % 12) - spec.rootPitchClass + 12) % 12);
  if (root < fromMidi - 6) root += 12;

  const ascending: number[] = [];
  for (let octave = 0; octave < octaves; octave++) {
    for (const interval of intervals) ascending.push(root + octave * 12 + interval);
  }
  ascending.push(root + octaves * 12);

  // Skip the top note on the way down so it isn't played twice in a row.
  return [...ascending, ...ascending.slice(0, -1).reverse()];
}

/** Ascending-then-descending scale notes for a key, one octave from `rootMidi`. */
export function scaleNotes(key: ParsedKey, rootMidi: number, octaves = 1, quality?: ScaleQuality): number[] {
  const offsets = scaleOffsets(key, quality);
  const ascending: number[] = [];
  for (let octave = 0; octave < octaves; octave++) {
    for (const offset of offsets) ascending.push(rootMidi + octave * 12 + offset);
  }
  ascending.push(rootMidi + octaves * 12);
  return [...ascending, ...ascending.slice(0, -1).reverse()];
}
