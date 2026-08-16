/**
 * Progress analytics tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/progressAnalytics.test.ts
 *   (or: npm run test:progress)
 *
 * Covers the derivations behind the Progress tab and piece detail: period
 * comparison with its dead-band, category series (including the "never
 * measured" path that must not render as zero), stuck/resolved issue
 * detection over a synthetic multi-session history, the piece-specific vs
 * universal split, the practice calendar, and the cold-start ladder.
 */

import {
  comparePeriods, compareHalves, directionFromDelta, DEFAULT_DEAD_BAND,
  buildCategorySeries, categoryScore, categoryRate, overallSeries,
  stuckIssues, resolvedIssues, pieceVsGlobalIssues,
  practiceCalendar, categoryDeltas, progressStage, rangeStart,
  type TrendPoint,
} from '../src/lib/progressAnalytics';
import type { MetricHistoryEntry } from '../src/store/useAnalysisStore';
import type { IssueSource } from '../src/lib/practiceIssues';
import type { PracticeEvidence } from '../src/lib/practiceEvidence';
import type { MetricKey, MetricScore, SessionSummary } from '../src/types/analysis';
import { severityFromScore } from '../src/types/analysis';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const DAY = 86_400_000;
const NOW = new Date('2026-08-01T12:00:00');

// ── fixtures ────────────────────────────────────────────────

function metric(
  key: MetricKey,
  score: number,
  extra: Partial<MetricScore> = {},
): MetricScore {
  return {
    key,
    score,
    flaggedTimestamps: [],
    severity: severityFromScore(score),
    events: [],
    occurrenceRate: 0.2,
    observationSummary: '',
    ...extra,
  };
}

/** A session `daysAgo` days back with the given per-metric scores. */
function entry(
  daysAgo: number,
  scores: MetricScore[],
  opts: Partial<MetricHistoryEntry> = {},
): MetricHistoryEntry {
  return {
    sessionId: `s-${daysAgo}`,
    recordedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    scores,
    ...opts,
  };
}

function evidence(id: string, metricKey: MetricKey = 'pitchAccuracy'): PracticeEvidence {
  return {
    id,
    kind: 'pitch_note',
    metricKey,
    title: id,
    reason: '',
    evidenceSummary: '',
    priority: 50,
    confidence: 0.8,
    supportsLive: true,
    requiresMic: true,
    requiresCamera: false,
    measurementAvailable: true,
    sessionCount: 1,
    target: {},
  };
}

function source(daysAgo: number, ids: string[], pieceId?: string): IssueSource {
  return {
    sessionId: `s-${daysAgo}`,
    recordedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    pieceId,
    evidence: ids.map((id) => evidence(id)),
  };
}

function point(daysAgo: number, value: number): TrendPoint {
  return { t: NOW.getTime() - daysAgo * DAY, value };
}

function summary(daysAgo: number, durationSeconds = 300): SessionSummary {
  const d = new Date(NOW.getTime() - daysAgo * DAY);
  d.setHours(12, 0, 0, 0);
  return {
    id: `s-${daysAgo}`,
    recordedAt: d.toISOString(),
    overallScore: 70,
    instrument: 'violin' as SessionSummary['instrument'],
    durationSeconds,
  };
}

// ── direction / dead-band ───────────────────────────────────

console.log('\nDirection and dead-band');

check('null delta is unknown', directionFromDelta(null) === 'unknown');
check('movement inside the dead-band reads steady', directionFromDelta(DEFAULT_DEAD_BAND) === 'steady');
check('clear gain reads improving', directionFromDelta(DEFAULT_DEAD_BAND + 1) === 'improving');
check('clear loss reads slipping', directionFromDelta(-(DEFAULT_DEAD_BAND + 1)) === 'slipping');

// ── period comparison ───────────────────────────────────────

console.log('\nPeriod comparison');

{
  // Previous 28d averages 60, current 28d averages 80.
  const points = [
    point(50, 58), point(40, 62),
    point(20, 78), point(10, 82),
  ];
  const cmp = comparePeriods(points, NOW.getTime() - 28 * DAY, NOW.getTime());
  check('current period mean', cmp.current === 80, `got ${cmp.current}`);
  check('previous period mean', cmp.previous === 60, `got ${cmp.previous}`);
  check('delta and direction', cmp.delta === 20 && cmp.direction === 'improving');
  check('counts each window', cmp.currentCount === 2 && cmp.previousCount === 2);
}

{
  const cmp = comparePeriods([point(5, 70)], NOW.getTime() - 28 * DAY, NOW.getTime());
  check(
    'no previous window means no direction',
    cmp.previous === null && cmp.delta === null && cmp.direction === 'unknown',
  );
}

{
  // One bad take at the end must not flip a rising month to "slipping".
  const points = [point(26, 60), point(20, 66), point(12, 74), point(2, 62)];
  const cmp = comparePeriods(points, NOW.getTime() - 28 * DAY, NOW.getTime());
  check('single bad take does not dominate', cmp.direction !== 'slipping', `got ${cmp.direction}`);
}

console.log('\nHalf-split comparison');

{
  const cmp = compareHalves([point(9, 50), point(7, 54), point(3, 70), point(1, 74)]);
  check('halves compared', cmp.previous === 52 && cmp.current === 72, `${cmp.previous}/${cmp.current}`);
  check('direction improving', cmp.direction === 'improving');
}

check('single point cannot be compared', compareHalves([point(1, 70)]).direction === 'unknown');
check('empty series cannot be compared', compareHalves([]).direction === 'unknown');

{
  // 5 points: the extra one goes to the recent half, which is the half being asked about.
  const cmp = compareHalves([point(9, 10), point(8, 10), point(3, 40), point(2, 40), point(1, 40)]);
  check('odd counts favour the recent half', cmp.currentCount === 3 && cmp.previousCount === 2);
}

// ── category series ─────────────────────────────────────────

console.log('\nCategory series');

{
  const history = [
    entry(1, [metric('pitchAccuracy', 84), metric('intonationStability', 80)], {
      headline: { inTuneRate: 0.84, totalNotes: 50 },
    }),
    entry(10, [metric('pitchAccuracy', 70), metric('intonationStability', 66)]),
    entry(40, [metric('pitchAccuracy', 60), metric('intonationStability', 58)]),
  ];
  const series = buildCategorySeries(history, '4w', NOW);
  const intonation = series.find((s) => s.id === 'intonation')!;

  check('intonation is measured', intonation.measured);
  check('only in-range points are charted', intonation.points.length === 2, `got ${intonation.points.length}`);
  check('points run oldest-first', intonation.points[0].t < intonation.points[1].t);
  check(
    'real unit comes from the persisted headline',
    intonation.headlineText === '84% in tune',
    `got ${intonation.headlineText}`,
  );
  check('improving against the previous month', intonation.direction === 'improving', `got ${intonation.direction}`);
}

{
  // Audio-only session: pose metrics absent entirely.
  const history = [entry(1, [metric('pitchAccuracy', 80)])];
  const series = buildCategorySeries(history, '4w', NOW);
  const posture = series.find((s) => s.id === 'posture')!;

  check('unmeasured category is flagged, not zeroed', !posture.measured && posture.latestScore === null);
  check('unmeasured category has no points', posture.points.length === 0);
  check('unmeasured category has no band text', posture.bandText === null);
}

{
  const history = [entry(1, [metric('posture', 90, { measurementQuality: 'unavailable' })])];
  const series = buildCategorySeries(history, '4w', NOW);
  const posture = series.find((s) => s.id === 'posture')!;
  check("'unavailable' quality counts as unmeasured", !posture.measured);
}

{
  // vibrato/dynamics have no honest real unit — band only, never a percentage.
  const history = [entry(1, [metric('vibrato', 72), metric('dynamicControl', 65)])];
  const series = buildCategorySeries(history, '4w', NOW);
  const vibrato = series.find((s) => s.id === 'vibrato')!;
  const dynamics = series.find((s) => s.id === 'dynamics')!;

  check('vibrato shows no fabricated percentage', vibrato.headlineText === null);
  check('vibrato falls back to a band', vibrato.bandText === 'solid', `got ${vibrato.bandText}`);
  check('dynamics shows no fabricated percentage', dynamics.headlineText === null);
}

{
  // Entries saved before `headline` existed must not invent a unit either.
  const history = [entry(1, [metric('pitchAccuracy', 84)])];
  const intonation = buildCategorySeries(history, '4w', NOW).find((s) => s.id === 'intonation')!;
  check('missing headline falls back to a band', intonation.headlineText === null && intonation.bandText !== null);
}

{
  const e = entry(1, [
    metric('bowPlacement', 80, { occurrenceRate: 0.1 }),
    metric('bowAngle', 70, { occurrenceRate: 0.3 }),
  ]);
  check('category score averages measured metrics', categoryScore(e, 'bow') === 75);
  check('bow rate derives from real occurrenceRate', Math.abs((categoryRate(e, 'bow') ?? 0) - 0.8) < 1e-9);
}

check('rangeStart is null for all-time', rangeStart('all', NOW) === null);
check('4w range starts 28 days back', rangeStart('4w', NOW) === NOW.getTime() - 28 * DAY);

{
  const series = overallSeries([summary(5), summary(1), summary(9)]);
  check('overall series is sorted oldest-first', series[0].t < series[1].t && series[1].t < series[2].t);
}

// ── stuck issues ────────────────────────────────────────────

console.log('\nStuck issues');

{
  // 8 sessions, newest first. `flat3rd` recurs; `oneOff` appears once.
  const sources = [
    source(0, ['flat3rd']),
    source(1, ['flat3rd', 'bowDrift']),
    source(2, []),
    source(3, ['flat3rd']),
    source(4, ['bowDrift']),
    source(5, ['flat3rd']),
    source(6, ['oneOff']),
    source(7, ['flat3rd', 'bowDrift']),
  ];
  const stuck = stuckIssues(sources, 8, 3);

  check('one-off issues are excluded', !stuck.some((s) => s.evidence.id === 'oneOff'));
  const flat = stuck.find((s) => s.evidence.id === 'flat3rd')!;
  check('recurring issue is found', !!flat);
  check('counts sightings', flat.seenIn === 5, `got ${flat.seenIn}`);
  check('reports the window size', flat.outOf === 8);
  check('presence strip covers the window', flat.presence.length === 8);
  check(
    'presence strip is oldest-first',
    // oldest (7 days ago) had it, third-oldest (5 days ago) had it, 6-days-ago did not
    flat.presence[0] === true && flat.presence[1] === false && flat.presence[2] === true,
    JSON.stringify(flat.presence),
  );
  check('most recurrent ranks first', stuck[0].evidence.id === 'flat3rd');
  check('a 3-sighting issue also qualifies', stuck.some((s) => s.evidence.id === 'bowDrift'));
}

check('no sessions means nothing stuck', stuckIssues([], 8, 3).length === 0);

{
  // Recurred 4 times but not once in the recent window — that is a fix, not a
  // stuck issue, and it must not appear in both sections at once.
  const sources = [
    source(0, ['active']),
    source(1, ['active']),
    source(2, ['active']),
    source(3, ['wasStuck']),
    source(4, ['wasStuck']),
    source(5, ['wasStuck']),
    source(6, ['wasStuck']),
    source(7, []),
  ];
  const stuck = stuckIssues(sources, 8, 3);
  const resolved = resolvedIssues(sources, 3, 8);

  check('a fixed issue is not still stuck', !stuck.some((s) => s.evidence.id === 'wasStuck'));
  check('the active issue is still stuck', stuck.some((s) => s.evidence.id === 'active'));
  check('the fixed issue is reported as resolved', resolved.some((e) => e.id === 'wasStuck'));
  check(
    'no issue is both stuck and resolved',
    !stuck.some((s) => resolved.some((r) => r.id === s.evidence.id)),
  );
}

{
  const sources = [source(0, ['a']), source(1, ['a'])];
  check('below the recurrence floor nothing is stuck', stuckIssues(sources, 8, 3).length === 0);
}

// ── resolved issues ─────────────────────────────────────────

console.log('\nResolved issues');

{
  const sources = [
    source(0, ['current']),
    source(1, ['current']),
    source(2, []),
    source(3, ['fixed', 'current']),
    source(4, ['fixed']),
    source(5, ['fixed']),
    source(6, ['onceOnly']),
  ];
  const resolved = resolvedIssues(sources, 3, 8);

  check('an issue that stopped appearing is resolved', resolved.some((e) => e.id === 'fixed'));
  check('a still-active issue is not resolved', !resolved.some((e) => e.id === 'current'));
  check('a single prior sighting is not a fix', !resolved.some((e) => e.id === 'onceOnly'));
}

{
  // Only two sessions total: absence is far more likely "not measured" than "fixed".
  const sources = [source(0, []), source(1, ['x'])];
  check('too little history claims no fixes', resolvedIssues(sources, 3, 8).length === 0);
}

// ── piece vs global ─────────────────────────────────────────

console.log('\nPiece vs global issues');

{
  const sources = [
    source(0, ['flat3rd', 'hardShift'], 'bach'),
    source(1, ['flat3rd', 'hardShift'], 'bach'),
    source(2, ['flat3rd'], 'vivaldi'),
    source(3, ['flat3rd'], 'vivaldi'),
  ];
  const split = pieceVsGlobalIssues(sources, 'bach');

  check(
    'an issue seen only on this piece is piece-specific',
    split.pieceSpecific.some((e) => e.id === 'hardShift'),
  );
  check(
    'an issue seen elsewhere too is universal',
    split.universal.some((e) => e.id === 'flat3rd'),
  );
  check(
    'each issue lands in exactly one group',
    !split.pieceSpecific.some((e) => split.universal.some((u) => u.id === e.id)),
  );
}

// ── practice calendar ───────────────────────────────────────

console.log('\nPractice calendar');

{
  const weeks = practiceCalendar([summary(0, 600), summary(3, 120)], 4, NOW);
  check('returns the requested number of weeks', weeks.length === 4);
  check('every week has 7 days', weeks.every((w) => w.length === 7));

  const flat = weeks.flat();
  const practised = flat.filter((d) => d.sessions > 0);
  check('practised days are marked', practised.length === 2, `got ${practised.length}`);
  check('minutes are summed', practised.some((d) => d.minutes === 10), JSON.stringify(practised.map((d) => d.minutes)));
  check('a short take still counts as a minute', practised.some((d) => d.minutes === 2));
  check('rest days are zero, not missing', flat.some((d) => d.sessions === 0 && d.minutes === 0));
  check('days run in ascending order', flat.every((d, i) => i === 0 || d.t > flat[i - 1].t));
  check('future days in the current week are flagged', flat.some((d) => d.isFuture));
}

// ── category deltas ─────────────────────────────────────────

console.log('\nCategory deltas (piece detail)');

{
  const attempts = [
    entry(20, [metric('pitchAccuracy', 50), metric('rhythmAccuracy', 80)]),
    entry(18, [metric('pitchAccuracy', 52), metric('rhythmAccuracy', 78)]),
    entry(16, [metric('pitchAccuracy', 54), metric('rhythmAccuracy', 76)]),
    entry(4, [metric('pitchAccuracy', 70), metric('rhythmAccuracy', 70)]),
    entry(2, [metric('pitchAccuracy', 72), metric('rhythmAccuracy', 68)]),
    entry(1, [metric('pitchAccuracy', 74), metric('rhythmAccuracy', 66)]),
  ];
  const deltas = categoryDeltas(attempts, 3);

  const intonation = deltas.find((d) => d.id === 'intonation')!;
  const rhythm = deltas.find((d) => d.id === 'rhythm')!;
  check('improvement is positive', intonation.delta === 20, `got ${intonation.delta}`);
  check('regression is negative', rhythm.delta === -10, `got ${rhythm.delta}`);
  check('sorted best-improved first', deltas[0].id === 'intonation');
  check('unmeasured categories are omitted', !deltas.some((d) => d.id === 'posture'));
}

{
  // 4 attempts with sampleSize 3 would overlap; the sample must shrink to 2.
  const attempts = [
    entry(10, [metric('pitchAccuracy', 40)]),
    entry(9, [metric('pitchAccuracy', 40)]),
    entry(2, [metric('pitchAccuracy', 80)]),
    entry(1, [metric('pitchAccuracy', 80)]),
  ];
  const intonation = categoryDeltas(attempts, 3).find((d) => d.id === 'intonation')!;
  check('samples never overlap', intonation.delta === 40, `got ${intonation.delta}`);
}

check('a single attempt yields no deltas', categoryDeltas([entry(1, [metric('pitchAccuracy', 70)])]).length === 0);

// ── cold start ──────────────────────────────────────────────

console.log('\nCold-start ladder');

check('no sessions', progressStage(0) === 'empty');
check('one session is a baseline', progressStage(1) === 'baseline');
check('two sessions are early', progressStage(2) === 'early');
check('three sessions unlock full trends', progressStage(3) === 'full');

console.log(failures === 0 ? '\nAll progress analytics tests passed.\n' : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
