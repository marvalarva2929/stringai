import { computeRmsEnvelope } from '../services/dsp';
import type { PracticeEvaluation } from './practiceEvaluator';

export type DynamicsShape = 'crescendo' | 'diminuendo' | 'swell' | 'steady';

export interface DynamicsShapeTarget {
  shape: DynamicsShape;
  minRangeDb?: number;
}

function classifyShape(db: number[]): { shape: DynamicsShape; rangeDb: number } {
  const minDb = Math.min(...db);
  const maxDb = Math.max(...db);
  const rangeDb = maxDb - minDb;
  if (rangeDb < 4) return { shape: 'steady', rangeDb };

  const peakPos = db.indexOf(maxDb) / Math.max(1, db.length - 1);
  if (peakPos < 0.3) return { shape: 'diminuendo', rangeDb };
  if (peakPos > 0.7) return { shape: 'crescendo', rangeDb };
  return { shape: 'swell', rangeDb };
}

/** Judges a take's loudness shape (crescendo/diminuendo/swell/steady) against a target. */
export function evaluateDynamicsShape(
  samples: Float32Array,
  sampleRate: number,
  target: DynamicsShapeTarget,
): PracticeEvaluation {
  const rms = computeRmsEnvelope(samples, Math.round(sampleRate * 0.05), Math.round(sampleRate * 0.02));
  const db = Array.from(rms).filter((v) => v > 1e-4).map((v) => 20 * Math.log10(v));

  if (db.length < 10) {
    return { passed: false, attempts: 0, successCount: 0, bestStreak: 0, feedback: 'No sustained sound was captured — try again.' };
  }

  const { shape, rangeDb } = classifyShape(db);
  const minRangeDb = target.minRangeDb ?? 6;
  const passed = shape === target.shape && rangeDb >= minRangeDb;

  return {
    passed,
    attempts: db.length,
    successCount: passed ? db.length : 0,
    bestStreak: passed ? db.length : 0,
    feedback: passed
      ? `Passed: clear ${target.shape} shape (${rangeDb.toFixed(1)}dB range).`
      : `Heard a ${shape} shape with ${rangeDb.toFixed(1)}dB range — aim for a clearer ${target.shape}.`,
  };
}
