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

import { MetricScore, MetricKey, MeasurementQuality, TechniqueEvent, FlaggedTimestamp, severityFromScore } from '../types/analysis';
import { InstrumentId } from '../types/instrument';

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
const MIN_CONSECUTIVE_FRAMES = 3;

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

const UNAVAILABLE_BOW_MSG =
  'Requires bow tracking — not available until a bow detector is integrated.';

function unavailableMetric(key: MetricKey): MetricScore {
  return {
    key,
    score: 0,
    flaggedTimestamps: [],
    severity: 'good',
    events: [],
    occurrenceRate: 0,
    observationSummary: UNAVAILABLE_BOW_MSG,
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

const THRESHOLDS = {
  leftHandWrist: {
    // Interior angle at the wrist (elbow→wrist→indexMCP). 180° = straight.
    // Below this threshold the wrist is collapsed inward.
    minStraightAngle: 160,
  },
  posture: {
    shoulderDiff: 0.04,
    headTilt: 0.15,
  },
};

// ─────────────────────────────────────────────────────────────
// Per-metric scoring
// ─────────────────────────────────────────────────────────────

function scoreBowPlacement(_frames: FrameKeypoints[]): MetricScore {
  return unavailableMetric('bowPlacement');
}

function scoreBowAngle(_frames: FrameKeypoints[]): MetricScore {
  return unavailableMetric('bowAngle');
}

function scoreBowArmLevel(_frames: FrameKeypoints[], _instrument: InstrumentId): MetricScore {
  return unavailableMetric('bowArmLevel');
}

function scoreBowDistribution(_frames: FrameKeypoints[]): MetricScore {
  return unavailableMetric('bowDistribution');
}

function scoreLeftHandWrist(frames: FrameKeypoints[]): MetricScore {
  const flaggedIndexes: number[] = [];
  const timestamps = frames.map((f) => f.timestamp);
  let goodFrames = 0;
  let totalFrames = 0;
  let noDataFrames = 0;

  for (let i = 0; i < frames.length; i++) {
    const pose     = frames[i].poseLandmarks;
    const leftHand = frames[i].leftHandLandmarks;
    if (!pose || !leftHand) { noDataFrames++; continue; }

    const elbow    = pose[POSE.LEFT_ELBOW];
    const wrist    = pose[POSE.LEFT_WRIST];
    const indexMcp = leftHand[HAND.INDEX_MCP];
    if (!elbow || !wrist || !indexMcp) { noDataFrames++; continue; }
    if (!visible(elbow) || !visible(wrist) || !visible(indexMcp)) { noDataFrames++; continue; }

    // Skip frames outside the calibrated palm orientation window (-0.25 to 0).
    // Only active when MediaPipe world coords are available; falls back to scoring
    // all frames when they are not (e.g. uploaded video, Vision-only path).
    const pnz = palmNormalZ(leftHand);
    if (pnz !== null && (pnz > 0 || pnz < -0.25)) { noDataFrames++; continue; }

    // Interior angle at the wrist between the forearm (elbow→wrist) and the hand
    // (wrist→indexMCP). 180° = straight; below threshold = collapsed.
    // When the arm points at the camera the projection foreshortens to a line, so
    // the measured angle stays near 180° — no false positives at bad angles.
    const angle = jointAngle(elbow, wrist, indexMcp);
    totalFrames++;
    if (angle >= THRESHOLDS.leftHandWrist.minStraightAngle) {
      goodFrames++;
    } else {
      flaggedIndexes.push(i);
    }
  }

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

  return {
    key: 'leftHandWrist',
    score,
    flaggedTimestamps,
    severity: severityFromScore(score),
    events,
    occurrenceRate,
    observationSummary,
    measurementQuality: quality,
  };
}

function scorePosture(frames: FrameKeypoints[]): MetricScore {
  const flaggedIndexes: number[] = [];
  const timestamps = frames.map((f) => f.timestamp);
  let goodFrames = 0;
  let totalFrames = 0;

  for (let i = 0; i < frames.length; i++) {
    const pose = frames[i].poseLandmarks;
    if (!pose) continue;

    const lShoulder = pose[POSE.LEFT_SHOULDER];
    const rShoulder = pose[POSE.RIGHT_SHOULDER];
    const nose = pose[POSE.NOSE];
    if (!visible(lShoulder) || !visible(rShoulder) || !visible(nose)) continue;

    const shoulderWidth = Math.abs(lShoulder.x - rShoulder.x);
    const shoulderDiff = Math.abs(lShoulder.y - rShoulder.y);
    const midX = (lShoulder.x + rShoulder.x) / 2;
    const headTilt = Math.abs(nose.x - midX) / shoulderWidth;

    totalFrames++;
    const isShoulderUneven = shoulderDiff > THRESHOLDS.posture.shoulderDiff;
    const isHeadTilted = headTilt > THRESHOLDS.posture.headTilt;

    if (!isShoulderUneven && !isHeadTilted) {
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
  const flaggedTimestamps = framesToTimestamps(confirmedFlags, timestamps, 'Posture issue — check shoulders and head position');
  const events = timestampsToEvents(flaggedTimestamps, 'shoulder_raised');
  const ratePct = Math.round(occurrenceRate * 100);
  const observationSummary =
    totalFrames === 0
      ? 'Step back so your shoulders are fully visible for posture assessment.'
      : occurrenceRate === 0
      ? 'Posture was well-balanced throughout the session.'
      : ratePct >= 40
      ? `Posture issues present ${ratePct}% of the session.`
      : `Posture issues detected ${flaggedTimestamps.length} ${flaggedTimestamps.length === 1 ? 'time' : 'times'}.`;
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
 * Score all video-based metrics from an array of per-frame pose keypoints.
 *
 * Called from runVideoAnalysis() once MediaPipe is integrated:
 *   const frames = await sampleFramesWithMediaPipe(videoUri, 2); // 2 fps
 *   return scorePoseMetrics(frames, audioMetrics, instrument, duration);
 */
export function scorePoseMetrics(
  frames: FrameKeypoints[],
  _audioMetrics: MetricScore[],
  instrument: InstrumentId,
  _duration: number,
): MetricScore[] {
  if (frames.length === 0) return [];
  return [
    scoreBowPlacement(frames),
    scoreBowAngle(frames),
    scoreBowArmLevel(frames, instrument),
    scoreBowDistribution(frames),
    scoreLeftHandWrist(frames),
    scorePosture(frames),
  ];
}
