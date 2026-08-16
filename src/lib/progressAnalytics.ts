import type { MetricKey, MetricScore, SessionSummary, SeverityBand } from '../types/analysis';
import { severityFromScore } from '../types/analysis';
import type { MetricHistoryEntry } from '../store/useAnalysisStore';
import type { PracticeEvidence } from './practiceEvidence';
import type { IssueSource } from './practiceIssues';
import { mergeIssues, issuesForPiece } from './practiceIssues';
import {
  CATEGORIES, CATEGORY_BY_ID, CATEGORY_ORDER, CATEGORY_UNITS, qualitativeBand,
  type CategoryId,
} from '../constants/categories';
import { getWeekStart } from './weeklyGoal';

// ─────────────────────────────────────────────────────────────
// Progress analytics
//
// Pure, Node-testable derivations behind the Progress tab and piece detail.
// Reads the two durable local series — sessionHistory (overall per session) and
// metricHistory (all 13 metrics + frozen L9 evidence per session) — and answers
// the four questions the screen is built around: am I improving, at what,
// what's stuck, what did I fix.
//
// Issue aggregation is NOT reimplemented here. mergeIssues/issuesForPiece in
// practiceIssues.ts already apply recurrence-boost + recency-decay and are
// covered by test/practiceIssues.test.ts; this module only reshapes their
// output for display.
// ─────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Points on the 0-100 scale within this of each other read as unchanged.
 *  Session-to-session movement of a few points is measurement noise, and a
 *  direction chip that flips on noise trains people to ignore it. */
export const DEFAULT_DEAD_BAND = 3;

export type ProgressRange = '4w' | '3m' | 'all';

export const RANGE_LABELS: Record<ProgressRange, string> = {
  '4w': '4 weeks',
  '3m': '3 months',
  all: 'All time',
};

const RANGE_DAYS: Record<Exclude<ProgressRange, 'all'>, number> = {
  '4w': 28,
  '3m': 91,
};

/** Start of the range as an epoch ms, or null for 'all'. */
export function rangeStart(range: ProgressRange, now: Date = new Date()): number | null {
  if (range === 'all') return null;
  return now.getTime() - RANGE_DAYS[range] * DAY_MS;
}

export type TrendDirection = 'improving' | 'steady' | 'slipping' | 'unknown';

export interface TrendPoint {
  /** Epoch ms — charts plot on a real time axis, so an even-spaced session
   *  index would misrepresent a two-week gap as one step. */
  t: number;
  value: number;
}

export interface PeriodComparison {
  current: number | null;
  previous: number | null;
  delta: number | null;
  direction: TrendDirection;
  currentCount: number;
  previousCount: number;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function directionFromDelta(
  delta: number | null,
  deadBand: number = DEFAULT_DEAD_BAND,
): TrendDirection {
  if (delta == null) return 'unknown';
  if (delta > deadBand) return 'improving';
  if (delta < -deadBand) return 'slipping';
  return 'steady';
}

/**
 * Compare the mean over [windowStart, windowEnd] against the mean over the
 * equally-long window immediately before it. Comparing period means rather than
 * latest-vs-previous is what makes the trend readable: one bad take shouldn't
 * turn a month of improvement into a downward arrow.
 */
export function comparePeriods(
  points: TrendPoint[],
  windowStart: number,
  windowEnd: number,
  deadBand: number = DEFAULT_DEAD_BAND,
): PeriodComparison {
  const span = windowEnd - windowStart;
  const currentValues = points.filter((p) => p.t >= windowStart && p.t <= windowEnd).map((p) => p.value);
  const previousValues = points
    .filter((p) => p.t >= windowStart - span && p.t < windowStart)
    .map((p) => p.value);

  const current = currentValues.length ? mean(currentValues) : null;
  const previous = previousValues.length ? mean(previousValues) : null;
  const delta = current != null && previous != null ? current - previous : null;

  return {
    current,
    previous,
    delta,
    direction: directionFromDelta(delta, deadBand),
    currentCount: currentValues.length,
    previousCount: previousValues.length,
  };
}

/**
 * Split a series in half by count and compare the two halves. Used when there
 * is no meaningful calendar window to compare against — the 'all' range, and
 * piece attempts, where "first few tries vs latest few" is the question.
 */
export function compareHalves(
  points: TrendPoint[],
  deadBand: number = DEFAULT_DEAD_BAND,
): PeriodComparison {
  if (points.length < 2) {
    return {
      current: points.length ? points[points.length - 1].value : null,
      previous: null,
      delta: null,
      direction: 'unknown',
      currentCount: points.length,
      previousCount: 0,
    };
  }

  const sorted = [...points].sort((a, b) => a.t - b.t);
  const mid = Math.floor(sorted.length / 2);
  const previousValues = sorted.slice(0, mid).map((p) => p.value);
  // Odd counts give the extra point to the recent half — it is the half the
  // user is asking about.
  const currentValues = sorted.slice(mid).map((p) => p.value);

  const current = mean(currentValues);
  const previous = mean(previousValues);
  const delta = current - previous;

  return {
    current,
    previous,
    delta,
    direction: directionFromDelta(delta, deadBand),
    currentCount: currentValues.length,
    previousCount: previousValues.length,
  };
}

// ─────────────────────────────────────────────────────────────
// Category trends
// ─────────────────────────────────────────────────────────────

/** A metric counts as measured only when it is present AND not flagged
 *  unavailable. Audio-only sessions omit the pose metrics entirely, so absence
 *  and 'unavailable' both have to mean "don't chart this". */
function measuredScores(scores: MetricScore[], keys: MetricKey[]): MetricScore[] {
  return keys
    .map((key) => scores.find((s) => s.key === key))
    .filter((s): s is MetricScore => !!s && s.measurementQuality !== 'unavailable');
}

/** Mean 0-100 score for a category in one session, or null if nothing measured. */
export function categoryScore(entry: MetricHistoryEntry, id: CategoryId): number | null {
  const found = measuredScores(entry.scores, CATEGORY_BY_ID[id].keys);
  return found.length ? mean(found.map((s) => s.score)) : null;
}

/**
 * The category's real-unit rate (0-1) for one session, or null when no honest
 * figure exists. See CATEGORY_UNITS — occurrenceRate is a genuine measurement
 * for tone/rhythm/bow/posture but a restatement of the score for the rest.
 */
export function categoryRate(entry: MetricHistoryEntry, id: CategoryId): number | null {
  const unit = CATEGORY_UNITS[id];

  if (unit.source.from === 'headline') {
    const value = entry.headline?.[unit.source.field];
    return typeof value === 'number' ? value : null;
  }

  if (unit.source.from === 'occurrenceRate') {
    const found = measuredScores(entry.scores, CATEGORY_BY_ID[id].keys);
    if (!found.length) return null;
    return 1 - mean(found.map((s) => s.occurrenceRate));
  }

  return null;
}

export interface CategorySeries {
  id: CategoryId;
  label: string;
  /** Oldest-first score points within the range. */
  points: TrendPoint[];
  latestScore: number | null;
  severity: SeverityBand | null;
  /** Real-unit copy, e.g. "84% in tune". Null when no honest unit is available. */
  headlineText: string | null;
  /** Plain-language stand-in, e.g. "developing". Null when never measured. */
  bandText: string | null;
  comparison: PeriodComparison;
  direction: TrendDirection;
  /** False when the category was never measured in the range — render greyed
   *  as "not measured yet" rather than showing a zero. */
  measured: boolean;
}

export function buildCategorySeries(
  metricHistory: MetricHistoryEntry[],
  range: ProgressRange = '4w',
  now: Date = new Date(),
  deadBand: number = DEFAULT_DEAD_BAND,
): CategorySeries[] {
  const start = rangeStart(range, now);
  const end = now.getTime();

  // metricHistory is stored newest-first; charts read oldest-first.
  const chronological = [...metricHistory].sort(
    (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
  );
  const inRange = start == null
    ? chronological
    : chronological.filter((e) => new Date(e.recordedAt).getTime() >= start);

  return CATEGORY_ORDER.map((id) => {
    const label = CATEGORY_BY_ID[id].label;

    const points: TrendPoint[] = [];
    for (const entry of inRange) {
      const score = categoryScore(entry, id);
      if (score != null) points.push({ t: new Date(entry.recordedAt).getTime(), value: score });
    }

    if (points.length === 0) {
      return {
        id, label, points: [],
        latestScore: null, severity: null,
        headlineText: null, bandText: null,
        comparison: { current: null, previous: null, delta: null, direction: 'unknown', currentCount: 0, previousCount: 0 },
        direction: 'unknown' as TrendDirection,
        measured: false,
      };
    }

    // The previous period sits outside the range, so compare against the full
    // chronological series rather than the filtered one.
    const allPoints: TrendPoint[] = [];
    for (const entry of chronological) {
      const score = categoryScore(entry, id);
      if (score != null) allPoints.push({ t: new Date(entry.recordedAt).getTime(), value: score });
    }
    const comparison = start == null
      ? compareHalves(allPoints, deadBand)
      : comparePeriods(allPoints, start, end, deadBand);

    const latestScore = points[points.length - 1].value;
    const severity = severityFromScore(Math.round(latestScore));

    // Most recent session in range that carries a real figure — older entries
    // predate the headline field, so the newest one may not have it either.
    let rate: number | null = null;
    for (let i = inRange.length - 1; i >= 0 && rate == null; i--) {
      rate = categoryRate(inRange[i], id);
    }
    const unit = CATEGORY_UNITS[id];
    const headlineText = rate == null
      ? null
      : `${Math.round(rate * 100)}% ${unit.suffix}`.trim();

    return {
      id, label, points,
      latestScore, severity,
      headlineText,
      bandText: qualitativeBand(severity),
      comparison,
      direction: comparison.direction,
      measured: true,
    };
  });
}

/** Overall-score points for the hero chart, oldest-first. */
export function overallSeries(history: SessionSummary[]): TrendPoint[] {
  return [...history]
    .map((s) => ({ t: new Date(s.recordedAt).getTime(), value: s.overallScore }))
    .sort((a, b) => a.t - b.t);
}

// ─────────────────────────────────────────────────────────────
// Issues — what's stuck, what got fixed
// ─────────────────────────────────────────────────────────────

export interface IssueRecurrence {
  evidence: PracticeEvidence;
  /** Oldest-first: was this issue present in each examined session? */
  presence: boolean[];
  /** How many of the examined sessions it appeared in. */
  seenIn: number;
  /** How many sessions were examined. */
  outOf: number;
}

/**
 * Issues that keep coming back AND are still coming back.
 *
 * Recurrence alone isn't enough: an issue that fired in the four oldest
 * sessions and none since has a high count but is exactly the thing
 * `resolvedIssues` calls fixed. Requiring a sighting inside `activeWindow`
 * keeps the two sections mutually exclusive — nothing should be listed as both
 * stuck and solved.
 *
 * `mergeIssues` already ranks by recurrence and recency; this adds the
 * per-session presence strip, which is what lets the UI show a run of recent
 * hits as "getting worse" without a label.
 */
export function stuckIssues(
  sources: IssueSource[],
  window = 8,
  minRecurrence = 3,
  activeWindow = 3,
): IssueRecurrence[] {
  const examined = sources.slice(0, window);
  if (examined.length === 0) return [];

  // Oldest-first so the strip reads left-to-right in time.
  const chronological = [...examined].reverse();
  const activeIds = new Set(
    examined.slice(0, activeWindow).flatMap((s) => s.evidence.map((e) => e.id)),
  );

  return mergeIssues(examined)
    .map((evidence) => {
      const presence = chronological.map((source) =>
        source.evidence.some((e) => e.id === evidence.id),
      );
      return {
        evidence,
        presence,
        seenIn: presence.filter(Boolean).length,
        outOf: presence.length,
      };
    })
    .filter((r) => r.seenIn >= minRecurrence && activeIds.has(r.evidence.id))
    .sort((a, b) => b.seenIn - a.seenIn);
}

/**
 * Issues that were a recurring problem and have since stopped appearing.
 *
 * Requires at least two sightings in the prior window so a single one-off
 * doesn't get celebrated as a fix, and requires the recent window to be full —
 * with only one session since, absence is far more likely to mean "not
 * measured this time" than "solved".
 */
export function resolvedIssues(
  sources: IssueSource[],
  recentWindow = 3,
  priorWindow = 8,
  minPriorSightings = 2,
): PracticeEvidence[] {
  if (sources.length < recentWindow + minPriorSightings) return [];

  const recent = sources.slice(0, recentWindow);
  const prior = sources.slice(recentWindow, priorWindow);
  if (prior.length === 0) return [];

  const recentIds = new Set(recent.flatMap((s) => s.evidence.map((e) => e.id)));

  const counts = new Map<string, { count: number; evidence: PracticeEvidence }>();
  for (const source of prior) {
    for (const evidence of source.evidence) {
      const existing = counts.get(evidence.id);
      if (existing) existing.count += 1;
      else counts.set(evidence.id, { count: 1, evidence });
    }
  }

  return [...counts.values()]
    .filter(({ count, evidence }) => count >= minPriorSightings && !recentIds.has(evidence.id))
    .sort((a, b) => b.count - a.count)
    .map(({ evidence }) => evidence);
}

export interface PieceIssueSplit {
  /** Shows up on this piece but not on anything else you've played — a hard
   *  passage rather than a technique problem. */
  pieceSpecific: PracticeEvidence[];
  /** Shows up here and elsewhere — it follows you, so it's technique. */
  universal: PracticeEvidence[];
}

export function pieceVsGlobalIssues(
  sources: IssueSource[],
  pieceId: string,
  window = 5,
): PieceIssueSplit {
  const onPiece = issuesForPiece(sources, pieceId, window);
  const elsewhere = mergeIssues(sources.filter((s) => s.pieceId !== pieceId).slice(0, window));
  const elsewhereIds = new Set(elsewhere.map((e) => e.id));

  return {
    pieceSpecific: onPiece.filter((e) => !elsewhereIds.has(e.id)),
    universal: onPiece.filter((e) => elsewhereIds.has(e.id)),
  };
}

// ─────────────────────────────────────────────────────────────
// Consistency
// ─────────────────────────────────────────────────────────────

export interface CalendarDay {
  /** Local midnight, epoch ms. */
  t: number;
  minutes: number;
  sessions: number;
  isFuture: boolean;
}

/** Monday-first weeks, oldest week first, each exactly 7 days. */
export function practiceCalendar(
  history: SessionSummary[],
  weeks = 8,
  now: Date = new Date(),
): CalendarDay[][] {
  const byDay = new Map<number, { seconds: number; sessions: number }>();
  for (const session of history) {
    const day = new Date(session.recordedAt);
    day.setHours(0, 0, 0, 0);
    const key = day.getTime();
    const existing = byDay.get(key) ?? { seconds: 0, sessions: 0 };
    existing.seconds += session.durationSeconds || 0;
    existing.sessions += 1;
    byDay.set(key, existing);
  }

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const firstWeekStart = getWeekStart(now).getTime() - (weeks - 1) * 7 * DAY_MS;

  const result: CalendarDay[][] = [];
  for (let w = 0; w < weeks; w++) {
    const days: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      const t = firstWeekStart + (w * 7 + d) * DAY_MS;
      const entry = byDay.get(t);
      days.push({
        t,
        // Any recorded practice counts as at least a minute, matching
        // minutesPracticedThisWeek — clips are short and a 40s take that
        // rendered as "0 min" would read as a missed day.
        minutes: entry ? Math.max(1, Math.round(entry.seconds / 60)) : 0,
        sessions: entry?.sessions ?? 0,
        isFuture: t > todayStart.getTime(),
      });
    }
    result.push(days);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Piece detail — what changed
// ─────────────────────────────────────────────────────────────

export interface CategoryDelta {
  id: CategoryId;
  label: string;
  before: number;
  after: number;
  delta: number;
  measured: boolean;
}

/**
 * Mean of the first `sampleSize` attempts against the mean of the last
 * `sampleSize`, per category — the clearest read on whether working a piece
 * actually moved anything. Returns only categories measured in both halves.
 */
export function categoryDeltas(
  entries: MetricHistoryEntry[],
  sampleSize = 3,
): CategoryDelta[] {
  const chronological = [...entries].sort(
    (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
  );
  if (chronological.length < 2) return [];

  // With fewer than 2*sampleSize attempts the two samples would overlap and
  // every delta would be damped toward zero. Shrink the sample instead.
  const n = Math.min(sampleSize, Math.floor(chronological.length / 2));
  const first = chronological.slice(0, n);
  const last = chronological.slice(-n);

  const deltas: CategoryDelta[] = [];
  for (const id of CATEGORY_ORDER) {
    const beforeScores = first.map((e) => categoryScore(e, id)).filter((s): s is number => s != null);
    const afterScores = last.map((e) => categoryScore(e, id)).filter((s): s is number => s != null);
    if (!beforeScores.length || !afterScores.length) continue;

    const before = mean(beforeScores);
    const after = mean(afterScores);
    deltas.push({
      id,
      label: CATEGORY_BY_ID[id].label,
      before,
      after,
      delta: after - before,
      measured: true,
    });
  }

  return deltas.sort((a, b) => b.delta - a.delta);
}

// ─────────────────────────────────────────────────────────────
// Cold start
// ─────────────────────────────────────────────────────────────

export type ProgressStage = 'empty' | 'baseline' | 'early' | 'full';

/**
 * How much of the screen has earned the right to render. Trends drawn from one
 * or two sessions are noise dressed as insight, so each tier unlocks only what
 * the data can actually support.
 */
export function progressStage(sessionCount: number): ProgressStage {
  if (sessionCount === 0) return 'empty';
  if (sessionCount === 1) return 'baseline';
  if (sessionCount < 3) return 'early';
  return 'full';
}

/** Sessions still needed before "Still working on" can find a recurrence. */
export const MIN_SESSIONS_FOR_STUCK = 5;

export { CATEGORIES, CATEGORY_ORDER, type CategoryId };
