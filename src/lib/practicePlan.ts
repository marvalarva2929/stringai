import type { MetricKey, AnalysisResult, PlayerCategory } from '../types/analysis';
import type { SkillLevel } from '../types/user';
import type { MetricHistoryEntry } from '../store/useAnalysisStore';
import { exercisesForMetric } from '../constants/exercises';
import type { Exercise } from '../constants/exercises';
import { METRIC_META } from '../constants/metricMeta';
import {
  buildPracticeEvidence,
  type PracticeEvidence,
} from './practiceEvidence';
import {
  rankPracticeEvidence,
  type RankedPracticeEvidence,
} from './practiceRanking';
import {
  buildPracticeBlocks,
  coachIntensityFor,
  targetPlanMinutes,
  type CoachIntensity,
  type PracticeBlock,
} from './practiceBlocks';

export interface WeakArea {
  metricKey: MetricKey;
  avgScore: number;
  sessionCount: number;
  exercises: Exercise[];
}

/** What the plan is scoped to. Also determines the plan id, which keys progress
 *  — so a session plan, a piece plan, and the daily plan coexist independently. */
export type PlanScope =
  | { kind: 'daily' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'piece'; pieceId: string };

export interface PracticePlanInput {
  recentSessions?: AnalysisResult[];
  metricHistory?: MetricHistoryEntry[];
  playerCategory?: PlayerCategory | null;
  weeklyGoalMinutes?: number | null;
  skillLevel?: SkillLevel;
  sessionWindow?: number;
  /** Defaults to daily. Session/piece scopes filter the evidence window down to
   *  the matching sessions and stamp a distinct plan id. */
  scope?: PlanScope;
}

/** Serialize a scope into route params (daily carries none). */
export function scopeToParams(scope: PlanScope): Record<string, string> {
  if (scope.kind === 'session') return { sessionId: scope.sessionId };
  if (scope.kind === 'piece') return { pieceId: scope.pieceId };
  return {};
}

/** Read a scope back from route params; absent → daily. */
export function scopeFromParams(p: { sessionId?: string; pieceId?: string }): PlanScope {
  if (p.sessionId) return { kind: 'session', sessionId: p.sessionId };
  if (p.pieceId) return { kind: 'piece', pieceId: p.pieceId };
  return { kind: 'daily' };
}

function planIdFor(scope: PlanScope | undefined, date: string): string {
  if (scope?.kind === 'session') return `session:${scope.sessionId}`;
  if (scope?.kind === 'piece') return `piece:${scope.pieceId}`;
  return `daily:${date}`;
}

function scopeSessions(sessions: AnalysisResult[], scope?: PlanScope): AnalysisResult[] {
  if (scope?.kind === 'session') return sessions.filter((s) => s.sessionId === scope.sessionId);
  if (scope?.kind === 'piece') return sessions.filter((s) => s.piece?.id === scope.pieceId);
  return sessions;
}

function scopeHistory(history: MetricHistoryEntry[], scope?: PlanScope): MetricHistoryEntry[] {
  if (scope?.kind === 'session') return history.filter((h) => h.sessionId === scope.sessionId);
  if (scope?.kind === 'piece') return history.filter((h) => h.pieceId === scope.pieceId);
  return history;
}

export interface PracticePlan {
  id: string;
  generatedAt: string;
  sessionCount: number;
  durationMinutes: number;
  coachIntensity: CoachIntensity;
  primaryFocus: string;
  summary: string;
  blocks: PracticeBlock[];
  evidence: RankedPracticeEvidence[];
  sourceSessionIds: string[];
  weakAreas: WeakArea[];
  allMetricAverages: Partial<Record<MetricKey, number>>;
  /** Grounded LLM root causes tying blocks together, when available (session
   *  scope only — see useSessionPracticePlan). Absent = deterministic-only. */
  rootCauses?: import('./practiceCuration').CuratedRootCause[];
}

export function computePracticePlan(
  metricHistory: MetricHistoryEntry[],
  sessionWindow?: number,
): PracticePlan;
export function computePracticePlan(input: PracticePlanInput): PracticePlan;
export function computePracticePlan(
  inputOrHistory: PracticePlanInput | MetricHistoryEntry[],
  legacySessionWindow = 5,
): PracticePlan {
  const input: PracticePlanInput = Array.isArray(inputOrHistory)
    ? { metricHistory: inputOrHistory, sessionWindow: legacySessionWindow }
    : inputOrHistory;

  const sessionWindow = input.sessionWindow ?? 5;
  const scopedSessions = scopeSessions(input.recentSessions ?? [], input.scope);
  const scopedHistory = scopeHistory(input.metricHistory ?? [], input.scope);
  const evidenceResult = buildPracticeEvidence({
    recentSessions: scopedSessions,
    metricHistory: scopedHistory,
    sessionWindow,
    playerCategory: input.playerCategory,
  });
  const ranked = rankPracticeEvidence(evidenceResult.evidence, {
    playerCategory: input.playerCategory,
  });
  const blocks = buildPracticeBlocks(ranked, {
    playerCategory: input.playerCategory,
    weeklyGoalMinutes: input.weeklyGoalMinutes,
    skillLevel: input.skillLevel,
    hasAnalyzedSessions: evidenceResult.sessionCount > 0,
  });

  const generatedAt = new Date().toISOString();
  const sourceSessionIds = unique(
    ranked
      .map((e) => e.sourceSessionId)
      .filter((id): id is string => Boolean(id)),
  );
  const weakAreas = buildWeakAreas(
    evidenceResult.allMetricAverages,
    scopedHistory,
    sessionWindow,
  );
  const durationMinutes = distributeBlockMinutes(blocks, targetPlanMinutes(input.weeklyGoalMinutes));

  return {
    id: planIdFor(input.scope, generatedAt.slice(0, 10)),
    generatedAt,
    sessionCount: evidenceResult.sessionCount,
    durationMinutes,
    coachIntensity: coachIntensityFor(input.playerCategory, input.weeklyGoalMinutes),
    primaryFocus: primaryFocus(blocks, ranked),
    summary: planSummary(evidenceResult.sessionCount, blocks, ranked, input.playerCategory),
    blocks,
    evidence: ranked,
    sourceSessionIds,
    weakAreas,
    allMetricAverages: evidenceResult.allMetricAverages,
  };
}

function distributeBlockMinutes(blocks: PracticeBlock[], targetMinutes: number): number {
  if (blocks.length === 0) return targetMinutes;
  const current = blocks.reduce((sum, block) => sum + block.estimatedMinutes, 0);
  if (current === targetMinutes) return current;
  // Preserve per-block estimates for display today; duration should reflect the
  // selected weekly commitment rather than the raw sum of templates.
  return targetMinutes;
}

function primaryFocus(blocks: PracticeBlock[], evidence: PracticeEvidence[]): string {
  const firstBlock = blocks[0];
  if (firstBlock?.type === 'pitch_landing' && firstBlock.target.pitchClass) {
    return `${firstBlock.target.pitchClass} landing`;
  }
  if (firstBlock) return firstBlock.title;
  return evidence[0]?.title ?? 'Baseline practice';
}

function planSummary(
  sessionCount: number,
  blocks: PracticeBlock[],
  evidence: PracticeEvidence[],
  playerCategory?: PlayerCategory | null,
): string {
  if (sessionCount === 0) {
    return 'Record one baseline session first; the next plan will target exact notes, bow habits, and phrase patterns.';
  }
  const focus = blocks.slice(0, 2).map((b) => b.title).join(' + ');
  const categoryCopy = playerCategory === 'refinement'
    ? 'The plan prioritizes specific, high-confidence evidence and phrase-level refinements.'
    : 'The plan prioritizes fundamentals first, with live checks before moving on.';
  const evidenceCopy = evidence.length > 0
    ? `Based on ${evidence.length} recent evidence signal${evidence.length === 1 ? '' : 's'}.`
    : 'Based on recent metric trends.';
  return `${focus}. ${categoryCopy} ${evidenceCopy}`;
}

function buildWeakAreas(
  averages: Partial<Record<MetricKey, number>>,
  metricHistory: MetricHistoryEntry[],
  sessionWindow: number,
): WeakArea[] {
  const recent = metricHistory.slice(0, sessionWindow);
  const counts = new Map<MetricKey, number>();
  for (const entry of recent) {
    for (const score of entry.scores) {
      counts.set(score.key, (counts.get(score.key) ?? 0) + 1);
    }
  }

  return Object.entries(averages)
    .map(([key, avgScore]) => ({
      metricKey: key as MetricKey,
      avgScore: avgScore ?? 0,
      sessionCount: counts.get(key as MetricKey) ?? Math.max(1, recent.length),
    }))
    .filter((area) => area.avgScore < 85)
    .sort((a, b) => a.avgScore - b.avgScore)
    .slice(0, 3)
    .map((area) => {
      const exs = exercisesForMetric(area.metricKey);
      const beginner = exs.find((e) => e.difficulty === 'beginner');
      const intermediate = exs.find((e) => e.difficulty === 'intermediate');
      const exercises: Exercise[] = [];
      if (beginner) exercises.push(beginner);
      if (intermediate && intermediate !== beginner) exercises.push(intermediate);
      if (exercises.length === 0 && exs.length > 0) exercises.push(exs[0]);
      return { ...area, exercises };
    });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function metricLabel(key: MetricKey): string {
  return METRIC_META[key]?.label ?? key;
}

export function metricIcon(key: MetricKey): string {
  return METRIC_META[key]?.icon ?? '🎵';
}
