// Minimal PCM16 / float32 WAV reader for test fixtures. Channel 0 only.
// Shared by the tone-quality test and the perception corpus harness.

export function readWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 12; // skip RIFF....WAVE
  let fmt = 1, channels = 1, sampleRate = 44100, bits = 16, dataOff = -1, dataLen = 0;
  while (p + 8 <= buf.length) {
    const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
    const size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') {
      fmt = dv.getUint16(p + 8, true);
      channels = dv.getUint16(p + 10, true);
      sampleRate = dv.getUint32(p + 12, true);
      bits = dv.getUint16(p + 22, true);
    } else if (id === 'data') { dataOff = p + 8; dataLen = size; break; }
    p += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new Error('no data chunk');
  const bytesPer = bits >> 3;
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = dataOff + i * bytesPer * channels; // channel 0 only (mono-ize)
    if (fmt === 3 && bits === 32) out[i] = dv.getFloat32(o, true);
    else if (bits === 16) out[i] = dv.getInt16(o, true) / 32768;
    else if (bits === 32) out[i] = dv.getInt32(o, true) / 2147483648;
    else if (bits === 8) out[i] = (buf[o] - 128) / 128;
  }
  return { samples: out, sampleRate };
}
