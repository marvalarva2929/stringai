import { FrameKeypoints, Landmark, POSE, HAND } from '../lib/poseScoring';
import { PoseJoints, HandLandmarks, PoseJoint } from '../components/analysis/PoseSkeleton';
import { RawBowFrame } from '../types/signals';
import { deriveBowFrameFromBoxes } from '../lib/bowBoxGeometry';
import { analyzeVideo } from 'pose-camera';

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
    if (joints.leftIndexTip)  pose[POSE.LEFT_INDEX_TIP] = toL(joints.leftIndexTip);
    if (joints.leftPinkyTip)  pose[POSE.LEFT_PINKY_TIP] = toL(joints.leftPinkyTip);
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
 * Parse bow data from a raw native frame dict into RawBowFrame, or null.
 *
 * Current payload (2-class detect model): bowBox + violinBox + wrist joints →
 * tip/frog/contact derived geometrically in bowBoxGeometry.ts. The wrists must
 * be the RAW native joints (non-mirrored, same coordinate space as the boxes),
 * NOT the mirrored scoring-space landmarks produced by toL().
 *
 * Legacy payload (3-keypoint pose model): bowTip/bowFrog/bowContact passed
 * through directly — kept so an old bundled model still produces data.
 */
function parseBowFrame(f: any): RawBowFrame | null {
  if (f.bowBox && typeof f.bowConfidence === 'number') {
    return deriveBowFrameFromBoxes({
      timestamp: f.timestamp ?? 0,
      bowBox: f.bowBox,
      bowConfidence: f.bowConfidence,
      violinBox: f.violinBox ?? null,
      rightWrist: f.joints?.rightWrist ?? null,
      leftWrist: f.joints?.leftWrist ?? null,
    });
  }
  if (!f.bowTip || !f.bowFrog || !f.bowContact) return null;
  return {
    timestamp:      f.timestamp ?? 0,
    tipX:           f.bowTip.x,     tipY:     f.bowTip.y,     tipVisible:     !!f.bowTip.visible,
    frogX:          f.bowFrog.x,    frogY:    f.bowFrog.y,    frogVisible:    !!f.bowFrog.visible,
    contactX:       f.bowContact.x, contactY: f.bowContact.y, contactVisible: !!f.bowContact.visible,
    confidence:     f.bowConfidence ?? 0,
  };
}

/**
 * Extract pose + bow frames from an existing video file via Apple Vision and
 * the CoreML bow detector. Used for the uploaded-video path.
 * Returns empty arrays on Android or when the module is unavailable.
 */
export async function extractVideoFrames(
  videoUri: string,
): Promise<{ poseFrames: FrameKeypoints[]; bowFrames: RawBowFrame[] }> {
  const rawFrames: any[] = await analyzeVideo(videoUri);
  if (!rawFrames || rawFrames.length === 0) return { poseFrames: [], bowFrames: [] };

  const poseFrames = rawFrames.map((f) =>
    convertPoseFrame(f.joints ?? {}, f.leftHand ?? null, f.rightHand ?? null, f.timestamp ?? 0),
  );
  const bowFrames = rawFrames
    .map(parseBowFrame)
    .filter((f): f is RawBowFrame => f !== null);

  return { poseFrames, bowFrames };
}
