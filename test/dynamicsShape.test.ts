/**
 * Per-phrase dynamic shaping tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/dynamicsShape.test.ts
 *   (or: npm run test:dynamicsshape)
 *
 * This logic used to live inside audioEngine.scoreDynamicControl on its own
 * phrase segmentation (gate 0.015, minimum 3s) that disagreed with L6. The
 * cases below pin the two things that move as a result: short phrases now get
 * analysed at all, and every observation carries the L6 phrase id the results
 * UI seeks with.
 */

import { computeDynamicsShape, rankDynamicsIssues } from '../src/lib/dynamicsShape';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const HOP = 0.02; // 50 Hz, matching the real rms frame rate

/** RMS frames from a level function over [0, seconds). */
function frames(seconds: number, level: (t: number) => number) {
  const out: { value: number; timestamp: number }[] = [];
  for (let t = 0; t < seconds; t += HOP) {
    out.push({ value: Math.max(0, level(t)), timestamp: Math.round(t * 1000) / 1000 });
  }
  return out;
}

/** A phrase peaking at `peakAt` (0-1 through the window), arch-shaped. */
const arch = (dur: number, peakAt: number, lo = 0.05, hi = 0.4) => (t: number) => {
  const x = t / dur;
  const d = Math.abs(x - peakAt) / Math.max(peakAt, 1 - peakAt);
  return lo + (hi - lo) * Math.max(0, 1 - d);
};

console.log('\nShort phrases (the 3s floor that used to drop them)');

// 2 seconds — under the old MIN_PH_FRAMES of 3s, so this produced nothing before.
const shortPhrase = frames(2, arch(2, 0.5));
const shortResult = computeDynamicsShape([{ start: 0, end: 1.98 }], shortPhrase);

check('a 2s phrase now produces a row', shortResult.phraseRows.length === 1,
  `got ${shortResult.phraseRows.length}`);
check('the row carries the phrase id', shortResult.phraseRows[0]?.phraseId === 0);
check('peak position is measured near the middle', (() => {
  const p = shortResult.phraseRows[0]?.peakPos ?? -1;
  return p > 0.3 && p < 0.7;
})(), `peakPos=${shortResult.phraseRows[0]?.peakPos}`);
check('peak time is absolute, so it can be seeked to', (() => {
  const r = shortResult.phraseRows[0];
  return !!r && r.peakSec >= r.startSec && r.peakSec <= r.endSec;
})());

console.log('\nPhrase ids are the L6 ids');

const three = [
  { start: 0, end: 3.9 },
  { start: 4, end: 7.9 },
  { start: 8, end: 11.9 },
];
const threeFrames = frames(12, (t) => {
  if (t < 4) return arch(4, 0.5)(t);
  if (t < 8) return arch(4, 0.5)(t - 4);
  return arch(4, 0.5)(t - 8);
});
const threeResult = computeDynamicsShape(three, threeFrames);

check('ids are the caller\'s indices, in order',
  threeResult.phraseRows.map((r) => r.phraseId).join(',') === '0,1,2',
  threeResult.phraseRows.map((r) => r.phraseId).join(','));
check('each row\'s window matches the phrase it was given',
  threeResult.phraseRows.every((r, i) => Math.abs(r.startSec - three[i].start) < 1e-6));

console.log('\nShape classification');

check('a flat phrase is detected as plateau', (() => {
  const flat = computeDynamicsShape([{ start: 0, end: 3.9 }], frames(4, () => 0.2));
  return flat.phraseRows[0]?.shape === 'plateau';
})());

check('a flat phrase is flagged, and the issue names its phrase', (() => {
  const flat = computeDynamicsShape([{ start: 0, end: 3.9 }], frames(4, () => 0.2));
  const issue = flat.issues.find((i) => i.type === 'dyn_flat_phrase');
  return !!issue && issue.phraseId === 0;
})());

// A phrase that simply decays from its start is a diminuendo, and the classifier
// correctly calls that 'falling' and leaves it alone. dyn_peak_early is for the
// other thing: a level phrase spiked early, like an unintended sforzando.
check('a decaying phrase is read as a diminuendo, not an error', (() => {
  const decay = computeDynamicsShape([{ start: 0, end: 3.9 }], frames(4, arch(4, 0.04)));
  return decay.phraseRows[0]?.shape === 'falling'
    && !decay.issues.some((i) => i.type === 'dyn_peak_early');
})());

// A sforzando-like spike at the start of a phrase that otherwise grows: the peak
// lands early while the overall slope stays positive, so it is neither a
// diminuendo nor an arch and the early-peak rule applies.
const spikeLevel = (t: number) => (t > 0.05 && t < 0.35 ? 0.5 : 0.1 + 0.08 * t);

check('an early spike is flagged, with a seekable phrase id and time', (() => {
  const spiked = computeDynamicsShape([{ start: 0, end: 3.9 }], frames(4, spikeLevel));
  const issue = spiked.issues.find((i) => i.type === 'dyn_peak_early');
  return !!issue && issue.phraseId === 0 && issue.note.includes(':');
})(), JSON.stringify(computeDynamicsShape([{ start: 0, end: 3.9 }], frames(4, spikeLevel)).phraseRows[0]));

check('a well-shaped arch is NOT flagged', (() => {
  const good = computeDynamicsShape([{ start: 0, end: 3.9 }], frames(4, arch(4, 0.5)));
  return !good.issues.some((i) => i.type.startsWith('dyn_peak') || i.type === 'dyn_flat_phrase');
})());

console.log('\nMelodic contour');

check('level rising with pitch is contour, not a dynamics fault', (() => {
  // Level climbs steadily; pitch climbs with it — a shaped rising line.
  const rms = frames(4, (t) => 0.08 + 0.08 * t);
  const pitch = rms.map((f) => ({
    // ~300 cents/sec — a clear rising line, well over the 80 cents/sec bar
    // but nothing like the 2500 the old per-frame threshold demanded.
    frequency: 440 * Math.pow(2, (300 * f.timestamp) / 1200),
    timestamp: f.timestamp,
  }));
  const res = computeDynamicsShape([{ start: 0, end: 3.9 }], rms, pitch);
  const row = res.phraseRows[0];
  return !!row && row.melodicContour && row.shape === 'melodic_contour';
})());

check('without pitch data the contour flag stays off', (() => {
  const res = computeDynamicsShape([{ start: 0, end: 3.9 }], frames(4, (t) => 0.08 + 0.08 * t));
  return res.phraseRows[0]?.melodicContour === false;
})());

console.log('\nSession-level');

check('narrow dynamic range is reported', (() => {
  const res = computeDynamicsShape([{ start: 0, end: 3.9 }], frames(4, () => 0.2));
  return res.issues.some((i) => i.type === 'dyn_narrow_range') && res.dynamicRatio < 2.5;
})());

check('ranking sorts by confidence and caps', (() => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    type: 'dyn_flat_phrase' as const,
    startSec: i,
    endSec: i + 1,
    confidence: i / 10,
    note: 'x',
  }));
  const ranked = rankDynamicsIssues(many, 5);
  return ranked.length === 5 && ranked[0].confidence >= ranked[4].confidence;
})());

check('low-confidence issues are dropped', (() => {
  const ranked = rankDynamicsIssues([
    { type: 'dyn_flat_phrase', startSec: 0, endSec: 1, confidence: 0.1, note: 'x' },
  ]);
  return ranked.length === 0;
})());

console.log('\nDegenerate input');

check('too little audio returns empty rather than throwing', (() => {
  const res = computeDynamicsShape([{ start: 0, end: 1 }], frames(0.1, () => 0.2));
  return res.phraseRows.length === 0 && res.issues.length === 0;
})());

check('silence returns empty', (() => {
  const res = computeDynamicsShape([{ start: 0, end: 3.9 }], frames(4, () => 0));
  return res.phraseRows.length === 0;
})());

check('a phrase window with no frames is skipped, not crashed on', (() => {
  const res = computeDynamicsShape(
    [{ start: 0, end: 3.9 }, { start: 90, end: 95 }],
    frames(4, arch(4, 0.5)),
  );
  return res.phraseRows.length === 1;
})());

if (failures > 0) {
  console.error(`\n${failures} failing check(s)`);
  process.exit(1);
}
console.log('\nAll dynamics shape checks passed.');
