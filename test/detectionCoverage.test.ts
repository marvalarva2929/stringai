/**
 * Detection coverage matrix (L8).
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/detectionCoverage.test.ts
 *
 * Each scenario plants a KNOWN set of issues in hand-built note events + signals,
 * then asserts runPatternDetection recovers exactly that set — no misses, no
 * false positives. Emphasis on cross-referencing: issues that only exist in the
 * correlation between fields (finger×string, bow-position×tone, time×error) and
 * entangled causes the detector must separate.
 */

import { runPatternDetection } from '../src/lib/patternDetection';
import { buildSessionEvidence } from '../src/lib/practiceEvidence';
import { createTimeSeries, type SessionSignals, type TimeSeriesPoint } from '../src/types/signals';
import type { NoteEvent } from '../src/lib/noteFusion';
import type { AnalysisResult, MetricScore, MetricKey } from '../src/types/analysis';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Deterministic PRNG for reproducible scatter.
let seed = 7;
function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
function coin() { return rnd() < 0.5 ? -1 : 1; }

const NOTE_POOL: Array<[string, NoteEvent['string']]> = [
  ['D4', 'D'], ['E4', 'D'], ['F#4', 'D'], ['G4', 'D'],
  ['A4', 'A'], ['B4', 'A'], ['C#5', 'A'], ['D5', 'A'],
];

interface NoteSpec {
  t: number; finger: 0 | 1 | 2 | 3 | 4; string?: NoteEvent['string'];
  cents: number; tone?: number; dyn?: number; bowU?: number | null;
}

function note(s: NoteSpec): NoteEvent {
  return {
    startSeconds: s.t, endSeconds: s.t + 1.2, durationSeconds: 1.2,
    pitchHz: 440, noteName: 'A4', string: s.string ?? 'A', inferredFinger: s.finger, positionGroup: 'first',
    centsDeviation: s.cents, absCentsDeviation: Math.abs(s.cents), inTune: Math.abs(s.cents) <= 25,
    fundamentalRatio: s.tone ?? 0.8, dynamicLevel: s.dyn ?? 0.5,
    bowContactPoint: s.bowU === undefined ? null : s.bowU,
    bowAngle: null, bowDistanceFromBridge: null, bowZone: null,
    wristCollapsed: null, shoulderRaised: null,
    distanceFromCrossing: null, phrasePosition: 0, phraseDurationSeconds: 0,
  };
}

function series<T>(pts: Array<TimeSeriesPoint<T>>) { return createTimeSeries(pts); }
function healthyRms(): SessionSignals['rms'] {
  // Wide dynamic range (ratio ~6) so dynamic_range_narrow stays silent by default.
  const pts = Array.from({ length: 200 }, (_, i) => ({ t: i * 0.7, v: 0.08 + 0.42 * Math.abs(Math.sin(i / 9)) }));
  return series(pts);
}
function healthyBow(): SessionSignals['bowContactPoint'] {
  // Full even sweep frog↔tip so bow_zone_camping / bow_distribution_narrow stay silent.
  const pts = Array.from({ length: 200 }, (_, i) => ({ t: i * 0.7, v: (0.05 + 0.9 * ((i % 20) / 19)) as number | null }));
  return series(pts);
}

function makeSignals(over: Partial<SessionSignals>): SessionSignals {
  const empty = <T,>() => series<T>([]);
  return {
    durationSeconds: 140,
    pitch: empty<number | null>(), rms: healthyRms(), fundamentalRatio: empty<number>(),
    leftWristAngle: empty<number | null>(), rightElbowY: empty<number | null>(),
    rightShoulderY: empty<number | null>(), shoulderDiff: empty<number | null>(),
    bowContactPoint: healthyBow(), bowAngle: empty<number | null>(),
    bowSpeed: empty<number | null>(), bowDirection: empty<-1 | 0 | 1 | null>(),
    spectralCentroid: empty<number>(), brightness: empty<number>(),
    noteEvents: [], ...over,
  };
}

function firedSet(signals: SessionSignals, notes: NoteEvent[]): Set<string> {
  return new Set(runPatternDetection(signals, notes).map((f) => f.testId));
}
function expect(name: string, got: Set<string>, want: string[]) {
  const w = new Set(want);
  const missing = [...w].filter((x) => !got.has(x));
  const extra = [...got].filter((x) => !w.has(x));
  check(name, missing.length === 0 && extra.length === 0,
    `missing=[${missing.join(',')}] extra=[${extra.join(',')}] got=[${[...got].join(',')}]`);
}

// ═════════════════════════════════════════════════════════════
// Scenario F (baseline first): clean session fires NOTHING.
// ═════════════════════════════════════════════════════════════
console.log('clean session → no false positives');
{
  const notes: NoteEvent[] = [];
  for (let i = 0; i < 40; i++) {
    const [nn, str] = NOTE_POOL[i % NOTE_POOL.length];
    notes.push(note({ t: i * 3.5, finger: (i % 3 + 1) as any, string: str, cents: coin() * (rnd() * 8), tone: 0.82, dyn: 0.5, bowU: 0.1 + 0.8 * ((i % 10) / 9) }));
  }
  expect('healthy playing fires no tests', firedSet(makeSignals({}), notes), []);
}

// ═════════════════════════════════════════════════════════════
// Scenario E: finger×string tendency — finger 2 sharp ONLY on E string.
// Cross-ref: the SAME finger is fine on the A string; the bias lives in the
// finger×string cell, and pitch_tendency must isolate it.
// ═════════════════════════════════════════════════════════════
console.log('\nfinger×string: finger 2 sharp only on the E string');
{
  const notes: NoteEvent[] = [];
  // finger 2 on E: consistently +30 sharp (12 notes)
  for (let i = 0; i < 12; i++) notes.push(note({ t: i * 3, finger: 2, string: 'E', cents: 28 + coin() * 4 }));
  // finger 2 on A: fine (12 notes) — same finger, different string
  for (let i = 0; i < 12; i++) notes.push(note({ t: 40 + i * 3, finger: 2, string: 'A', cents: coin() * 5 }));
  // other fingers fine
  for (let i = 0; i < 12; i++) notes.push(note({ t: 80 + i * 3, finger: 1, string: 'D', cents: coin() * 6 }));
  const got = firedSet(makeSignals({}), notes);
  expect('only pitch_tendency fires', got, ['pitch_tendency']);
  const f = runPatternDetection(makeSignals({}), notes).find((x) => x.testId === 'pitch_tendency')!;
  check('names finger 2 / E string / sharp', f.summary.includes('finger 2') && f.summary.includes('E string') && f.summary.includes('sharp'), f.summary);
}

// ═════════════════════════════════════════════════════════════
// Scenario A: TWO ENTANGLED CAUSES — a flat 3rd finger AND independent fatigue.
// The detector must report both, not collapse them. finger_accuracy_gap and
// pitch_tendency isolate finger 3; intonation_fatigue sees the time trend across
// ALL fingers. This is the disentanglement the whole design rests on.
// ═════════════════════════════════════════════════════════════
console.log('\nentangled: flat 3rd finger + independent fatigue');
{
  const notes: NoteEvent[] = [];
  for (let i = 0; i < 45; i++) {
    const t = i * 3;
    const finger = (i % 3 + 1) as 1 | 2 | 3;
    const string: NoteEvent['string'] = finger === 3 ? 'D' : 'A';
    const fatigue = (t / 135) * 34;   // error growth over time, affecting every finger
    // finger 3 sits flat and gets flatter with fatigue; other fingers scatter
    // (random sign) with a magnitude that also grows, so fatigue is real but
    // there's no directional bias to fake a tendency on them.
    const cents = finger === 3 ? -34 - fatigue : coin() * (6 + fatigue);
    notes.push(note({ t, finger, string, cents }));
  }
  const got = firedSet(makeSignals({}), notes);
  check('finger_accuracy_gap fires (finger 3 isolated)', got.has('finger_accuracy_gap'));
  check('pitch_tendency fires (finger 3 flat)', got.has('pitch_tendency'));
  check('intonation_fatigue fires (time trend survives the finger-3 offset)', got.has('intonation_fatigue'));
  const gap = runPatternDetection(makeSignals({}), notes).find((x) => x.testId === 'finger_accuracy_gap')!;
  check('gap names finger 3, not a different finger', gap.summary.includes('Finger 3'), gap.summary);
}

// ═════════════════════════════════════════════════════════════
// Scenario B: PURE fatigue, no per-finger bias. Confound rejection — a high but
// TIME-DRIVEN error must NOT be misread as a finger gap or a tendency.
// ═════════════════════════════════════════════════════════════
console.log('\nconfound: pure fatigue must not masquerade as a finger gap');
{
  const notes: NoteEvent[] = [];
  for (let i = 0; i < 45; i++) {
    const t = i * 3;
    const finger = (i % 3 + 1) as 1 | 2 | 3;                 // every finger equally affected
    const grow = 8 + (t / 135) * 40;
    notes.push(note({ t, finger, string: finger % 2 ? 'D' : 'A', cents: coin() * grow })); // random sign → no tendency
  }
  const got = firedSet(makeSignals({}), notes);
  check('intonation_fatigue fires', got.has('intonation_fatigue'));
  check('finger_accuracy_gap does NOT fire (no single bad finger)', !got.has('finger_accuracy_gap'), [...got].join(','));
  check('pitch_tendency does NOT fire (error cancels by sign)', !got.has('pitch_tendency'), [...got].join(','));
}

// ═════════════════════════════════════════════════════════════
// Scenario C: BOW-ARM WEIGHT — one physical habit, three cross-signal findings.
// Camps in the lower bow; whenever notes DO reach the upper bow, tone AND volume
// collapse. bow_zone_camping (signal) + upper_bow_tone_degradation (bowU×tone) +
// tip_dynamic_ceiling (bowU×dyn) must all fire.
// ═════════════════════════════════════════════════════════════
console.log('\ncross-signal: bow-arm weight (camping + tone + dynamics)');
{
  // Signal series: 80% of samples in the lower third.
  const bowPts: Array<TimeSeriesPoint<number | null>> = [];
  for (let i = 0; i < 200; i++) {
    const inLower = i % 5 !== 0;                    // 4 of every 5 samples low
    bowPts.push({ t: i * 0.7, v: inLower ? 0.05 + rnd() * 0.25 : 0.62 + rnd() * 0.2 });
  }
  // Notes: lower-bow notes clean/loud; upper-bow notes thin/quiet (the cross-ref).
  const notes: NoteEvent[] = [];
  for (let i = 0; i < 20; i++) notes.push(note({ t: i * 3, finger: 1, cents: coin() * 6, tone: 0.82, dyn: 0.6, bowU: 0.1 + rnd() * 0.2 }));
  for (let i = 0; i < 12; i++) notes.push(note({ t: 60 + i * 3, finger: 1, cents: coin() * 6, tone: 0.56, dyn: 0.28, bowU: 0.7 + rnd() * 0.1 }));
  const got = firedSet(makeSignals({ bowContactPoint: series(bowPts) }), notes);
  check('bow_zone_camping fires', got.has('bow_zone_camping'));
  check('upper_bow_tone_degradation fires (bowU×tone)', got.has('upper_bow_tone_degradation'));
  check('tip_dynamic_ceiling fires (bowU×dyn)', got.has('tip_dynamic_ceiling'));
  check('no pitch/finger tests fire on a bow scenario', !got.has('finger_accuracy_gap') && !got.has('pitch_tendency') && !got.has('intonation_fatigue'), [...got].join(','));
}

// ═════════════════════════════════════════════════════════════
// Scenario D: CONFOUND — uniformly mediocre tone that does NOT depend on bow
// position. upper_bow_tone_degradation must not fire; the bow is well used.
// ═════════════════════════════════════════════════════════════
console.log('\nconfound: uniform mediocre tone is not a bow-position problem');
{
  const notes: NoteEvent[] = [];
  for (let i = 0; i < 20; i++) notes.push(note({ t: i * 3, finger: 1, cents: coin() * 6, tone: 0.6, dyn: 0.5, bowU: 0.1 + rnd() * 0.2 }));
  for (let i = 0; i < 20; i++) notes.push(note({ t: 60 + i * 3, finger: 1, cents: coin() * 6, tone: 0.6, dyn: 0.5, bowU: 0.7 + rnd() * 0.2 }));
  const got = firedSet(makeSignals({}), notes);
  check('upper_bow_tone_degradation does NOT fire (tone flat across positions)', !got.has('upper_bow_tone_degradation'), [...got].join(','));
  check('tip_dynamic_ceiling does NOT fire (dyn flat across positions)', !got.has('tip_dynamic_ceiling'), [...got].join(','));
}

// ═════════════════════════════════════════════════════════════
// Scenario G: dynamic range — narrow vs wide RMS.
// ═════════════════════════════════════════════════════════════
console.log('\ndynamic range: narrow fires, wide is silent');
{
  const flatRms = series(Array.from({ length: 60 }, (_, i) => ({ t: i, v: 0.30 + (rnd() - 0.5) * 0.02 })));
  const notes = Array.from({ length: 10 }, (_, i) => note({ t: i, finger: 1, cents: 0 }));
  check('narrow RMS → dynamic_range_narrow', firedSet(makeSignals({ rms: flatRms }), notes).has('dynamic_range_narrow'));
  check('healthy wide RMS → silent', !firedSet(makeSignals({}), notes).has('dynamic_range_narrow'));
}

// ═════════════════════════════════════════════════════════════
// End-to-end: findings become practice evidence (detection → issue).
// ═════════════════════════════════════════════════════════════
console.log('\ndetection flows into session evidence');
{
  function score(key: MetricKey, s: number): MetricScore {
    return { key, score: s, flaggedTimestamps: [], severity: s >= 75 ? 'good' : 'critical',
      events: [], occurrenceRate: 0, observationSummary: `${key}`, measurementQuality: 'high' };
  }
  const notes: NoteEvent[] = [];
  for (let i = 0; i < 12; i++) notes.push(note({ t: i * 3, finger: 3, string: 'D', cents: -32 }));
  for (let i = 0; i < 12; i++) notes.push(note({ t: 40 + i * 3, finger: 1, string: 'A', cents: coin() * 6 }));
  const findings = runPatternDetection(makeSignals({}), notes);
  const session: AnalysisResult = {
    sessionId: 'x', userId: 'u', instrument: 'violin', durationSeconds: 140,
    recordedAt: '2026-07-10T00:00:00Z', overallScore: 62,
    metrics: [score('pitchAccuracy', 60)], audioMetrics: [score('pitchAccuracy', 60)], videoMetrics: [],
    patternFindings: findings,
  } as AnalysisResult;
  const evidence = buildSessionEvidence(session);
  const ids = evidence.map((e) => e.id);
  check('pitch_tendency finding became evidence', ids.includes('pattern:pitch_tendency'), ids.join(','));
  check('finger_accuracy_gap finding became evidence', ids.includes('pattern:finger_accuracy_gap'), ids.join(','));
}

console.log('');
// ─────────────────────────────────────────────────────────────────────────────
// A mistuned instrument is not a technique fault — and it used to read as one.
//
// pitch_tendency ranks finger×string groups by mean signed deviation. With the
// violin tuned flat, every group's mean is equally flat, so the test fired and
// blamed whichever finger happened to be worst. Nothing about the player's
// technique needed to change; they needed to tune.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nmistuned instrument: the peg, not the finger');
{
  const notes: NoteEvent[] = [];
  // Everything 25 cents flat, open strings included — the giveaway, since an
  // open string cannot be fingered wrong.
  for (let i = 0; i < 6; i++) notes.push(note({ t: i * 3, finger: 0, string: 'A', cents: -25 + coin() * 3 }));
  for (let i = 0; i < 10; i++) notes.push(note({ t: 20 + i * 3, finger: 1, string: 'A', cents: -25 + coin() * 4 }));
  for (let i = 0; i < 10; i++) notes.push(note({ t: 55 + i * 3, finger: 2, string: 'D', cents: -24 + coin() * 4 }));
  for (let i = 0; i < 10; i++) notes.push(note({ t: 90 + i * 3, finger: 3, string: 'D', cents: -26 + coin() * 4 }));

  const got = firedSet(makeSignals({}), notes);
  check('instrument_out_of_tune fires', got.has('instrument_out_of_tune'), [...got].join(','));
  check(
    'and pitch_tendency does NOT blame a finger for it',
    !got.has('pitch_tendency'),
    [...got].join(','),
  );
  const f = runPatternDetection(makeSignals({}), notes).find((x) => x.testId === 'instrument_out_of_tune')!;
  check('says flat, and says to tune', /flat/.test(f.summary) && /[Tt]une/.test(f.summary), f.summary);
}

console.log('\nmistuned AND one bad finger: report both, blame each correctly');
{
  const notes: NoteEvent[] = [];
  // Interleaved in time so a genuine finger fault cannot masquerade as fatigue.
  let t = 0;
  for (let i = 0; i < 12; i++) {
    // Instrument 20 flat everywhere, open strings included...
    if (i % 2 === 0) notes.push(note({ t: t += 3, finger: 0, string: 'A', cents: -20 + coin() * 3 }));
    notes.push(note({ t: t += 3, finger: 1, string: 'A', cents: -20 + coin() * 4 }));
    notes.push(note({ t: t += 3, finger: 2, string: 'D', cents: -21 + coin() * 4 }));
    // ...and finger 4 a further 30 flat on top of it.
    notes.push(note({ t: t += 3, finger: 4, string: 'D', cents: -50 + coin() * 4 }));
  }

  const got = firedSet(makeSignals({}), notes);
  check('instrument_out_of_tune still fires', got.has('instrument_out_of_tune'), [...got].join(','));
  check('and the genuinely bad finger still surfaces', got.has('pitch_tendency'), [...got].join(','));
  const f = runPatternDetection(makeSignals({}), notes).find((x) => x.testId === 'pitch_tendency')!;
  check('naming finger 4, not one of the merely-flat ones', f.summary.includes('finger 4'), f.summary);
}

console.log('\nin-tune instrument stays quiet');
{
  const notes: NoteEvent[] = [];
  for (let i = 0; i < 6; i++) notes.push(note({ t: i * 3, finger: 0, string: 'A', cents: coin() * 4 }));
  for (let i = 0; i < 12; i++) notes.push(note({ t: 20 + i * 3, finger: 1, string: 'A', cents: coin() * 6 }));
  for (let i = 0; i < 12; i++) notes.push(note({ t: 60 + i * 3, finger: 2, string: 'D', cents: coin() * 6 }));
  const got = firedSet(makeSignals({}), notes);
  check('no tuning finding on a tuned violin', !got.has('instrument_out_of_tune'), [...got].join(','));
}

console.log('\na tuning finding is reported but never becomes a drill');
{
  function score2(key: MetricKey, sc: number): MetricScore {
    return { key, score: sc, flaggedTimestamps: [], severity: sc >= 75 ? 'good' : 'critical',
      events: [], occurrenceRate: 0, observationSummary: `${key}`, measurementQuality: 'high' };
  }
  const notes: NoteEvent[] = [];
  for (let i = 0; i < 6; i++) notes.push(note({ t: i * 3, finger: 0, string: 'A', cents: -25 + coin() * 3 }));
  for (let i = 0; i < 12; i++) notes.push(note({ t: 20 + i * 3, finger: 1, string: 'A', cents: -25 + coin() * 4 }));
  for (let i = 0; i < 12; i++) notes.push(note({ t: 60 + i * 3, finger: 2, string: 'D', cents: -24 + coin() * 4 }));

  const findings = runPatternDetection(makeSignals({}), notes);
  check(
    'the finding is in the session report',
    findings.some((f) => f.testId === 'instrument_out_of_tune'),
    findings.map((f) => f.testId).join(','),
  );

  const session: AnalysisResult = {
    sessionId: 'x', userId: 'u', instrument: 'violin', durationSeconds: 140,
    recordedAt: '2026-07-10T00:00:00Z', overallScore: 62,
    metrics: [score2('pitchAccuracy', 60)], audioMetrics: [score2('pitchAccuracy', 60)], videoMetrics: [],
    patternFindings: findings,
  } as AnalysisResult;
  const ids = buildSessionEvidence(session).map((e) => e.id);
  // Practising intonation against a mistuned instrument is practising against a
  // moving target — the fix is a tuning peg, not an exercise.
  check(
    'but it does not become practice evidence',
    !ids.includes('pattern:instrument_out_of_tune'),
    ids.join(','),
  );
}

if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('All detection coverage checks passed');
