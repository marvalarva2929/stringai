import type { NoteEvent } from './noteFusion';
import type { SessionSignals } from '../types/signals';

// ─────────────────────────────────────────────────────────────────────────────
// StatisticalFinding
// ─────────────────────────────────────────────────────────────────────────────

export interface StatisticalFinding {
  testId: string;
  fired: boolean;
  severity: 'minor' | 'moderate' | 'significant';
  confidence: number;  // 0–1
  summary: string;
  evidence: {
    groupA: { label: string; value: number; n: number };
    groupB: { label: string; value: number; n: number };
    effectSize: number;
  };
  timestamps: Array<{ startSeconds: number; endSeconds: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MIN_GROUP_SIZE = 8;

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Simple OLS: returns { slope, intercept }. */
function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  const xBar = mean(xs);
  const yBar = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xBar) * (ys[i] - yBar);
    den += (xs[i] - xBar) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { slope, intercept: yBar - slope * xBar };
}

/** Confidence from sample size + effect magnitude (0–1). */
function confidenceFromEffect(n: number, effectSize: number): number {
  // Saturate at n=40 (larger gives diminishing returns in short sessions)
  const sizeFactor = Math.min(n / 40, 1);
  // effectSize is the ratio or normalized slope
  const effectFactor = Math.min(Math.abs(effectSize), 1);
  return Math.sqrt(sizeFactor * effectFactor);
}

function notFired(testId: string): StatisticalFinding {
  return {
    testId,
    fired: false,
    severity: 'minor',
    confidence: 0,
    summary: '',
    evidence: {
      groupA: { label: '', value: 0, n: 0 },
      groupB: { label: '', value: 0, n: 0 },
      effectSize: 0,
    },
    timestamps: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: intonation_fatigue
//
// Detects: pitch accuracy degrades over time.
// Method:  OLS regression of absCentsDeviation on startSeconds.
//          A positive slope means intonation gets worse as the session goes on.
// Fires:   when slope > 0.3 cents/second AND confidence ≥ 0.4.
// ─────────────────────────────────────────────────────────────────────────────

export function testIntonationFatigue(notes: NoteEvent[]): StatisticalFinding {
  if (notes.length < MIN_GROUP_SIZE) return notFired('intonation_fatigue');

  const xs = notes.map((n) => n.startSeconds);
  const ys = notes.map((n) => n.absCentsDeviation);
  const { slope } = linearRegression(xs, ys);

  // Effect size: slope in cents/second — normalize by session mean
  const avgError = mean(ys);
  const normalizedSlope = avgError > 0 ? slope / avgError : 0;

  const confidence = confidenceFromEffect(notes.length, Math.abs(normalizedSlope));

  // Split into early/late halves for evidence
  const mid = notes.length >> 1;
  const earlyNotes = notes.slice(0, mid);
  const lateNotes  = notes.slice(mid);
  const earlyMean  = mean(earlyNotes.map((n) => n.absCentsDeviation));
  const lateMean   = mean(lateNotes.map((n) => n.absCentsDeviation));

  const SLOPE_THRESHOLD = 0.3;
  const fired = slope > SLOPE_THRESHOLD && confidence >= 0.4;

  if (!fired) return { ...notFired('intonation_fatigue'), confidence };

  return {
    testId: 'intonation_fatigue',
    fired: true,
    severity: lateMean - earlyMean > 20 ? 'significant' : 'moderate',
    confidence,
    summary: `Intonation drifted over time: average pitch error rose from ${earlyMean.toFixed(0)} cents to ${lateMean.toFixed(0)} cents by the end of the session.`,
    evidence: {
      groupA: { label: 'Early session', value: earlyMean, n: earlyNotes.length },
      groupB: { label: 'Late session',  value: lateMean,  n: lateNotes.length },
      effectSize: slope,
    },
    timestamps: [
      { startSeconds: lateNotes[0].startSeconds, endSeconds: notes[notes.length - 1].endSeconds },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: finger_accuracy_gap
//
// Detects: one specific finger is consistently less accurate than the others.
// Method:  avg(absCentsDeviation) by inferredFinger.
//          Finds the worst finger, compares it to the mean of the rest.
// Fires:   when worst finger is ≥ 15 cents worse AND confidence ≥ 0.4
//          AND worst finger group has ≥ 8 notes.
// ─────────────────────────────────────────────────────────────────────────────

export function testFingerAccuracyGap(notes: NoteEvent[]): StatisticalFinding {
  if (notes.length < MIN_GROUP_SIZE) return notFired('finger_accuracy_gap');

  const byFinger = new Map<number, NoteEvent[]>();
  for (const n of notes) {
    const group = byFinger.get(n.inferredFinger) ?? [];
    group.push(n);
    byFinger.set(n.inferredFinger, group);
  }

  // Only consider fingers with enough data points
  const fingerStats = Array.from(byFinger.entries())
    .filter(([, ns]) => ns.length >= MIN_GROUP_SIZE)
    .map(([finger, ns]) => ({
      finger,
      avg: mean(ns.map((n) => n.absCentsDeviation)),
      n: ns.length,
      notes: ns,
    }));

  if (fingerStats.length < 2) return notFired('finger_accuracy_gap');

  fingerStats.sort((a, b) => b.avg - a.avg);
  const worst = fingerStats[0];
  const rest  = fingerStats.slice(1);
  const restAvg = mean(rest.map((s) => s.avg));
  const gap = worst.avg - restAvg;

  const effectSize = restAvg > 0 ? gap / restAvg : 0;
  const confidence = confidenceFromEffect(worst.n, effectSize);

  const CENTS_GAP_THRESHOLD = 15;
  const fired = gap >= CENTS_GAP_THRESHOLD && confidence >= 0.4;

  if (!fired) return { ...notFired('finger_accuracy_gap'), confidence };

  const fingerName = worst.finger === 0 ? 'open string' : `finger ${worst.finger}`;
  const severity: StatisticalFinding['severity'] = gap > 35 ? 'significant' : gap > 22 ? 'moderate' : 'minor';

  return {
    testId: 'finger_accuracy_gap',
    fired: true,
    severity,
    confidence,
    summary: `${fingerName.charAt(0).toUpperCase() + fingerName.slice(1)} is consistently less accurate (avg ${worst.avg.toFixed(0)} cents off vs. ${restAvg.toFixed(0)} cents for other fingers).`,
    evidence: {
      groupA: { label: fingerName,    value: worst.avg, n: worst.n },
      groupB: { label: 'Other fingers', value: restAvg,  n: rest.reduce((s, r) => s + r.n, 0) },
      effectSize: gap,
    },
    timestamps: worst.notes
      .filter((n) => n.absCentsDeviation > 30)
      .map((n) => ({ startSeconds: n.startSeconds, endSeconds: n.endSeconds }))
      .slice(0, 5),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: pitch_tendency
//
// Detects: systematic sharp or flat bias per finger × string combination.
// Method:  mean(centsDeviation) — signed — by (inferredFinger, string).
//          Surfaces combinations that are ≥ 20 cents consistently biased.
//          Picks the single worst combination to report (highest |mean|).
// Fires:   when |mean| ≥ 20 cents, group has ≥ 8 notes, confidence ≥ 0.4.
// ─────────────────────────────────────────────────────────────────────────────

export function testPitchTendency(notes: NoteEvent[]): StatisticalFinding {
  if (notes.length < MIN_GROUP_SIZE) return notFired('pitch_tendency');

  const byGroup = new Map<string, NoteEvent[]>();
  for (const n of notes) {
    const key = `${n.inferredFinger}-${n.string}`;
    const group = byGroup.get(key) ?? [];
    group.push(n);
    byGroup.set(key, group);
  }

  type GroupStat = { finger: number; string: string; meanDev: number; n: number; notes: NoteEvent[] };
  const stats: GroupStat[] = [];
  for (const [key, ns] of byGroup.entries()) {
    if (ns.length < MIN_GROUP_SIZE) continue;
    const [fingerStr, str] = key.split('-');
    stats.push({
      finger: Number(fingerStr),
      string: str,
      meanDev: mean(ns.map((n) => n.centsDeviation)),
      n: ns.length,
      notes: ns,
    });
  }

  if (stats.length === 0) return notFired('pitch_tendency');

  // Pick the most extreme (highest |meanDev|)
  stats.sort((a, b) => Math.abs(b.meanDev) - Math.abs(a.meanDev));
  const worst = stats[0];

  const BIAS_THRESHOLD = 20;
  const effectSize = Math.abs(worst.meanDev) / 50;  // 50 cents = half-step
  const confidence = confidenceFromEffect(worst.n, effectSize);

  const fired = Math.abs(worst.meanDev) >= BIAS_THRESHOLD && confidence >= 0.4;
  if (!fired) return { ...notFired('pitch_tendency'), confidence };

  const direction = worst.meanDev > 0 ? 'sharp' : 'flat';
  const fingerLabel = worst.finger === 0 ? 'open string' : `finger ${worst.finger}`;
  const severity: StatisticalFinding['severity'] =
    Math.abs(worst.meanDev) > 40 ? 'significant' : Math.abs(worst.meanDev) > 25 ? 'moderate' : 'minor';

  // Overall session mean for comparison
  const sessionMean = mean(notes.map((n) => n.centsDeviation));

  return {
    testId: 'pitch_tendency',
    fired: true,
    severity,
    confidence,
    summary: `${fingerLabel} on the ${worst.string} string tends to play ${direction} by ${Math.abs(worst.meanDev).toFixed(0)} cents on average.`,
    evidence: {
      groupA: { label: `${fingerLabel} / ${worst.string} string`, value: worst.meanDev, n: worst.n },
      groupB: { label: 'Session mean', value: sessionMean, n: notes.length },
      effectSize: worst.meanDev,
    },
    timestamps: worst.notes
      .filter((n) => Math.sign(n.centsDeviation) === Math.sign(worst.meanDev) && Math.abs(n.centsDeviation) > 25)
      .map((n) => ({ startSeconds: n.startSeconds, endSeconds: n.endSeconds }))
      .slice(0, 5),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: dynamic_range_narrow
//
// Detects: the player plays at the same volume throughout — no dynamic contrast.
// Method:  ratio of loudest to quietest non-silent RMS across the session.
//          Uses signals.rms directly; does not require NoteEvent fields.
// Fires:   when ratio < 2.5 AND at least 20 non-silent frames (confidence ≥ 0.4).
// ─────────────────────────────────────────────────────────────────────────────

export function testDynamicRangeNarrow(signals: SessionSignals, _noteEvents: NoteEvent[]): StatisticalFinding {
  const playing = signals.rms.points.map((p) => p.v).filter((v) => v > 0.02);
  if (playing.length < 20) return notFired('dynamic_range_narrow');

  const maxRms = Math.max(...playing);
  const minRms = Math.min(...playing);
  const ratio = maxRms / Math.max(minRms, 0.001);

  const NARROW_THRESHOLD = 2.5;
  const effectSize = Math.max(0, NARROW_THRESHOLD - ratio) / NARROW_THRESHOLD;
  const confidence = confidenceFromEffect(playing.length, effectSize);

  const fired = ratio < NARROW_THRESHOLD && confidence >= 0.4;
  if (!fired) return { ...notFired('dynamic_range_narrow'), confidence };

  const severity: StatisticalFinding['severity'] =
    ratio < 1.5 ? 'significant' : ratio < 2.0 ? 'moderate' : 'minor';

  return {
    testId: 'dynamic_range_narrow',
    fired: true,
    severity,
    confidence,
    summary: `Dynamic range is narrow — loudest playing was ${ratio.toFixed(1)}× louder than quietest (target: 4× or more for expressive playing).`,
    evidence: {
      groupA: { label: 'Peak RMS (loudest moment)',   value: maxRms, n: playing.length },
      groupB: { label: 'Trough RMS (quietest moment)', value: minRms, n: playing.length },
      effectSize: ratio,
    },
    timestamps: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: bow_distribution_narrow
//
// Detects: player uses only a small portion of the bow (e.g. always middle).
// Method:  range (max − min) of the non-null bowContactPoint samples.
// Fires:   when range < 0.35 AND ≥ 20 samples (confidence ≥ 0.4).
// ─────────────────────────────────────────────────────────────────────────────

export function testBowDistributionNarrow(signals: SessionSignals, _noteEvents: NoteEvent[]): StatisticalFinding {
  const u = signals.bowContactPoint.points.map((p) => p.v).filter((v): v is number => v !== null);
  if (u.length < 20) return notFired('bow_distribution_narrow');

  const maxU = Math.max(...u);
  const minU = Math.min(...u);
  const range = maxU - minU;

  const NARROW_THRESHOLD = 0.35;
  const effectSize = Math.max(0, NARROW_THRESHOLD - range) / NARROW_THRESHOLD;
  const confidence = confidenceFromEffect(u.length, effectSize);

  const fired = range < NARROW_THRESHOLD && confidence >= 0.4;
  if (!fired) return { ...notFired('bow_distribution_narrow'), confidence };

  const severity: StatisticalFinding['severity'] =
    range < 0.2 ? 'significant' : range < 0.28 ? 'moderate' : 'minor';
  const center = mean(u);
  const zone = center < 0.33 ? 'lower half' : center > 0.67 ? 'upper half' : 'middle';

  return {
    testId: 'bow_distribution_narrow',
    fired: true,
    severity,
    confidence,
    summary: `Only ${(range * 100).toFixed(0)}% of the bow length is being used, concentrated in the ${zone} — full strokes develop tone control across the whole bow.`,
    evidence: {
      groupA: { label: 'Bow range used (0=frog, 1=tip)', value: range, n: u.length },
      groupB: { label: 'Mean contact point', value: center, n: u.length },
      effectSize: range,
    },
    timestamps: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: upper_bow_tone_degradation
//
// Detects: tone quality collapses in the upper half of the bow (usually not
//          enough arm weight transfer toward the tip).
// Method:  notes split by bowContactPoint > 0.6 (upper) vs < 0.4 (lower);
//          compare mean fundamentalRatio.
// Fires:   when upper tone is ≥ 15% worse, both groups ≥ 8 notes.
// ─────────────────────────────────────────────────────────────────────────────

export function testUpperBowToneDegradation(_signals: SessionSignals, noteEvents: NoteEvent[]): StatisticalFinding {
  const withBow = noteEvents.filter((n) => n.bowContactPoint !== null);
  const upper = withBow.filter((n) => n.bowContactPoint! > 0.6);
  const lower = withBow.filter((n) => n.bowContactPoint! < 0.4);
  if (upper.length < MIN_GROUP_SIZE || lower.length < MIN_GROUP_SIZE) {
    return notFired('upper_bow_tone_degradation');
  }

  const upperTone = mean(upper.map((n) => n.fundamentalRatio));
  const lowerTone = mean(lower.map((n) => n.fundamentalRatio));
  if (lowerTone <= 0) return notFired('upper_bow_tone_degradation');

  const degradation = (lowerTone - upperTone) / lowerTone;

  const DEGRADATION_THRESHOLD = 0.15;
  // Normalize against the 'significant' bar (0.35) — a 35% tone drop is a
  // full-strength effect for fundamentalRatio, not 0.35 of one.
  const confidence = confidenceFromEffect(Math.min(upper.length, lower.length), degradation / 0.35);

  const fired = degradation >= DEGRADATION_THRESHOLD && confidence >= 0.4;
  if (!fired) return { ...notFired('upper_bow_tone_degradation'), confidence };

  const severity: StatisticalFinding['severity'] =
    degradation > 0.35 ? 'significant' : degradation > 0.25 ? 'moderate' : 'minor';

  return {
    testId: 'upper_bow_tone_degradation',
    fired: true,
    severity,
    confidence,
    summary: `Tone quality drops ${(degradation * 100).toFixed(0)}% in the upper half of the bow — usually a sign the arm weight isn't following through toward the tip.`,
    evidence: {
      groupA: { label: 'Upper-bow notes (u > 0.6)', value: upperTone, n: upper.length },
      groupB: { label: 'Lower-bow notes (u < 0.4)', value: lowerTone, n: lower.length },
      effectSize: degradation,
    },
    timestamps: upper
      .filter((n) => n.fundamentalRatio <= upperTone)
      .map((n) => ({ startSeconds: n.startSeconds, endSeconds: n.endSeconds }))
      .slice(0, 5),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: tip_dynamic_ceiling
//
// Detects: sound gets quiet at the tip (insufficient index-finger leverage).
// Method:  tip-zone notes (u > 0.67) mean dynamicLevel vs all other bow zones.
// Fires:   when tip notes are ≥ 25% quieter, both groups ≥ 8 notes.
// ─────────────────────────────────────────────────────────────────────────────

export function testTipDynamicCeiling(_signals: SessionSignals, noteEvents: NoteEvent[]): StatisticalFinding {
  const withBow = noteEvents.filter((n) => n.bowContactPoint !== null);
  const tip = withBow.filter((n) => n.bowContactPoint! > 0.67);
  const rest = withBow.filter((n) => n.bowContactPoint! <= 0.67);
  if (tip.length < MIN_GROUP_SIZE || rest.length < MIN_GROUP_SIZE) {
    return notFired('tip_dynamic_ceiling');
  }

  const tipLevel = mean(tip.map((n) => n.dynamicLevel));
  const restLevel = mean(rest.map((n) => n.dynamicLevel));
  if (restLevel <= 0) return notFired('tip_dynamic_ceiling');

  const drop = (restLevel - tipLevel) / restLevel;

  const DROP_THRESHOLD = 0.25;
  // Normalized against the 'significant' bar (0.5) like the tone test above.
  const confidence = confidenceFromEffect(Math.min(tip.length, rest.length), drop / 0.5);

  const fired = drop >= DROP_THRESHOLD && confidence >= 0.4;
  if (!fired) return { ...notFired('tip_dynamic_ceiling'), confidence };

  const severity: StatisticalFinding['severity'] =
    drop > 0.5 ? 'significant' : drop > 0.35 ? 'moderate' : 'minor';

  return {
    testId: 'tip_dynamic_ceiling',
    fired: true,
    severity,
    confidence,
    summary: `Volume drops ${(drop * 100).toFixed(0)}% when playing at the tip — index-finger pressure needs to compensate as the bow's natural weight decreases.`,
    evidence: {
      groupA: { label: 'Tip-zone notes (u > 0.67)', value: tipLevel, n: tip.length },
      groupB: { label: 'Rest of the bow', value: restLevel, n: rest.length },
      effectSize: drop,
    },
    timestamps: tip
      .filter((n) => n.dynamicLevel < tipLevel)
      .map((n) => ({ startSeconds: n.startSeconds, endSeconds: n.endSeconds }))
      .slice(0, 5),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all statistical tests on SessionSignals + NoteEvent[].
 * Returns only findings that fired (fired=true) with confidence ≥ 0.4.
 *
 * Tests that don't have enough data silently return fired=false and are
 * excluded from the result.
 */
export function runPatternDetection(
  signals: SessionSignals,
  noteEvents: NoteEvent[],
): StatisticalFinding[] {
  const tests = [
    testIntonationFatigue(noteEvents),
    testFingerAccuracyGap(noteEvents),
    testPitchTendency(noteEvents),
    testDynamicRangeNarrow(signals, noteEvents),
    testBowDistributionNarrow(signals, noteEvents),
    testUpperBowToneDegradation(signals, noteEvents),
    testTipDynamicCeiling(signals, noteEvents),
  ];

  return tests.filter((f) => f.fired && f.confidence >= 0.4);
}
