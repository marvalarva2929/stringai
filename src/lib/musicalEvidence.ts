/**
 * The musical picture the coach reasons over.
 *
 * The pipeline computes a great deal of musical detail and, before this module,
 * discarded nearly all of it at the prompt boundary: `buildCoachingInput`
 * flattened every metric to `{key, score, severity, observationSummary}`, so
 * the model received **zero timestamps**. Given six aggregate numbers and no
 * temporal detail, "focus on dynamics and phrasing" was the only honest answer
 * available to it. Everything here already existed somewhere upstream — the job
 * is selection and shaping, not new analysis.
 *
 * Three things make advice specific, and all three are timestamped so the
 * results UI can seek to them:
 *   - `phrases`   — where the music breathes, how each was shaped
 *   - `tempo`     — where it pushed and dragged, against the intended tempo
 *   - `moments`   — individual notes worth naming
 *
 * Pure and dependency-free so it runs under the Node test harness, matching
 * `phraseFeatures.ts`, `dynamicsShape.ts` and `scoring.ts`.
 */

import type { PhraseFeatures } from './phraseFeatures';
import type { NoteEvent } from './noteFusion';
import type { MusicalContext } from './musicalContext';
import type { RhythmAnalysis } from '../types/analysis';

/** One phrase, as the coach sees it. */
export interface EvidencePhrase {
  id: number;
  start_t: number;
  end_t: number;
  note_count: number;
  slur_count: number;
  /** Coarse envelope shape from L7. */
  energy_shape: PhraseFeatures['energy_shape'];
  /** 0-1 position of the loudest moment. */
  peak_location: number;
  /** Finer shaping from L6.5, when it ran. */
  shape?: string;
  peak_t?: number;
  /** Level and pitch moving together — a shaped line, not a fault. */
  melodic_contour?: boolean;
  intonation_stability: PhraseFeatures['intonation']['stability'];
  vibrato_consistency: number;
  /** Local key, when the estimator was confident enough to name one. */
  key?: string;
  /** Why this phrase was selected — keeps the model honest about relevance. */
  selected_for: string;
}

export interface EvidenceTempo {
  /** Estimated from the player's own onsets. */
  bpm_estimate: number;
  /** What they were *trying* to play, when the metronome was on. */
  intended_bpm?: number;
  tendency: 'rushing' | 'dragging' | null;
  /** 0-100; lower means the pulse wandered more. */
  drift_score: number;
  /**
   * True when timing varied too much to grid-analyse. Reported as an
   * observation rather than swallowed: in a musicality context, elastic timing
   * is the subject, not a measurement failure.
   */
  rubato: boolean;
  regions: { start_t: number; end_t: number; direction: 'rushed' | 'dragged'; deviation_pct: number }[];
}

/** A single note worth naming, with why it is worth naming. */
export interface EvidenceMoment {
  t: number;
  note: string;
  duration_s: number;
  /** 0-1 relative loudness within the session. */
  level: number;
  /** 0-1 position within its phrase. */
  phrase_position: number;
  cents_off: number;
  reason: string;
}

export interface MusicalEvidence {
  key?: string;
  key_confidence?: number;
  phrases: EvidencePhrase[];
  tempo?: EvidenceTempo;
  moments: EvidenceMoment[];
  /** Musical figures — runs, arpeggios, shifts — that went badly. */
  figures: { id: string; kind: string; start_t: number; end_t: number; notes: string; issue: string }[];
  /** How many phrases existed in total, so the model knows this is a selection. */
  phrases_total: number;
}

/** Enough to shape advice; few enough to leave room for the conversation. */
export const MAX_EVIDENCE_PHRASES = 6;
export const MAX_MOMENTS = 8;
export const MAX_FIGURES = 3;
/** Below this a key estimate is a guess and should not steer interpretation. */
const MIN_KEY_CONFIDENCE = 0.5;

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * How much a phrase is worth talking about, and why.
 *
 * The previous behaviour took the first ten phrases chronologically, which on a
 * five-minute take means the opening and nothing else. Ranking by what actually
 * went wrong is the difference between commenting on the warm-up and commenting
 * on the performance.
 */
function phraseInterest(p: PhraseFeatures): { score: number; reason: string } {
  const d = p.dynamics;

  // A shaped line is not a fault, however extreme its slope.
  if (d?.melodic_contour) return { score: 0.35, reason: 'shaped line — level follows the melody' };

  if (d?.shape === 'plateau' || p.energy_shape === 'flat') {
    return { score: 1.0, reason: 'no dynamic shape' };
  }
  if (d?.shape === 'unclassified' && d.peak_pos < 0.15) {
    return { score: 0.95, reason: 'peaks almost immediately' };
  }
  if (d?.shape === 'unclassified' && d.peak_pos > 0.82) {
    return { score: 0.9, reason: 'still growing at the phrase end' };
  }
  if (p.energy_shape === 'early_peak') return { score: 0.8, reason: 'peaks early' };
  if (p.energy_shape === 'late_peak') return { score: 0.75, reason: 'peaks late' };
  if (p.intonation.stability === 'low') return { score: 0.7, reason: 'unsteady intonation' };
  if (d?.shape === 'falling') return { score: 0.5, reason: 'fades away' };
  if (p.intonation.stability === 'moderate') return { score: 0.4, reason: 'intonation drifts' };

  // A well-shaped phrase is still worth one mention — praise needs evidence too.
  return { score: 0.25, reason: 'well shaped' };
}

/** Why an individual note is worth naming. Null when it isn't. */
function momentReason(n: NoteEvent, longThreshold: number): string | null {
  if (!n.inTune && Math.abs(n.centsDeviation) >= 30) {
    return n.centsDeviation > 0 ? 'noticeably sharp' : 'noticeably flat';
  }
  if (n.durationSeconds >= longThreshold && n.dynamicLevel < 0.35) {
    return 'long note played quietly — a chance to sustain and grow';
  }
  if (n.durationSeconds >= longThreshold) return 'the longest notes — where tone shows';
  if (n.phrasePosition > 0.9 && n.dynamicLevel > 0.75) return 'phrase ends loud rather than tapering';
  return null;
}

export interface BuildMusicalEvidenceInput {
  phraseFeatures: PhraseFeatures[];
  noteEvents: NoteEvent[];
  musicalContext?: MusicalContext | null;
  rhythm?: RhythmAnalysis | null;
  /** The tempo the student set on the metronome, when they used one. */
  metronomeBpm?: number;
}

export function buildMusicalEvidence(input: BuildMusicalEvidenceInput): MusicalEvidence {
  const { phraseFeatures, noteEvents, musicalContext, rhythm, metronomeBpm } = input;

  // ── Phrases: rank by what went wrong, then restore playing order ──
  const ranked = phraseFeatures
    .map((p) => ({ p, ...phraseInterest(p) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_EVIDENCE_PHRASES)
    .sort((a, b) => a.p.start_t - b.p.start_t);

  const phrases: EvidencePhrase[] = ranked.map(({ p, reason }) => {
    const key = musicalContext?.phraseKeys?.[p.id];
    return {
      id: p.id,
      start_t: round(p.start_t, 1),
      end_t: round(p.end_t, 1),
      note_count: p.note_count,
      slur_count: p.slur_count,
      energy_shape: p.energy_shape,
      peak_location: round(p.peak_location),
      shape: p.dynamics?.shape,
      peak_t: p.dynamics?.peak_t,
      melodic_contour: p.dynamics?.melodic_contour,
      intonation_stability: p.intonation.stability,
      vibrato_consistency: round(p.vibrato_consistency),
      key: key && key.confidence >= MIN_KEY_CONFIDENCE ? key.name : undefined,
      selected_for: reason,
    };
  });

  // ── Tempo ──
  let tempo: EvidenceTempo | undefined;
  if (rhythm) {
    tempo = {
      bpm_estimate: Math.round(rhythm.bpmEst),
      intended_bpm: metronomeBpm,
      tendency: rhythm.tendency,
      drift_score: rhythm.tempoDriftScore,
      rubato: rhythm.isRubato,
      regions: (rhythm.flaggedRegions ?? []).slice(0, 4).map((r) => ({
        start_t: round(r.startSeconds, 1),
        end_t: round(r.endSeconds, 1),
        direction: r.direction,
        deviation_pct: Math.round(r.deviationPct),
      })),
    };
  }

  // ── Moments ──
  const durations = noteEvents.map((n) => n.durationSeconds).sort((a, b) => b - a);
  // "Long" is relative to this performance, not an absolute — a slow movement
  // and a fast one have very different note lengths.
  const longThreshold = durations.length > 0 ? durations[Math.floor(durations.length * 0.1)] : Infinity;

  const moments: EvidenceMoment[] = noteEvents
    .map((n) => ({ n, reason: momentReason(n, longThreshold) }))
    .filter((x): x is { n: NoteEvent; reason: string } => x.reason !== null)
    // Worst intonation first, then longest — the two most speakable faults.
    .sort((a, b) => {
      const ac = Math.abs(a.n.centsDeviation);
      const bc = Math.abs(b.n.centsDeviation);
      if (bc !== ac) return bc - ac;
      return b.n.durationSeconds - a.n.durationSeconds;
    })
    .slice(0, MAX_MOMENTS)
    .sort((a, b) => a.n.startSeconds - b.n.startSeconds)
    .map(({ n, reason }) => ({
      t: round(n.startSeconds, 1),
      note: n.noteName,
      duration_s: round(n.durationSeconds, 1),
      level: round(n.dynamicLevel),
      phrase_position: round(n.phrasePosition),
      cents_off: Math.round(n.centsDeviation),
      reason,
    }));

  // ── Figures that went badly ──
  // `assessments` is already worst-first and only contains figures worth
  // reporting — every severity level is actionable, so nothing is filtered out.
  const figures = (musicalContext?.assessments ?? [])
    .slice(0, MAX_FIGURES)
    .map((a) => {
      const fig = musicalContext?.figures.find((f) => f.id === a.figureId);
      return {
        id: a.figureId,
        kind: a.kind,
        start_t: round(fig?.startSeconds ?? 0, 1),
        end_t: round(fig?.endSeconds ?? 0, 1),
        notes: (fig?.noteNames ?? []).slice(0, 8).join(' '),
        issue:
          a.worstNoteName && a.worstCents !== null
            ? `${a.worstNoteName} ${a.worstCents > 0 ? 'sharp' : 'flat'} by ${Math.abs(Math.round(a.worstCents))}c`
            : `mean ${Math.round(a.meanAbsCents)}c off`,
      };
    });

  const key = musicalContext?.key;

  return {
    key: key && key.confidence >= MIN_KEY_CONFIDENCE ? key.name : undefined,
    key_confidence: key ? round(key.confidence) : undefined,
    phrases,
    tempo,
    moments,
    figures,
    phrases_total: phraseFeatures.length,
  };
}
