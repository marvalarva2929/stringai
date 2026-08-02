/**
 * Two reference captures (bow near tip/contact near bridge, then bow near
 * frog/contact near fingerboard) recording where those positions land in
 * `deriveBowTimeSeries`'s raw 0-1 output. `applyCalibration()` (bowAnalysis.ts)
 * rescales bowContactPoint/stringPos against these values.
 */
export interface BowCalibration {
  /** Raw (uncalibrated) bowContactPoint value observed with the bow near the frog. */
  frogFraction: number;
  /** Raw bowContactPoint value observed with the bow near the tip. */
  tipFraction: number;
  /** Raw stringPos value observed with the contact point near the fingerboard. */
  fingerboardFraction: number;
  /** Raw stringPos value observed with the contact point near the bridge. */
  bridgeFraction: number;
  /** Epoch ms — display-only ("last calibrated 3 days ago"), no forced expiry. */
  calibratedAt: number;
}
