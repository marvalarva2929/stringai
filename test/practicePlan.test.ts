/**
 * Daily practice plan tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/practicePlan.test.ts
 */

import { computePracticePlan } from '../src/lib/practicePlan';
import { buildSessionEvidence } from '../src/lib/practiceEvidence';
import { nextIncompleteBlock, completedBlockIdsFor, markComplete } from '../src/lib/practiceProgress';
import { evaluatePitchLanding } from '../src/lib/practiceEvaluator';
import type { AnalysisResult, MetricKey, MetricScore, PitchClassIssue } from '../src/types/analysis';
import type { MetricHistoryEntry } from '../src/store/useAnalysisStore';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function metric(key: MetricKey, score: number, observationSummary = ''): MetricScore {
  return {
    key,
    score,
    flaggedTimestamps: [],
    severity: score >= 70 ? 'good' : score >= 50 ? 'needs_attention' : 'critical',
    events: [],
    occurrenceRate: score < 70 ? 0.25 : 0,
    observationSummary,
  };
}

function result(overrides: Partial<AnalysisResult>): AnalysisResult {
  return {
    sessionId: 's1',
    userId: 'u1',
    instrument: 'violin',
    durationSeconds: 60,
    recordedAt: '2026-07-06T12:00:00.000Z',
    overallScore: 70,
    metrics: [metric('pitchAccuracy', 64, 'Pitch accuracy needs work.')],
    audioMetrics: [metric('pitchAccuracy', 64)],
    videoMetrics: [],
    ...overrides,
  } as AnalysisResult;
}

function pitchIssue(overrides: Partial<PitchClassIssue>): PitchClassIssue {
  return {
    pitchClass: 'A4',
    totalNoteEvents: 11,
    outOfTuneCount: 7,
    errorRate: 7 / 11,
    avgDeviationCents: -24,
    tendency: 'flat',
    representativeMidi: 69,
    exampleTimestamps: [{ startSeconds: 4, endSeconds: 4.6 }],
    ...overrides,
  };
}

console.log('practice plan generation');
{
  const plan = computePracticePlan({
    recentSessions: [
      result({
        intonationAnalysis: {
          totalNoteEvents: 20,
          inTuneCount: 12,
          outOfTuneCount: 8,
          inTuneRate: 0.6,
          overallTendency: 'flat',
          tendencyCents: -10,
          problemNotes: [pitchIssue({})],
          observationSummary: 'A4 was often flat.',
          _score: 64,
        },
      }),
    ],
    metricHistory: [],
    playerCategory: 'foundation',
    weeklyGoalMinutes: 30,
    skillLevel: 'beginner',
  });

  check('specific note becomes primary focus', /A4/.test(plan.primaryFocus), plan.primaryFocus);
  check('first block is pitch landing', plan.blocks[0]?.type === 'pitch_landing', plan.blocks[0]?.type);
  check('scale lock is added after note target', plan.blocks.some((b) => b.type === 'scale_lock'));
  check('foundation category uses guided coaching', plan.coachIntensity === 'guided', plan.coachIntensity);
}

console.log('bow gating');
{
  const entry: MetricHistoryEntry = {
    sessionId: 's-bow',
    recordedAt: '2026-07-06T12:00:00.000Z',
    scores: [
      {
        ...metric('bowDistribution', 42, 'Bow distribution unavailable.'),
        measurementQuality: 'unavailable',
      },
    ],
  };
  const plan = computePracticePlan({
    metricHistory: [entry],
    playerCategory: 'refinement',
    weeklyGoalMinutes: 60,
  });

  check('unavailable bow metric does not create bow-control block', !plan.blocks.some((b) => b.type === 'bow_control'));
  check('unavailable bow metric falls back to review/check-in', plan.blocks.some((b) => b.type === 'review'));
  check('high weekly goal uses advanced coaching for refinement', plan.coachIntensity === 'advanced', plan.coachIntensity);
  check('high weekly goal produces longer plan', plan.durationMinutes === 28, String(plan.durationMinutes));
}

console.log('live evaluator');
{
  const evalResult = evaluatePitchLanding(
    [
      { centsDeviation: -18, confidence: 0.9 },
      { centsDeviation: -8, confidence: 0.9 },
      { centsDeviation: 6, confidence: 0.9 },
      { centsDeviation: -4, confidence: 0.9 },
      { centsDeviation: 3, confidence: 0.9 },
    ],
    { centsThreshold: 10, requiredStreak: 4 },
  );
  check('pitch landing requires accurate streak after miss', evalResult.passed);
  check('best streak is tracked', evalResult.bestStreak === 4, String(evalResult.bestStreak));
}

console.log('practice progression');
{
  const plan = computePracticePlan({
    recentSessions: [
      result({
        intonationAnalysis: {
          totalNoteEvents: 20,
          inTuneCount: 12,
          outOfTuneCount: 8,
          inTuneRate: 0.6,
          overallTendency: 'flat',
          tendencyCents: -10,
          problemNotes: [pitchIssue({})],
          observationSummary: 'A4 was often flat.',
          _score: 64,
        },
      }),
    ],
    metricHistory: [],
    playerCategory: 'foundation',
    weeklyGoalMinutes: 30,
  });

  const first = plan.blocks[0];
  const second = plan.blocks[1];
  check('next incomplete is the first block when nothing done', nextIncompleteBlock(plan, [])?.id === first?.id);
  check(
    'next incomplete skips completed blocks',
    nextIncompleteBlock(plan, [first!.id])?.id === second?.id,
    nextIncompleteBlock(plan, [first!.id])?.id,
  );
  check('next incomplete is null when all done', nextIncompleteBlock(plan, plan.blocks.map((b) => b.id)) === null);
  check(
    'unknown plan id has no completions',
    completedBlockIdsFor({ completedByPlan: { 'daily:2026-07-05': ['x'] } }, plan.id).length === 0,
  );
  check(
    'completed ids kept for matching plan id',
    completedBlockIdsFor({ completedByPlan: { [plan.id]: [first!.id] } }, plan.id)[0] === first!.id,
  );
}

// ─────────────────────────────────────────────────────────────
console.log('\nscoped plans: session and piece produce distinct, filtered plans');
{
  const pitchEv = (id: string) => ({ id, kind: 'pitch_note', metricKey: 'pitchAccuracy',
    title: id, reason: '', evidenceSummary: '', priority: 110, confidence: 0.8, supportsLive: true,
    requiresMic: true, requiresCamera: false, measurementAvailable: true, sessionCount: 1,
    target: { metricKey: 'pitchAccuracy' } });
  const bachA = result({ sessionId: 'a', recordedAt: '2026-07-10T00:00:00Z',
    piece: { id: 'bach', title: 'Minuet' } as any, metrics: [metric('pitchAccuracy', 60)],
    sessionEvidence: [pitchEv('pitch_note:G4')] as any });
  const bachB = result({ sessionId: 'b', recordedAt: '2026-07-09T00:00:00Z',
    piece: { id: 'bach', title: 'Minuet' } as any, metrics: [metric('pitchAccuracy', 60)],
    sessionEvidence: [pitchEv('pitch_note:G4')] as any });
  const kreutzer = result({ sessionId: 'c', recordedAt: '2026-07-08T00:00:00Z',
    piece: { id: 'kreutzer', title: 'Etude' } as any, metrics: [metric('pitchAccuracy', 60)],
    sessionEvidence: [pitchEv('pitch_note:B4')] as any });
  const all = [bachA, bachB, kreutzer];
  const base = { metricHistory: [], playerCategory: 'refinement' as const, weeklyGoalMinutes: 45 };

  const daily = computePracticePlan({ recentSessions: all, ...base, scope: { kind: 'daily' } });
  const session = computePracticePlan({ recentSessions: all, ...base, scope: { kind: 'session', sessionId: 'a' } });
  const piece = computePracticePlan({ recentSessions: all, ...base, scope: { kind: 'piece', pieceId: 'bach' } });

  check('daily plan id', daily.id.startsWith('daily:'), daily.id);
  check('session plan id', session.id === 'session:a', session.id);
  check('piece plan id', piece.id === 'piece:bach', piece.id);
  check('distinct ids across scopes so progress never collides',
    new Set([daily.id, session.id, piece.id]).size === 3);

  const cited = (p: typeof daily) => new Set(p.evidence.map((e) => e.id));
  check('session scope sees only session a evidence', cited(session).has('pitch_note:G4') && !cited(session).has('pitch_note:B4'));
  check('piece scope excludes the other piece', cited(piece).has('pitch_note:G4') && !cited(piece).has('pitch_note:B4'));
  check('piece scope merges both bach sessions', piece.evidence.find((e) => e.id === 'pitch_note:G4')?.sessionCount === 2,
    String(piece.evidence.find((e) => e.id === 'pitch_note:G4')?.sessionCount));
}

// ─────────────────────────────────────────────────────────────
console.log('\ncross-restart: plan builds from persisted history evidence alone');
{
  // After an app restart the in-memory rich cache is gone; only metricHistory
  // (with frozen evidence) survives. The plan must still be real, not cold-start.
  const bowEv = { id: 'pattern:bow_zone_camping', kind: 'bow_pattern', metricKey: 'bowDistribution',
    title: 'Bow zone camping', reason: 'camping', evidenceSummary: '', priority: 92, confidence: 0.7,
    supportsLive: true, requiresMic: false, requiresCamera: true, measurementAvailable: true,
    sessionCount: 1, target: { metricKey: 'bowDistribution' } };
  const plan = computePracticePlan({
    recentSessions: [],
    metricHistory: [
      { sessionId: 's0', recordedAt: '2026-07-10T00:00:00Z', scores: [metric('bowDistribution', 55)], evidence: [{ ...bowEv }] as any, pieceId: 'bach' },
      { sessionId: 's1', recordedAt: '2026-07-09T00:00:00Z', scores: [metric('bowDistribution', 55)], evidence: [{ ...bowEv }] as any, pieceId: 'bach' },
    ],
    playerCategory: 'refinement', weeklyGoalMinutes: 45,
  });
  check('history-only plan is not cold-start', !plan.blocks.some((b) => b.id.startsWith('starter:')), plan.blocks.map((b) => b.id).join(','));
  check('recurrence counted from history entries', plan.evidence.find((e) => e.id === 'pattern:bow_zone_camping')?.sessionCount === 2,
    String(plan.evidence.find((e) => e.id === 'pattern:bow_zone_camping')?.sessionCount));
}

// ─────────────────────────────────────────────────────────────
console.log('\ncold start vs clean session');
{
  const cold = computePracticePlan({ recentSessions: [], metricHistory: [], playerCategory: 'foundation', weeklyGoalMinutes: 45 });
  check('no data → cold-start baseline block', cold.blocks.some((b) => b.id.startsWith('starter:')), cold.blocks.map((b) => b.id).join(','));
  check('cold start does NOT show maintenance', !cold.blocks.some((b) => b.id.startsWith('maintenance:')));

  // A session with strong scores and nothing flagged must not be told to "record
  // your first session".
  const clean = computePracticePlan({
    recentSessions: [result({
      overallScore: 92,
      metrics: [metric('pitchAccuracy', 92, 'clean'), metric('toneQuality', 90), metric('rhythmAccuracy', 94)],
      audioMetrics: [metric('pitchAccuracy', 92)],
      intonationAnalysis: { totalNoteEvents: 60, inTuneCount: 58, outOfTuneCount: 2, inTuneRate: 0.97,
        overallTendency: 'neutral', tendencyCents: 1, problemNotes: [], observationSummary: 'clean' } as any,
    })],
    metricHistory: [{ sessionId: 's1', recordedAt: '2026-07-10T12:00:00Z', scores: [metric('pitchAccuracy', 92), metric('toneQuality', 90)] }],
    playerCategory: 'refinement',
    weeklyGoalMinutes: 45,
  });
  check('clean session → maintenance blocks', clean.blocks.some((b) => b.id.startsWith('maintenance:')), clean.blocks.map((b) => b.id).join(','));
  check('clean session shows NO cold-start baseline', !clean.blocks.some((b) => b.id.startsWith('starter:')));
}

// ─────────────────────────────────────────────────────────────
console.log('\nrecurring issue outranks a one-off through the whole plan');
{
  // Two sessions with FROZEN evidence: a bow issue recurs in both; a tone issue
  // appears only in the newest. The recurring one should end up ranked ahead.
  const bowEv = { id: 'pattern:bow_zone_camping', kind: 'bow_pattern', metricKey: 'bowDistribution',
    title: 'Bow zone camping', reason: 'camping', evidenceSummary: '', priority: 92, confidence: 0.7,
    supportsLive: true, requiresMic: false, requiresCamera: true, measurementAvailable: true,
    sessionCount: 1, target: { metricKey: 'bowDistribution' } };
  const toneEv = { id: 'metric:toneQuality', kind: 'tone', metricKey: 'toneQuality',
    title: 'Tone quality', reason: 'thin', evidenceSummary: '', priority: 92, confidence: 0.7,
    supportsLive: true, requiresMic: true, requiresCamera: false, measurementAvailable: true,
    sessionCount: 1, target: { metricKey: 'toneQuality' } };
  const newest = result({ sessionId: 'n', recordedAt: '2026-07-10T00:00:00Z',
    metrics: [metric('bowDistribution', 55), metric('toneQuality', 64)],
    sessionEvidence: [{ ...bowEv }, { ...toneEv }] as any });
  const older = result({ sessionId: 'o', recordedAt: '2026-07-08T00:00:00Z',
    metrics: [metric('bowDistribution', 55)],
    sessionEvidence: [{ ...bowEv }] as any });

  const plan = computePracticePlan({ recentSessions: [newest, older], metricHistory: [],
    playerCategory: 'refinement', weeklyGoalMinutes: 45 });
  const bow = plan.evidence.find((e) => e.id === 'pattern:bow_zone_camping');
  const tone = plan.evidence.find((e) => e.id === 'metric:toneQuality');
  check('recurring bow issue counted across 2 sessions', bow?.sessionCount === 2, String(bow?.sessionCount));
  check('recurring issue outranks equal-base one-off', !!bow && !!tone && bow.rankScore > tone.rankScore,
    `bow=${bow?.rankScore} tone=${tone?.rankScore}`);
}

// ─────────────────────────────────────────────────────────────
console.log('\npersisted sessionEvidence == re-derived (single source of truth)');
{
  const rich = () => result({
    metrics: [metric('pitchAccuracy', 60, 'flat'), metric('bowDistribution', 52, 'frog-heavy')],
    audioMetrics: [metric('pitchAccuracy', 60)],
    videoMetrics: [{ ...metric('bowDistribution', 52), measurementQuality: 'low' }],
    patternFindings: [
      { testId: 'finger_accuracy_gap', fired: true, severity: 'moderate', confidence: 0.67, summary: 'finger 3',
        evidence: { groupA: { label: 'a', value: 1, n: 20 }, groupB: { label: 'b', value: 2, n: 20 }, effectSize: 1 },
        timestamps: [{ startSeconds: 5, endSeconds: 6 }] },
      { testId: 'bow_zone_camping', fired: true, severity: 'moderate', confidence: 0.74, summary: 'camping',
        evidence: { groupA: { label: 'a', value: 1, n: 20 }, groupB: { label: 'b', value: 2, n: 20 }, effectSize: 1 },
        timestamps: [{ startSeconds: 5, endSeconds: 6 }] },
    ] as any,
    intonationAnalysis: {
      totalNoteEvents: 80, inTuneCount: 44, outOfTuneCount: 36, inTuneRate: 0.55,
      overallTendency: 'flat', tendencyCents: -18, problemNotes: [pitchIssue({ pitchClass: 'G4', avgDeviationCents: -55 })],
      observationSummary: 'flat',
    } as any,
  });

  const derivedSession = rich();
  const persistedSession = { ...rich(), sessionEvidence: buildSessionEvidence(rich()) };

  const opts = { metricHistory: [], playerCategory: 'refinement' as const, weeklyGoalMinutes: 45, skillLevel: 'intermediate' as const };
  const planFromDerive = computePracticePlan({ recentSessions: [derivedSession], ...opts });
  const planFromPersist = computePracticePlan({ recentSessions: [persistedSession], ...opts });

  const ids = (p: typeof planFromDerive) => p.blocks.map((b) => `${b.type}:${b.title}`).join(' | ');
  const cited = (p: typeof planFromDerive) => p.blocks.flatMap((b) => b.evidenceRefs.map((r) => r.evidenceId)).sort().join(',');
  check('same blocks whether evidence is persisted or re-derived', ids(planFromDerive) === ids(planFromPersist), `\n    derive:  ${ids(planFromDerive)}\n    persist: ${ids(planFromPersist)}`);
  check('same cited evidence either way', cited(planFromDerive) === cited(planFromPersist));
  check('sessionEvidence actually populated', (persistedSession.sessionEvidence?.length ?? 0) > 0, String(persistedSession.sessionEvidence?.length));
}

// ─────────────────────────────────────────────────────────────
console.log('\nunmeasured evidence never seeds a technique block');
{
  // An empty vibratoAnalysis (notes: []) reports eligibleCount but measured
  // nothing. It must not become a "Custom Vibrato Trainer" on its own.
  const plan = computePracticePlan({
    recentSessions: [
      result({
        metrics: [metric('toneQuality', 64, 'Tone thinned.')],
        audioMetrics: [metric('toneQuality', 64)],
        vibratoAnalysis: { eligibleCount: 6, avgNoteScore: 40, notes: [] } as any,
      }),
    ],
    metricHistory: [],
    playerCategory: 'refinement',
    weeklyGoalMinutes: 45,
  });
  check('no vibrato block from an empty analysis', !plan.blocks.some((b) => b.type === 'vibrato'),
    plan.blocks.map((b) => b.type).join(','));
}

// ─────────────────────────────────────────────────────────────
console.log('\ncorroborating findings fold into one block');
{
  const bowFinding = (testId: string, confidence: number) => ({
    testId, fired: true as const, severity: 'moderate' as const, confidence,
    summary: testId, evidence: { groupA: { label: 'a', value: 1, n: 20 }, groupB: { label: 'b', value: 2, n: 20 }, effectSize: 1 },
    timestamps: [{ startSeconds: 5, endSeconds: 6 }],
  });
  const plan = computePracticePlan({
    recentSessions: [
      result({
        metrics: [metric('bowDistribution', 52, 'Frog-heavy.')],
        audioMetrics: [],
        videoMetrics: [{ ...metric('bowDistribution', 52), measurementQuality: 'low' }],
        patternFindings: [
          bowFinding('bow_zone_camping', 0.74),
          bowFinding('upper_bow_tone_degradation', 0.58),
          bowFinding('tip_dynamic_ceiling', 0.52),
        ],
      }),
    ],
    metricHistory: [],
    playerCategory: 'refinement',
    weeklyGoalMinutes: 45,
  });
  const bow = plan.blocks.find((b) => b.type === 'bow_control');
  const cited = new Set(plan.blocks.flatMap((b) => b.evidenceRefs.map((r) => r.evidenceId)));
  check('one bow block, not three', plan.blocks.filter((b) => b.type === 'bow_control').length === 1);
  check('all three bow findings survive into the plan',
    ['bow_zone_camping', 'upper_bow_tone_degradation', 'tip_dynamic_ceiling'].every((t) => cited.has(`pattern:${t}`)),
    bow ? bow.evidenceRefs.map((r) => r.evidenceId).join(',') : 'no bow block');
}

// ─────────────────────────────────────────────────────────────
console.log('\nprogress is scoped per plan');
{
  // The whole point of keying by plan: a session plan and the daily plan must
  // not erase each other. Under the old single-planId store this was impossible.
  let byPlan: Record<string, string[]> = {};
  byPlan = markComplete(byPlan, 'daily:2026-07-10', 'block-a');
  byPlan = markComplete(byPlan, 'session:abc', 'block-b');
  byPlan = markComplete(byPlan, 'daily:2026-07-10', 'block-c');

  check('daily progress survives a session plan', completedBlockIdsFor({ completedByPlan: byPlan }, 'daily:2026-07-10').join(',') === 'block-a,block-c');
  check('session progress survives the daily plan', completedBlockIdsFor({ completedByPlan: byPlan }, 'session:abc').join(',') === 'block-b');

  const twice = markComplete(byPlan, 'session:abc', 'block-b');
  check('re-marking a block is a no-op', completedBlockIdsFor({ completedByPlan: twice }, 'session:abc').length === 1);

  // Pruning drops least-recently-written plans, never the one just written.
  let many: Record<string, string[]> = {};
  for (let i = 0; i < 5; i++) many = markComplete(many, `plan:${i}`, 'b', 3);
  check('prunes to the cap', Object.keys(many).length === 3, Object.keys(many).join(','));
  check('keeps the most recent plans', Object.keys(many).join(',') === 'plan:2,plan:3,plan:4', Object.keys(many).join(','));

  // Touching an old plan should rescue it from the next prune.
  let touch: Record<string, string[]> = {};
  for (let i = 0; i < 3; i++) touch = markComplete(touch, `plan:${i}`, 'b', 3);
  touch = markComplete(touch, 'plan:0', 'c', 3);
  touch = markComplete(touch, 'plan:9', 'b', 3);
  check('re-touched plan survives pruning', Object.keys(touch).join(',') === 'plan:2,plan:0,plan:9', Object.keys(touch).join(','));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll practice plan checks passed');
