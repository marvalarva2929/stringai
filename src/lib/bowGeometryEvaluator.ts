import type { RawBowFrame } from '../types/signals';
import type { BowCalibration } from '../types/calibration';
import { deriveBowTimeSeries, applyCalibration, analyzeBowUsage, bowZoneLabel, type BowTimeSeries } from './bowAnalysis';
import { evaluateBowControl, type BowControlSample, type PracticeEvaluation } from './practiceEvaluator';

export type BowGeometrySignal = 'bowAngle' | 'bowContactPoint' | 'stringPos' | 'bowDistribution';

export interface BowGeometryTarget {
  signal: BowGeometrySignal;
  // bowAngle / bowContactPoint / stringPos
  minValue?: number;
  maxValue?: number;
  requiredGoodFraction?: number;
  minConfidence?: number;
  // bowDistribution
  minRobustRange?: number;
}

// stringPos/bowDistribution are meaningless without calibration's real
// bridge/fingerboard/frog/tip range; bowAngle is a pure geometric angle and
// doesn't need it, bowContactPoint benefits silently but isn't blocked.
const CALIBRATION_REQUIRED: BowGeometrySignal[] = ['stringPos', 'bowDistribution'];

const UNCALIBRATED_EVALUATION: PracticeEvaluation = {
  passed: false,
  attempts: 0,
  successCount: 0,
  bestStreak: 0,
  feedback: 'This exercise needs bow calibration first. Calibrate, then try again.',
};

export function evaluateBowGeometry(
  rawFrames: RawBowFrame[],
  calibration: BowCalibration | null,
  target: BowGeometryTarget,
): PracticeEvaluation {
  if (CALIBRATION_REQUIRED.includes(target.signal) && !calibration) {
    return UNCALIBRATED_EVALUATION;
  }

  const series = applyCalibration(deriveBowTimeSeries(rawFrames), calibration);

  if (target.signal === 'bowDistribution') {
    return evaluateBowDistribution(series, target);
  }

  const points = target.signal === 'bowAngle' ? series.bowAngle.points
    : target.signal === 'bowContactPoint' ? series.bowContactPoint.points
    : series.stringPos.points;

  const samples: BowControlSample[] = points.map((p) => ({ value: p.v, confidence: 1 }));
  return evaluateBowControl(samples, {
    minValue: target.minValue ?? -Infinity,
    maxValue: target.maxValue ?? Infinity,
    requiredGoodFraction: target.requiredGoodFraction ?? 0.7,
    minConfidence: target.minConfidence,
  });
}

function evaluateBowDistribution(series: BowTimeSeries, target: BowGeometryTarget): PracticeEvaluation {
  const values = series.bowContactPoint.points.map((p) => p.v).filter((v): v is number => v !== null);
  const usage = analyzeBowUsage(values);
  const minRobustRange = target.minRobustRange ?? 0.6;

  if (!usage) {
    return {
      passed: false,
      attempts: 0,
      successCount: 0,
      bestStreak: 0,
      feedback: 'Camera tracking was not confident enough to judge this take.',
    };
  }

  const passed = usage.robustRange >= minRobustRange && !usage.campedZone;
  return {
    passed,
    attempts: usage.n,
    successCount: passed ? usage.n : 0,
    bestStreak: passed ? usage.n : 0,
    feedback: passed
      ? `Passed: used ${Math.round(usage.robustRange * 100)}% of the bow.`
      : usage.campedZone
        ? `Camped in the ${bowZoneLabel(usage.campedZone)} — use more of the bow.`
        : `Used ${Math.round(usage.robustRange * 100)}% of the bow, need ${Math.round(minRobustRange * 100)}%.`,
  };
}
