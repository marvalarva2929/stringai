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
  /**
   * True only when the camera saw no bow whatsoever across *both* clips — no
   * qualifying reading, not one frame.
   *
   * This is the line between "we can't calibrate from this" and "there was
   * nothing to calibrate from". Everything short of the latter is a soft
   * failure: the player did the take, the camera saw a bow, it just wasn't
   * clean or separated enough to derive a scale from. Sending them back to do
   * the holds again over that is what made calibration feel like a wall in
   * beta, so BowCalibrationFlow continues uncalibrated instead and only ever
   * asks for a redo when this flag is set.
   */
  nothingDetected: boolean;
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
  const sp1 = nonNull(series1.stringPos.points.map((p) => p.v));
  const sp2 = nonNull(series2.stringPos.points.map((p) => p.v));

  // The one hard failure: the camera never found a bow in either clip. Any
  // other outcome below is soft — see CalibrationError.nothingDetected.
  if (cp1.length === 0 && cp2.length === 0 && sp1.length === 0 && sp2.length === 0) {
    return {
      error: "The camera didn't pick up a bow at all. Check the phone can see you and your bow, then run it again.",
      nothingDetected: true,
    };
  }

  if (cp1.length < MIN_QUALIFYING_SAMPLES) {
    return { error: "Couldn't get a clean bow-position reading for position 1.", nothingDetected: false };
  }
  if (cp2.length < MIN_QUALIFYING_SAMPLES) {
    return { error: "Couldn't get a clean bow-position reading for position 2.", nothingDetected: false };
  }
  if (sp1.length < MIN_QUALIFYING_SAMPLES) {
    return { error: "Couldn't get a clean contact-point reading near the bridge.", nothingDetected: false };
  }
  if (sp2.length < MIN_QUALIFYING_SAMPLES) {
    return { error: "Couldn't get a clean contact-point reading near the fingerboard.", nothingDetected: false };
  }

  const tipFraction = median(cp1);
  const frogFraction = median(cp2);
  const bridgeFraction = median(sp1);
  const fingerboardFraction = median(sp2);

  if (Math.abs(tipFraction - frogFraction) < MIN_FRACTION_SEPARATION) {
    return { error: 'The two bow positions read almost the same.', nothingDetected: false };
  }
  if (Math.abs(bridgeFraction - fingerboardFraction) < MIN_FRACTION_SEPARATION) {
    return { error: 'The two contact points read almost the same.', nothingDetected: false };
  }

  return { frogFraction, tipFraction, fingerboardFraction, bridgeFraction, calibratedAt: Date.now() };
}

export function isCalibrationError(result: BowCalibration | CalibrationError): result is CalibrationError {
  return 'error' in result;
}
