/**
 * Pattern detection (L8) test harness — bow statistical tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/patternDetection.test.ts
 *   (or: npm run test:patterns)
 */

import {
  testBowDistributionNarrow,
  testUpperBowToneDegradation,
  testTipDynamicCeiling,
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
console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All pattern detection checks passed');
