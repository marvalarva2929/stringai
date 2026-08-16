/**
 * Activation sample-analysis fixture tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/demoAnalysis.test.ts
 *   (or: npm run test:demo)
 *
 * The demo is the first thing a user without their violin sees, and it has to
 * survive every card of the results carousel without hitting an empty state.
 * These are the invariants that would silently rot if a metric were renamed, a
 * category added, or a score nudged: a blank card wouldn't crash anything, it
 * would just quietly teach the user that the feature is hollow.
 */

import { DEMO_ANALYSIS, DEMO_NOTE_EVENTS, DEMO_SESSION_ID } from '../src/constants/demoAnalysis';
import { CATEGORIES } from '../src/constants/categories';
import { computeOverallScore, activeScoreWeights, HIDDEN_SCORE_KEYS } from '../src/lib/scoring';
import { INSTRUMENTS } from '../src/constants/instruments';
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

console.log('\nIdentity');

check('is flagged as a demo', DEMO_ANALYSIS.isDemo === true);
check('uses the shared demo session id', DEMO_ANALYSIS.sessionId === DEMO_SESSION_ID);
check(
  'carries no video uri — the placeholder is the point',
  DEMO_ANALYSIS.videoUri === undefined,
);
check('names a piece', !!DEMO_ANALYSIS.piece?.title);

console.log('\nEvery carousel card has content');

for (const category of CATEGORIES) {
  const scored = category.keys.filter((key) =>
    DEMO_ANALYSIS.metrics.some(
      (m) => m.key === key && m.measurementQuality !== 'unavailable',
    ),
  );
  check(`${category.label} resolves to a scored metric`, scored.length > 0);
}

check(
  'every metric carries a user-facing observation',
  DEMO_ANALYSIS.metrics.every((m) => m.observationSummary.trim().length > 0),
);

check(
  'severity bands agree with the scores',
  DEMO_ANALYSIS.metrics.every((m) => m.severity === severityFromScore(m.score)),
);

check(
  'metrics is exactly audioMetrics + videoMetrics',
  DEMO_ANALYSIS.metrics.length ===
    DEMO_ANALYSIS.audioMetrics.length + DEMO_ANALYSIS.videoMetrics.length,
);

console.log('\nPer-domain analyses are populated');

check('intonation has problem notes', (DEMO_ANALYSIS.intonationAnalysis?.problemNotes.length ?? 0) > 0);
check('stability has worst notes', (DEMO_ANALYSIS.intonationStabilityAnalysis?.worstNotes.length ?? 0) > 0);
check('vibrato has assessed notes', (DEMO_ANALYSIS.vibratoAnalysis?.notes.length ?? 0) > 0);
check('rhythm has a flagged region', (DEMO_ANALYSIS.rhythmAnalysis?.flaggedRegions.length ?? 0) > 0);
check('there is a coach take', !!DEMO_ANALYSIS.llmFeedback?.overallTake);
check('coaching names at least three items', (DEMO_ANALYSIS.llmFeedback?.items.length ?? 0) >= 3);
check('there is a session assessment', !!DEMO_ANALYSIS.sessionAssessment);

console.log('\nThe practice plan has something to build from');

const evidence = DEMO_ANALYSIS.sessionEvidence ?? [];
check('evidence is non-empty', evidence.length > 0);
check('every issue is measurable', evidence.every((e) => e.measurementAvailable));
check('every issue names a metric', evidence.every((e) => !!e.metricKey));
check(
  'evidence points back at this session',
  evidence.every((e) => e.sourceSessionId === DEMO_SESSION_ID),
);
check(
  'priorities are distinct so the ordering is deterministic',
  new Set(evidence.map((e) => e.priority)).size === evidence.length,
);

console.log('\nNote events');

check('there are enough notes to fill a timeline', DEMO_NOTE_EVENTS.length >= 30);

check(
  'starts are monotonic',
  DEMO_NOTE_EVENTS.every((n, i) => i === 0 || n.startSeconds >= DEMO_NOTE_EVENTS[i - 1].startSeconds),
);

check(
  'no note ends before it starts',
  DEMO_NOTE_EVENTS.every((n) => n.endSeconds > n.startSeconds),
);

check(
  'no note overlaps the one after it',
  DEMO_NOTE_EVENTS.every((n, i) => i === 0 || n.startSeconds >= DEMO_NOTE_EVENTS[i - 1].endSeconds),
);

check(
  'every note fits inside the session duration',
  DEMO_NOTE_EVENTS.every((n) => n.endSeconds <= DEMO_ANALYSIS.durationSeconds),
  `last note ends at ${DEMO_NOTE_EVENTS[DEMO_NOTE_EVENTS.length - 1].endSeconds}, duration ${DEMO_ANALYSIS.durationSeconds}`,
);

check(
  'inTune agrees with the 25-cent threshold',
  DEMO_NOTE_EVENTS.every((n) => n.inTune === (Math.abs(n.centsDeviation) <= 25)),
);

check(
  'absCentsDeviation matches centsDeviation',
  DEMO_NOTE_EVENTS.every((n) => n.absCentsDeviation === Math.abs(n.centsDeviation)),
);

check(
  'open strings are played in tune — the fault is a fingered one',
  DEMO_NOTE_EVENTS.filter((n) => n.inferredFinger === 0).every((n) => n.inTune),
);

check(
  'the headline fault is real: every G is out of tune',
  DEMO_NOTE_EVENTS.filter((n) => n.noteName === 'G4').every((n) => !n.inTune),
);

console.log('\nIntonation totals agree with the notes');

const intonation = DEMO_ANALYSIS.intonationAnalysis!;
const actualInTune = DEMO_NOTE_EVENTS.filter((n) => n.inTune).length;
check('totalNoteEvents matches', intonation.totalNoteEvents === DEMO_NOTE_EVENTS.length);
check('inTuneCount matches', intonation.inTuneCount === actualInTune, `expected ${actualInTune}`);
check(
  'inTuneCount + outOfTuneCount is the whole session',
  intonation.inTuneCount + intonation.outOfTuneCount === DEMO_NOTE_EVENTS.length,
);
check(
  'inTuneRate is consistent to within rounding',
  Math.abs(intonation.inTuneRate - actualInTune / DEMO_NOTE_EVENTS.length) < 0.01,
);

console.log('\nOverall score');

// The demo is authored as a beginner's session, which is also the fallback
// skill level in app/(tabs)/analyze.tsx when no profile is loaded.
const weights = activeScoreWeights(INSTRUMENTS.violin.skillWeights.beginner);
const recomputed = computeOverallScore(
  DEMO_ANALYSIS.audioMetrics,
  DEMO_ANALYSIS.videoMetrics,
  weights,
);

check(
  'declared overallScore matches computeOverallScore',
  recomputed === DEMO_ANALYSIS.overallScore,
  `computed ${recomputed}, declared ${DEMO_ANALYSIS.overallScore}`,
);

check(
  'the unreliable bow/posture keys really are excluded',
  Object.keys(weights).every((k) => !HIDDEN_SCORE_KEYS.has(k)),
);

check(
  'the score is flawed enough to justify practising',
  DEMO_ANALYSIS.overallScore > 50 && DEMO_ANALYSIS.overallScore < 85,
  `got ${DEMO_ANALYSIS.overallScore}`,
);

console.log(
  failures === 0 ? '\nAll demo analysis tests passed.\n' : `\n${failures} failure(s).\n`,
);
process.exit(failures === 0 ? 0 : 1);
