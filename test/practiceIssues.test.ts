/**
 * Issue query layer tests (Phase 1.2 / 1.4).
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/practiceIssues.test.ts
 */

import {
  collectIssueSources,
  issuesForSession,
  issuesForPiece,
  issuesRecent,
  type IssueSource,
} from '../src/lib/practiceIssues';
import { EVIDENCE_VERSION, type PracticeEvidence } from '../src/lib/practiceEvidence';
import type { AnalysisResult, MetricScore } from '../src/types/analysis';
import type { MetricHistoryEntry } from '../src/store/useAnalysisStore';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function ev(id: string, priority: number, over: Partial<PracticeEvidence> = {}): PracticeEvidence {
  return {
    id, kind: 'pitch_note', metricKey: 'pitchAccuracy', title: id, reason: '', evidenceSummary: '',
    priority, confidence: 0.8, supportsLive: true, requiresMic: true, requiresCamera: false,
    measurementAvailable: true, sessionCount: 1, target: { metricKey: 'pitchAccuracy' }, ...over,
  };
}
function source(sessionId: string, recordedAt: string, evidence: PracticeEvidence[], pieceId?: string): IssueSource {
  return { sessionId, recordedAt, pieceId, evidence };
}

// ─────────────────────────────────────────────────────────────
console.log('collectIssueSources');
{
  const richScore: MetricScore = {
    key: 'pitchAccuracy', score: 60, flaggedTimestamps: [], severity: 'critical',
    events: [], occurrenceRate: 0, observationSummary: '', measurementQuality: 'high',
  };
  const rich: AnalysisResult = {
    sessionId: 'rich-1', userId: 'u', instrument: 'violin', durationSeconds: 60,
    recordedAt: '2026-07-10T00:00:00Z', overallScore: 60,
    metrics: [richScore], audioMetrics: [richScore], videoMetrics: [],
    sessionEvidence: [ev('pitch_note:G4', 120)],
    // Stamped current: frozen evidence is trusted as-is. Without the stamp it
    // would be treated as predating the current analysis and recomputed, which
    // is what stops an old session serving findings now known to be wrong.
    evidenceVersion: EVIDENCE_VERSION,
  } as AnalysisResult;

  const history: MetricHistoryEntry[] = [
    { sessionId: 'rich-1', recordedAt: '2026-07-10T00:00:00Z', scores: [richScore], evidence: [ev('should-not-win', 999)], evidenceVersion: EVIDENCE_VERSION },
    { sessionId: 'hist-2', recordedAt: '2026-07-09T00:00:00Z', scores: [richScore], evidence: [ev('pattern:bow_zone_camping', 98)], pieceId: 'p1', evidenceVersion: EVIDENCE_VERSION },
    { sessionId: 'hist-old', recordedAt: '2026-07-01T00:00:00Z', scores: [richScore] }, // no evidence → skipped
  ];

  const sources = collectIssueSources({ recentSessions: [rich], metricHistory: history });
  check('one source per session id', sources.length === 2, String(sources.length));
  check('rich session wins over history entry for same id', sources[0].evidence[0].id === 'pitch_note:G4');

  // An unstamped rich session predates versioning, so its frozen findings are
  // recomputed rather than trusted — the fix for stale crossing labels.
  const unstamped = collectIssueSources({
    recentSessions: [{ ...rich, evidenceVersion: undefined } as AnalysisResult],
    metricHistory: [],
  });
  check('unstamped rich evidence is recomputed, not served',
    !unstamped[0]?.evidence.some((e) => e.id === 'pitch_note:G4'),
    JSON.stringify(unstamped[0]?.evidence.map((e) => e.id)));
  check('history-only session included', sources.some((s) => s.sessionId === 'hist-2'));
  check('evidence-less entry skipped', !sources.some((s) => s.sessionId === 'hist-old'));
  check('newest source first', sources[0].sessionId === 'rich-1');
  check('pieceId carried from history', sources.find((s) => s.sessionId === 'hist-2')?.pieceId === 'p1');
}

// ─────────────────────────────────────────────────────────────
console.log('\nissuesForSession is the raw single-session set');
{
  const sources = [source('s1', '2026-07-10T00:00:00Z', [ev('a', 100), ev('b', 90)])];
  check('returns that session evidence', issuesForSession(sources, 's1').length === 2);
  check('unknown session → empty', issuesForSession(sources, 'nope').length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('\nmerge: recurrence boosts, recency decays');
{
  // A recurs in all 3 sessions; B is a fresh one-off (newest only); C is stale
  // (only in the oldest). Same base priority, so ordering must come from merge.
  const sources = [
    source('s0', '2026-07-10T00:00:00Z', [ev('A', 80), ev('B', 80)]),
    source('s1', '2026-07-09T00:00:00Z', [ev('A', 80)]),
    source('s2', '2026-07-08T00:00:00Z', [ev('A', 80), ev('C', 80)]),
  ];
  const merged = issuesRecent(sources);
  const order = merged.map((e) => e.id);
  check('recurring issue ranks first', order[0] === 'A', order.join(','));
  check('fresh one-off beats stale one-off', order.indexOf('B') < order.indexOf('C'), order.join(','));
  const a = merged.find((e) => e.id === 'A')!;
  check('recurring issue reports its session count', a.sessionCount === 3, String(a.sessionCount));
  check('recurring issue priority boosted above base', a.priority > 80, String(a.priority));
  const c = merged.find((e) => e.id === 'C')!;
  check('stale issue penalised below base', c.priority < 80, String(c.priority));
}

// ─────────────────────────────────────────────────────────────
console.log('\nissuesForPiece scopes to the piece');
{
  const sources = [
    source('s0', '2026-07-10T00:00:00Z', [ev('bach-issue', 100)], 'bach'),
    source('s1', '2026-07-09T00:00:00Z', [ev('scales-issue', 100)], 'scales'),
    source('s2', '2026-07-08T00:00:00Z', [ev('bach-issue', 100)], 'bach'),
  ];
  const bach = issuesForPiece(sources, 'bach');
  check('only bach issues returned', bach.length === 1 && bach[0].id === 'bach-issue', bach.map((e) => e.id).join(','));
  check('bach issue counted across 2 sessions', bach[0].sessionCount === 2, String(bach[0].sessionCount));
  check('unknown piece → empty', issuesForPiece(sources, 'nope').length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log('\ndedup: same session in rich cache and history counts once');
{
  const shared = [ev('pattern:finger_accuracy_gap', 100)];
  const rich: AnalysisResult = {
    sessionId: 'dup', userId: 'u', instrument: 'violin', durationSeconds: 60,
    recordedAt: '2026-07-10T00:00:00Z', overallScore: 60,
    metrics: [], audioMetrics: [], videoMetrics: [], sessionEvidence: shared,
  } as AnalysisResult;
  const history: MetricHistoryEntry[] = [{ sessionId: 'dup', recordedAt: '2026-07-10T00:00:00Z', scores: [], evidence: shared }];
  const sources = collectIssueSources({ recentSessions: [rich], metricHistory: history });
  check('one source for a session present in both', sources.length === 1, String(sources.length));
  check('recurrence count is 1, not 2', issuesRecent(sources)[0].sessionCount === 1, String(issuesRecent(sources)[0].sessionCount));
}

// ─────────────────────────────────────────────────────────────
console.log('\nwindow truncation caps recurrence');
{
  const sources = Array.from({ length: 8 }, (_, i) =>
    source(`s${i}`, `2026-07-${String(20 - i).padStart(2, '0')}T00:00:00Z`, [ev('X', 80)]));
  check('an issue is counted at most `window` times', issuesRecent(sources, 5)[0].sessionCount === 5, String(issuesRecent(sources, 5)[0].sessionCount));
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('All issue query checks passed');
