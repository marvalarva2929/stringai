import { FrameKeypoints, Landmark, POSE, HAND, CONFIDENCE_THRESHOLD } from './poseScoring';

/** Unified sampling rate for live and uploaded video scoring paths. */
export const SCORING_TARGET_FPS = 10;

/** EMA alpha — ~5-frame effective window at 10 fps. */
const SMOOTH_ALPHA = 0.35;

const MIN_SHOULDER_WIDTH = 0.05;

function cloneLandmark(lm: Landmark): Landmark {
  return { x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility };
}

function smoothLandmark(prev: Landmark | undefined, next: Landmark): Landmark {
  if (!prev || prev.visibility === undefined || prev.visibility < CONFIDENCE_THRESHOLD) {
    return cloneLandmark(next);
  }
  if (next.visibility === undefined || next.visibility < CONFIDENCE_THRESHOLD) {
    return cloneLandmark(prev);
  }
  const a = SMOOTH_ALPHA;
  return {
    x: prev.x * (1 - a) + next.x * a,
    y: prev.y * (1 - a) + next.y * a,
    z: prev.z * (1 - a) + next.z * a,
    visibility: Math.max(prev.visibility ?? 0, next.visibility ?? 0),
  };
}

function smoothLandmarkArray(
  prev: Landmark[] | null,
  next: Landmark[] | null,
  length: number,
): Landmark[] | null {
  if (!next) return prev;
  const out: Landmark[] = new Array(length);
  for (let i = 0; i < length; i++) {
    const n = next[i];
    const p = prev?.[i];
    if (!n || (n.visibility !== undefined && n.visibility < CONFIDENCE_THRESHOLD)) {
      out[i] = p ? cloneLandmark(p) : n;
      continue;
    }
    out[i] = smoothLandmark(p, n);
  }
  return out;
}

/** Keep one frame per target interval using timestamps. */
export function downsamplePoseFrames(
  frames: FrameKeypoints[],
  targetFps = SCORING_TARGET_FPS,
): FrameKeypoints[] {
  if (frames.length <= 1) return frames;
  const minGap = 1 / targetFps;
  const result: FrameKeypoints[] = [frames[0]];
  let lastTs = frames[0].timestamp;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].timestamp - lastTs >= minGap * 0.85) {
      result.push(frames[i]);
      lastTs = frames[i].timestamp;
    }
  }
  return result;
}

/** Exponential moving average over joint positions to reduce single-frame jitter. */
export function smoothPoseFrames(frames: FrameKeypoints[]): FrameKeypoints[] {
  if (frames.length === 0) return frames;
  let prevPose: Landmark[] | null = null;
  let prevLeft: Landmark[] | null = null;
  let prevRight: Landmark[] | null = null;

  return frames.map((frame) => {
    const poseLandmarks = frame.poseLandmarks
      ? smoothLandmarkArray(prevPose, frame.poseLandmarks, 33)
      : prevPose;
    const leftHandLandmarks = frame.leftHandLandmarks
      ? smoothLandmarkArray(prevLeft, frame.leftHandLandmarks, 21)
      : prevLeft;
    const rightHandLandmarks = frame.rightHandLandmarks
      ? smoothLandmarkArray(prevRight, frame.rightHandLandmarks, 21)
      : prevRight;

    if (poseLandmarks) prevPose = poseLandmarks;
    if (leftHandLandmarks) prevLeft = leftHandLandmarks;
    if (rightHandLandmarks) prevRight = rightHandLandmarks;

    return {
      timestamp: frame.timestamp,
      poseLandmarks,
      leftHandLandmarks,
      rightHandLandmarks,
    };
  });
}

/**
 * Express landmarks in a body-relative frame: origin at shoulder midpoint,
 * scale by shoulder width. Makes measurements invariant to camera distance.
 */
export function normalizePoseFramesToBody(frames: FrameKeypoints[]): FrameKeypoints[] {
  return frames.map((frame) => {
    const pose = frame.poseLandmarks;
    if (!pose) return frame;

    const lS = pose[POSE.LEFT_SHOULDER];
    const rS = pose[POSE.RIGHT_SHOULDER];
    if (!lS || !rS) return frame;
    if ((lS.visibility ?? 0) < CONFIDENCE_THRESHOLD || (rS.visibility ?? 0) < CONFIDENCE_THRESHOLD) {
      return frame;
    }

    const midX = (lS.x + rS.x) / 2;
    const midY = (lS.y + rS.y) / 2;
    const shoulderWidth = lS.x - rS.x;
    if (shoulderWidth < MIN_SHOULDER_WIDTH) return frame;

    const normPose = pose.map((lm) => {
      if (!lm || (lm.visibility !== undefined && lm.visibility < CONFIDENCE_THRESHOLD)) return lm;
      return {
        ...lm,
        x: (lm.x - midX) / shoulderWidth,
        y: (lm.y - midY) / shoulderWidth,
      };
    });

    const normHand = (hand: Landmark[] | null): Landmark[] | null => {
      if (!hand) return null;
      return hand.map((lm) => {
        if (!lm || (lm.visibility !== undefined && lm.visibility < CONFIDENCE_THRESHOLD)) return lm;
        return {
          ...lm,
          x: (lm.x - midX) / shoulderWidth,
          y: (lm.y - midY) / shoulderWidth,
        };
      });
    };

    return {
      timestamp: frame.timestamp,
      poseLandmarks: normPose,
      leftHandLandmarks: normHand(frame.leftHandLandmarks),
      rightHandLandmarks: normHand(frame.rightHandLandmarks),
    };
  });
}

/** Full prep pipeline applied before poseScoring. */
export function preparePoseFramesForScoring(frames: FrameKeypoints[]): FrameKeypoints[] {
  if (frames.length === 0) return frames;
  return normalizePoseFramesToBody(
    smoothPoseFrames(
      downsamplePoseFrames(frames, SCORING_TARGET_FPS),
    ),
  );
}
