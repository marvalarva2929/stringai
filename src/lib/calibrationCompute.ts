import type { RawBowFrame } from '../types/signals';
import type { BowCalibration } from '../types/calibration';
import { deriveBowTimeSeries, percentile } from './bowAnalysis';

// Roughly a bar, not a rubber stamp: at ~10fps a 2-3s capture yields ~20-30
// raw frames, so requiring 8 qualifying (non-null) readings rejects a
// genuinely bad capture without demanding a perfectly steady hold.
const MIN_QUALIFYING_SAMPLES = 8;
// Reject when the two observed fractions read almost the same — the player
// didn't actually move the bow between the two captures.
const MIN_FRACTION_SEPARATION = 0.1;

export interface CalibrationError {
  error: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

function nonNull(values: Array<number | null>): number[] {
  return values.filter((v): v is number => v !== null);
}

/**
 * Runs both reference clips through deriveBowTimeSeries() and reads off where
 * each landed. bridgeTipClip = bow near tip, contact near bridge.
 * fingerboardFrogClip = bow near frog, contact near fingerboard.
 */
export function computeCalibration(
  bridgeTipClip: RawBowFrame[],
  fingerboardFrogClip: RawBowFrame[],
): BowCalibration | CalibrationError {
  const series1 = deriveBowTimeSeries(bridgeTipClip);        // position 1: near tip / near bridge
  const series2 = deriveBowTimeSeries(fingerboardFrogClip);  // position 2: near frog / near fingerboard

  const cp1 = nonNull(series1.bowContactPoint.points.map((p) => p.v));
  const cp2 = nonNull(series2.bowContactPoint.points.map((p) => p.v));
  if (cp1.length < MIN_QUALIFYING_SAMPLES) {
    return { error: "Couldn't get a clean bow-position reading for position 1. Keep a clear section of the bow visible on the strings, then try again." };
  }
  if (cp2.length < MIN_QUALIFYING_SAMPLES) {
    return { error: "Couldn't get a clean bow-position reading for position 2. Keep a clear section of the bow visible on the strings, then try again." };
  }

  const sp1 = nonNull(series1.stringPos.points.map((p) => p.v));
  const sp2 = nonNull(series2.stringPos.points.map((p) => p.v));
  if (sp1.length < MIN_QUALIFYING_SAMPLES) {
    return { error: "Couldn't get a clean contact-point reading near the bridge — make sure the bow is clearly touching the string, then try again." };
  }
  if (sp2.length < MIN_QUALIFYING_SAMPLES) {
    return { error: "Couldn't get a clean contact-point reading near the fingerboard — make sure the bow is clearly touching the string, then try again." };
  }

  const tipFraction = median(cp1);
  const frogFraction = median(cp2);
  const bridgeFraction = median(sp1);
  const fingerboardFraction = median(sp2);

  if (Math.abs(tipFraction - frogFraction) < MIN_FRACTION_SEPARATION) {
    return { error: "The two bow positions read almost the same — move the bow clearly between the frog and the tip, then try again." };
  }
  if (Math.abs(bridgeFraction - fingerboardFraction) < MIN_FRACTION_SEPARATION) {
    return { error: "The two contact points read almost the same — move the bow clearly between the bridge and the fingerboard, then try again." };
  }

  return { frogFraction, tipFraction, fingerboardFraction, bridgeFraction, calibratedAt: Date.now() };
}

export function isCalibrationError(result: BowCalibration | CalibrationError): result is CalibrationError {
  return 'error' in result;
}
