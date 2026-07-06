/**
 * Phrase detection (L6) test harness.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/detectPhrases.test.ts
 *   (or: npm run test:phrases)
 *
 * Checks: silence-gap segmentation unchanged (the floor), composite
 * subdivision fires only when an RMS dip is corroborated by a bow-speed drop,
 * degradation to RMS-only when the bow is absent, and the 500ms minimum
 * phrase duration.
 */

import { detectPhrases } from '../src/lib/noteFusion';
import { createTimeSeries } from '../src/types/signals';
import type { TimeSeriesPoint } from '../src/types/signals';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const HOP = 0.02; // 20ms like the real RMS frames

/** RMS frames from a piecewise level map: [untilT, level][]. */
function rmsFrames(spans: Array<[number, number]>, duration: number) {
  const frames: { value: number; timestamp: number }[] = [];
  for (let t = 0; t < duration; t += HOP) {
    const span = spans.find(([until]) => t < until);
    frames.push({ value: span ? span[1] : 0, timestamp: t });
  }
  return frames;
}

/** Bow speed series at 10fps from a piecewise map. */
function speedSeries(spans: Array<[number, number | null]>, duration: number) {
  const pts: Array<TimeSeriesPoint<number | null>> = [];
  for (let t = 0; t < duration; t += 0.1) {
    const span = spans.find(([until]) => t < until);
    pts.push({ t, v: span ? span[1] : null });
  }
  return createTimeSeries(pts);
}

// ─────────────────────────────────────────────────────────────
console.log('\nSilence gap still segments (floor behavior)');
{
  // 2s playing, 1.5s silence, 2s playing (the 500ms smoothing window means
  // sub-second gaps never registered as silence — historical behavior)
  const frames = rmsFrames([[2.0, 0.3], [3.5, 0.0], [5.5, 0.3]], 5.5);
  const phrases = detectPhrases(frames);
  check('2 phrases', phrases.length === 2, `got ${phrases.length}`);
}

console.log('\nMid-phrase RMS dip alone does not split (no bow data)');
{
  // Continuous playing with a 55% dip at 2s — never fully silent
  const frames = rmsFrames([[1.8, 0.3], [2.2, 0.135], [4.0, 0.3]], 4.0);
  const phrases = detectPhrases(frames, { onsets: [] });
  check('stays 1 phrase', phrases.length === 1, `got ${phrases.length}: ${JSON.stringify(phrases)}`);
}

console.log('\nSame dip + bow-speed drop → splits');
{
  const frames = rmsFrames([[1.8, 0.3], [2.2, 0.135], [4.0, 0.3]], 4.0);
  // Bow moving normally, then nearly stopped around the dip, then normal
  const bowSpeed = speedSeries([[1.8, 0.5], [2.2, 0.02], [4.0, 0.5]], 4.0);
  const phrases = detectPhrases(frames, { bowSpeed });
  check('2 phrases', phrases.length === 2, `got ${phrases.length}: ${JSON.stringify(phrases)}`);
  if (phrases.length === 2) {
    check('boundary near the dip (~2s)', Math.abs(phrases[0].end - 2.0) < 0.3, `boundary at ${phrases[0].end}`);
  }
}

console.log('\nBow mostly null → bow term dropped (degrades to RMS-only)');
{
  const frames = rmsFrames([[1.8, 0.3], [2.2, 0.135], [4.0, 0.3]], 4.0);
  // Bow visible for only a couple frames — under the 20% coverage floor
  const pts: Array<TimeSeriesPoint<number | null>> = [];
  for (let t = 0; t < 4.0; t += 0.1) pts.push({ t, v: t < 0.2 ? 0.5 : null });
  const phrases = detectPhrases(frames, { bowSpeed: createTimeSeries(pts) });
  check('stays 1 phrase', phrases.length === 1, `got ${phrases.length}`);
}

console.log('\nMinimum phrase duration enforced');
{
  // Dip at 0.3s — even with a strong bow drop, the left segment would be <500ms
  const frames = rmsFrames([[0.25, 0.3], [0.35, 0.1], [4.0, 0.3]], 4.0);
  const bowSpeed = speedSeries([[0.25, 0.5], [0.35, 0.02], [4.0, 0.5]], 4.0);
  const phrases = detectPhrases(frames, { bowSpeed });
  check('no sub-500ms phrase', phrases.every(p => p.duration >= 0.5), JSON.stringify(phrases));
}

console.log('\nEmpty input');
{
  check('empty → no phrases', detectPhrases([]).length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All phrase detection checks passed');
