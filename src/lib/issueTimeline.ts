import type { IssueSource } from './practiceIssues';
import type { PracticeEvidence } from './practiceEvidence';
import type { PracticeAttempt } from './practiceAttempts';
import { attemptsForIssue, tallyAttempts, type AttemptTally } from './practiceAttempts';
import { directionFromDelta, type TrendDirection, type TrendPoint } from './progressAnalytics';

// ─────────────────────────────────────────────────────────────
// "Did it actually help?"
//
// Act three of the story, and the only part the app could not previously tell.
// For one piece, for one issue: when it first showed up, which drill was
// prescribed, how much work went in, and what the measurement did over the
// sessions since.
//
// The honesty rule this module exists to enforce: an issue that improved while
// the player did the drill is evidence, not proof, and the verdict wording has
// to survive that distinction. So the verdict describes the *measurement*
// ('improving', 'stuck', 'fixed'), and the practice tally is reported beside it
// as a separate fact rather than folded in as a cause.
// ─────────────────────────────────────────────────────────────

export type IssueVerdict = 'new' | 'improving' | 'stuck' | 'fixed';

export interface IssueTimelineEntry {
  /** Content-based, timestamp-free — the join key. See musicalMoments.ts. */
  issueId: string;
  /** Most recent occurrence, for its title and copy. */
  evidence: PracticeEvidence;
  /** ISO date it was first seen in this piece. */
  firstSeen: string;
  /** ISO date it was last seen, or null once it stopped appearing. */
  lastSeen: string | null;
  /** Oldest-first, one per examined session: did it appear? */
  presence: boolean[];
  /** Session dates aligned with `presence`. */
  sessionDates: string[];
  /**
   * The issue's own measurement over time, oldest-first, when the evidence
   * carries a comparable number. Absent for issues whose severity is only a
   * qualitative band — see the CATEGORY_UNITS honesty constraint.
   */
  measurements: TrendPoint[] | null;
  /** Unit for `measurements`, e.g. '¢'. Null when there is nothing to show. */
  unit: string | null;
  /** Drill titles prescribed for this issue, most recent first. */
  exercises: string[];
  practice: AttemptTally;
  verdict: IssueVerdict;
  /** One line stating what the measurement did. Never claims causation. */
  summary: string;
}

/** Sessions of a piece to look back over. */
const DEFAULT_WINDOW = 8;
/** Consecutive recent sessions without a sighting before calling it fixed. */
const CLEAR_RUN_FOR_FIXED = 2;
/** Cents of improvement before the trend is called, not noise. */
const CENTS_DEAD_BAND = 4;

/**
 * The comparable number behind an issue, when one exists.
 *
 * Only pulled from `evidenceSummary` strings that a dedicated evidence builder
 * wrote with real units. A metric-fallback issue's "score 62" is an internal
 * 0-100 number that is never shown to players, so it deliberately yields null
 * rather than being dressed up as a measurement.
 */
export function measurementOf(evidence: PracticeEvidence): { value: number; unit: string } | null {
  // Miss rate first, and deliberately: a pitch issue's summary carries both
  // ("40% miss rate, average 12 cents flat") and they can move in opposite
  // directions — a player who stops missing the note entirely can still average
  // the same deviation on the few they do miss. How often it goes wrong is the
  // question "did it get better?" is actually asking.
  const pct = /(\d+(?:\.\d+)?)%\s*miss rate/i.exec(evidence.evidenceSummary);
  if (pct) return { value: Number(pct[1]), unit: '%' };
  const cents = /(\d+(?:\.\d+)?)\s*(?:¢|cents)/i.exec(evidence.evidenceSummary);
  if (cents) return { value: Number(cents[1]), unit: '¢' };
  return null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function verdictFor(
  presence: boolean[],
  measurements: TrendPoint[] | null,
): IssueVerdict {
  if (presence.length === 0) return 'new';
  const recent = presence.slice(-CLEAR_RUN_FOR_FIXED);
  if (recent.length === CLEAR_RUN_FOR_FIXED && recent.every((seen) => !seen)) return 'fixed';
  // A single sighting is not yet a trend either way.
  if (presence.filter(Boolean).length <= 1) return 'new';

  if (measurements && measurements.length >= 2) {
    const first = measurements[0].value;
    const last = measurements[measurements.length - 1].value;
    // Lower is better for every unit here (cents off, miss rate), so a positive
    // delta means the number came down.
    const direction = directionFromDelta(first - last, CENTS_DEAD_BAND);
    if (direction === 'improving') return 'improving';
    if (direction === 'slipping') return 'stuck';
  }
  return 'stuck';
}

function summaryFor(
  verdict: IssueVerdict,
  measurements: TrendPoint[] | null,
  unit: string | null,
): string {
  const first = measurements?.[0]?.value;
  const last = measurements?.[measurements.length - 1]?.value;
  const span = first != null && last != null && unit
    ? `${Math.round(first)}${unit} → ${Math.round(last)}${unit}`
    : null;

  switch (verdict) {
    case 'fixed':
      return span
        ? `Hasn't come back in your last few takes of this piece — it was ${span} before it stopped appearing.`
        : "Hasn't come back in your last few takes of this piece.";
    case 'improving':
      return span
        ? `Still showing up, but measurably closer: ${span}.`
        : 'Still showing up, but less often than it was.';
    case 'stuck':
      return span
        ? `Not moving yet — ${span} across these sessions.`
        : 'Still showing up at about the same rate.';
    case 'new':
    default:
      return 'Too new to call — play this piece again and the trend will fill in.';
  }
}

export interface BuildIssueTimelineInput {
  /** Per-session frozen evidence, newest-first (see collectIssueSources). */
  sources: IssueSource[];
  attempts: PracticeAttempt[];
  pieceId: string;
  window?: number;
}

/**
 * One entry per issue this piece has produced, most-worked-on first.
 *
 * Scoped to a single piece because that is the only scope in which "it got
 * better" means anything — the same passage, played again, measured again.
 */
export function buildIssueTimeline(input: BuildIssueTimelineInput): IssueTimelineEntry[] {
  const window = input.window ?? DEFAULT_WINDOW;
  const pieceSources = input.sources.filter((s) => s.pieceId === input.pieceId).slice(0, window);
  if (pieceSources.length === 0) return [];

  // Oldest-first so every strip and trend reads left-to-right in time.
  const chronological = [...pieceSources].reverse();
  const pieceAttempts = input.attempts.filter((a) => a.pieceId === input.pieceId);

  const issueIds = new Set(chronological.flatMap((s) => s.evidence.map((e) => e.id)));
  const entries: IssueTimelineEntry[] = [];

  for (const issueId of issueIds) {
    const presence: boolean[] = [];
    const sessionDates: string[] = [];
    const measurements: TrendPoint[] = [];
    let unit: string | null = null;
    let firstSeen: string | null = null;
    let lastSeen: string | null = null;
    let latest: PracticeEvidence | null = null;

    for (const source of chronological) {
      const found = source.evidence.find((e) => e.id === issueId);
      presence.push(Boolean(found));
      sessionDates.push(source.recordedAt);
      if (!found) continue;

      firstSeen ??= source.recordedAt;
      lastSeen = source.recordedAt;
      latest = found;

      const measured = measurementOf(found);
      if (measured) {
        // Mixing units across sessions would produce a meaningless line, so the
        // first unit seen wins and anything else is dropped.
        unit ??= measured.unit;
        if (measured.unit === unit) {
          measurements.push({ t: new Date(source.recordedAt).getTime(), value: measured.value });
        }
      }
    }

    if (!latest || !firstSeen) continue;

    const issueAttempts = attemptsForIssue(pieceAttempts, issueId);
    const trend = measurements.length >= 2 ? measurements : null;
    const verdict = verdictFor(presence, trend);

    entries.push({
      issueId,
      evidence: latest,
      firstSeen,
      lastSeen,
      presence,
      sessionDates,
      measurements: trend,
      unit: trend ? unit : null,
      exercises: [...new Set(issueAttempts.map((a) => a.blockTitle))],
      practice: tallyAttempts(issueAttempts),
      verdict,
      summary: summaryFor(verdict, trend, trend ? unit : null),
    });
  }

  // Most-practised first: the issue the player has put work into is the one
  // they most want an answer about.
  return entries.sort((a, b) => {
    if (b.practice.total !== a.practice.total) return b.practice.total - a.practice.total;
    return b.presence.filter(Boolean).length - a.presence.filter(Boolean).length;
  });
}

export const VERDICT_LABEL: Record<IssueVerdict, string> = {
  new: 'Too new to call',
  improving: 'Improving',
  stuck: 'Not moving yet',
  fixed: 'Fixed',
};

export { formatDate as formatTimelineDate };
export type { TrendDirection };
