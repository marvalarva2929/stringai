/**
 * Pattern detection (L8) test harness — bow statistical tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/patternDetection.test.ts
 *   (or: npm run test:patterns)
 */

import {
  testBowDistributionNarrow,
  testBowZoneCamping,
  testUpperBowToneDegradation,
  testTipDynamicCeiling,
  testIntonationFatigue,
  testFingerAccuracyGap,
  testPitchTendency,
} from '../src/lib/patternDetection';
import type { SessionSignals } from '../src/types/signals';
import { createTimeSeries } from '../src/types/signals';
import type { TimeSeriesPoint } from '../src/types/signals';
import type { NoteEvent } from '../src/lib/noteFusion';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function emptySeries<T>() {
  return createTimeSeries<T>([]);
}

function makeSignals(over: Partial<SessionSignals>): SessionSignals {
  return {
    durationSeconds: 30,
    pitch: emptySeries<number | null>(),
    rms: emptySeries<number>(),
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

function note(start: number, over: Partial<NoteEvent> = {}): NoteEvent {
  return {
    startSeconds: start, endSeconds: start + 0.4, durationSeconds: 0.4,
    pitchHz: 440, noteName: 'A4', string: 'A', inferredFinger: 1, positionGroup: 'first',
    centsDeviation: 0, absCentsDeviation: 0, inTune: true,
    fundamentalRatio: 0.8, dynamicLevel: 0.5,
    bowContactPoint: null, bowAngle: null, bowDistanceFromBridge: null, bowZone: null,
    wristCollapsed: null, shoulderRaised: null,
    distanceFromCrossing: null, phrasePosition: 0, phraseDurationSeconds: 0,
    ...over,
  };
}

function contactSeries(fn: (i: number) => number | null, n: number) {
  const pts: Array<TimeSeriesPoint<number | null>> = [];
  for (let i = 0; i < n; i++) pts.push({ t: i * 0.1, v: fn(i) });
  return createTimeSeries(pts);
}

// ─────────────────────────────────────────────────────────────
console.log('\nbow_distribution_narrow');
{
  // 60 samples all within u ∈ [0.45, 0.55] — clearly narrow
  const narrow = makeSignals({
    bowContactPoint: contactSeries(i => 0.45 + 0.1 * ((i % 10) / 10), 60),
  });
  const f = testBowDistributionNarrow(narrow, []);
  check('fires on narrow usage', f.fired === true, `fired=${f.fired} conf=${f.confidence}`);
  check('significant severity (<0.2 range)', f.severity === 'significant', `got ${f.severity}`);

  // Full-bow sweep 0.1 → 0.9
  const full = makeSignals({
    bowContactPoint: contactSeries(i => 0.1 + 0.8 * ((i % 20) / 20), 60),
  });
  check('silent on full bow', testBowDistributionNarrow(full, []).fired === false);

  // Too little data
  const sparse = makeSignals({ bowContactPoint: contactSeries(() => 0.5, 10) });
  check('silent below 20 samples', testBowDistributionNarrow(sparse, []).fired === false);

  // All-null bow (no detector data)
  const nullBow = makeSignals({ bowContactPoint: contactSeries(() => null, 60) });
  check('silent on null bow', testBowDistributionNarrow(nullBow, []).fired === false);
}

console.log('\nbow_zone_camping');
{
  // Upper half only, sweeping 0.5→1.0 — range looks "good" but half the bow is unused
  const upperHalf = makeSignals({
    bowContactPoint: contactSeries(i => 0.5 + 0.5 * ((i % 20) / 20), 60),
  });
  const f = testBowZoneCamping(upperHalf, []);
  check('fires on upper-half camping', f.fired === true, `fired=${f.fired} conf=${f.confidence}`);
  check('summary names the region', f.fired && f.summary.includes('upper'), f.summary);

  // Full-bow sweep → silent
  const full = makeSignals({
    bowContactPoint: contactSeries(i => 0.1 + 0.8 * ((i % 20) / 20), 60),
  });
  check('silent on full bow', testBowZoneCamping(full, []).fired === false);

  // Too little data → silent
  const sparse = makeSignals({ bowContactPoint: contactSeries(() => 0.8, 10) });
  check('silent below 20 samples', testBowZoneCamping(sparse, []).fired === false);
}

console.log('\nupper_bow_tone_degradation');
{
  // 10 upper-bow notes with poor tone, 10 lower-bow notes with good tone
  const notes: NoteEvent[] = [];
  for (let i = 0; i < 10; i++) notes.push(note(i, { bowContactPoint: 0.8, fundamentalRatio: 0.5 }));
  for (let i = 10; i < 20; i++) notes.push(note(i, { bowContactPoint: 0.2, fundamentalRatio: 0.85 }));
  const f = testUpperBowToneDegradation(makeSignals({}), notes);
  check('fires on upper-bow degradation', f.fired === true, `fired=${f.fired} conf=${f.confidence}`);
  check('has example timestamps', f.timestamps.length > 0);

  // Even tone everywhere → silent
  const even: NoteEvent[] = [];
  for (let i = 0; i < 10; i++) even.push(note(i, { bowContactPoint: 0.8, fundamentalRatio: 0.8 }));
  for (let i = 10; i < 20; i++) even.push(note(i, { bowContactPoint: 0.2, fundamentalRatio: 0.8 }));
  check('silent on even tone', testUpperBowToneDegradation(makeSignals({}), even).fired === false);

  // No bow fields → silent
  const noBow = Array.from({ length: 20 }, (_, i) => note(i));
  check('silent without bow fields', testUpperBowToneDegradation(makeSignals({}), noBow).fired === false);
}

console.log('\ntip_dynamic_ceiling');
{
  // Tip notes much quieter than the rest
  const notes: NoteEvent[] = [];
  for (let i = 0; i < 10; i++) notes.push(note(i, { bowContactPoint: 0.8, dynamicLevel: 0.25 }));
  for (let i = 10; i < 20; i++) notes.push(note(i, { bowContactPoint: 0.4, dynamicLevel: 0.7 }));
  const f = testTipDynamicCeiling(makeSignals({}), notes);
  check('fires on tip volume drop', f.fired === true, `fired=${f.fired} conf=${f.confidence}`);
  check('significant severity (>50% drop)', f.severity === 'significant', `got ${f.severity}`);

  // Consistent volume → silent
  const even: NoteEvent[] = [];
  for (let i = 0; i < 10; i++) even.push(note(i, { bowContactPoint: 0.8, dynamicLevel: 0.6 }));
  for (let i = 10; i < 20; i++) even.push(note(i, { bowContactPoint: 0.4, dynamicLevel: 0.6 }));
  check('silent on even volume', testTipDynamicCeiling(makeSignals({}), even).fired === false);

  // Too few tip notes → silent
  const few: NoteEvent[] = [];
  for (let i = 0; i < 3; i++) few.push(note(i, { bowContactPoint: 0.8, dynamicLevel: 0.2 }));
  for (let i = 3; i < 20; i++) few.push(note(i, { bowContactPoint: 0.4, dynamicLevel: 0.7 }));
  check('silent below MIN_GROUP_SIZE tip notes', testTipDynamicCeiling(makeSignals({}), few).fired === false);
}

// ─────────────────────────────────────────────────────────────
console.log('\nintonation_fatigue');
{
  // Error grows 10 → 50 cents across a 140s take.
  const drifting: NoteEvent[] = [];
  for (let i = 0; i < 40; i++) {
    const t = i * 3.5;
    const err = 10 + (t / 140) * 40;
    drifting.push(note(t, { centsDeviation: -err, absCentsDeviation: err }));
  }
  const f = testIntonationFatigue(drifting);
  check('fires on drifting intonation', f.fired === true, `fired=${f.fired} conf=${f.confidence.toFixed(2)}`);
  // Linear 10→50 puts the half-means at 20 and 40 — exactly the 20-cent band edge.
  check('severity is moderate at the band edge', f.fired && f.severity === 'moderate', f.severity);
  check('summary names both halves', f.fired && f.summary.includes('cents'), f.summary);

  // A steeper 10 → 80 rise clears the 20-cent half-mean gap.
  const steep: NoteEvent[] = [];
  for (let i = 0; i < 40; i++) {
    const t = i * 3.5;
    const err = 10 + (t / 140) * 70;
    steep.push(note(t, { centsDeviation: -err, absCentsDeviation: err }));
  }
  const fSteep = testIntonationFatigue(steep);
  check('severity is significant on a steep rise', fSteep.fired && fSteep.severity === 'significant', fSteep.severity);

  // Same total drift, session stretched 4x. A cents/second threshold would miss this;
  // a duration-invariant one must not.
  const slowDrift: NoteEvent[] = [];
  for (let i = 0; i < 40; i++) {
    const t = i * 14;
    const err = 10 + (t / 560) * 40;
    slowDrift.push(note(t, { centsDeviation: -err, absCentsDeviation: err }));
  }
  check('fires regardless of session length', testIntonationFatigue(slowDrift).fired === true);

  // Flat error → silent
  const steady: NoteEvent[] = [];
  for (let i = 0; i < 40; i++) steady.push(note(i * 3.5, { centsDeviation: -12, absCentsDeviation: 12 }));
  check('silent on steady intonation', testIntonationFatigue(steady).fired === false);

  // Improving over time → silent (negative slope)
  const improving: NoteEvent[] = [];
  for (let i = 0; i < 40; i++) {
    const err = 50 - i;
    improving.push(note(i * 3.5, { centsDeviation: -err, absCentsDeviation: err }));
  }
  check('silent when intonation improves', testIntonationFatigue(improving).fired === false);

  check('silent below MIN_GROUP_SIZE', testIntonationFatigue(drifting.slice(0, 5)).fired === false);
}

// ─────────────────────────────────────────────────────────────
console.log('\nfinger_accuracy_gap');
{
  // Finger 3 is ~35 cents off; fingers 1 and 2 are ~10 cents off.
  const gap: NoteEvent[] = [];
  for (let i = 0; i < 10; i++) gap.push(note(i, { inferredFinger: 1, centsDeviation: -10, absCentsDeviation: 10 }));
  for (let i = 10; i < 20; i++) gap.push(note(i, { inferredFinger: 2, centsDeviation: 9, absCentsDeviation: 9 }));
  for (let i = 20; i < 32; i++) gap.push(note(i, { inferredFinger: 3, centsDeviation: -35, absCentsDeviation: 35 }));
  const f = testFingerAccuracyGap(gap);
  check('fires on one bad finger', f.fired === true, `fired=${f.fired} conf=${f.confidence.toFixed(2)}`);
  check('names the offending finger', f.fired && f.summary.includes('Finger 3'), f.summary);
  check('groupA is the worst finger', f.fired && f.evidence.groupA.n === 12, String(f.evidence.groupA.n));

  // All fingers equally accurate → silent
  const even: NoteEvent[] = [];
  for (let i = 0; i < 12; i++) even.push(note(i, { inferredFinger: 1, absCentsDeviation: 12 }));
  for (let i = 12; i < 24; i++) even.push(note(i, { inferredFinger: 2, absCentsDeviation: 13 }));
  for (let i = 24; i < 36; i++) even.push(note(i, { inferredFinger: 3, absCentsDeviation: 11 }));
  check('silent when fingers are even', testFingerAccuracyGap(even).fired === false);

  // Only one finger has enough samples → silent (nothing to compare against)
  const oneFinger: NoteEvent[] = [];
  for (let i = 0; i < 20; i++) oneFinger.push(note(i, { inferredFinger: 3, absCentsDeviation: 40 }));
  check('silent with fewer than 2 comparable fingers', testFingerAccuracyGap(oneFinger).fired === false);

  check('silent below MIN_GROUP_SIZE', testFingerAccuracyGap(gap.slice(0, 5)).fired === false);
}

// ─────────────────────────────────────────────────────────────
console.log('\npitch_tendency');
{
  // Finger 3 on the D string is systematically 30 cents flat; everything else centered.
  const biased: NoteEvent[] = [];
  for (let i = 0; i < 12; i++) biased.push(note(i, { inferredFinger: 3, string: 'D', centsDeviation: -30, absCentsDeviation: 30 }));
  for (let i = 12; i < 24; i++) biased.push(note(i, { inferredFinger: 1, string: 'A', centsDeviation: 2, absCentsDeviation: 2 }));
  const f = testPitchTendency(biased);
  check('fires on a systematic bias', f.fired === true, `fired=${f.fired} conf=${f.confidence.toFixed(2)}`);
  check('names finger, string and direction', f.fired && f.summary.includes('finger 3') && f.summary.includes('D string') && f.summary.includes('flat'), f.summary);

  // Sharp bias is detected too, with the right direction word.
  const sharp: NoteEvent[] = [];
  for (let i = 0; i < 12; i++) sharp.push(note(i, { inferredFinger: 2, string: 'E', centsDeviation: 28, absCentsDeviation: 28 }));
  for (let i = 12; i < 24; i++) sharp.push(note(i, { inferredFinger: 1, string: 'A', centsDeviation: 1, absCentsDeviation: 1 }));
  const fs = testPitchTendency(sharp);
  check('reports sharp bias as sharp', fs.fired && fs.summary.includes('sharp'), fs.summary);

  // Errors that cancel out (mixed sign) are NOT a tendency — this is the case
  // absCentsDeviation-based tests would wrongly flag.
  const mixed: NoteEvent[] = [];
  for (let i = 0; i < 12; i++) {
    const c = i % 2 === 0 ? 30 : -30;
    mixed.push(note(i, { inferredFinger: 3, string: 'D', centsDeviation: c, absCentsDeviation: 30 }));
  }
  for (let i = 12; i < 24; i++) mixed.push(note(i, { inferredFinger: 1, string: 'A', centsDeviation: 0, absCentsDeviation: 0 }));
  check('silent on mixed-sign scatter', testPitchTendency(mixed).fired === false);

  check('silent below MIN_GROUP_SIZE', testPitchTendency(biased.slice(0, 5)).fired === false);
}

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All pattern detection checks passed');
