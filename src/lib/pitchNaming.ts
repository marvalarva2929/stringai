/**
 * Pure pitch-class/MIDI naming helpers — no Expo/RN imports, so this runs
 * under plain Node for unit testing (referenceNote.ts pulls in expo-file-system).
 */

// Default MIDI note per pitch class when no specific octave is known
export const PITCH_CLASS_MIDI: Record<string, number> = {
  'C':  72, // C5
  'C#': 73,
  'D':  62, // D4  (open D)
  'D#': 63,
  'E':  76, // E5  (open E)
  'F':  77,
  'F#': 66, // F#4 (D string)
  'G':  55, // G3  (open G)
  'G#': 56,
  'A':  69, // A4  (open A)
  'A#': 70,
  'B':  71, // B4
};

// Human-readable violin position descriptions keyed by MIDI note
const MIDI_DESCRIPTIONS: Record<number, string> = {
  55: 'Open G string',
  56: 'G#3 on G string',
  57: 'A3, 1st finger on G string',
  58: 'Bb3 on G string',
  59: 'B3, 2nd finger on G string',
  60: 'C4, 3rd finger on G string',
  61: 'C#4 on G string',
  62: 'Open D string',
  63: 'Eb4 on D string',
  64: 'E4, 1st finger on D string',
  65: 'F4 on D string',
  66: 'F#4, 2nd finger on D string',
  67: 'G4, 3rd finger on D string',
  68: 'G#4 on D string',
  69: 'Open A string (Concert A)',
  70: 'Bb4 on A string',
  71: 'B4, 1st finger on A string',
  72: 'C5, 2nd finger on A string',
  73: 'C#5 on A string',
  74: 'D5, 3rd finger on A string',
  75: 'Eb5 on A string',
  76: 'Open E string',
  77: 'F5 on E string',
  78: 'F#5, 1st finger on E string',
  79: 'G5, 2nd finger on E string',
  80: 'G#5 on E string',
  81: 'A5, 3rd finger on E string',
};

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[((midi % 12) + 12) % 12]}${octave}`;
}

/** Parses an octave-qualified note name like "F#4" or "Bb3" into a MIDI number. */
export function noteNameToMidi(name: string): number | null {
  const match = /^([A-G])(#|b)?(-?\d+)$/.exec(name.trim());
  if (!match) return null;
  const [, letter, accidental, octaveStr] = match;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const offset = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  const octave = parseInt(octaveStr, 10);
  return base[letter] + offset + (octave + 1) * 12;
}

export function pitchClassInfo(pitchClass: string, midiNote?: number): { freq: number; description: string } {
  const midi = midiNote ?? (PITCH_CLASS_MIDI[pitchClass] ?? 69);
  const freq = Math.round(midiToFreq(midi));
  const description = MIDI_DESCRIPTIONS[midi] ?? midiToNoteName(midi);
  return { freq, description };
}
