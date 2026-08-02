import { FrameKeypoints, Landmark, POSE, HAND } from '../lib/poseScoring';
import { PoseJoints, HandLandmarks, PoseJoint } from '../components/analysis/PoseSkeleton';
import { RawBowFrame } from '../types/signals';
import { deriveBowFrameFromBoxes, lineIntersection, isClipped, crossDiagonal, NormBox, NormPoint } from '../lib/bowBoxGeometry';
import { analyzeVideo } from 'pose-camera';

/**
 * Raw per-frame detector output for the debug box inspector — the bow/violin
 * boxes exactly as the CoreML model emitted them (normalized [0,1], top-left
 * origin, same space as the video frame), before any geometric derivation,
 * plus the derived bow/string contact point for that frame.
 */
export interface DetectionFrame {
  timestamp: number;
  bow: NormBox | null;
  bowConfidence: number;
  violin: NormBox | null;
  violinConfidence: number;
  /** Bow×string intersection point (normalized frame coords), or null. */
  contact: NormPoint | null;
  /** Contact position along the BOW: 0 = frog, 1 = tip. This is the bow-
   *  distribution reading (which part of the bow is on the string). Normalized
   *  by a running full-bow length so it stays correct when an end is off-frame. */
  bowPosT: number | null;
  /** True when bowPosT is a rough fallback (no full-bow reference seen yet) —
   *  the UI flags it rather than trusting the truncated box length. */
  bowPosApprox: boolean;
  /** Contact position along the string: 0 = fingerboard/scroll side, 1 = bridge
   *  side. null when the left wrist wasn't available to orient the string. */
  stringPosS: number | null;
  /** Bow diagonal endpoints (frog → tip) used for the contact geometry. */
  frog: NormPoint | null;
  tip: NormPoint | null;
  /** String diagonal endpoints (scroll/fingerboard → bridge) when oriented by
   *  the left wrist. null when the wrist was unavailable to orient it. */
  stringA: NormPoint | null;
  stringB: NormPoint | null;
}

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

// Box corner ids: 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right.
// The two diagonals of an axis-aligned box are {0,3} and {1,2}, so the opposite
// corner is always `3 - id`.
function cornerAt(box: NormBox, id: number): NormPoint {
  switch (id) {
    case 0: return { x: box.x1, y: box.y1 };
    case 1: return { x: box.x2, y: box.y1 };
    case 2: return { x: box.x1, y: box.y2 };
    default: return { x: box.x2, y: box.y2 };
  }
}
const oppositeId = (id: number) => 3 - id;

function nearestCornerId(box: NormBox, p: NormPoint): number {
  let best = 0;
  let bestD = Infinity;
  for (let id = 0; id < 4; id++) {
    const c = cornerAt(box, id);
    const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

/**
 * Decide once, from the start of the clip, which box corner the diagonal
 * anchors to (the bow's frog corner, the violin's scroll corner). Uses the
 * modal nearest-corner over the first `LOCK_SAMPLE` frames that have the needed
 * wrist — robust to a single jittery frame — then that choice is reused for
 * every frame so the diagonal can't flip to the other diagonal mid-clip.
 */
function lockAnchorCorner(
  frames: any[],
  getBox: (f: any) => NormBox | null | undefined,
  getWrist: (f: any) => NormPoint | null | undefined,
): number | null {
  const LOCK_SAMPLE = 15;
  const votes = new Map<number, number>();
  let sampled = 0;
  for (const f of frames) {
    const box = getBox(f);
    const wrist = getWrist(f);
    if (!box || !wrist) continue;
    const id = nearestCornerId(box, wrist);
    votes.set(id, (votes.get(id) ?? 0) + 1);
    if (++sampled >= LOCK_SAMPLE) break;
  }
  if (sampled === 0) return null;
  let best: number | null = null;
  let bestC = -1;
  for (const [id, c] of votes) if (c > bestC) { bestC = c; best = id; }
  return best;
}

/**
 * Decide once which violin corner the string diagonal starts from (the scroll end).
 *
 * crossDiagonal picks the diagonal that crosses the bow, which is the right rule —
 * but it reads the bow's slope SIGN, and that flips every time the bow rotates
 * through vertical or horizontal. Calling it per frame therefore flips the string
 * diagonal mid-clip. The violin is near-stationary, so the correct diagonal is a
 * property of the setup, not of the frame: vote over the first frames that have both
 * boxes, then keep that corner id for the whole clip.
 */
function lockScrollCorner(frames: any[], bowFrogId: number | null): number | null {
  if (bowFrogId == null) return null;
  const LOCK_SAMPLE = 15;
  const votes = new Map<number, number>();
  let sampled = 0;

  for (const f of frames) {
    const violinBox = (f.violinBox ?? null) as NormBox | null;
    if (!violinBox) continue;
    const bowBox = f.bowBox as NormBox;
    const frog = cornerAt(bowBox, bowFrogId);
    const tip = cornerAt(bowBox, oppositeId(bowFrogId));
    const leftWrist = (f.joints?.leftWrist ?? null) as NormPoint | null;
    const [scrollEnd] = crossDiagonal(frog, tip, violinBox, leftWrist);
    const id = nearestCornerId(violinBox, scrollEnd);
    votes.set(id, (votes.get(id) ?? 0) + 1);
    if (++sampled >= LOCK_SAMPLE) break;
  }
  if (sampled === 0) return null;

  let best: number | null = null;
  let bestC = -1;
  for (const [id, c] of votes) if (c > bestC) { bestC = c; best = id; }
  return best;
}

/**
 * Extract pose + bow frames from an existing video file via Apple Vision and
 * the CoreML bow detector. Used for the uploaded-video path.
 * Returns empty arrays on Android or when the module is unavailable.
 */
export async function extractVideoFrames(
  videoUri: string,
): Promise<{ poseFrames: FrameKeypoints[]; bowFrames: RawBowFrame[]; detectionFrames: DetectionFrame[] }> {
  const rawFrames: any[] = await analyzeVideo(videoUri);
  if (!rawFrames || rawFrames.length === 0) return { poseFrames: [], bowFrames: [], detectionFrames: [] };

  const poseFrames = rawFrames.map((f) =>
    convertPoseFrame(f.joints ?? {}, f.leftHand ?? null, f.rightHand ?? null, f.timestamp ?? 0),
  );
  // Box-based bow geometry for the debug inspector AND the scoring metric.
  //
  // The diagonal anchor corners (bow frog, violin scroll) are locked ONCE from
  // the start of the clip and reused every frame, so the diagonals never flip to
  // the other diagonal mid-clip. Given the anchors, the contact point is the
  // intersection of the two diagonals (same math as bowBoxGeometry.findContact),
  // and bowPosT is normalized by a running full-bow length (below).
  //
  // Computed indexed against rawFrames (null where no bow box) so the resulting
  // bowPosT can be attached to the matching RawBowFrame — that makes the
  // bowDistribution metric use the exact same values shown in the inspector.
  const boxedFrames = rawFrames.filter((f) => f.bowBox);
  const bowFrogId = lockAnchorCorner(boxedFrames, (f) => f.bowBox, (f) => f.joints?.rightWrist);
  const violinScrollId = lockScrollCorner(boxedFrames, bowFrogId);

  // Running full-bow length: whenever BOTH ends are on-screen we refresh it, and
  // clipped frames normalize against the most recent good value. This tracks the
  // real bow scale as the player moves toward/away from the camera, and works
  // regardless of which end (frog or tip) is the one off-frame.
  const MIN_BOW_LEN = 0.15;
  let lastFullLen: number | null = null;

  const boxSeries: Array<DetectionFrame | null> = rawFrames.map((f) => {
    if (!f.bowBox) return null;
    const bowBox = f.bowBox as NormBox;
    const violinBox = (f.violinBox ?? null) as NormBox | null;

    const frog = bowFrogId != null ? cornerAt(bowBox, bowFrogId) : null;
    const tip = bowFrogId != null ? cornerAt(bowBox, oppositeId(bowFrogId)) : null;
    // Violin string diagonal: the locked one (see lockScrollCorner). It must NOT be
    // re-derived per frame — crossDiagonal reads the bow's slope sign, which flips
    // as the bow rotates through vertical/horizontal, so a per-frame call makes the
    // string diagonal jump to the other diagonal mid-clip.
    const [stringA, stringB] = violinBox && violinScrollId != null
      ? [cornerAt(violinBox, violinScrollId), cornerAt(violinBox, oppositeId(violinScrollId))]
      : [null, null];

    let contact: NormPoint | null = null;
    let bowPosT: number | null = null;
    let bowPosApprox = false;
    let stringPosS: number | null = null;

    if (frog && tip && stringA && stringB) {
      const hit = lineIntersection(frog, tip, stringA, stringB);
      if (hit && hit.t >= -0.05 && hit.t <= 1.05 && hit.s >= -0.1 && hit.s <= 1.1) {
        contact = hit.point;
        stringPosS = hit.s;

        // Bow direction (frog → tip). The visible portion of a straight bow lies
        // on the true bow line, so this direction is reliable even when clipped.
        const dx = tip.x - frog.x;
        const dy = tip.y - frog.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-6) {
          const ux = dx / len;
          const uy = dy / len;
          const frogClipped = isClipped(frog);
          const tipClipped = isClipped(tip);
          const fullVisible = !frogClipped && !tipClipped && len >= MIN_BOW_LEN;
          if (fullVisible) lastFullLen = len; // refresh running length

          // Normalize against the running full length; anchor off whichever end
          // is on-screen (measure from frog, or from tip backward).
          const L = lastFullLen ?? len;
          bowPosApprox = lastFullLen == null; // only a truncated box to go on
          const fromFrog = ((contact.x - frog.x) * ux + (contact.y - frog.y) * uy) / L;
          const fromTip = ((tip.x - contact.x) * ux + (tip.y - contact.y) * uy) / L;
          if (!frogClipped) bowPosT = fromFrog;
          else if (!tipClipped) bowPosT = 1 - fromTip;
          else bowPosT = null; // both ends off-frame — nothing reliable to anchor to
        }
      }
    }

    return {
      timestamp: f.timestamp ?? 0,
      bow: bowBox,
      bowConfidence: f.bowConfidence ?? 0,
      violin: violinBox,
      violinConfidence: f.violinConfidence ?? 0,
      contact,
      bowPosT,
      bowPosApprox,
      stringPosS,
      frog,
      tip,
      stringA,
      stringB,
    };
  });

  const detectionFrames: DetectionFrame[] = boxSeries.filter(
    (d): d is DetectionFrame => d !== null,
  );

  // Bow frames for scoring — attach the inspector's exact box-recomputed bowPosT
  // (index-aligned) so bowDistribution matches the Detection Inspector exactly.
  const bowFrames = rawFrames
    .map((f, i) => {
      const bf = parseBowFrame(f);
      // boxSeries[i]?.bowPosT is undefined for legacy (no-box) frames — leave
      // bowPosT undefined there so deriveBowTimeSeries reconstructs it instead.
      if (bf) bf.bowPosT = boxSeries[i]?.bowPosT;
      return bf;
    })
    .filter((f): f is RawBowFrame => f !== null);

  return { poseFrames, bowFrames, detectionFrames };
}
