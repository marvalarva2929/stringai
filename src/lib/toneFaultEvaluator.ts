import { detectPitches } from '../services/dsp';
import { extractToneFrameFeatures, classifyFrames, type ToneFrameFeatures } from '../services/toneAnalysis';
import type { ToneFault } from '../types/analysis';
import type { PracticeEvaluation } from './practiceEvaluator';

// toneAnalysis.ts's extractToneFrameFeatures hops every 50ms (HOP_S) — 20
// windows covers ~1s of playing per judged attempt.
const FRAMES_PER_WINDOW = 20;

export interface ToneFaultTarget {
  /** Faults that fail a window. Omit to fail on any non-clean fault. */
  disallowedFaults?: Exclude<ToneFault, 'clean'>[];
  requiredCleanFraction: number;
  /** Average YIN periodicity a window needs to count — filters out noise/silence blips. */
  minConfidence?: number;
}

/**
 * Judges a captured take for the sustained tone faults classifyFrames can
 * actually decide (scratch/rasp/thin — see its doc comment). Chunks the clip
 * into ~1s windows and requires the given fraction to come back clean.
 */
export function evaluateToneFault(
  samples: Float32Array,
  sampleRate: number,
  target: ToneFaultTarget,
): PracticeEvaluation {
  const minConfidence = target.minConfidence ?? 0.35;
  const pitches = detectPitches(samples, sampleRate);
  const frames = extractToneFrameFeatures(samples, sampleRate, pitches);
  const voiced = frames.filter((f) => f.voiced);

  const windows: ToneFrameFeatures[][] = [];
  for (let i = 0; i < voiced.length; i += FRAMES_PER_WINDOW) {
    windows.push(voiced.slice(i, i + FRAMES_PER_WINDOW));
  }
  const usable = windows.filter((w) => avgPeriodicity(w) >= minConfidence);

  if (usable.length === 0) {
    return {
      passed: false,
      attempts: 0,
      successCount: 0,
      bestStreak: 0,
      feedback: 'Mic tracking was not confident enough to judge this take. Play a longer, steadier stroke closer to the mic.',
    };
  }

  const disallowed = target.disallowedFaults ?? null;
  let successCount = 0;
  let streak = 0;
  let bestStreak = 0;
  let lastFault: Exclude<ToneFault, 'clean'> | null = null;

  for (const w of usable) {
    const fault = classifyFrames(w);
    const good = fault === null || (disallowed !== null && !disallowed.includes(fault));
    if (good) {
      successCount += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else {
      streak = 0;
      lastFault = fault;
    }
  }

  const fraction = successCount / usable.length;
  const passed = fraction >= target.requiredCleanFraction;
  return {
    passed,
    attempts: usable.length,
    successCount,
    bestStreak,
    feedback: passed
      ? `Passed: ${Math.round(fraction * 100)}% of the take was clean.`
      : toneMissFeedback(lastFault, fraction, target.requiredCleanFraction),
  };
}

function avgPeriodicity(frames: ToneFrameFeatures[]): number {
  if (frames.length === 0) return 0;
  return frames.reduce((sum, f) => sum + f.P, 0) / frames.length;
}

function toneMissFeedback(fault: Exclude<ToneFault, 'clean'> | null, fraction: number, required: number): string {
  const pct = Math.round(fraction * 100);
  const requiredPct = Math.round(required * 100);
  if (!fault) return `${pct}% clean, need ${requiredPct}%. Keep working on a steady, even stroke.`;
  const label = fault === 'thin' ? 'thin and airy' : fault === 'scratch' ? 'scratchy' : 'a bit rough';
  return `Tone was ${label} for part of the take (${pct}% clean, need ${requiredPct}%).`;
}
