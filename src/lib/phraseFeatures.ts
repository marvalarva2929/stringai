import type { SessionSignals } from '../types/signals';
import type { NoteEvent, Phrase } from './noteFusion';
import type { NoteGroup } from './noteGrouping';
import type { VibratoAnalysis } from '../types/analysis';

// ─────────────────────────────────────────────────────────────
// L7 — Phrase feature engine
//
// Per-phrase musical descriptors over the SessionSignals window. Everything
// here is evidence for L9 interpretation and the L10 coaching prompt; nothing
// is shown raw to the user.
// ─────────────────────────────────────────────────────────────

export interface PhraseBowUsage {
  /** Mean bowContactPoint over the phrase (0 = frog, 1 = tip). */
  mean_u: number;
  /** Which third of the bow dominates (>50% of samples), or 'full'. */
  distribution: 'frog_heavy' | 'middle_heavy' | 'tip_heavy' | 'full';
  /** Range of bow used: max − min contact point. */
  coverage: number;
}

export interface PhraseFeatures {
  id: number;
  start_t: number;
  end_t: number;
  energy_shape: 'flat' | 'arch' | 'late_peak' | 'early_peak';
  /** 0-1 relative position of the RMS peak within the phrase. */
  peak_location: number;
  /** Null when the bow was not visible during the phrase. */
  bow_usage: PhraseBowUsage | null;
  intonation: {
    mean_error_cents: number;
    variance: number;
    stability: 'high' | 'moderate' | 'low';
  };
  /** Fraction of eligible notes in the phrase with detected vibrato. */
  vibrato_consistency: number;
  /** Std dev of the spectral centroid within the phrase (Hz). */
  timbre_variation: number;
  /** Notes and slur groups overlapping this phrase, for L10 drill-down. */
  note_count: number;
  slur_count: number;
}

// Energy-shape thirds comparison margin (plan.md: 20%)
const SHAPE_MARGIN = 0.2;
// Intonation stability bands on σ of centsDeviation
const STABILITY_HIGH_CENTS = 15;
const STABILITY_MODERATE_CENTS = 30;
// Vibrato counts as present on a note when its score clears this bar
const VIBRATO_PRESENT_SCORE = 50;

function mean(vals: number[]): number {
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
}

function variance(vals: number[]): number {
  if (vals.length === 0) return 0;
  const m = mean(vals);
  return mean(vals.map(v => (v - m) ** 2));
}

function classifyEnergyShape(rmsVals: number[]): { shape: PhraseFeatures['energy_shape']; peak: number } {
  if (rmsVals.length < 3) return { shape: 'flat', peak: 0.5 };

  const third = Math.floor(rmsVals.length / 3);
  const first = mean(rmsVals.slice(0, third));
  const middle = mean(rmsVals.slice(third, 2 * third));
  const last = mean(rmsVals.slice(2 * third));

  let peakIdx = 0;
  for (let i = 1; i < rmsVals.length; i++) if (rmsVals[i] > rmsVals[peakIdx]) peakIdx = i;
  const peak = peakIdx / (rmsVals.length - 1);

  const over = (a: number, b: number) => b > 0 && a > b * (1 + SHAPE_MARGIN);
  if (over(middle, first) && over(middle, last)) return { shape: 'arch', peak };
  if (over(last, first)) return { shape: 'late_peak', peak };
  if (over(first, last)) return { shape: 'early_peak', peak };
  return { shape: 'flat', peak };
}

function classifyBowUsage(uVals: number[]): PhraseBowUsage | null {
  if (uVals.length === 0) return null;
  let frog = 0, middle = 0, tip = 0;
  for (const u of uVals) {
    if (u < 0.33) frog++;
    else if (u < 0.67) middle++;
    else tip++;
  }
  const n = uVals.length;
  const distribution: PhraseBowUsage['distribution'] =
    frog / n > 0.5 ? 'frog_heavy'
    : tip / n > 0.5 ? 'tip_heavy'
    : middle / n > 0.5 ? 'middle_heavy'
    : 'full';
  return {
    mean_u: mean(uVals),
    distribution,
    coverage: Math.max(...uVals) - Math.min(...uVals),
  };
}

export function buildPhraseFeatures(
  phrases: Phrase[],
  signals: SessionSignals,
  noteEvents: NoteEvent[],
  noteGroups: NoteGroup[],
  vibratoAnalysis?: VibratoAnalysis,
): PhraseFeatures[] {
  return phrases.map((phrase, id) => {
    const { start, end } = phrase;

    // ── Energy shape from the RMS window ──
    const rmsVals = signals.rms.window(start, end).map(p => p.v);
    const { shape: energy_shape, peak: peak_location } = classifyEnergyShape(rmsVals);

    // ── Bow usage ──
    const uVals = signals.bowContactPoint
      .window(start, end)
      .map(p => p.v)
      .filter((v): v is number => v !== null);
    const bow_usage = classifyBowUsage(uVals);

    // ── Intonation over the phrase's notes ──
    const phraseNotes = noteEvents.filter(n => n.startSeconds >= start && n.startSeconds < end);
    const cents = phraseNotes.map(n => n.centsDeviation);
    const centsVariance = variance(cents);
    const sigma = Math.sqrt(centsVariance);
    const stability: PhraseFeatures['intonation']['stability'] =
      phraseNotes.length === 0 ? 'low'
      : sigma < STABILITY_HIGH_CENTS ? 'high'
      : sigma < STABILITY_MODERATE_CENTS ? 'moderate'
      : 'low';

    // ── Vibrato consistency: fraction of assessed notes with vibrato present ──
    let vibrato_consistency = 0;
    if (vibratoAnalysis && vibratoAnalysis.notes.length > 0) {
      const inPhrase = vibratoAnalysis.notes.filter(v => v.startS >= start && v.startS < end);
      if (inPhrase.length > 0) {
        vibrato_consistency =
          inPhrase.filter(v => v.noteScore >= VIBRATO_PRESENT_SCORE).length / inPhrase.length;
      }
    }

    // ── Timbre variation ──
    const centroids = signals.spectralCentroid.window(start, end).map(p => p.v);
    const timbre_variation = Math.sqrt(variance(centroids));

    // ── Structure counts ──
    const slur_count = noteGroups.filter(
      g => g.type === 'slur' && g.start_t < end && g.end_t > start,
    ).length;

    return {
      id,
      start_t: start,
      end_t: end,
      energy_shape,
      peak_location,
      bow_usage,
      intonation: {
        mean_error_cents: Math.round(mean(cents) * 10) / 10,
        variance: Math.round(centsVariance * 10) / 10,
        stability,
      },
      vibrato_consistency,
      timbre_variation: Math.round(timbre_variation * 10) / 10,
      note_count: phraseNotes.length,
      slur_count,
    };
  });
}
