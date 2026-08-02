/**
 * Generates a short reference-pitch WAV file and writes it to the cache directory.
 * Returns a local file:// URI for expo-av playback.
 *
 * Pass midiNote to play the exact octave the player used (e.g. A3 on G string vs A4 open A).
 */

import { File, Paths } from 'expo-file-system';
import { PITCH_CLASS_MIDI, midiToFreq } from './pitchNaming';

export { pitchClassInfo, noteNameToMidi } from './pitchNaming';

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
  await file.write(wav);
  return file.uri;
}
