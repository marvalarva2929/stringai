/**
 * Pure L10 input-shaping — compacting L1-L9 output into what actually gets
 * sent to the coaching model. Kept separate from services/llmFeedback.ts
 * (which imports the Supabase client, a native-only dependency) so it can be
 * exercised directly by Node tests (test/llmFeedback.test.ts).
 */

import type { MetricScore, PlayerCategory } from '../types/analysis';
import type { Piece } from '../types/piece';
import type { StatisticalFinding } from './patternDetection';
import type { PhraseFeatures } from './phraseFeatures';
import type { MusicalEvidence } from './musicalEvidence';
import type { PracticeEvidence } from './practiceEvidence';

export interface CoachingInput {
  instrument: string;
  piece?: { title: string; composer?: string; movement?: string };
  skillLevel: 'beginner' | 'intermediate' | 'advanced';
  playerCategory: PlayerCategory;
  metrics: {
    key: string;
    score: number;
    severity: string;
    observationSummary: string;
    /** Up to two flagged moments, so a claim can point somewhere. */
    moments?: { t: number; note?: string }[];
  }[];
  patternFindings: { testId: string; summary: string; evidence: unknown; severity: string }[];
  phraseFeatures?: PhraseFeatures[];
  /** The exact issue set the model may cite. Every curated block/root cause must
   *  reference one of these ids — the client rejects any it invents. */
  issues?: { id: string; summary: string; quality: 'high' | 'proxy' | 'low' }[];
  /**
   * The timestamped musical picture: which phrases were shaped how, where the
   * tempo moved, which notes are worth naming. This is what makes musical
   * advice specific rather than categorical.
   */
  musicalEvidence?: MusicalEvidence;
}

/** Compact the frozen issue set into what the coaching model may cite. */
export function issuesForCoaching(
  issues: PracticeEvidence[],
): NonNullable<CoachingInput['issues']> {
  return issues.map((issue) => {
    // `reason` carries the specific musical narrative (e.g. tone's per-section fault
    // text, "flat3rd was flat in 4 of 9 attempts"); `evidenceSummary` carries hard
    // numbers where a dedicated evidence builder produced them. For metric-fallback
    // evidence (tone, posture, bow form) evidenceSummary is a generic "score X;
    // severity Y" string — using `||` here used to silently drop the specific reason
    // whenever evidenceSummary was present, which is always. Combine both instead.
    // `contrast` is the group comparison behind a musical moment ("crossing runs
    // averaged 24¢ further off than the rest of the take"). It only exists when
    // the measurement actually supported the claim, and it is the single most
    // useful sentence the model can be given — without it the model has a tally
    // and has to guess at causation.
    const detail = [issue.reason, issue.contrast, issue.evidenceSummary]
      .filter(Boolean).join(' ').trim();
    return {
      id: issue.id,
      summary: `${issue.title}: ${detail}`,
      quality: (issue.measurementQuality === 'proxy' || issue.measurementQuality === 'low'
        ? issue.measurementQuality
        : 'high') as 'high' | 'proxy' | 'low',
    };
  });
}

export function buildCoachingInput(
  metrics: MetricScore[],
  playerCategory: PlayerCategory,
  skillLevel: 'beginner' | 'intermediate' | 'advanced',
  piece?: Piece,
  findings?: StatisticalFinding[],
  phraseFeatures?: PhraseFeatures[],
  issues?: PracticeEvidence[],
  /** The timestamped musical picture — see lib/musicalEvidence.ts. */
  musicalEvidence?: MusicalEvidence,
): CoachingInput {
  return {
    instrument: 'violin',
    piece: piece
      ? { title: piece.title, composer: piece.composer, movement: piece.movement }
      : undefined,
    skillLevel,
    playerCategory,
    metrics: metrics
      .filter((m) => m.measurementQuality !== 'unavailable')
      .map((m) => ({
        key: m.key,
        score: m.score,
        severity: m.severity,
        observationSummary: m.observationSummary,
        // Without these the model has no way to point at a moment, which is
        // the whole difference between "work on your dynamics" and "the phrase
        // at 0:48 peaked at the very end".
        moments: m.flaggedTimestamps.slice(0, 2).map((ts) => ({
          t: Math.round(ts.startSeconds * 10) / 10,
          note: ts.note,
        })),
      })),
    patternFindings: (findings ?? []).map((f) => ({
      testId: f.testId,
      summary: f.summary,
      evidence: f.evidence,
      severity: f.severity,
    })),
    phraseFeatures,
    issues: issues ? issuesForCoaching(issues) : undefined,
    musicalEvidence,
  };
}
