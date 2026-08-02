/**
 * Slices a short segment out of a captured take's decoded audio (mono,
 * normalized to [-1, 1], see WavData in audioEngine.ts) and writes it as its
 * own playable WAV file — lets the result screen replay exactly what the
 * player produced for a single attempt/scale degree.
 */

import { File, Paths } from 'expo-file-system';

export async function writeTakeClipWav(
  samples: Float32Array,
  sampleRate: number,
  startSeconds: number,
  endSeconds: number,
): Promise<string> {
  const startIdx = Math.max(0, Math.floor(startSeconds * sampleRate));
  const endIdx = Math.min(samples.length, Math.ceil(endSeconds * sampleRate));
  const slice = samples.subarray(startIdx, Math.max(startIdx, endIdx));

  const numSamples = slice.length;
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, slice[i]));
    v.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }

  const file = new File(Paths.cache, `take_clip_${Date.now()}_${startIdx}.wav`);
  await file.write(new Uint8Array(buf));
  return file.uri;
}
