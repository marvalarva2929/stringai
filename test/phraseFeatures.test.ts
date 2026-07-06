/**
 * Phrase feature engine (L7) test harness.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/phraseFeatures.test.ts
 *   (or: npm run test:phrasefeatures)
 */

import { buildPhraseFeatures } from '../src/lib/phraseFeatures';
import type { SessionSignals } from '../src/types/signals';
import { createTimeSeries } from '../src/types/signals';
import type { TimeSeriesPoint } from '../src/types/signals';
import type { NoteEvent, Phrase } from '../src/lib/noteFusion';
import type { NoteGroup } from '../src/lib/noteGrouping';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function series<T>(fn: (t: number) => T, duration: number, hop = 0.05) {
  const pts: Array<TimeSeriesPoint<T>> = [];
  for (let t = 0; t < duration; t += hop) pts.push({ t, v: fn(t) });
  return createTimeSeries(pts);
}

function emptySeries<T>() {
  return createTimeSeries<T>([]);
}

function makeSignals(duration: number, over: Partial<SessionSignals>): SessionSignals {
  return {
    durationSeconds: duration,
    pitch: emptySeries<number | null>(),
    rms: series(() => 0.3, duration),
    fundamentalRatio: emptySeries<number>(),
    leftWristAngle: emptySeries<number | null>(),
    rightElbowY: emptySeries<number | null>(),
    rightShoulderY: emptySeries<number | null>(),
    shoulderDiff: emptySeries<number | null>(),
    bowContactPoint: emptySeries<number | null>(),
    bowAngle: emptySeries<number | null>(),
    bowSpeed: emptySeries<number | null>(),
    bowDirection: emptySeries<-1 | 0 | 1 | null>(),
    spectralCentroid: emptySeries<number>(),
    brightness: emptySeries<number>(),
    noteEvents: [],
    ...over,
  };
}

function note(start: number, end: number, cents = 0): NoteEvent {
  return {
    startSeconds: start, endSeconds: end, durationSeconds: end - start,
    pitchHz: 440, noteName: 'A4', string: 'A', inferredFinger: 0, positionGroup: 'first',
    centsDeviation: cents, absCentsDeviation: Math.abs(cents), inTune: Math.abs(cents) <= 25,
    fundamentalRatio: 0.8, dynamicLevel: 0.5,
    bowContactPoint: null, bowAngle: null, bowDistanceFromBridge: null, bowZone: null,
    wristCollapsed: null, shoulderRaised: null,
    distanceFromCrossing: null, phrasePosition: 0, phraseDurationSeconds: 0,
  };
}

const phrase = (start: number, end: number): Phrase => ({ start, end, duration: end - start });
const noGroups: NoteGroup[] = [];

// ─────────────────────────────────────────────────────────────
console.log('\nEnergy shapes');
{
  const dur = 3.0;
  const arch = makeSignals(dur, { rms: series(t => 0.1 + 0.4 * Math.sin((Math.PI * t) / dur), dur) });
  const [fArch] = buildPhraseFeatures([phrase(0, dur)], arch, [], noGroups);
  check('arch detected', fArch.energy_shape === 'arch', `got ${fArch.energy_shape}`);
  check('peak near middle', Math.abs(fArch.peak_location - 0.5) < 0.15, `got ${fArch.peak_location}`);

  const crescendo = makeSignals(dur, { rms: series(t => 0.05 + 0.2 * t, dur) });
  const [fLate] = buildPhraseFeatures([phrase(0, dur)], crescendo, [], noGroups);
  check('late_peak on crescendo', fLate.energy_shape === 'late_peak', `got ${fLate.energy_shape}`);

  const flat = makeSignals(dur, { rms: series(() => 0.3, dur) });
  const [fFlat] = buildPhraseFeatures([phrase(0, dur)], flat, [], noGroups);
  check('flat on constant', fFlat.energy_shape === 'flat', `got ${fFlat.energy_shape}`);
}

console.log('\nBow usage');
{
  const dur = 2.0;
  const frogHeavy = makeSignals(dur, {
    bowContactPoint: series(() => 0.2 as number | null, dur, 0.1),
  });
  const [f] = buildPhraseFeatures([phrase(0, dur)], frogHeavy, [], noGroups);
  check('frog_heavy', f.bow_usage?.distribution === 'frog_heavy', `got ${f.bow_usage?.distribution}`);
  check('coverage small', (f.bow_usage?.coverage ?? 1) < 0.05);

  const fullBow = makeSignals(dur, {
    bowContactPoint: series(t => (0.1 + 0.8 * (t / dur)) as number | null, dur, 0.1),
  });
  const [f2] = buildPhraseFeatures([phrase(0, dur)], fullBow, [], noGroups);
  check('full distribution on sweep', f2.bow_usage?.distribution === 'full', `got ${f2.bow_usage?.distribution}`);
  check('coverage large', (f2.bow_usage?.coverage ?? 0) > 0.6, `got ${f2.bow_usage?.coverage}`);

  const noBow = makeSignals(dur, {});
  const [f3] = buildPhraseFeatures([phrase(0, dur)], noBow, [], noGroups);
  check('bow_usage null when no bow data', f3.bow_usage === null);
}

console.log('\nIntonation stability');
{
  const dur = 2.0;
  const signals = makeSignals(dur, {});
  const steady = [note(0, 0.5, 3), note(0.5, 1.0, -4), note(1.0, 1.5, 5), note(1.5, 2.0, -2)];
  const [f] = buildPhraseFeatures([phrase(0, dur)], signals, steady, noGroups);
  check('high stability on tight cents', f.intonation.stability === 'high', `got ${f.intonation.stability}`);

  const wild = [note(0, 0.5, 45), note(0.5, 1.0, -50), note(1.0, 1.5, 38), note(1.5, 2.0, -42)];
  const [f2] = buildPhraseFeatures([phrase(0, dur)], signals, wild, noGroups);
  check('low stability on wild cents', f2.intonation.stability === 'low', `got ${f2.intonation.stability}`);
  check('note_count 4', f2.note_count === 4);
}

console.log('\nVibrato consistency');
{
  const dur = 2.0;
  const signals = makeSignals(dur, {});
  const vibrato = {
    eligibleCount: 2,
    avgNoteScore: 60,
    notes: [
      { startS: 0.1, endS: 0.9, durationS: 0.8, noteScore: 80, rateHz: 5.5, depthCents: 30, periodicityScore: 0.9, consistencyOk: true, feedbackNotes: [], cents: [] },
      { startS: 1.1, endS: 1.9, durationS: 0.8, noteScore: 20, rateHz: 0, depthCents: 0, periodicityScore: 0.1, consistencyOk: false, feedbackNotes: [], cents: [] },
    ],
  };
  const [f] = buildPhraseFeatures([phrase(0, dur)], signals, [], noGroups, vibrato);
  check('vibrato_consistency 0.5', f.vibrato_consistency === 0.5, `got ${f.vibrato_consistency}`);
}

console.log('\nSlur count overlaps phrase window');
{
  const dur = 3.0;
  const signals = makeSignals(dur, {});
  const groups: NoteGroup[] = [
    { id: 0, type: 'slur', noteIds: [0, 1], start_t: 0.2, end_t: 0.9, confidence: 1 },
    { id: 1, type: 'detache', noteIds: [2], start_t: 1.0, end_t: 1.4, confidence: 1 },
    { id: 2, type: 'slur', noteIds: [3, 4], start_t: 2.5, end_t: 3.5, confidence: 1 },
  ];
  const [f] = buildPhraseFeatures([phrase(0, 2.0)], signals, [], groups);
  check('1 slur inside the 0-2s phrase', f.slur_count === 1, `got ${f.slur_count}`);
}

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All phrase feature checks passed');
