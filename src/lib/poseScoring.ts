/**
 * Pose-based metric scoring for violin analysis.
 *
 * All functions are pure — no MediaPipe dependency here. They accept normalized
 * landmark coordinates (x/y in 0-1, origin top-left) as produced by MediaPipe
 * Pose and Hands models at 2 fps.
 *
 * Coordinates assume a FRONT-FACING (selfie) camera, which mirrors the image:
 *   - Player's right arm (bow arm) → appears on LEFT side of frame (lower x)
 *   - Player's left arm (violin arm) → appears on RIGHT side of frame (higher x)
 *   - rightShoulder.x < leftShoulder.x always
 */

import { severityFromScore, type MetricScore, type MetricKey, type MeasurementQuality, type TechniqueEvent, type FlaggedTimestamp } from '../types/analysis';
import type { InstrumentId } from '../types/instrument';
import type { RawBowFrame, SessionSignals } from '../types/signals';
import { deriveBowTimeSeries, analyzeBowUsage, bowZoneLabel, type BowTimeSeries } from './bowAnalysis';
import { INSTRUMENTS } from '../constants/instruments';

// ─────────────────────────────────────────────────────────────
// Landmark type definitions (MediaPipe format)
// ─────────────────────────────────────────────────────────────

export interface Landmark {
  x: number;       // 0-1, left to right in image
  y: number;       // 0-1, top to bottom in image
  z: number;       // depth (relative, less reliable)
  visibility?: number; // 0-1, confidence
  wx?: number;     // world x (metres relative to wrist, from MediaPipe world landmarks)
  wy?: number;
  wz?: number;
}

// MediaPipe Pose — 33 landmarks
export const POSE = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY_TIP: 17,
  LEFT_INDEX_TIP: 19,
} as const;

// MediaPipe Hands — 21 landmarks per hand
export const HAND = {
  WRIST: 0,
  INDEX_MCP: 5,
  MIDDLE_MCP: 9,
  RING_MCP: 13,
} as const;

export interface FrameKeypoints {
  timestamp: number;                      // seconds into the recording
  poseLandmarks: Landmark[] | null;       // 33 pose landmarks, null if not detected
  leftHandLandmarks: Landmark[] | null;   // 21 hand landmarks, null if not detected
  rightHandLandmarks: Landmark[] | null;  // 21 hand landmarks, null if not detected
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

export const CONFIDENCE_THRESHOLD = 0.6;
const MIN_CONSECUTIVE_FRAMES = 5;

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function deg(radians: number): number {
  return radians * (180 / Math.PI);
}

function visible(lm: Landmark, threshold = CONFIDENCE_THRESHOLD): boolean {
  return lm.visibility === undefined || lm.visibility >= threshold;
}

// Interior angle at joint b (degrees). Returns 180 when points are coincident
// (e.g. arm pointing straight at camera) so foreshortened frames read as "straight".
export function jointAngle(a: Landmark, b: Landmark, c: Landmark): number {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const mag = Math.sqrt((abx ** 2 + aby ** 2) * (cbx ** 2 + cby ** 2));
  if (mag < 0.0001) return 180;
  return deg(Math.acos(Math.max(-1, Math.min(1, (abx * cbx + aby * cby) / mag))));
}


/**
 * Z-component of the palm's unit normal vector computed from MediaPipe world landmarks.
 * Returns null when world coordinates are unavailable (uploaded video, Android, or when
 * the model file is missing). When present:
 *   > 0  → palm faces camera (can see palm creases)
 *   < 0  → back of hand faces camera (dorsal view, typical violin position)
 *   ≈ 0  → palm is edge-on (unreliable for 2D wrist angle)
 * Magnitude encodes how face-on the palm is; |z| < 0.25 means the palm is too
 * edge-on to reliably measure wrist collapse from this view angle.
 */
export function palmNormalZ(hand: Landmark[]): number | null {
  const w = hand[HAND.WRIST];
  const ix = hand[HAND.INDEX_MCP];
  const rg = hand[HAND.RING_MCP];
  if (w?.wx == null || ix?.wx == null || rg?.wx == null) return null;
  const ax = ix.wx - w.wx, ay = ix.wy! - w.wy!, az = ix.wz! - w.wz!;
  const bx = rg.wx - w.wx, by = rg.wy! - w.wy!, bz = rg.wz! - w.wz!;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const mag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  return mag < 0.0001 ? null : cz / mag;
}

/**
 * Interior angle at the violin-arm wrist (elbow→wrist→indexTip) for one frame,
 * with the measurement mode and the intermediate magnitudes the debug HUD reads.
 * Null when the frame lacks the three landmarks or they're below confidence.
 *
 * All three landmarks come from the same MediaPipe Pose world coordinate frame
 * (hip-centred, metres), so the 3D angle is camera-angle-independent and needs no
 * palm-orientation gate. Falls back to the 2D projected angle when world coords
 * are unavailable (e.g. the useMpPose prop is off).
 *
 * Shared by scoreLeftHandWrist (offline) and the live coach, so both read the
 * wrist identically.
 */
export function leftWristAngleFromFrame(frame: FrameKeypoints): {
  angle: number;
  mode: '3D' | '2D';
  cos: number | null;
  magF: number | null;
  magH: number | null;
} | null {
  const pose = frame.poseLandmarks;
  if (!pose) return null;

  const elbow    = pose[POSE.LEFT_ELBOW];
  const wrist    = pose[POSE.LEFT_WRIST];
  const indexTip = pose[POSE.LEFT_INDEX_TIP];
  if (!elbow || !wrist || !indexTip) return null;
  if (!visible(elbow) || !visible(wrist) || !visible(indexTip)) return null;

  if (elbow.wx != null && wrist.wx != null && indexTip.wx != null) {
    const fax = elbow.wx - wrist.wx, fay = elbow.wy! - wrist.wy!, faz = elbow.wz! - wrist.wz!;
    const hx = indexTip.wx - wrist.wx, hy = indexTip.wy! - wrist.wy!, hz = indexTip.wz! - wrist.wz!;
    const magF = Math.sqrt(fax * fax + fay * fay + faz * faz);
    const magH = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (magF < 0.0001 || magH < 0.0001) return null;
    const cosA = Math.max(-1, Math.min(1, (fax * hx + fay * hy + faz * hz) / (magF * magH)));
    return {
      angle: deg(Math.acos(cosA)),
      mode: '3D',
      cos: Math.round(cosA * 100) / 100,
      magF: Math.round(magF * 100),
      magH: Math.round(magH * 100),
    };
  }

  return { angle: jointAngle(elbow, wrist, indexTip), mode: '2D', cos: null, magF: null, magH: null };
}

/**
 * |leftShoulder.y − rightShoulder.y| for one frame — the only posture signal a
 * front-facing camera measures reliably. Null when either shoulder is missing
 * or below confidence. Shared by scorePosture and the live coach.
 */
export function shoulderDiffFromFrame(frame: FrameKeypoints): number | null {
  const pose = frame.poseLandmarks;
  if (!pose) return null;
  const lShoulder = pose[POSE.LEFT_SHOULDER];
  const rShoulder = pose[POSE.RIGHT_SHOULDER];
  if (!lShoulder || !rShoulder) return null;
  if (!visible(lShoulder) || !visible(rShoulder)) return null;
  return Math.abs(lShoulder.y - rShoulder.y);
}

/** Keep only indexes that belong to runs of at least minLength consecutive frames. */
export function filterConsecutiveRuns(indexes: number[], minLength = MIN_CONSECUTIVE_FRAMES): number[] {
  if (indexes.length === 0) return [];
  const sorted = [...indexes].sort((a, b) => a - b);
  const result: number[] = [];
  let runStart = 0;

  for (let i = 1; i <= sorted.length; i++) {
    const endRun = i === sorted.length || sorted[i] !== sorted[i - 1] + 1;
    if (endRun) {
      const runLen = i - runStart;
      if (runLen >= minLength) {
        for (let j = runStart; j < i; j++) result.push(sorted[j]);
      }
      runStart = i;
    }
  }
  return result;
}

function unavailableMetric(key: MetricKey, reason?: string): MetricScore {
  return {
    key,
    score: 0,
    flaggedTimestamps: [],
    severity: 'good',
    events: [],
    occurrenceRate: 0,
    observationSummary: reason ?? 'Bow tracking data not available for this session.',
    measurementQuality: 'unavailable',
  };
}

// Collapse a run of contiguous flagged frames into FlaggedTimestamp spans.
function framesToTimestamps(
  flaggedFrames: number[],
  frameTimestamps: number[],
  note: string,
  minGapSeconds = 0.5,
): FlaggedTimestamp[] {
  if (flaggedFrames.length === 0) return [];
  const result: FlaggedTimestamp[] = [];
  let start = frameTimestamps[flaggedFrames[0]];
  let prev = flaggedFrames[0];

  for (let i = 1; i < flaggedFrames.length; i++) {
    const curr = flaggedFrames[i];
    const gap = frameTimestamps[curr] - frameTimestamps[prev];
    if (gap > minGapSeconds) {
      result.push({ startSeconds: start, endSeconds: frameTimestamps[prev] + 0.5, note });
      start = frameTimestamps[curr];
    }
    prev = curr;
  }
  result.push({ startSeconds: start, endSeconds: frameTimestamps[prev] + 0.5, note });
  return result.slice(0, 6);
}

// Count distinct "entry" events: transitions from good→bad state in flaggedIndexes.
function countEntries(flaggedIndexes: number[]): number {
  if (flaggedIndexes.length === 0) return 0;
  let count = 1;
  for (let i = 1; i < flaggedIndexes.length; i++) {
    if (flaggedIndexes[i] !== flaggedIndexes[i - 1] + 1) count++;
  }
  return count;
}

// Convert flagged timestamp spans to TechniqueEvents.
function timestampsToEvents(
  flaggedTimestamps: FlaggedTimestamp[],
  type: string,
): TechniqueEvent[] {
  return flaggedTimestamps.map((ts) => ({
    type,
    startSeconds: ts.startSeconds,
    endSeconds: ts.endSeconds,
  }));
}

// ─────────────────────────────────────────────────────────────
// Thresholds (calibrate via debug screen once real data exists)
// ─────────────────────────────────────────────────────────────

// Exported so the live coach (src/lib/liveCoach.ts) fires its in-the-moment cues
// off the same numbers the session report is graded on — a tip shown while
// playing must not contradict the verdict shown afterwards.
export const THRESHOLDS = {
  leftHandWrist: {
    // Interior angle at the wrist (elbow→wrist→indexMCP). 180° = straight.
    // Below this threshold the wrist is collapsed inward.
    minStraightAngle: 160,
  },
  posture: {
    // |leftShoulder.y − rightShoulder.y| in normalized frame coords.
    // Violin players have natural asymmetry so this is intentionally lenient.
    shoulderDiff: 0.05,
  },
  bow: {
    // Deviation from the session-median bow angle that triggers a flag.
    // Using session median as baseline makes this camera-angle agnostic.
    angleDeviationDeg: 15,
    // Bow usage bands on the ROBUST range (p95 − p05 of contact point u).
    // Full détaché uses 80%+ of the bow; half-bow playing lands ~0.45-0.55.
    distributionFullRange: 0.75,
    distributionGoodRange: 0.55,
    // Below this the distribution is considered too narrow.
    minDistributionRange: 0.4,
    // Max score when the player camps in one zone of the bow, regardless of
    // how wide the local travel is (needs_attention band).
    campedScoreCap: 55,
    // Minimum bow frames required before a metric is considered reliable.
    minFrames: 5,
    // Placement proxy: allowed drift of the string-diagonal contact position
    // from the player's session median before a frame is flagged.
    placementDriftS: 0.15,
    // Arm level: allowed deviation of shoulder-relative elbow height from the
    // expected height for the string being played (normalized frame units).
    armLevelToleranceY: 0.08,
  },
};

// ─────────────────────────────────────────────────────────────
// Per-metric scoring
// ─────────────────────────────────────────────────────────────

// Bow placement proxy: contact position along the violin-box string diagonal
// (RawBowFrame.stringPosS). Without a bridge detector we can't label absolute
// sul tasto / sul ponticello zones, but drift away from the player's own
// session-median contact position is measurable — quality stays 'low' until
// the bridge detector (Phase 18) provides absolute zones.
function scoreBowPlacement(bow: BowTimeSeries): MetricScore {
  const pts = bow.stringPos.points.filter(p => p.v !== null) as Array<{ t: number; v: number }>;
  if (pts.length < THRESHOLDS.bow.minFrames * 2) {
    return unavailableMetric('bowPlacement', 'Not enough bow-contact frames detected in this session.');
  }

  const sorted = [...pts].map(p => p.v).sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length / 2)];
  const timestamps = pts.map(p => p.t);

  const flaggedIndexes: number[] = [];
  let goodFrames = 0;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].v - baseline) <= THRESHOLDS.bow.placementDriftS) {
      goodFrames++;
    } else {
      flaggedIndexes.push(i);
    }
  }

  const confirmedFlags = filterConsecutiveRuns(flaggedIndexes);
  const score = clamp(Math.round((goodFrames / pts.length) * 100));
  const occurrenceRate = confirmedFlags.length / pts.length;
  const flaggedTimestamps = framesToTimestamps(confirmedFlags, timestamps, 'Contact point drifting along the string');
  const events = timestampsToEvents(flaggedTimestamps, 'bow_placement_drift');

  const entryCount = countEntries(confirmedFlags);
  const observationSummary = entryCount === 0
    ? 'Bow contact point stayed consistent along the string.'
    : `Bow contact point drifted noticeably ${entryCount} ${entryCount === 1 ? 'time' : 'times'} — aim for a steady lane between bridge and fingerboard.`;

  return {
    key: 'bowPlacement',
    score,
    flaggedTimestamps,
    severity: severityFromScore(score),
    events,
    occurrenceRate,
    observationSummary,
    measurementQuality: 'low',
  };
}

function scoreBowAngle(bow: BowTimeSeries): MetricScore {
  const pts = bow.bowAngle.points.filter(p => p.v !== null) as Array<{ t: number; v: number }>;
  if (pts.length < THRESHOLDS.bow.minFrames) {
    return unavailableMetric('bowAngle', 'Not enough bow frames detected in this session.');
  }

  // Session median as baseline — makes this robust to camera tilt/orientation.
  const sorted = [...pts].map(p => p.v).sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length / 2)];
  const timestamps = pts.map(p => p.t);

  const flaggedIndexes: number[] = [];
  let goodFrames = 0;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].v - baseline) <= THRESHOLDS.bow.angleDeviationDeg) {
      goodFrames++;
    } else {
      flaggedIndexes.push(i);
    }
  }

  const confirmedFlags = filterConsecutiveRuns(flaggedIndexes);
  const score = clamp(Math.round((goodFrames / pts.length) * 100));
  const occurrenceRate = confirmedFlags.length / pts.length;
  const flaggedTimestamps = framesToTimestamps(confirmedFlags, timestamps, 'Bow angle deviation — keep the stick more consistent');
  const events = timestampsToEvents(flaggedTimestamps, 'bow_angle_deviation');

  const entryCount = countEntries(confirmedFlags);
  const ratePct = Math.round(occurrenceRate * 100);
  const observationSummary = entryCount === 0
    ? 'Bow stick angle was consistent throughout.'
    : ratePct >= 50
    ? `Bow stick tilted beyond normal range ${ratePct}% of the session.`
    : `Bow angle deviation detected ${entryCount} ${entryCount === 1 ? 'time' : 'times'}.`;

  return {
    key: 'bowAngle',
    score,
    flaggedTimestamps,
    severity: severityFromScore(score),
    events,
    occurrenceRate,
    observationSummary,
    measurementQuality: 'high',
  };
}

// Bow arm level: shoulder-relative elbow height vs the expected height for the
// string currently being played (string inferred from the pitch signal).
// Config semantics: elbowHeightHigh = expected height on the LOWEST string
// (G — elbow raised), elbowHeightLow = on the HIGHEST string (E — elbow drops).
function scoreBowArmLevel(
  _bow: BowTimeSeries,
  instrument: InstrumentId,
  signals?: SessionSignals,
): MetricScore {
  if (!signals) {
    return unavailableMetric('bowArmLevel', 'Bow arm level requires the session signal store.');
  }

  const config = INSTRUMENTS[instrument];
  const strings = config.strings;                 // low → high
  const { elbowHeightLow, elbowHeightHigh } = config.bowArmThresholds;

  // Usable samples: elbow + shoulder + a voiced pitch at the same moment
  type Sample = { t: number; height: number; stringIdx: number };
  const samples: Sample[] = [];
  for (const p of signals.rightElbowY.points) {
    if (p.v === null) continue;
    const shoulderY = signals.rightShoulderY.sample(p.t);
    const pitch = signals.pitch.sample(p.t, 0.2);
    if (shoulderY === null || pitch === null) continue;

    // String from pitch: highest string whose open frequency is below the pitch
    let stringIdx = 0;
    for (let s = strings.length - 1; s >= 0; s--) {
      if (pitch >= strings[s].openFrequency) { stringIdx = s; break; }
    }
    // Height above shoulder (screen y grows downward)
    samples.push({ t: p.t, height: shoulderY - p.v, stringIdx });
  }

  if (samples.length < THRESHOLDS.bow.minFrames * 2) {
    return unavailableMetric('bowArmLevel', 'Not enough frames with both pose and pitch data.');
  }

  const flaggedIndexes: number[] = [];
  const timestamps = samples.map(s => s.t);
  let goodFrames = 0;
  let lowCount = 0;   // elbow below expected band
  for (let i = 0; i < samples.length; i++) {
    const { height, stringIdx } = samples[i];
    // Interpolate expected height: lowest string → elbowHeightHigh, highest → elbowHeightLow
    const frac = strings.length > 1 ? stringIdx / (strings.length - 1) : 0;
    const expected = elbowHeightHigh + (elbowHeightLow - elbowHeightHigh) * frac;
    const dev = height - expected;
    if (Math.abs(dev) <= THRESHOLDS.bow.armLevelToleranceY) {
      goodFrames++;
    } else {
      flaggedIndexes.push(i);
      if (dev < 0) lowCount++;
    }
  }

  const confirmedFlags = filterConsecutiveRuns(flaggedIndexes);
  const score = clamp(Math.round((goodFrames / samples.length) * 100));
  const occurrenceRate = confirmedFlags.length / samples.length;
  const flaggedTimestamps = framesToTimestamps(confirmedFlags, timestamps, 'Bow arm height off for the string being played');
  const events = timestampsToEvents(flaggedTimestamps, 'bow_arm_level');

  const entryCount = countEntries(confirmedFlags);
  const mostlyLow = flaggedIndexes.length > 0 && lowCount / flaggedIndexes.length > 0.6;
  const observationSummary = entryCount === 0
    ? 'Bow arm height tracked the string level well.'
    : mostlyLow
    ? `Bow elbow sat too low for the string being played ${entryCount} ${entryCount === 1 ? 'time' : 'times'} — raise the arm as you move to lower strings.`
    : `Bow arm height didn't match the string level ${entryCount} ${entryCount === 1 ? 'time' : 'times'}.`;

  return {
    key: 'bowArmLevel',
    score,
    flaggedTimestamps,
    severity: severityFromScore(score),
    events,
    occurrenceRate,
    observationSummary,
    measurementQuality: 'low',
  };
}

function scoreBowDistribution(bow: BowTimeSeries): MetricScore {
  const pts = bow.bowContactPoint.points.filter(p => p.v !== null) as Array<{ t: number; v: number }>;
  if (pts.length < THRESHOLDS.bow.minFrames) {
    return unavailableMetric('bowDistribution', 'Not enough bow frames detected in this session.');
  }
  if (!bow.fullBowEverSeen && !bow.calibrated) {
    // Without calibration, no frame ever showed the whole bow, so the
    // contact-point normalization never had a real full-bow length. Once
    // calibrated, the observed range has already been remapped against the
    // player's reference clips.
    return unavailableMetric('bowDistribution', "The bow wasn't visible enough in frame to measure bow distribution reliably. Calibrate first, then keep a clear section of the bow visible.");
  }

  // Percentile coverage + zone occupancy (analyzeBowUsage). Raw min−max range
  // is blind to position — playing only the upper half still sweeps ~50% of
  // the bow — and one glitched frame can fake full-bow travel.
  const usage = analyzeBowUsage(pts.map(p => p.v))!;
  const range = usage.robustRange;

  let score: number;
  if (range >= THRESHOLDS.bow.distributionFullRange) score = 92;
  else if (range >= THRESHOLDS.bow.distributionGoodRange) score = 78;
  else if (range >= THRESHOLDS.bow.minDistributionRange) score = 62;
  else score = 35;

  // Camping in one region caps the score even when the local travel is wide —
  // half the bow used constantly is still half the bow unused.
  const camped = usage.campedZone !== null;
  if (camped) score = Math.min(score, THRESHOLDS.bow.campedScoreCap);

  const pctUsed = Math.round(range * 100);
  const observationSummary = camped
    ? `You stayed in the ${bowZoneLabel(usage.campedZone!)} for ${Math.round(usage.campedShare * 100)}% of the session — practice traveling the full bow from frog to tip.`
    : range >= THRESHOLDS.bow.distributionFullRange
    ? `Using ${pctUsed}% of the bow — excellent range.`
    : range >= THRESHOLDS.bow.distributionGoodRange
    ? `Using ${pctUsed}% of the bow — good range.`
    : range >= THRESHOLDS.bow.minDistributionRange
    ? `Using only ${pctUsed}% of the bow — try to extend to the tip and frog more.`
    : `Using only ${pctUsed}% of the bow — very restricted range.`;

  return {
    key: 'bowDistribution',
    score,
    flaggedTimestamps: [],
    severity: severityFromScore(score),
    events: [],
    occurrenceRate: camped ? usage.campedShare : range < THRESHOLDS.bow.minDistributionRange ? 1.0 : 0,
    observationSummary,
    measurementQuality: 'high',
    // Bow position over time (0=frog, 1=tip) — powers the results-screen graph
    timeSeries: pts,
  };
}

function scoreLeftHandWrist(frames: FrameKeypoints[]): MetricScore {
  const flaggedIndexes: number[] = [];
  const timestamps = frames.map((f) => f.timestamp);
  const timeSeries: Array<{ t: number; v: number }> = [];
  const debugSeries: Array<{ t: number; cos: number | null; magF: number | null; magH: number | null; mode: '3D' | '2D' }> = [];
  let goodFrames = 0;
  let totalFrames = 0;
  let noDataFrames = 0;

  for (let i = 0; i < frames.length; i++) {
    const measured = leftWristAngleFromFrame(frames[i]);
    if (!measured) { noDataFrames++; continue; }

    const { angle, mode, cos, magF, magH } = measured;
    debugSeries.push({ t: timestamps[i], cos, magF, magH, mode });

    totalFrames++;
    timeSeries.push({ t: timestamps[i], v: angle });
    if (angle >= THRESHOLDS.leftHandWrist.minStraightAngle) {
      goodFrames++;
    } else {
      flaggedIndexes.push(i);
    }
  }

  // 3-frame sliding median to smooth the graph display.
  // Violation detection uses frame indices above, so it is unaffected.
  const smoothedTimeSeries = timeSeries.map((pt, i) => {
    const win = timeSeries.slice(Math.max(0, i - 1), i + 2).map(p => p.v).sort((a, b) => a - b);
    return { t: pt.t, v: win[Math.floor(win.length / 2)] };
  });

  const allFrames = totalFrames + noDataFrames;
  const quality: MeasurementQuality =
    allFrames < 5 || totalFrames / Math.max(allFrames, 1) < 0.30 ? 'low' : 'high';

  const confirmedFlags = filterConsecutiveRuns(flaggedIndexes);
  const score = totalFrames > 0 ? clamp(Math.round((goodFrames / totalFrames) * 100)) : 65;
  const occurrenceRate = totalFrames > 0 ? confirmedFlags.length / totalFrames : 0;
  const flaggedTimestamps = framesToTimestamps(confirmedFlags, timestamps, 'Left wrist collapsing inward');
  const events = timestampsToEvents(flaggedTimestamps, 'wrist_collapse');
  const entryCount = countEntries(confirmedFlags);
  const ratePct = Math.round(occurrenceRate * 100);
  const observationSummary =
    totalFrames === 0
      ? 'Left hand was not visible — keep your left wrist in frame for this metric.'
      : entryCount === 0
      ? 'Left wrist stayed well-aligned throughout.'
      : ratePct >= 50
      ? `Left wrist was collapsed ${ratePct}% of the session.`
      : `Left wrist collapsed ${entryCount} ${entryCount === 1 ? 'time' : 'times'}.`;

  // Log every frame so we can inspect from Metro logs.
  // grep for WRIST_DEBUG in the Metro terminal output.
  if (__DEV__ && debugSeries.length > 0) {
    console.log('WRIST_DEBUG', JSON.stringify(debugSeries));
  }

  return {
    key: 'leftHandWrist',
    score,
    flaggedTimestamps,
    severity: severityFromScore(score),
    events,
    occurrenceRate,
    observationSummary,
    measurementQuality: quality,
    timeSeries: smoothedTimeSeries.length >= 2 ? smoothedTimeSeries : undefined,
    debugSeries: debugSeries.length >= 2 ? debugSeries : undefined,
  };
}

function scorePosture(frames: FrameKeypoints[]): MetricScore {
  const flaggedIndexes: number[] = [];
  const timestamps = frames.map((f) => f.timestamp);
  let goodFrames = 0;
  let totalFrames = 0;

  for (let i = 0; i < frames.length; i++) {
    // Violin players must tilt their head to hold the instrument — head position is
    // intentionally excluded. Shoulder level is the only reliable posture signal
    // measurable from a front-facing camera.
    const shoulderDiff = shoulderDiffFromFrame(frames[i]);
    if (shoulderDiff === null) continue;

    totalFrames++;
    if (shoulderDiff <= THRESHOLDS.posture.shoulderDiff) {
      goodFrames++;
    } else {
      flaggedIndexes.push(i);
    }
  }

  const confirmedFlags = filterConsecutiveRuns(flaggedIndexes);
  const score = totalFrames > 0
    ? clamp(Math.round((goodFrames / totalFrames) * 100))
    : 75;
  const occurrenceRate = totalFrames > 0 ? confirmedFlags.length / totalFrames : 0;
  const flaggedTimestamps = framesToTimestamps(confirmedFlags, timestamps, 'Shoulders uneven — try to keep them level');
  const events = timestampsToEvents(flaggedTimestamps, 'shoulder_uneven');
  const ratePct = Math.round(occurrenceRate * 100);
  const observationSummary =
    totalFrames === 0
      ? 'Step back so your shoulders are fully visible for posture assessment.'
      : occurrenceRate === 0
      ? 'Shoulders stayed level throughout the session.'
      : ratePct >= 40
      ? `Shoulder unevenness present ${ratePct}% of the session.`
      : `Uneven shoulders detected ${flaggedTimestamps.length} ${flaggedTimestamps.length === 1 ? 'time' : 'times'}.`;
  return {
    key: 'posture',
    score,
    flaggedTimestamps,
    severity: severityFromScore(score),
    events,
    occurrenceRate,
    observationSummary,
    measurementQuality: 'high',
  };
}

// ─────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────

/**
 * Score all video-based metrics from pose frames and bow detector output.
 *
 * @param frames    Normalized FrameKeypoints[] (after preparePoseFramesForScoring).
 * @param bowFrames RawBowFrame[] from the native bow detector. Pass [] when
 *                  bow data is unavailable — bow metrics gracefully return
 *                  measurementQuality: 'unavailable'.
 * @param instrument Instrument config key.
 * @param bowSeries Optional precomputed bow series, already calibrated when
 *                  calibration is available.
 */
export function scorePoseMetrics(
  frames: FrameKeypoints[],
  bowFrames: RawBowFrame[],
  instrument: InstrumentId,
  _duration: number,
  signals?: SessionSignals,
  bowSeries?: BowTimeSeries,
): MetricScore[] {
  if (frames.length === 0) return [];
  const bow = bowSeries ?? deriveBowTimeSeries(bowFrames);
  // bowArmLevel and leftHandWrist are intentionally excluded — their camera
  // measurement isn't reliable enough yet (see the exercise catalog's same
  // exclusion note in practiceBlocks.ts). scoreBowArmLevel/scoreLeftHandWrist
  // are left defined, unused, for when a reliable replacement exists.
  return [
    scoreBowPlacement(bow),
    scoreBowAngle(bow),
    scoreBowDistribution(bow),
    scorePosture(frames),
  ];
}
