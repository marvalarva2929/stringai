/**
 * Intonation-stability calibration harness (report, not pass/fail).
 *
 *   npm run calibrate:intonation
 *   (node --experimental-strip-types --loader ./test/ts-resolver.mjs test/calibrateIntonation.ts)
 *
 * Drop labelled clips in test/fixtures/intonation/ named  <label>__<n>.<ext>
 *   steady-vibrato__1.mov     steady center, with vibrato   → should score HIGH
 *   steady-flat__1.mov        steady center, long tones     → should score HIGH
 *   unstable-vibrato__1.mov   wobbly center, with vibrato   → should score LOW   (hard case)
 *   unstable-flat__1.mov      drifting/scooping, no vibrato → should score LOW
 *
 * Video (.mov/.mp4/.m4a) is auto-converted to mono 44.1 kHz WAV via ffmpeg (cached as
 * <name>.cal.wav). The harness prints each clip's center-line drift (cents), the resulting
 * score, and whether the two label groups separate cleanly enough to set thresholds.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPitches } from '../src/services/dsp';
import { computeIntonationStability, scoreIntonationStability } from '../src/services/pitchContour';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'intonation');
const STEADY_LABELS   = ['steady-vibrato', 'steady-flat'];
const UNSTABLE_LABELS = ['unstable-vibrato', 'unstable-flat'];
const MEDIA = /\.(wav|mov|mp4|m4a|aac)$/i;

if (!existsSync(dir) || readdirSync(dir).filter((f) => MEDIA.test(f)).length === 0) {
  console.log(`\nNo clips in ${dir}.\nAdd files named <label>__<n>.<ext>; see the header of this file for labels.\n`);
  process.exit(0);
}

// ── ensure a mono 44.1 kHz WAV exists for each clip (ffmpeg for video) ──
function toWav(file: string): string | null {
  if (file.toLowerCase().endsWith('.wav')) return join(dir, file);
  const src = join(dir, file);
  const out = src.replace(/\.[^.]+$/, '.cal.wav');
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) return out;
  try {
    execFileSync('ffmpeg', ['-y', '-i', src, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', out], { stdio: 'ignore' });
    return out;
  } catch {
    console.log(`  ! ffmpeg failed on ${file} — skipping`);
    return null;
  }
}

// ── minimal WAV reader (PCM16 / float32), mono ─────────────────
function readWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 12, fmt = 1, channels = 1, sampleRate = 44100, bits = 16, dataOff = -1, dataLen = 0;
  while (p + 8 <= buf.length) {
    const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
    const size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') { fmt = dv.getUint16(p + 8, true); channels = dv.getUint16(p + 10, true); sampleRate = dv.getUint32(p + 12, true); bits = dv.getUint16(p + 22, true); }
    else if (id === 'data') { dataOff = p + 8; dataLen = size; break; }
    p += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new Error('no data chunk');
  const bytesPer = bits >> 3;
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = dataOff + i * bytesPer * channels;
    if (fmt === 3 && bits === 32) out[i] = dv.getFloat32(o, true);
    else if (bits === 16) out[i] = dv.getInt16(o, true) / 32768;
    else if (bits === 32) out[i] = dv.getInt32(o, true) / 2147483648;
    else if (bits === 8) out[i] = (buf[o] - 128) / 128;
  }
  return { samples: out, sampleRate };
}

type Row = { file: string; label: string; drift: number; noteStds: number[]; score: number; flags: number; mode: string };
const rows: Row[] = [];

console.log('\nPer-clip:');
for (const file of readdirSync(dir).filter((f) => MEDIA.test(f) && !f.endsWith('.cal.wav')).sort()) {
  const label = file.split('__')[0];
  const wav = toWav(file);
  if (!wav) continue;
  const { samples, sampleRate } = readWav(readFileSync(wav));
  const pitches = detectPitches(samples, sampleRate);
  const stats = computeIntonationStability(pitches);
  const { metric, analysis } = scoreIntonationStability(pitches);
  const drift = stats.mode === 'per-note' ? stats.avgStd : stats.mode === 'short' ? stats.stdCents : NaN;
  const flags = analysis.unsteadyCount;
  const noteStds = stats.mode === 'per-note' ? stats.notes.map((n) => n.driftCents) : [];
  rows.push({ file, label, drift, noteStds, score: metric.score, flags, mode: stats.mode });
  console.log(`  ${file.padEnd(28)} drift=${Number.isNaN(drift) ? ' n/a' : drift.toFixed(1).padStart(5)}¢  score=${String(metric.score).padStart(3)}  flags=${flags}  [${stats.mode}]`);
}

// ── group separation ──
const driftOf = (labels: string[]) => rows.filter((r) => labels.includes(r.label) && !Number.isNaN(r.drift)).map((r) => r.drift);
const steady = driftOf(STEADY_LABELS);
const unstable = driftOf(UNSTABLE_LABELS);
const stat = (xs: number[]) => ({ n: xs.length, min: Math.min(...xs), med: [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)], max: Math.max(...xs) });

console.log('\nGroup drift (cents):');
if (steady.length) { const s = stat(steady); console.log(`  steady   n=${s.n}  min=${s.min.toFixed(1)}  median=${s.med.toFixed(1)}  max=${s.max.toFixed(1)}`); }
if (unstable.length) { const u = stat(unstable); console.log(`  unstable n=${u.n}  min=${u.min.toFixed(1)}  median=${u.med.toFixed(1)}  max=${u.max.toFixed(1)}`); }

if (steady.length && unstable.length) {
  const sMax = Math.max(...steady), uMin = Math.min(...unstable);
  const sMed = stat(steady).med, uMed = stat(unstable).med;
  console.log('\nSuggested thresholds:');
  if (uMin > sMax) {
    console.log(`  clean separation — steady clips ≤ ${sMax.toFixed(1)}¢ avg, unstable ≥ ${uMin.toFixed(1)}¢ avg`);
    // SCORE_SLOPE from the clip-average clusters (steady median→~90, unstable median→~40).
    const slope = sMed < uMed ? (90 - 40) / (uMed - sMed) : NaN;
    if (!Number.isNaN(slope)) console.log(`  STABILITY_SCORE_SLOPE ≈ ${slope.toFixed(1)} (steady median→~90, unstable median→~40)`);
    console.log(`  STABILITY_STEADY_CENTS ≈ ${sMax.toFixed(1)} (top of steady cluster), STABILITY_SLIGHT_CENTS ≈ ${uMin.toFixed(1)} (bottom of unstable)`);
    // FLAG is PER-NOTE, so derive it from the per-note std distribution, NOT the clip-avg gap:
    // it must sit above the noisiest note seen in an otherwise-steady clip (residual slides /
    // short-note vibrato leak) or every steady clip will false-flag individual notes.
    const steadyNotes = rows.filter((r) => STEADY_LABELS.includes(r.label)).flatMap((r) => r.noteStds);
    if (steadyNotes.length) {
      const steadyNoteMax = Math.max(...steadyNotes);
      console.log(`  STABILITY_FLAG_CENTS ≈ ${Math.ceil(steadyNoteMax)} (just above steady clips' worst single note = ${steadyNoteMax.toFixed(1)}¢)`);
    }
  } else {
    console.log(`  ⚠ groups OVERLAP (steady max ${sMax.toFixed(1)}¢ ≥ unstable min ${uMin.toFixed(1)}¢).`);
    console.log(`    No threshold separates them. Inspect the overlapping clips above — if a STEADY-vibrato`);
    console.log(`    clip has high drift, the detrend window isn't nulling vibrato (tune the window, not the`);
    console.log(`    thresholds). If an UNSTABLE clip has low drift, the take may not actually be unstable.`);
  }
} else {
  console.log('\nNeed clips in BOTH groups (steady-* and unstable-*) to suggest thresholds.');
}
console.log('');
