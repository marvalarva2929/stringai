/**
 * Issue timeline tests — "did the practice help?" must never overclaim.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/issueTimeline.test.ts
 */

import { buildIssueTimeline, measurementOf, VERDICT_LABEL } from '../src/lib/issueTimeline';
import { recordAttempt, tallyAttempts, attemptsForIssue, MAX_TRACKED_ATTEMPTS, type PracticeAttempt } from '../src/lib/practiceAttempts';
import type { IssueSource } from '../src/lib/practiceIssues';
import type { PracticeEvidence } from '../src/lib/practiceEvidence';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function evidence(id: string, summary: string): PracticeEvidence {
  return {
    id,
    kind: 'figure_crossing',
    metricKey: 'pitchAccuracy',
    title: 'D→A crossings',
    reason: 'At 0:42 you crossed D→A and drifted flat.',
    evidenceSummary: summary,
    priority: 110,
    confidence: 0.8,
    supportsLive: true,
    requiresMic: true,
    requiresCamera: false,
    measurementAvailable: true,
    sessionCount: 1,
    target: { metricKey: 'pitchAccuracy', startSeconds: 42 },
  };
}

/** Sources are newest-first, matching collectIssueSources. */
function sources(rows: { day: number; summaries: [string, string][] }[]): IssueSource[] {
  return rows
    .map(({ day, summaries }) => ({
      sessionId: `s-${day}`,
      recordedAt: `2026-08-${String(day).padStart(2, '0')}T10:00:00.000Z`,
      pieceId: 'p1',
      evidence: summaries.map(([id, summary]) => evidence(id, summary)),
    }))
    .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
}

function attempt(day: number, over: Partial<PracticeAttempt> = {}): PracticeAttempt {
  return {
    at: `2026-08-${String(day).padStart(2, '0')}T18:00:00.000Z`,
    planId: `session:s-${day}`,
    blockId: 'crossing_wave:figure_crossing:A-D',
    blockType: 'crossing_wave',
    blockTitle: 'D→A crossing wave',
    issueIds: ['figure_crossing:A-D'],
    pieceId: 'p1',
    passed: true,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────
console.log('measurementOf');
{
  check('reads cents', measurementOf(evidence('x', 'average 24¢ flat, 30% in tune.'))?.value === 24);
  check('reads cents spelled out', measurementOf(evidence('x', 'drift 18 cents'))?.unit === '¢');
  check('reads a miss rate', measurementOf(evidence('x', '40% miss rate, average 12 cents flat.'))?.value === 40);
  // An internal 0-100 score is never shown to players, so it must not be
  // dressed up as a measurement.
  check('refuses an internal score', measurementOf(evidence('x', 'Recent score 62; severity critical.')) === null);
  check('refuses when there is no number', measurementOf(evidence('x', 'Bow tracking was unavailable.')) === null);
}

// ─────────────────────────────────────────────────────────────
console.log('practiceAttempts');
{
  const log = [attempt(1), attempt(3), attempt(3, { passed: false })];
  const tally = tallyAttempts(log);
  check('counts every take', tally.total === 3);
  check('counts passes only', tally.passed === 2, String(tally.passed));
  check('counts distinct days, not takes', tally.days === 2, String(tally.days));

  check('filters by issue', attemptsForIssue(log, 'figure_crossing:A-D').length === 3);
  check('unrelated issue has no attempts', attemptsForIssue(log, 'other').length === 0);

  const appended = recordAttempt(log, attempt(5));
  check('newest first', appended[0].at.includes('-05'));
  check('append-only, retakes are separate entries', appended.length === 4);

  const overflowing = Array.from({ length: MAX_TRACKED_ATTEMPTS + 10 }, () => attempt(1));
  check('trims to the cap', recordAttempt(overflowing, attempt(2)).length === MAX_TRACKED_ATTEMPTS);
}

// ─────────────────────────────────────────────────────────────
console.log('improving');
{
  const timeline = buildIssueTimeline({
    sources: sources([
      { day: 1, summaries: [['figure_crossing:A-D', 'average 24¢ flat, 30% in tune.']] },
      { day: 3, summaries: [['figure_crossing:A-D', 'average 18¢ flat, 45% in tune.']] },
      { day: 5, summaries: [['figure_crossing:A-D', 'average 13¢ flat, 60% in tune.']] },
      { day: 8, summaries: [['figure_crossing:A-D', 'average 9¢ flat, 78% in tune.']] },
    ]),
    attempts: [attempt(2), attempt(4), attempt(6), attempt(7, { passed: false })],
    pieceId: 'p1',
  });

  const entry = timeline[0];
  check('one entry for one issue', timeline.length === 1, String(timeline.length));
  check('verdict is improving', entry?.verdict === 'improving', entry?.verdict);
  check('summary states the span', entry?.summary.includes('24¢ → 9¢') === true, entry?.summary);
  check('summary does not claim the drill caused it',
    !/because|thanks to|your practice (fixed|worked)/i.test(entry?.summary ?? ''), entry?.summary);
  check('presence is oldest-first and complete',
    entry?.presence.join(',') === 'true,true,true,true', entry?.presence.join(','));
  check('first seen is the oldest session', entry?.firstSeen.includes('-01') === true, entry?.firstSeen);
  check('names the exercise that was prescribed',
    entry?.exercises[0] === 'D→A crossing wave', JSON.stringify(entry?.exercises));
  check('reports the work separately from the trend',
    entry?.practice.total === 4 && entry?.practice.passed === 3, JSON.stringify(entry?.practice));
  check('measurements carry a unit', entry?.unit === '¢');
}

// ─────────────────────────────────────────────────────────────
console.log('stuck');
{
  const timeline = buildIssueTimeline({
    sources: sources([
      { day: 1, summaries: [['figure_crossing:A-D', 'average 22¢ flat, 30% in tune.']] },
      { day: 3, summaries: [['figure_crossing:A-D', 'average 23¢ flat, 31% in tune.']] },
      { day: 5, summaries: [['figure_crossing:A-D', 'average 21¢ flat, 33% in tune.']] },
    ]),
    attempts: [attempt(2), attempt(4)],
    pieceId: 'p1',
  });
  check('flat measurement reads stuck', timeline[0]?.verdict === 'stuck', timeline[0]?.verdict);
  check('stuck summary is honest, not encouraging',
    timeline[0]?.summary.includes('Not moving yet') === true, timeline[0]?.summary);
}

// ─────────────────────────────────────────────────────────────
console.log('fixed');
{
  const timeline = buildIssueTimeline({
    sources: sources([
      { day: 1, summaries: [['figure_crossing:A-D', 'average 26¢ flat, 20% in tune.']] },
      { day: 3, summaries: [['figure_crossing:A-D', 'average 20¢ flat, 35% in tune.']] },
      { day: 5, summaries: [['other:issue', 'average 8¢ flat, 80% in tune.']] },
      { day: 8, summaries: [['other:issue', 'average 7¢ flat, 82% in tune.']] },
    ]),
    attempts: [attempt(4), attempt(6)],
    pieceId: 'p1',
  });
  const crossing = timeline.find((e) => e.issueId === 'figure_crossing:A-D');
  check('an issue that stopped appearing reads fixed', crossing?.verdict === 'fixed', crossing?.verdict);
  check('fixed entry records when it was last seen',
    crossing?.lastSeen?.includes('-03') === true, crossing?.lastSeen ?? 'null');
  check('presence shows the run of clear takes',
    crossing?.presence.join(',') === 'true,true,false,false', crossing?.presence.join(','));
}

// ─────────────────────────────────────────────────────────────
console.log('too new to call');
{
  const timeline = buildIssueTimeline({
    sources: sources([
      { day: 8, summaries: [['figure_crossing:A-D', 'average 24¢ flat, 30% in tune.']] },
    ]),
    attempts: [],
    pieceId: 'p1',
  });
  check('a single sighting makes no claim', timeline[0]?.verdict === 'new', timeline[0]?.verdict);
  check('no measurement line from one point', timeline[0]?.measurements === null);
  check('says so plainly', timeline[0]?.summary.includes('Too new to call') === true);
  check('reports no practice rather than pretending', timeline[0]?.practice.total === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('scoping and safety');
{
  const mixed: IssueSource[] = [
    ...sources([{ day: 5, summaries: [['figure_crossing:A-D', 'average 12¢ flat, 60% in tune.']] }]),
    {
      sessionId: 'other-piece',
      recordedAt: '2026-08-04T10:00:00.000Z',
      pieceId: 'p2',
      evidence: [evidence('figure_crossing:A-D', 'average 40¢ flat, 10% in tune.')],
    },
  ];
  const timeline = buildIssueTimeline({
    sources: mixed,
    attempts: [attempt(3), attempt(3, { pieceId: 'p2', blockTitle: 'Other piece drill' })],
    pieceId: 'p1',
  });
  check('another piece does not pollute the trend',
    timeline[0]?.presence.length === 1, String(timeline[0]?.presence.length));
  check('another piece\'s practice is not counted',
    timeline[0]?.practice.total === 1, String(timeline[0]?.practice.total));

  check('a piece with no sessions is empty',
    buildIssueTimeline({ sources: [], attempts: [], pieceId: 'p1' }).length === 0);
  check('every verdict has a label',
    (['new', 'improving', 'stuck', 'fixed'] as const).every((v) => VERDICT_LABEL[v].length > 0));
}

// ─────────────────────────────────────────────────────────────
console.log('ordering');
{
  const timeline = buildIssueTimeline({
    sources: sources([
      { day: 1, summaries: [['a', 'average 20¢ flat.'], ['b', 'average 20¢ flat.']] },
      { day: 3, summaries: [['a', 'average 18¢ flat.'], ['b', 'average 18¢ flat.']] },
    ]),
    attempts: [
      attempt(2, { issueIds: ['b'], blockTitle: 'B drill' }),
      attempt(2, { issueIds: ['b'], blockTitle: 'B drill' }),
      attempt(2, { issueIds: ['a'], blockTitle: 'A drill' }),
    ],
    pieceId: 'p1',
  });
  check('the most-practised issue leads', timeline[0]?.issueId === 'b', timeline[0]?.issueId);
}

console.log(failures === 0 ? '\nAll issue timeline tests passed.' : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
