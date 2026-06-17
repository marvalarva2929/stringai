import { FrameKeypoints, Landmark, POSE, HAND, scorePoseMetrics, CONFIDENCE_THRESHOLD } from '../lib/poseScoring';
import { preparePoseFramesForScoring } from '../lib/poseFramePrep';
import { MetricScore, MeasurementQuality } from '../types/analysis';
import { PoseJoints, HandLandmarks, PoseJoint } from '../components/analysis/PoseSkeleton';
import { InstrumentId } from '../types/instrument';
import { analyzeVideo } from 'pose-camera';

// Minimum shoulder width in raw screen coordinates (0-1) for reliable measurement.
// Below this, the camera angle is too oblique or the player is too far away.
const MIN_SHOULDER_WIDTH_RAW = 0.15;

// Placeholder for landmarks we don't capture — visibility: 0 causes poseScoring.ts
// to skip them via the visible() check (threshold 0.5).
const INVISIBLE: Landmark = { x: 0, y: 0, z: 0, visibility: 0 };

// Vision/MediaPipe x coordinates are non-mirrored. poseScoring.ts expects mirrored
// (display) coordinates where rightShoulder.x < leftShoulder.x. Flip x here.
// World coords (wx/wy/wz) are camera-space metres from MediaPipe — no flip needed.
function toL(j: PoseJoint): Landmark {
  return { x: 1 - j.x, y: j.y, z: 0, visibility: j.confidence, wx: j.wx, wy: j.wy, wz: j.wz };
}

/**
 * Convert a single onPose native event (named joints) into a FrameKeypoints
 * (index-addressed array) ready for scorePoseMetrics().
 */
export function convertPoseFrame(
  joints: PoseJoints,
  leftHand: HandLandmarks | null,
  rightHand: HandLandmarks | null,
  timestamp: number,
): FrameKeypoints {
  const hasAnyPose = Object.keys(joints).length > 0;

  let poseLandmarks: Landmark[] | null = null;
  if (hasAnyPose) {
    const pose: Landmark[] = new Array(33).fill(INVISIBLE);
    if (joints.leftShoulder)  pose[POSE.LEFT_SHOULDER]  = toL(joints.leftShoulder);
    if (joints.rightShoulder) pose[POSE.RIGHT_SHOULDER] = toL(joints.rightShoulder);
    if (joints.leftElbow)     pose[POSE.LEFT_ELBOW]     = toL(joints.leftElbow);
    if (joints.rightElbow)    pose[POSE.RIGHT_ELBOW]    = toL(joints.rightElbow);
    if (joints.leftWrist)     pose[POSE.LEFT_WRIST]     = toL(joints.leftWrist);
    if (joints.rightWrist)    pose[POSE.RIGHT_WRIST]    = toL(joints.rightWrist);
    // Vision provides neck, not nose — map neck to POSE.NOSE for head-tilt scoring.
    if (joints.neck)          pose[POSE.NOSE]           = toL(joints.neck);
    poseLandmarks = pose;
  }

  const toHandLandmarks = (hand: HandLandmarks | null): Landmark[] | null => {
    if (!hand || !hand.wrist) return null;
    const arr: Landmark[] = new Array(21).fill(INVISIBLE);
    if (hand.wrist)     arr[HAND.WRIST]      = toL(hand.wrist);
    if (hand.indexMCP)  arr[HAND.INDEX_MCP]  = toL(hand.indexMCP);
    if (hand.middleMCP) arr[HAND.MIDDLE_MCP] = toL(hand.middleMCP);
    if (hand.ringMCP)   arr[HAND.RING_MCP]   = toL(hand.ringMCP);
    return arr;
  };

  return {
    timestamp,
    poseLandmarks,
    leftHandLandmarks: toHandLandmarks(leftHand),
    rightHandLandmarks: toHandLandmarks(rightHand),
  };
}

/**
 * Assess overall visibility quality from RAW (un-normalized) screen-space frames.
 * Returns 'low' if fewer than 40% of frames have both shoulders clearly visible.
 * Must be called before preparePoseFramesForScoring — body-normalized frames always
 * have shoulderWidth ≈ 1.0, making this check meaningless after normalization.
 */
function assessFrameQuality(frames: FrameKeypoints[]): MeasurementQuality {
  if (frames.length === 0) return 'unavailable';
  let goodFrames = 0;
  for (const frame of frames) {
    const pose = frame.poseLandmarks;
    if (!pose) continue;
    const lS = pose[POSE.LEFT_SHOULDER];
    const rS = pose[POSE.RIGHT_SHOULDER];
    if (!lS || !rS) continue;
    if ((lS.visibility ?? 0) < CONFIDENCE_THRESHOLD || (rS.visibility ?? 0) < CONFIDENCE_THRESHOLD) continue;
    const shoulderWidth = Math.abs(lS.x - rS.x);
    if (shoulderWidth >= MIN_SHOULDER_WIDTH_RAW) goodFrames++;
  }
  return goodFrames / frames.length >= 0.4 ? 'high' : 'low';
}

export function scorePoseFrames(
  frames: FrameKeypoints[],
  instrument: InstrumentId,
  durationSeconds: number,
): MetricScore[] {
  if (frames.length < 5) return [];
  const quality = assessFrameQuality(frames);
  const prepared = preparePoseFramesForScoring(frames);
  if (prepared.length < 5) return [];
  const metrics = scorePoseMetrics(prepared, [], instrument, durationSeconds);
  if (quality === 'low') {
    return metrics.map((m) =>
      m.measurementQuality === 'unavailable' ? m : { ...m, measurementQuality: 'low' as MeasurementQuality },
    );
  }
  return metrics;
}

/**
 * Extract pose frames from an existing video file by running Apple Vision at 5 fps.
 * Used for the uploaded-video path where no live onPose events were collected.
 * Returns [] on Android or when the module is unavailable.
 */
export async function extractVideoFrames(videoUri: string): Promise<FrameKeypoints[]> {
  const rawFrames: any[] = await analyzeVideo(videoUri);
  if (!rawFrames || rawFrames.length === 0) return [];
  return rawFrames.map((f) =>
    convertPoseFrame(f.joints ?? {}, f.leftHand ?? null, f.rightHand ?? null, f.timestamp ?? 0),
  );
}
