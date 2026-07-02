import { AudioAnalysisOutput } from '../types/analysis';
import {
  RawBowFrame,
  SessionSignals,
  TimeSeriesPoint,
  createTimeSeries,
} from '../types/signals';
import { NoteEvent } from './noteFusion';
import { FrameKeypoints, POSE, HAND, jointAngle } from './poseScoring';
import { deriveBowTimeSeries } from './bowAnalysis';

// ─────────────────────────────────────────────────────────────
// Pose time series extraction
// ─────────────────────────────────────────────────────────────

interface PoseTimeSeries {
  leftWristAngle: Array<TimeSeriesPoint<number | null>>;
  rightElbowY:    Array<TimeSeriesPoint<number | null>>;
  shoulderDiff:   Array<TimeSeriesPoint<number | null>>;
}

function extractPoseTimeSeries(frames: FrameKeypoints[]): PoseTimeSeries {
  const leftWristAngle: Array<TimeSeriesPoint<number | null>> = [];
  const rightElbowY:    Array<TimeSeriesPoint<number | null>> = [];
  const shoulderDiff:   Array<TimeSeriesPoint<number | null>> = [];

  for (const f of frames) {
    const pose     = f.poseLandmarks;
    const leftHand = f.leftHandLandmarks;

    // Left wrist angle: interior angle at the violin-arm wrist (elbow→wrist→indexMCP)
    let wristAngle: number | null = null;
    if (pose && leftHand) {
      const elbow    = pose[POSE.LEFT_ELBOW];
      const wrist    = pose[POSE.LEFT_WRIST];
      const indexMcp = leftHand[HAND.INDEX_MCP];
      if (elbow?.visibility && wrist?.visibility && indexMcp?.visibility) {
        wristAngle = jointAngle(elbow, wrist, indexMcp);
      }
    }

    // Right elbow Y: bow-arm level indicator
    let elbowY: number | null = null;
    if (pose) {
      const re = pose[POSE.RIGHT_ELBOW];
      if (re?.visibility) elbowY = re.y;
    }

    // Shoulder diff: absolute y-difference between shoulders
    let sDiff: number | null = null;
    if (pose) {
      const lS = pose[POSE.LEFT_SHOULDER];
      const rS = pose[POSE.RIGHT_SHOULDER];
      if (lS?.visibility && rS?.visibility) {
        sDiff = Math.abs(lS.y - rS.y);
      }
    }

    leftWristAngle.push({ t: f.timestamp, v: wristAngle });
    rightElbowY.push(   { t: f.timestamp, v: elbowY    });
    shoulderDiff.push(  { t: f.timestamp, v: sDiff     });
  }

  return { leftWristAngle, rightElbowY, shoulderDiff };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Assemble a SessionSignals object from all signal sources.
 *
 * @param audioOutput     Result of analyzeMediaFile — contains rawSignals.
 * @param poseFrames      FrameKeypoints[] from convertPoseFrame (already converted).
 * @param bowFrames       RawBowFrame[] extracted from the native frame dicts.
 * @param noteEvents      NoteEvent[] from noteFusion (audio-only fields).
 * @param durationSeconds Session duration in seconds.
 */
export function buildSessionSignals(
  audioOutput:      AudioAnalysisOutput,
  poseFrames:       FrameKeypoints[],
  bowFrames:        RawBowFrame[],
  noteEvents:       NoteEvent[],
  durationSeconds:  number,
): SessionSignals {
  const { rawSignals } = audioOutput;

  // ── Audio time series ────────────────────────────────────────
  const pitch = createTimeSeries(
    rawSignals.pitchFrames.map(f => ({ t: f.timestamp, v: f.frequency })),
  );
  const rms = createTimeSeries(
    rawSignals.rmsFrames.map(f => ({ t: f.timestamp, v: f.value })),
  );
  const fundamentalRatio = createTimeSeries(
    rawSignals.toneFrames.map(f => ({ t: f.timestamp, v: f.fundamentalRatio })),
  );
  const spectralCentroid = createTimeSeries(
    rawSignals.spectralCentroidFrames.map(f => ({ t: f.timestamp, v: f.value })),
  );
  const brightness = createTimeSeries(
    rawSignals.brightnessFrames.map(f => ({ t: f.timestamp, v: f.value })),
  );

  // ── Pose time series ────────────────────────────────────────
  const { leftWristAngle, rightElbowY, shoulderDiff } = extractPoseTimeSeries(poseFrames);

  // ── Bow time series ─────────────────────────────────────────
  const bow = deriveBowTimeSeries(bowFrames);

  return {
    durationSeconds,
    pitch,
    rms,
    fundamentalRatio,
    spectralCentroid,
    brightness,
    leftWristAngle: createTimeSeries(leftWristAngle),
    rightElbowY:    createTimeSeries(rightElbowY),
    shoulderDiff:   createTimeSeries(shoulderDiff),
    bowContactPoint: bow.bowContactPoint,
    bowAngle:        bow.bowAngle,
    bowSpeed:        bow.bowSpeed,
    noteEvents,
  };
}
