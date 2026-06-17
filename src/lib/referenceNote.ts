/**
 * Generates a short reference-pitch WAV file and writes it to the cache directory.
 * Returns a local file:// URI for expo-av playback.
 *
 * Pass midiNote to play the exact octave the player used (e.g. A3 on G string vs A4 open A).
 */

import { File, Paths } from 'expo-file-system';

// Default MIDI note per pitch class when no specific octave is known
const PITCH_CLASS_MIDI: Record<string, number> = {
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
  56: 'G#3 · G string',
  57: 'A3 · G string, 1st finger',
  58: 'Bb3 · G string',
  59: 'B3 · G string, 2nd finger',
  60: 'C4 · G string, 3rd finger',
  61: 'C#4 · G string',
  62: 'Open D string',
  63: 'Eb4 · D string',
  64: 'E4 · D string, 1st finger',
  65: 'F4 · D string',
  66: 'F#4 · D string, 2nd finger',
  67: 'G4 · D string, 3rd finger',
  68: 'G#4 · D string',
  69: 'Open A string · Concert A',
  70: 'Bb4 · A string',
  71: 'B4 · A string, 1st finger',
  72: 'C5 · A string, 2nd finger',
  73: 'C#5 · A string',
  74: 'D5 · A string, 3rd finger',
  75: 'Eb5 · A string',
  76: 'Open E string',
  77: 'F5 · E string',
  78: 'F#5 · E string, 1st finger',
  79: 'G5 · E string, 2nd finger',
  80: 'G#5 · E string',
  81: 'A5 · E string, 3rd finger',
};

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToNoteName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[((midi % 12) + 12) % 12]}${octave}`;
}

function buildWav(frequency: number): Uint8Array {
  const SR = 22050;
  const DURATION = 1.5;
  const numSamples = Math.floor(SR * DURATION);
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SR;
    let env = 1.0;
    if (t < 0.03) env = t / 0.03;
    if (t > DURATION - 0.45) env = (DURATION - t) / 0.45;
    const sig =
      0.55 * Math.sin(2 * Math.PI * frequency * t) +
      0.27 * Math.sin(2 * Math.PI * frequency * 2 * t) +
      0.12 * Math.sin(2 * Math.PI * frequency * 3 * t) +
      0.06 * Math.sin(2 * Math.PI * frequency * 4 * t);
    v.setInt16(44 + i * 2, Math.round(env * 0.62 * 32767 * sig), true);
  }
  return new Uint8Array(buf);
}

export async function getReferenceNoteUri(pitchClass: string, midiNote?: number): Promise<string> {
  const midi = midiNote ?? (PITCH_CLASS_MIDI[pitchClass] ?? 69);
  const wav = buildWav(midiToFreq(midi));
  const safe = pitchClass.replace('#', 's');
  const octave = Math.floor(midi / 12) - 1;
  const file = new File(Paths.cache, `ref_${safe}${octave}.wav`);
  file.write(wav);
  return file.uri;
}

export function pitchClassInfo(pitchClass: string, midiNote?: number): { freq: number; description: string } {
  const midi = midiNote ?? (PITCH_CLASS_MIDI[pitchClass] ?? 69);
  const freq = Math.round(midiToFreq(midi));
  const description = MIDI_DESCRIPTIONS[midi] ?? midiToNoteName(midi);
  return { freq, description };
}
