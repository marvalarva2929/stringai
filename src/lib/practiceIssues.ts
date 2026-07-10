import type { AnalysisResult } from '../types/analysis';
import type { MetricHistoryEntry } from '../store/useAnalysisStore';
import type { PracticeEvidence } from './practiceEvidence';
import { buildSessionEvidence } from './practiceEvidence';

// ─────────────────────────────────────────────────────────────
// Issue query layer (Phase 1.2 / 1.4)
//
// One store of frozen per-session evidence ("issues"), three views over it:
//   issuesForSession — this session's issues (results screen, post-session plan)
//   issuesForPiece   — issues across sessions of one piece (pinned-piece warmup)
//   issuesRecent     — issues across the recent window (daily plan)
//
// All three return the SAME PracticeEvidence objects the results screen shows,
// merged with recency decay + a recurrence boost so an issue that keeps coming
// back outranks a one-off, and an issue that stopped appearing (fixed) drops out
// simply by not being in the recent window.
// ─────────────────────────────────────────────────────────────

/** One session's frozen evidence, the atom every view is built from. */
export interface IssueSource {
  sessionId: string;
  recordedAt: string;
  pieceId?: string;
  evidence: PracticeEvidence[];
}

export interface CollectIssueSourcesInput {
  recentSessions?: AnalysisResult[];
  metricHistory?: MetricHistoryEntry[];
}

// Each older session contributes, but a recurring issue should still beat a
// fresh one-off. These constants are deliberately gentle.
const RECURRENCE_BONUS = 10;   // per extra session an issue reappears in (capped)
const MAX_RECURRENCE = 3;      // beyond this many repeats, no further boost
const RECENCY_PENALTY = 6;     // per window slot an issue's newest sighting is old

/**
 * Gather one IssueSource per session, newest-first, deduped by sessionId.
 * Prefers a rich AnalysisResult's frozen `sessionEvidence`, then a
 * MetricHistoryEntry's persisted `evidence`, then re-derives from a rich
 * session as a last resort (old sessions saved before evidence was frozen).
 * Sessions with no recoverable evidence are skipped.
 */
export function collectIssueSources(input: CollectIssueSourcesInput): IssueSource[] {
  const byId = new Map<string, IssueSource>();

  for (const session of input.recentSessions ?? []) {
    if (byId.has(session.sessionId)) continue;
    const evidence = session.sessionEvidence ?? buildSessionEvidence(session);
    if (evidence.length === 0) continue;
    byId.set(session.sessionId, {
      sessionId: session.sessionId,
      recordedAt: session.recordedAt,
      pieceId: session.piece?.id,
      evidence,
    });
  }

  for (const entry of input.metricHistory ?? []) {
    if (byId.has(entry.sessionId) || !entry.evidence?.length) continue;
    byId.set(entry.sessionId, {
      sessionId: entry.sessionId,
      recordedAt: entry.recordedAt,
      pieceId: entry.pieceId,
      evidence: entry.evidence,
    });
  }

  return [...byId.values()].sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
  );
}

/** Issues for exactly one session, untouched (no merge — it is a single source). */
export function issuesForSession(sources: IssueSource[], sessionId: string): PracticeEvidence[] {
  return sources.find((s) => s.sessionId === sessionId)?.evidence ?? [];
}

/**
 * Merge issues across a list of sources (already newest-first). An issue's
 * priority gains a bonus for each session it recurs in and loses a penalty for
 * how many slots back its most recent sighting is. The representative object is
 * the most recent occurrence, with `sessionCount` set to the recurrence count.
 */
export function mergeIssues(sources: IssueSource[]): PracticeEvidence[] {
  interface Agg { newestIndex: number; count: number; base: PracticeEvidence }
  const agg = new Map<string, Agg>();

  sources.forEach((source, index) => {
    for (const evidence of source.evidence) {
      const existing = agg.get(evidence.id);
      if (!existing) {
        agg.set(evidence.id, { newestIndex: index, count: 1, base: evidence });
      } else {
        existing.count += 1;
        // `sources` is newest-first, so the first sighting is already the newest.
      }
    }
  });

  return [...agg.values()]
    .map(({ newestIndex, count, base }) => {
      const recurrence = RECURRENCE_BONUS * Math.min(count - 1, MAX_RECURRENCE);
      const recency = RECENCY_PENALTY * newestIndex;
      return {
        ...base,
        sessionCount: count,
        priority: Math.max(0, base.priority + recurrence - recency),
      };
    })
    .sort((a, b) => b.priority * b.confidence - a.priority * a.confidence);
}

/** Issues across every session that practiced `pieceId`, within the window. */
export function issuesForPiece(
  sources: IssueSource[],
  pieceId: string,
  window = 5,
): PracticeEvidence[] {
  return mergeIssues(sources.filter((s) => s.pieceId === pieceId).slice(0, window));
}

/** Issues across the recent window regardless of piece (the daily plan). */
export function issuesRecent(sources: IssueSource[], window = 5): PracticeEvidence[] {
  return mergeIssues(sources.slice(0, window));
}
