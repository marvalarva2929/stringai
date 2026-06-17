import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
  Alert,
  ActivityIndicator,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
  Animated,
  PanResponder,
  Dimensions,
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { router, useNavigation } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useUserStore } from '../../src/store/useUserStore';
import { TunerModal } from '../../src/components/tuner/TunerModal';
import { runAudioAnalysis, runVideoAnalysis, computeOverallScore, saveSession, sessionToSummary, buildSessionFeedback } from '../../src/services/analysis';
import { AnalysisTimeline } from '../../src/components/analysis/AnalysisTimeline';
import { CoachingReport } from '../../src/components/analysis/CoachingReport';
import { InlineVideoPlayer } from '../../src/components/analysis/InlineVideoPlayer';
import { Button } from '../../src/components/ui/Button';
import { colors, spacing, radius } from '../../src/constants/theme';
import { AnalysisResult, MetricScore } from '../../src/types/analysis';
import { buildSessionAssessment } from '../../src/lib/sessionAssessment';
import { Piece } from '../../src/types/piece';
import { INSTRUMENTS } from '../../src/constants/instruments';
import { PoseSkeleton, PoseJoint, PoseJoints, HandLandmarks, LEFT_HAND_COLOR, RIGHT_HAND_COLOR } from '../../src/components/analysis/PoseSkeleton';
import { startRecording as poseStartRecording, stopRecording as poseStopRecording, getPoseCameraView } from 'pose-camera';
import { FrameKeypoints } from '../../src/lib/poseScoring';
import { convertPoseFrame } from '../../src/services/videoAnalysis';
import { fuseSignals, debugLogNoteEvents, deriveIntonationAnalysis } from '../../src/lib/noteFusion';
import Svg, { Circle, Line, G, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Positional thresholds (normalized 0–1 frame coordinates, y increases downward)
const ARM_TOO_LOW_THRESHOLD = 0.22;   // elbow drops this far below shoulder
const WRIST_TOO_LOW_THRESHOLD = 0.12; // wrist drops this far below elbow
const JOINT_CONF_THRESHOLD = 0;
// Palm orientation window for reliable wrist collapse detection.
// palmNormalZ outside this range means the camera angle is off and the user
// should reposition. Values calibrated from real playing.
const PALM_NZ_MIN = -0.25;
const PALM_NZ_MAX = 0;
// Elbow-bend angle thresholds (shoulder–elbow–wrist, degrees).
// Used only when hand landmarks are unavailable. "Too straight" is intentionally
// omitted — the bow arm extends at the tip of every stroke and would false-positive.
const BOW_ELBOW_MIN_ANGLE = 55;       // over-bent bow arm → wrist break
const VIOLIN_ELBOW_MIN_ANGLE = 60;    // violin arm too bent → wrist collapse

// Toggle if the skeleton appears mirrored or upside-down in the landscape view.
const LANDSCAPE_FLIP = true;

// Aspect ratio of the captured frame (.high preset = 1920×1080 landscape).
// Used to correct normalised image distances in wrist angle calculation.
const FRAME_ASPECT_RATIO = 16 / 9;

// 2D angle at joint b (degrees).
function computeAngleDeg(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const mag = Math.sqrt((abx ** 2 + aby ** 2) * (cbx ** 2 + cby ** 2));
  if (mag < 0.0001) return 90;
  return (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI;
}

// Z-component of the palm's unit normal vector (from MediaPipe world coords on PoseJoint).
// Returns null when world coordinates are unavailable.
// > 0: palm faces camera; < 0: dorsal (back of hand); ≈ 0: edge-on (unreliable).
function livePalmNormalZ(hand: HandLandmarks | null): number | null {
  const w = hand?.wrist, idx = hand?.indexMCP, rng = hand?.ringMCP;
  if (!w?.wx || !idx?.wx || !rng?.wx) return null;
  const ax = idx.wx - w.wx, ay = idx.wy! - w.wy!, az = idx.wz! - w.wz!;
  const bx = rng.wx - w.wx, by = rng.wy! - w.wy!, bz = rng.wz! - w.wz!;
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  const mag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  return mag < 0.0001 ? null : cz / mag;
}

// ─── Skeleton smoothing ───────────────────────────────────────────────────────
// Swift fires at 15 fps. A requestAnimationFrame loop runs at ~60 fps and lerps
// the displayed skeleton toward the latest target, so joints glide rather than jump.
// LERP_ALPHA is the per-frame blend weight: 0.3 at 60 fps ≈ 100 ms effective window.
const LERP_ALPHA = 0.3;

function emaJoint(prev: PoseJoint | undefined, next: PoseJoint, alpha: number): PoseJoint {
  if (!prev) return next;
  return {
    x: prev.x * (1 - alpha) + next.x * alpha,
    y: prev.y * (1 - alpha) + next.y * alpha,
    confidence: next.confidence,
    wx: next.wx, wy: next.wy, wz: next.wz,
  };
}

function emaJointsObj(prev: PoseJoints, next: PoseJoints, alpha: number): PoseJoints {
  const out: PoseJoints = {};
  for (const k of Object.keys(next) as (keyof PoseJoints)[]) {
    const nj = next[k];
    if (nj) out[k] = emaJoint(prev[k], nj, alpha);
  }
  return out;
}

function emaHand(prev: HandLandmarks | null, next: HandLandmarks | null, alpha: number): HandLandmarks | null {
  if (!next) return null;
  const s = (p: PoseJoint | undefined, n: PoseJoint | undefined) =>
    n ? emaJoint(p, n, alpha) : undefined;
  return {
    wrist:     s(prev?.wrist,     next.wrist),
    indexMCP:  s(prev?.indexMCP,  next.indexMCP),
    middleMCP: s(prev?.middleMCP, next.middleMCP),
    ringMCP:   s(prev?.ringMCP,   next.ringMCP),
  };
}

// Interior angle at the left wrist (elbow→wrist→indexMCP), aspect-ratio corrected.
function liveWristAngle(
  joints: PoseJoints,
  hand: HandLandmarks | null,
): number | null {
  const elbow = joints.leftElbow;
  const wrist = hand?.wrist;
  const mcp   = hand?.indexMCP;
  if (!elbow || !wrist || !mcp) return null;
  const abx = (elbow.x - wrist.x) * FRAME_ASPECT_RATIO, aby = elbow.y - wrist.y;
  const cbx = (mcp.x   - wrist.x) * FRAME_ASPECT_RATIO, cby = mcp.y   - wrist.y;
  const mag = Math.sqrt((abx * abx + aby * aby) * (cbx * cbx + cby * cby));
  if (mag < 0.0001) return null;
  return (Math.acos(Math.max(-1, Math.min(1, (abx * cbx + aby * cby) / mag))) * 180) / Math.PI;
}

function evaluatePoseWarnings(
  joints: PoseJoints,
  leftHand: HandLandmarks | null,
  rightHand: HandLandmarks | null,
): string[] {
  const ok = (j: { confidence: number } | undefined) =>
    j != null && j.confidence >= JOINT_CONF_THRESHOLD;

  const hasBowArm =
    ok(joints.rightShoulder) && ok(joints.rightElbow) && ok(joints.rightWrist);
  const hasViolinArm =
    ok(joints.leftShoulder) && ok(joints.leftElbow) && ok(joints.leftWrist);

  if (!hasBowArm && !hasViolinArm) return ['Move closer to the camera'];

  const warnings: string[] = [];

  if (hasBowArm) {
    const rS = joints.rightShoulder!;
    const rE = joints.rightElbow!;
    const rW = joints.rightWrist!;
    if (rE.y - rS.y > ARM_TOO_LOW_THRESHOLD) warnings.push('Lift your bow arm');
    const bowAngle = computeAngleDeg(rS, rE, rW);
    if (bowAngle < BOW_ELBOW_MIN_ANGLE) warnings.push('Open your bow elbow');
  }

  if (hasViolinArm) {
    const pnz = livePalmNormalZ(leftHand);
    if (pnz !== null && pnz > PALM_NZ_MAX) {
      warnings.push('Turn slightly to your right');
    } else if (pnz !== null && pnz < PALM_NZ_MIN) {
      warnings.push('Turn slightly to your left');
    } else {
      const wa = liveWristAngle(joints, leftHand);
      if (wa !== null && wa < 155) warnings.push('Straighten your left wrist');
    }
  }

  return warnings;
}

// ─── Debug overlay ────────────────────────────────────────────────────────────

interface DebugMetrics {
  bowElbowDrop:     number | null;
  bowElbowAngle:    number | null;
  violinWristDrop:  number | null;
  violinElbowAngle: number | null;
  violinWristAngle: number | null;
}

function computeDebugMetrics(
  joints: PoseJoints,
  leftHand: HandLandmarks | null,
  rightHand: HandLandmarks | null,
): DebugMetrics {
  const ok = (j: { confidence: number } | undefined) =>
    j != null && j.confidence >= JOINT_CONF_THRESHOLD;
  const r1 = (n: number | null) => n != null ? Math.round(n * 10) / 10 : null;
  const r3 = (n: number | null) => n != null ? Math.round(n * 1000) / 1000 : null;

  const rS = joints.rightShoulder, rE = joints.rightElbow, rW = joints.rightWrist;
  const lS = joints.leftShoulder,  lE = joints.leftElbow,  lW = joints.leftWrist;
  const hasBow    = ok(rS) && ok(rE) && ok(rW);
  const hasViolin = ok(lS) && ok(lE) && ok(lW);

  return {
    bowElbowDrop:     hasBow    ? r3(rE!.y - rS!.y)                 : null,
    bowElbowAngle:    hasBow    ? r1(computeAngleDeg(rS!, rE!, rW!)) : null,
    violinWristDrop:  hasViolin ? r3(lW!.y - lE!.y)                  : null,
    violinElbowAngle: hasViolin ? r1(computeAngleDeg(lS!, lE!, lW!)) : null,
    violinWristAngle: r1(liveWristAngle(joints, leftHand)),
  };
}

// Bottom-drawer snap points (computed once from current screen dimensions)
const _SCREEN_H = Dimensions.get('window').height;
const DRAWER_DEFAULT_H = Math.round(_SCREEN_H * 0.55);
const DRAWER_MAX_H    = Math.round(_SCREEN_H * 0.85);
const DRAWER_MIN_H    = Math.round(_SCREEN_H * 0.25);

// ─── Audio quality heuristic ─────────────────────────────────────────────────
// Uses three signals already present in rawSignals:
//   • pitchFrames detection rate — wind/noise stays above the RMS gate → high rate
//   • toneFrames fundamentalRatio — broadband noise has no dominant fundamental
//   • average note duration — noise fragments into many short events
// The combination catches loud wind without false-positives on fast clean playing.
function detectAudioQualityWarning(
  noteEvents: { durationSeconds: number }[],
  rawSignals?: {
    pitchFrames: { frequency: number | null }[];
    toneFrames: { fundamentalRatio: number }[];
    duration: number;
  },
): string | undefined {
  if (!rawSignals) return undefined;
  const { pitchFrames, toneFrames, duration } = rawSignals;
  if (pitchFrames.length === 0 || duration <= 0) return undefined;

  const detectedCount = pitchFrames.filter(f => f.frequency !== null).length;
  const detectionRate = detectedCount / pitchFrames.length;

  // Very quiet: almost nothing detected and few or no note events
  if (detectionRate < 0.04 && noteEvents.length < 2) {
    return 'The recording was too quiet to analyze. Try moving your device closer to the violin.';
  }

  if (noteEvents.length < 2) return undefined;

  const avgDuration = noteEvents.reduce((s, n) => s + n.durationSeconds, 0) / noteEvents.length;

  // Spectral tonality: musical notes have a clear fundamental (ratio ≈ 0.1–0.3);
  // broadband noise is diffuse (ratio < 0.05). Silence frames contribute 0.
  const overallFundamentalRatio = toneFrames.length > 0
    ? toneFrames.reduce((s, f) => s + f.fundamentalRatio, 0) / toneFrames.length
    : 0.5;

  // Wind/noise signature: detection stays high (continuous sound above gate),
  // spectrum is non-tonal, and events are short fragments rather than real notes.
  if (detectionRate > 0.50 && overallFundamentalRatio < 0.06 && avgDuration < 0.25) {
    return 'Background wind or noise was picked up in this recording — pitch results may be less accurate. Try recording in a quieter space.';
  }

  return undefined;
}

const SESSIONS_DIR = FileSystem.documentDirectory ? FileSystem.documentDirectory + 'sessions/' : null;

async function pruneOldVideos(): Promise<void> {
  if (!SESSIONS_DIR) return;
  const files = await FileSystem.readDirectoryAsync(SESSIONS_DIR).catch(() => [] as string[]);
  if (files.length <= 10) return;
  const sorted = [...files].sort(); // session_<timestamp>.* — lexicographic = chronological
  const toDelete = sorted.slice(0, sorted.length - 10);
  await Promise.all(
    toDelete.map((name) => FileSystem.deleteAsync(SESSIONS_DIR! + name, { idempotent: true })),
  );
}

async function persistVideo(tempUri: string): Promise<string> {
  if (tempUri.startsWith('ph://')) return tempUri; // Photos library URI — directly playable
  if (!SESSIONS_DIR) return tempUri;               // documentDirectory unavailable
  const ext = tempUri.split('.').pop() ?? 'mp4';
  await FileSystem.makeDirectoryAsync(SESSIONS_DIR, { intermediates: true });
  await pruneOldVideos();
  const dest = `${SESSIONS_DIR}session_${Date.now()}.${ext}`;
  await FileSystem.copyAsync({ from: tempUri, to: dest });
  return dest;
}

const PHASE_LABELS: Record<string, string> = {
  processing_audio: 'Analyzing pitch & tone…',
  processing_video: 'Checking bow placement…',
  uploading: 'Saving session…',
};

export default function AnalyzeScreen() {
  const {
    phase, selectedPiece, currentResult, error, sessionHistory,
    metricHistory, sessionResultCache,
    setPhase, setSelectedPiece, setRecordingUri, setResult, setError, reset,
    addToHistory, addToMetricHistory, cacheSessionResult,
  } = useAnalysisStore();
  const { profile } = useUserStore();
  const { isAuthenticated, playerCategory } = useAuthStore();

  // Video seek state (for inline player in results)
  const [seekVersion, setSeekVersion] = useState(0);
  const [seekSeconds, setSeekSeconds] = useState(0);

  // Bottom drawer state for results screen
  const drawerHeightRef = useRef(DRAWER_DEFAULT_H);
  const gestureStartHRef = useRef(DRAWER_DEFAULT_H);
  const drawerAnim = useRef(new Animated.Value(DRAWER_DEFAULT_H)).current;
  // Tracks whether the active card's content is scrolled to top / bottom
  const cardScrollAtTopRef = useRef(true);
  const cardScrollAtBottomRef = useRef(false);
  // When drawer is at minimum, disable card ScrollViews so vertical swipes reach the drawer.
  // A native ScrollView that claims the responder on touch-start can't be overridden by any
  // parent PanResponder on move — the only reliable way is to prevent it from claiming at all.
  const [cardsScrollEnabled, setCardsScrollEnabled] = useState(true);

  // Stable move/release logic shared by both PanResponders.
  // setCardsScrollEnabled is a stable React setter — safe to close over in useRef.
  const drawerGestureRef = useRef({
    onGrant: () => { gestureStartHRef.current = drawerHeightRef.current; },
    onMove: (dy: number) => {
      const newH = Math.max(DRAWER_MIN_H, Math.min(DRAWER_MAX_H, gestureStartHRef.current - dy));
      drawerAnim.setValue(newH);
    },
    onRelease: (dy: number, vy: number) => {
      const finalH = Math.max(DRAWER_MIN_H, Math.min(DRAWER_MAX_H, gestureStartHRef.current - dy));
      let target: number;
      if (vy > 0.5 || finalH < (DRAWER_DEFAULT_H + DRAWER_MIN_H) / 2) {
        target = DRAWER_MIN_H;
      } else if (vy < -0.5 || finalH > (DRAWER_DEFAULT_H + DRAWER_MAX_H) / 2) {
        target = DRAWER_MAX_H;
      } else {
        target = DRAWER_DEFAULT_H;
      }
      drawerHeightRef.current = target;
      setCardsScrollEnabled(target !== DRAWER_MIN_H);
      Animated.spring(drawerAnim, { toValue: target, useNativeDriver: false, bounciness: 0 }).start();
    },
  });

  // Handle PanResponder — always active on the drag pill; handles full expand/collapse
  const handlePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => drawerGestureRef.current.onGrant(),
      onPanResponderMove: (_, gs) => drawerGestureRef.current.onMove(gs.dy),
      onPanResponderRelease: (_, gs) => drawerGestureRef.current.onRelease(gs.dy, gs.vy),
    })
  ).current;

  // Shared condition logic for the content pan responder (move events only)
  const contentShouldClaim = (gs: { dy: number; dx: number }) => {
    if (Math.abs(gs.dy) < 2) return false;           // low threshold — responsive feel
    if (Math.abs(gs.dx) >= Math.abs(gs.dy)) return false;
    if (gs.dy > 0 && cardScrollAtTopRef.current) return true;
    if (gs.dy < 0 && drawerHeightRef.current <= DRAWER_MIN_H + 10) return true;
    if (gs.dy < 0 && cardScrollAtBottomRef.current &&
        drawerHeightRef.current < DRAWER_MAX_H - 10) return true;
    return false;
  };

  // Content PanResponder — three hooks for reliability across iOS responder phases:
  //  1. onStartShouldSetPanResponder  — claims at touch-start only when drawer is fully
  //     collapsed (any touch should start expanding). At other heights we skip start-phase
  //     claiming so the horizontal FlatList can receive swipe touches before direction is known.
  //  2. onMoveShouldSetPanResponderCapture — steals from a child that holds the responder
  //  3. onMoveShouldSetPanResponder   — claims once a child voluntarily releases
  const contentPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () =>
        drawerHeightRef.current <= DRAWER_MIN_H + 10,
      onMoveShouldSetPanResponderCapture: (_, gs) => contentShouldClaim(gs),
      onMoveShouldSetPanResponder: (_, gs) => contentShouldClaim(gs),
      onPanResponderGrant: () => drawerGestureRef.current.onGrant(),
      onPanResponderMove: (_, gs) => drawerGestureRef.current.onMove(gs.dy),
      onPanResponderRelease: (_, gs) => drawerGestureRef.current.onRelease(gs.dy, gs.vy),
    })
  ).current;

  const collapseDrawer = () => {
    drawerHeightRef.current = DRAWER_MIN_H;
    setCardsScrollEnabled(false);
    Animated.spring(drawerAnim, { toValue: DRAWER_MIN_H, useNativeDriver: false, bounciness: 0 }).start();
  };

  // Reset drawer and card scroll state each time results appear
  useEffect(() => {
    if (phase === 'done') {
      drawerHeightRef.current = DRAWER_DEFAULT_H;
      drawerAnim.setValue(DRAWER_DEFAULT_H);
      setCardsScrollEnabled(true);
    }
  }, [phase]);

  const handleTimestampPress = (s: number) => {
    // Seek 30ms past the chip's timestamp so integer-precision video seek never
    // undershoots into the gap before the note. 30ms < MIN_DURATION_S (50ms),
    // so this always lands inside the note regardless of its length.
    setSeekSeconds(s + 0.030);
    setSeekVersion((v) => v + 1);
    collapseDrawer();
  };

  // Tuner
  const [tunerOpen, setTunerOpen] = useState(false);

  // Step 1 form state
  const [songName, setSongName] = useState('');
  const [sheetMusicUri, setSheetMusicUri] = useState<string | null>(null);
  const [sheetMusicName, setSheetMusicName] = useState<string | null>(null);

  // Camera recording refs
  const cameraRef = useRef<CameraView | null>(null);
  const recordingStartedRef = useRef(false);
  const recordingActiveRef = useRef(false);   // true only while frames should be accumulated
  const cameraReadyRef = useRef(false);        // true once onCameraReady fired this mount
  const pendingRecordingRef = useRef(false);   // startRecording pressed before camera was ready
  const elapsedRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Pose overlay
  const [poseJoints, setPoseJoints] = useState<PoseJoints>({});
  const [leftHand, setLeftHand] = useState<HandLandmarks | null>(null);
  const [rightHand, setRightHand] = useState<HandLandmarks | null>(null);
  const poseJointsRef = useRef<PoseJoints>({});
  const leftHandRef = useRef<HandLandmarks | null>(null);
  const rightHandRef = useRef<HandLandmarks | null>(null);
  // Latest pose from Swift (15 fps) — animation loop reads these as lerp targets.
  const targetJointsRef   = useRef<PoseJoints>({});
  const targetLeftHandRef  = useRef<HandLandmarks | null>(null);
  const targetRightHandRef = useRef<HandLandmarks | null>(null);
  // Current displayed position — lerped toward target at ~60 fps.
  const displayJointsRef   = useRef<PoseJoints>({});
  const displayLeftHandRef  = useRef<HandLandmarks | null>(null);
  const displayRightHandRef = useRef<HandLandmarks | null>(null);
  const animFrameRef = useRef<number | null>(null);
  // Accumulated pose frames for post-session scoring
  const poseFramesRef = useRef<FrameKeypoints[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const poseCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Warnings surface after appearing in 2 consecutive 1s checks (2s debounce).
  const prevWarningsRef = useRef<Set<string>>(new Set());
  // Tracks whether we've received the first pose frame this recording session.
  const firstPoseRef = useRef(false);
  const [poseWarnings, setPoseWarnings] = useState<string[]>([]);
  const [debugMetrics, setDebugMetrics] = useState<DebugMetrics | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const PoseCameraView = getPoseCameraView();
  const usingPoseCamera = PoseCameraView != null;

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const instrument = 'violin';
  const instrumentConfig = INSTRUMENTS[instrument];

  // Hide the tab bar during calibration and recording so it doesn't overlap the camera UI.
  useEffect(() => {
    const hide = phase === 'recording';
    navigation.setOptions({
      tabBarStyle: hide
        ? { display: 'none' }
        : { borderTopColor: '#f0eeff', backgroundColor: '#fff', elevation: 8,
            shadowColor: '#000', shadowOpacity: 0.06,
            shadowOffset: { width: 0, height: -2 }, shadowRadius: 8 },
    });
  }, [phase, navigation]);

  // Reset camera-ready flag when we leave the camera phases so the next visit starts fresh.
  useEffect(() => {
    const inCameraPhase = phase === 'camera_tip' || phase === 'recording';
    if (!inCameraPhase) {
      cameraReadyRef.current = false;
      pendingRecordingRef.current = false;
    }
  }, [phase]);

  // Run a pose check every 1s during recording
  useEffect(() => {
    if (phase !== 'recording') {
      if (poseCheckIntervalRef.current) {
        clearInterval(poseCheckIntervalRef.current);
        poseCheckIntervalRef.current = null;
      }
      setPoseWarnings([]);
      return;
    }
    poseCheckIntervalRef.current = setInterval(() => {
      const raw = evaluatePoseWarnings(
        poseJointsRef.current,
        leftHandRef.current,
        rightHandRef.current,
      );
      // "Arm not detected" always shows immediately (structural, not angle-based).
      // All other warnings require two consecutive checks to surface, which
      // filters out single-frame projection artifacts from normal bow strokes.
      const persistent = raw.filter(
        w => w.includes('not detected') || prevWarningsRef.current.has(w),
      );
      prevWarningsRef.current = new Set(raw);
      setPoseWarnings(persistent);
    }, 1000);
    return () => {
      if (poseCheckIntervalRef.current) {
        clearInterval(poseCheckIntervalRef.current);
        poseCheckIntervalRef.current = null;
      }
    };
  }, [phase]);

  // Animation loop: lerps displayed skeleton toward the 15-fps target at ~60 fps
  // so joints glide smoothly rather than teleporting on each pose event.
  useEffect(() => {
    if (phase !== 'camera_tip' && phase !== 'recording') {
      displayJointsRef.current   = {};
      displayLeftHandRef.current  = null;
      displayRightHandRef.current = null;
      return;
    }
    let rafId: number;
    const loop = () => {
      const dj  = emaJointsObj(displayJointsRef.current, targetJointsRef.current, LERP_ALPHA);
      const dlh = emaHand(displayLeftHandRef.current, targetLeftHandRef.current, LERP_ALPHA);
      const drh = emaHand(displayRightHandRef.current, targetRightHandRef.current, LERP_ALPHA);
      displayJointsRef.current   = dj;
      displayLeftHandRef.current  = dlh;
      displayRightHandRef.current = drh;
      setPoseJoints(dj);
      setLeftHand(dlh);
      setRightHand(drh);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [phase]);

  // ── Step 1: Song name input ────────────────────────────────

  const handleUploadSheetMusic = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setSheetMusicUri(asset.uri);
    setSheetMusicName(asset.name.replace(/\.pdf$/i, ''));
  };

  const handleRemoveSheetMusic = () => {
    setSheetMusicUri(null);
    setSheetMusicName(null);
  };

  const buildPiece = (): Piece | null => {
    if (!songName.trim()) return null;
    // Deterministic ID from title so repeated sessions for the same piece share one ID
    const slug = songName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    return {
      id: `manual-${slug}`,
      title: songName.trim(),
      source: 'manual',
      pdfUri: sheetMusicUri ?? undefined,
    };
  };

  const handleNext = () => {
    setSelectedPiece(buildPiece());
    setPhase('method_select');
  };

  const handleSkip = () => {
    setSelectedPiece(null);
    setPhase('method_select');
  };

  // ── Step 2: Method select ──────────────────────────────────

  const handleBackToInput = () => {
    setPhase('piece_input');
  };

  // ── In-app camera recording ────────────────────────────────

  // Starts the actual video capture once the camera is confirmed ready.
  const beginRecording = useCallback(async () => {
    if (recordingStartedRef.current) return;
    recordingStartedRef.current = true;
    recordingActiveRef.current = true;
    recordingStartTimeRef.current = Date.now();
    timerRef.current = setInterval(() => { elapsedRef.current++; setElapsed((s) => s + 1); }, 1000);
    await poseStartRecording();
  }, []);

  const startRecording = async () => {
    if (!cameraPermission?.granted) {
      const { granted } = await requestCameraPermission();
      if (!granted) { Alert.alert('Camera Permission', 'Camera access is needed to record video.'); return; }
    }
    if (!micPermission?.granted) {
      const { granted } = await requestMicPermission();
      if (!granted) { Alert.alert('Microphone Permission', 'Microphone access is needed to record audio.'); return; }
    }
    recordingStartedRef.current  = false;
    recordingActiveRef.current   = false;
    elapsedRef.current           = 0;
    setElapsed(0);
    prevWarningsRef.current       = new Set();
    firstPoseRef.current          = false;
    poseFramesRef.current         = [];
    recordingStartTimeRef.current = 0;
    setPhase('recording');
    if (cameraReadyRef.current) {
      await beginRecording();
    } else {
      pendingRecordingRef.current = true;
    }
  };

  // Called when PoseCameraView signals the camera is ready.
  // May fire during camera_tip (pre-warm) or during recording (cold start fallback).
  const onPoseCameraReady = useCallback(async () => {
    cameraReadyRef.current = true;
    if (pendingRecordingRef.current) {
      pendingRecordingRef.current = false;
      await beginRecording();
    }
  }, [beginRecording]);

  // Called when the native module finishes writing the video file
  const onPoseRecordingFinished = useCallback(async (e: any) => {
    recordingActiveRef.current = false;
    if (timerRef.current) clearInterval(timerRef.current);
    const { uri, error } = e.nativeEvent ?? e;
    if (error || !uri) {
      setError(error ?? 'Recording failed');
      return;
    }
    setRecordingUri(uri);
    await processMedia(uri, elapsedRef.current, true, poseFramesRef.current);
  }, []);

  const handleStopPoseRecording = useCallback(async () => {
    await poseStopRecording();
  }, []);

  // Fallback: expo-camera path (used when PoseCameraView native module is unavailable)
  const onCameraReady = async () => {
    if (recordingStartedRef.current) return;
    recordingStartedRef.current = true;
    timerRef.current = setInterval(() => { elapsedRef.current++; setElapsed((s) => s + 1); }, 1000);
    try {
      const recorded = await cameraRef.current!.recordAsync({ maxDuration: 120 });
      if (timerRef.current) clearInterval(timerRef.current);
      setRecordingUri(recorded!.uri);
      await processMedia(recorded!.uri, elapsedRef.current, true);
    } catch (err: any) {
      if (timerRef.current) clearInterval(timerRef.current);
      const msg: string = err?.message ?? '';
      if (!msg.toLowerCase().includes('stop') && !msg.toLowerCase().includes('abort') && !msg.toLowerCase().includes('cancel')) {
        setError(msg || 'Recording failed');
      }
    }
  };

  const stopRecording = () => { cameraRef.current?.stopRecording(); };

  // ── Upload from camera roll ────────────────────────────────

  const uploadVideoFromLibrary = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Photos Permission', 'Photo library access is needed to upload a video.'); return; }

    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'videos', allowsEditing: false, quality: 1 });
    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    const durationSec = asset.duration ? Math.round(asset.duration / 1000) : 60;
    setRecordingUri(asset.uri);
    await processMedia(asset.uri, durationSec, true);
  };

  // ── Core analysis pipeline ─────────────────────────────────

  const processMedia = async (uri: string, durationSec: number, isVideo: boolean, poseFrames?: FrameKeypoints[]) => {
    let videoUri: string | undefined;
    if (isVideo) {
      try {
        videoUri = await persistVideo(uri);
      } catch {
        // Copy failed — fall back to original URI (valid for this session)
        videoUri = uri;
      }
    }
    setPhase('processing_audio');
    try {
      let audioMetrics: MetricScore[] = [];
      let audioOutput: import('../../src/types/analysis').AudioAnalysisOutput | undefined;
      try {
        audioOutput = await runAudioAnalysis(uri, instrument, durationSec);
        audioMetrics = audioOutput.metrics;
      } catch (err: any) {
        if (err?.message === 'VIDEO_UPLOADED') {
          Alert.alert(
            'No audio found',
            'Could not extract audio from this video. Make sure the video has a recorded audio track, or use the Record button to capture directly.',
            [{ text: 'OK', onPress: reset }],
          );
          return;
        }
        throw err;
      }

      setPhase('processing_video');
      const videoMetrics: MetricScore[] = isVideo
        ? await runVideoAnalysis(uri, instrument, poseFrames, durationSec)
        : [];

      // Fuse audio signals + pose frames into per-note events (single source of truth)
      // Pass raw (un-normalized) frames — fuseSignals needs screen-space coords for
      // getShoulderRaised; scorePoseFrames (inside runVideoAnalysis) owns normalization.
      const noteEvents = audioOutput
        ? fuseSignals(audioOutput.rawSignals, poseFrames ?? [])
        : [];
      if (__DEV__) debugLogNoteEvents(noteEvents);

      // Derive intonation analysis from the same note events — single source of truth.
      // If fuseSignals produces no events, intonation is undefined so feedback never
      // mentions notes that the debug log doesn't show (no pipeline divergence).
      const intonationAnalysis = noteEvents.length > 0
        ? deriveIntonationAnalysis(noteEvents)
        : undefined;

      const audioQualityWarning = detectAudioQualityWarning(noteEvents, audioOutput?.rawSignals);

      // Rewrite ALL flaggedTimestamps to align with noteEvents so every coaching chip
      // seeks to a real note boundary and the overlay always shows the correct note.
      //
      // pitchAccuracy: replace with the out-of-tune noteEvents (same source as the
      //   intonation cards), so note name, timestamp, and overlay are all in sync.
      // All other metrics: snap each raw timestamp to the nearest noteEvent start
      //   (raw audio analysis timestamps don't land on note boundaries).
      const snapToNote = (t: number) => {
        let best = noteEvents[0];
        let bestDist = Math.abs(noteEvents[0].startSeconds - t);
        for (const n of noteEvents) {
          const d = Math.abs(n.startSeconds - t);
          if (d < bestDist) { best = n; bestDist = d; }
        }
        return { startSeconds: best.startSeconds, endSeconds: best.endSeconds, note: best.noteName };
      };

      const audioMetricsFinal = audioMetrics.map(m => {
        if (noteEvents.length === 0) return m;
        if (m.key === 'pitchAccuracy') {
          const outOfTune = noteEvents
            .filter(n => !n.inTune)
            .slice(0, 6)
            .map(n => ({ startSeconds: n.startSeconds, endSeconds: n.endSeconds, note: n.noteName }));
          return { ...m, flaggedTimestamps: outOfTune };
        }
        return { ...m, flaggedTimestamps: m.flaggedTimestamps.map(ts => snapToNote(ts.startSeconds)) };
      });

      const skillLevel = profile?.skillLevel ?? 'beginner';
      const weights = instrumentConfig.skillWeights[skillLevel];
      const overallScore = computeOverallScore(audioMetricsFinal, videoMetrics, weights as any);

      // Rolling delta: new score vs. average of the 3 most recent sessions
      const recentScores = sessionHistory.slice(0, 3).map((s) => s.overallScore);
      const overallDelta = recentScores.length > 0
        ? Math.round(overallScore - recentScores.reduce((a, b) : number => a + b, 0) / recentScores.length)
        : undefined;

      setPhase('uploading');
      const sessionId = Math.random().toString(36).slice(2);
      const recordedAt = new Date().toISOString();
      const allMetrics = [...audioMetricsFinal, ...videoMetrics];
      // Use the user's stated goal from onboarding; fall back to video-computed classification
      const userCategory = profile?.playerCategory ?? playerCategory ?? undefined;
      const sessionAssessment = buildSessionAssessment(videoMetrics, userCategory);

      // Generate coaching feedback from all metrics + previous session for trend comparison
      const prevSessionMetrics = metricHistory[0]?.scores;
      const llmFeedback = buildSessionFeedback(
        [...audioMetricsFinal, ...videoMetrics],
        sessionAssessment.playerCategory,
        selectedPiece ?? undefined,
        prevSessionMetrics,
        intonationAnalysis,
      );

      const result: AnalysisResult = {
        sessionId,
        userId: profile?.id ?? 'guest',
        instrument,
        piece: selectedPiece ?? undefined,
        durationSeconds: durationSec,
        recordedAt,
        overallScore,
        overallDelta,
        metrics: allMetrics,
        audioMetrics: audioMetricsFinal,
        videoMetrics,
        sessionAssessment,
        llmFeedback,
        intonationAnalysis,
        audioQualityWarning,
        videoUri,
        noteEvents,
      };

      if (isAuthenticated && profile?.id) await saveSession(result);
      addToHistory(sessionToSummary(result));
      addToMetricHistory({ sessionId, recordedAt, scores: allMetrics });
      cacheSessionResult(result);
      setResult(result);
    } catch (err: any) {
      setError(err.message ?? 'Analysis failed');
    }
  };

  const formatElapsed = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  // ── Step 1: Piece input ────────────────────────────────────
  if (phase === 'piece_input') {
    return (
      <SafeAreaView style={styles.safe}>
        <LinearGradient colors={[colors.brand[900], colors.brand[800]]} style={styles.header}>
          <Text style={styles.headerTitle}>Start New Session</Text>
          <Text style={styles.headerSub}>Name the piece you're practicing</Text>
        </LinearGradient>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            style={styles.inputContent}
            contentContainerStyle={styles.inputContentInner}
            keyboardShouldPersistTaps="handled"
          >
            <TextInput
              style={styles.songInput}
              placeholder="e.g. G major scale, Vivaldi"
              placeholderTextColor={colors.text.muted}
              value={songName}
              onChangeText={setSongName}
              returnKeyType="next"
              autoCorrect={false}
              autoCapitalize="words"
              autoFocus
            />

            {/* Sheet music upload */}
            {sheetMusicUri ? (
              <View style={styles.sheetMusicAttached}>
                <Text style={styles.sheetMusicIcon}>📄</Text>
                <Text style={styles.sheetMusicFilename} numberOfLines={1}>{sheetMusicName}</Text>
                <Pressable onPress={handleRemoveSheetMusic} style={styles.sheetMusicRemove}>
                  <Text style={styles.sheetMusicRemoveText}>✕</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable style={styles.sheetMusicBtn} onPress={handleUploadSheetMusic}>
                <Text style={styles.sheetMusicBtnIcon}>📄</Text>
                <View>
                  <Text style={styles.sheetMusicBtnTitle}>Add Sheet Music</Text>
                  <Text style={styles.sheetMusicBtnSub}>Optional — upload a PDF for better analysis</Text>
                </View>
              </Pressable>
            )}

            <Button
              label="Next"
              onPress={handleNext}
              size="lg"
              fullWidth
            />

            <Pressable style={styles.skipBtn} onPress={handleSkip}>
              <Text style={styles.skipLabel}>Skip — practice without naming</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── Step 2: Recording method ───────────────────────────────
  if (phase === 'method_select') {
    return (
      <SafeAreaView style={styles.safe}>
        <TunerModal visible={tunerOpen} onClose={() => setTunerOpen(false)} />
        <LinearGradient colors={[colors.brand[900], colors.brand[800]]} style={styles.header}>
          <Text style={styles.headerTitle}>How do you want to record?</Text>
          {selectedPiece && (
            <View style={styles.pieceChip}>
              <Text style={styles.pieceChipText} numberOfLines={1}>
                {selectedPiece.title}
              </Text>
            </View>
          )}
        </LinearGradient>

        <View style={styles.methodContent}>
          <Pressable style={styles.methodCard} onPress={() => setPhase('camera_tip')}>
            <View style={[styles.methodIcon, { backgroundColor: colors.brand[100] }]}>
              <Text style={styles.methodIconText}>📹</Text>
            </View>
            <View style={styles.methodText}>
              <Text style={styles.methodTitle}>Record In-App</Text>
              <Text style={styles.methodSub}>Live camera view with real-time feedback</Text>
            </View>
            <Text style={styles.methodArrow}>›</Text>
          </Pressable>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerLabel}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <Pressable style={styles.methodCard} onPress={uploadVideoFromLibrary}>
            <View style={[styles.methodIcon, { backgroundColor: '#fef3c7' }]}>
              <Text style={styles.methodIconText}>🎬</Text>
            </View>
            <View style={styles.methodText}>
              <Text style={styles.methodTitle}>Upload a Video</Text>
              <Text style={styles.methodSub}>Pick a recording from your camera roll</Text>
            </View>
            <Text style={styles.methodArrow}>›</Text>
          </Pressable>
          <View style={styles.uploadTip}>
            <Text style={styles.uploadTipText}>
              Tip: videos work best when both elbows and your upper body are fully visible
            </Text>
          </View>

          <Pressable style={styles.tuneLink} onPress={() => setTunerOpen(true)}>
            <Text style={styles.tuneLinkText}>♩  Tune strings first</Text>
          </Pressable>

          <Pressable style={styles.backBtn} onPress={handleBackToInput}>
            <Text style={styles.backLabel}>← Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── Camera position guide + Calibrating + Recording (shared block so PoseCameraView stays mounted) ──
  if (phase === 'camera_tip' || phase === 'recording') {
    const isRecording = phase === 'recording';
    const lsContainer   = {
      position: 'absolute' as const,
      width: screenHeight,
      height: screenWidth,
      top: (screenHeight - screenWidth) / 2,
      left: -(screenHeight - screenWidth) / 2,
      transform: [{ rotate: '-90deg' }],
      // portrait-bottom (home indicator) maps to local-right after -90° rotation
      paddingRight: insets.bottom,
    };
    return (
      <View style={styles.recordingScreen}>

        {/* PoseCameraView is always mounted here — warms up during camera_tip so
            the skeleton appears immediately when recording starts. */}
        {usingPoseCamera && (
          <PoseCameraView
            style={StyleSheet.absoluteFillObject}
            onCameraReady={onPoseCameraReady}
            onPose={(e: any) => {
              const ev = e.nativeEvent ?? e;
              const joints = ev.joints ?? {};
              const lh = ev.leftHand ?? null;
              const rh = ev.rightHand ?? null;
              // Raw refs — used by warning polling and scoring pipeline.
              poseJointsRef.current  = joints;
              leftHandRef.current    = lh;
              rightHandRef.current   = rh;
              // Animation loop targets — display state is updated by the rAF loop.
              targetJointsRef.current   = joints;
              targetLeftHandRef.current  = lh;
              targetRightHandRef.current = rh;
              setDebugMetrics(computeDebugMetrics(joints, lh, rh));
              if (recordingActiveRef.current) {
                const ts = recordingStartTimeRef.current > 0
                  ? (Date.now() - recordingStartTimeRef.current) / 1000
                  : elapsedRef.current;
                poseFramesRef.current.push(convertPoseFrame(joints, lh, rh, ts));
                if (!firstPoseRef.current) {
                  firstPoseRef.current = true;
                  prevWarningsRef.current = new Set(evaluatePoseWarnings(joints, lh, rh));
                }
              }
            }}
            onRecordingFinished={onPoseRecordingFinished}
          />
        )}

        {/* Camera tip overlay (opaque — covers camera preview while user reads tips) */}
        {phase === 'camera_tip' && (
          <SafeAreaView style={[StyleSheet.absoluteFillObject, { backgroundColor: colors.background }]}>
            <LinearGradient colors={[colors.brand[900], colors.brand[800]]} style={styles.header}>
              <Text style={styles.headerTitle}>Position yourself</Text>
              {selectedPiece && (
                <View style={styles.pieceChip}>
                  <Text style={styles.pieceChipText} numberOfLines={1}>{selectedPiece.title}</Text>
                </View>
              )}
            </LinearGradient>

            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={styles.cameraTipContent}
              bounces={false}
            >
          {/* SVG illustration: stick-figure violin player with camera framing guide */}
          <View style={styles.cameraTipIllustration}>
            <Svg width={220} height={260} viewBox="0 0 220 260">
              {/* Camera frame guide — dashed border */}
              <Rect
                x={8} y={8} width={204} height={244}
                rx={12} ry={12}
                fill="none"
                stroke="rgba(139,92,246,0.35)"
                strokeWidth={2}
                strokeDasharray="6,5"
              />

              {/* Body */}
              <Line x1={110} y1={72} x2={110} y2={190} stroke="#64748b" strokeWidth={3} strokeLinecap="round" />

              {/* Head */}
              <Circle cx={110} cy={36} r={22} fill="none" stroke="#64748b" strokeWidth={3} />

              {/* Shoulders */}
              <Line x1={46} y1={72} x2={174} y2={72} stroke="#64748b" strokeWidth={3} strokeLinecap="round" />

              {/* Left arm — violin arm (green) */}
              {/* Shoulder → elbow (angled in and slightly down) */}
              <Line x1={46} y1={72} x2={28} y2={122} stroke="#22c55e" strokeWidth={3.5} strokeLinecap="round" />
              {/* Elbow → wrist (wrist raised, holding violin up) */}
              <Line x1={28} y1={122} x2={50} y2={158} stroke="#22c55e" strokeWidth={3.5} strokeLinecap="round" />
              {/* Wrist dot */}
              <Circle cx={50} cy={158} r={5} fill="#22c55e" />
              {/* Elbow dot */}
              <Circle cx={28} cy={122} r={5} fill="#22c55e" />

              {/* Right arm — bow arm (blue) */}
              {/* Shoulder → elbow (extended out) */}
              <Line x1={174} y1={72} x2={192} y2={116} stroke="#3b82f6" strokeWidth={3.5} strokeLinecap="round" />
              {/* Elbow → wrist */}
              <Line x1={192} y1={116} x2={186} y2={158} stroke="#3b82f6" strokeWidth={3.5} strokeLinecap="round" />
              {/* Wrist dot */}
              <Circle cx={186} cy={158} r={5} fill="#3b82f6" />
              {/* Elbow dot */}
              <Circle cx={192} cy={116} r={5} fill="#3b82f6" />

              {/* Shoulder dots */}
              <Circle cx={46} cy={72} r={5} fill="#64748b" />
              <Circle cx={174} cy={72} r={5} fill="#64748b" />

              {/* Camera icon below figure */}
              <G>
                {/* Phone body */}
                <Rect x={92} y={208} width={36} height={44} rx={5} ry={5} fill="none" stroke="#94a3b8" strokeWidth={2} />
                {/* Lens */}
                <Circle cx={110} cy={228} r={8} fill="none" stroke="#94a3b8" strokeWidth={2} />
                <Circle cx={110} cy={228} r={3} fill="#94a3b8" />
                {/* Home button */}
                <Rect x={105} y={242} width={10} height={4} rx={2} fill="#94a3b8" />
              </G>
            </Svg>
          </View>

          {/* Landscape callout */}
          <View style={styles.landscapeCallout}>
            <Text style={styles.landscapeCalloutTitle}>Hold phone in landscape</Text>
            <Text style={styles.landscapeCalloutBody}>
              Rotate your phone sideways before recording — landscape captures your full arm reach in frame.
            </Text>
          </View>

          {/* Callout tips */}
          <View style={styles.cameraTips}>
            <View style={styles.cameraTipRow}>
              <View style={[styles.cameraTipDot, { backgroundColor: '#22c55e' }]} />
              <Text style={styles.cameraTipRowText}>Left arm (violin) clearly visible</Text>
            </View>
            <View style={styles.cameraTipRow}>
              <View style={[styles.cameraTipDot, { backgroundColor: '#3b82f6' }]} />
              <Text style={styles.cameraTipRowText}>Right arm (bow) clearly visible</Text>
            </View>
            <View style={styles.cameraTipRow}>
              <View style={[styles.cameraTipDot, { backgroundColor: '#64748b' }]} />
              <Text style={styles.cameraTipRowText}>Step back so both elbows are in frame</Text>
            </View>
            <View style={styles.cameraTipRow}>
              <View style={[styles.cameraTipDot, { backgroundColor: '#94a3b8' }]} />
              <Text style={styles.cameraTipRowText}>Camera at roughly chest height, facing you</Text>
            </View>
          </View>

          <Button
            label="Ready — Start Recording"
            onPress={startRecording}
            size="lg"
            fullWidth
          />

          <Pressable style={styles.backBtn} onPress={() => setPhase('method_select')}>
            <Text style={styles.backLabel}>← Back</Text>
          </Pressable>
        </ScrollView>
          </SafeAreaView>
        )}

        {/* Expo-camera fallback (Android / no native module) — only during recording */}
        {isRecording && !usingPoseCamera && (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFillObject}
            facing="front"
            mode="video"
            onCameraReady={onCameraReady}
          />
        )}

        {/* Arm skeleton overlay */}
        {isRecording && usingPoseCamera && Object.keys(poseJoints).length > 0 && (
          <PoseSkeleton
            joints={poseJoints}
            leftHand={leftHand}
            rightHand={rightHand}
            width={screenWidth}
            height={screenHeight}
            flip={LANDSCAPE_FLIP}
          />
        )}

        {/* Recording HUD — wrist angle + stop button only */}
        {isRecording && (
          <View style={lsContainer} pointerEvents="box-none">
            {usingPoseCamera && (
              <Text style={styles.recWristAngle} pointerEvents="none">
                {(() => { const wa = liveWristAngle(poseJoints, leftHand); return wa !== null ? `${Math.round(wa)}°` : ''; })()}
              </Text>
            )}
            <View style={styles.recStopCorner} pointerEvents="box-none">
              <Pressable
                style={styles.stopButton}
                onPress={usingPoseCamera ? handleStopPoseRecording : stopRecording}
                pointerEvents="auto"
              >
                <View style={styles.stopButtonInner} />
              </Pressable>
            </View>
          </View>
        )}

      </View>
    );
  }

  // ── Processing ─────────────────────────────────────────────
  if (['processing_audio', 'processing_video', 'uploading'].includes(phase)) {
    return (
      <View style={[styles.fullScreen, { backgroundColor: colors.brand[900] }]}>
        <ActivityIndicator size="large" color="#fff" />
        <Text style={styles.processingLabel}>{PHASE_LABELS[phase]}</Text>
        <Text style={styles.processingSubLabel}>This takes about 15 seconds</Text>
      </View>
    );
  }

  // ── Error ──────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.fullScreen}>
          <Text style={styles.errorEmoji}>⚠️</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Button label="Try Again" onPress={reset} size="md" />
        </View>
      </SafeAreaView>
    );
  }

  // ── Results ────────────────────────────────────────────────
  if (phase === 'done' && currentResult) {
    const prevResultForTrend = sessionResultCache[sessionHistory[1]?.id ?? ''];
    const prevIntonationAnalysis = prevResultForTrend?.intonationAnalysis;
    const assessment = currentResult.sessionAssessment;

    return (
      <SafeAreaView style={styles.resultsSafe}>
        {/* Video occupies only the visible area above the drawer */}
        <Animated.View style={[styles.resultsVideoLayer, { bottom: drawerAnim }]}>
          {currentResult.videoUri ? (
            <InlineVideoPlayer
              uri={currentResult.videoUri}
              seekVersion={seekVersion}
              seekSeconds={seekSeconds}
              fullScreen
              noteEvents={currentResult.noteEvents}
              durationSeconds={currentResult.durationSeconds}
              onMarkerPress={handleTimestampPress}
            />
          ) : null}
        </Animated.View>

        {/* Swipeable bottom drawer */}
        <Animated.View style={[styles.resultsDrawer, { height: drawerAnim }]}>
          {/* Drag handle — always responds to vertical swipes */}
          <View style={styles.drawerHandleArea} {...handlePanResponder.panHandlers}>
            <View style={styles.drawerHandlePill} />
          </View>

          {/* Content area — steals vertical scrolls at card top/bottom boundaries */}
          <View style={styles.drawerContent} {...contentPanResponder.panHandlers}>
            {currentResult.audioQualityWarning && (
              <View style={styles.audioWarningBanner}>
                <Text style={styles.audioWarningIcon}>⚠</Text>
                <Text style={styles.audioWarningText}>{currentResult.audioQualityWarning}</Text>
              </View>
            )}
            {currentResult.llmFeedback && (
              <CoachingReport
                llmFeedback={currentResult.llmFeedback}
                assessment={assessment}
                intonationAnalysis={currentResult.intonationAnalysis}
                prevIntonationAnalysis={prevIntonationAnalysis}
                videoUri={currentResult.videoUri}
                metrics={currentResult.metrics}
                durationSeconds={currentResult.durationSeconds}
                onTimestampPress={handleTimestampPress}
                cardScrollEnabled={cardsScrollEnabled}
                onCardScrollPosition={(atTop, atBottom) => {
                  cardScrollAtTopRef.current = atTop;
                  cardScrollAtBottomRef.current = atBottom;
                }}
              />
            )}
          </View>

          {/* Action button */}
          <View style={styles.resultsDrawerActions}>
            <Button label="New Session" onPress={reset} variant="primary" fullWidth size="md" />
          </View>
        </Animated.View>
      </SafeAreaView>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  fullScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  header: { paddingTop: 20, paddingBottom: spacing.xl, paddingHorizontal: spacing.xl },
  headerTitle: { fontSize: 24, fontWeight: '700', color: '#fff' },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.7)', marginTop: 4 },

  // Piece chip (method_select)
  pieceChip: {
    marginTop: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    alignSelf: 'flex-start',
    maxWidth: '90%',
  },
  pieceChipText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  // Step 1 — piece input
  inputContent: { flex: 1 },
  inputContentInner: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  songInput: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontSize: 17,
    color: colors.text.primary,
    borderWidth: 1.5,
    borderColor: colors.brand[200],
  },
  sheetMusicBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderStyle: 'dashed',
  },
  sheetMusicBtnIcon: { fontSize: 22 },
  sheetMusicBtnTitle: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
  sheetMusicBtnSub: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
  sheetMusicAttached: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: '#f0fdf4',
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: '#86efac',
  },
  sheetMusicIcon: { fontSize: 20 },
  sheetMusicFilename: { flex: 1, fontSize: 13, fontWeight: '600', color: '#166534' },
  sheetMusicRemove: { padding: 4 },
  sheetMusicRemoveText: { fontSize: 14, color: '#dc2626', fontWeight: '700' },
  skipBtn: { alignItems: 'center', paddingVertical: spacing.md },
  skipLabel: { fontSize: 14, color: colors.text.muted, textDecorationLine: 'underline' },

  // Step 2 — method select
  methodContent: { flex: 1, padding: spacing.lg, justifyContent: 'center', gap: spacing.md },
  methodCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 3,
  },
  methodIcon: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  methodIconText: { fontSize: 24 },
  methodText: { flex: 1 },
  methodTitle: { fontSize: 16, fontWeight: '700', color: colors.text.primary },
  methodSub: { fontSize: 12, color: colors.text.muted, marginTop: 2, lineHeight: 17 },
  methodArrow: { fontSize: 22, color: colors.text.muted, fontWeight: '300' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#e5e7eb' },
  dividerLabel: { fontSize: 13, color: colors.text.muted, fontWeight: '500' },
  tuneLink: { alignItems: 'center', paddingVertical: spacing.sm },
  tuneLinkText: { fontSize: 14, color: colors.brand[600], fontWeight: '600' },
  backBtn: { alignItems: 'center', paddingVertical: spacing.md },
  backLabel: { fontSize: 14, color: colors.brand[600], fontWeight: '600' },
  uploadTip: {
    backgroundColor: '#fef3c7',
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: -spacing.xs,
  },
  uploadTipText: { fontSize: 12, color: '#92400e', lineHeight: 17 },

  // Camera position guide
  cameraTipContent: {
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.lg,
    paddingBottom: spacing.xl,
  },
  cameraTipIllustration: {
    alignItems: 'center',
    backgroundColor: '#f8f7ff',
    borderRadius: 16,
    padding: spacing.md,
  },
  landscapeCallout: {
    width: '100%',
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderLeftWidth: 3,
    borderLeftColor: '#f59e0b',
    borderRadius: 8,
    padding: spacing.sm,
    marginBottom: spacing.xs,
  },
  landscapeCalloutTitle: { fontSize: 13, fontWeight: '700', color: '#f59e0b', marginBottom: 2 },
  landscapeCalloutBody: { fontSize: 13, color: colors.text.secondary, lineHeight: 18 },
  cameraTips: { width: '100%', gap: spacing.sm },
  cameraTipRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cameraTipDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  cameraTipRowText: { fontSize: 14, color: colors.text.secondary, flex: 1, lineHeight: 20 },

  // Large wrist angle + palm normal display
  wristAngleRow: {
    position: 'absolute',
    bottom: 230,
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  wristAngleDisplay: {
    width: 130,
    height: 108,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 16,
    gap: 2,
  },
  wristAngleLabel: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  wristAngleValue: {
    fontSize: 72,
    fontWeight: '200',
    lineHeight: 76,
    width: 130,
    textAlign: 'center',
    includeFontPadding: false,
  },

  // Camera recording
  recordingScreen: { flex: 1, backgroundColor: '#000' },
  recordingOverlay: { flex: 1, justifyContent: 'space-between' },
  recordingTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
  },
  recBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
  },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444' },
  recText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  recordingTimer: { fontSize: 36, fontWeight: '200', color: '#fff' },
  recordingBottom: { alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.xl },
  recordingPieceName: { color: 'rgba(255,255,255,0.9)', fontSize: 15, fontWeight: '600', maxWidth: '80%' },
  recordingHint: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  stopButton: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
    marginTop: spacing.sm,
  },
  stopButtonInner: { width: 28, height: 28, borderRadius: 6, backgroundColor: '#ef4444' },
  stopLabel: { color: '#fff', fontSize: 13, fontWeight: '600' },
  poseLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#22c55e',
  },
  legendText: { color: '#fff', fontSize: 11, fontWeight: '600' },

  // Processing
  processingLabel: { fontSize: 18, color: '#fff', fontWeight: '600' },
  processingSubLabel: { fontSize: 13, color: 'rgba(255,255,255,0.6)' },

  // Error
  errorEmoji: { fontSize: 48 },
  errorText: { fontSize: 15, color: colors.text.primary, textAlign: 'center' },

  // Debug overlay
  debugToggleBtn: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  debugToggleBtnActive: {
    backgroundColor: 'rgba(251,191,36,0.3)',
    borderColor: '#fbbf24',
  },
  debugToggleBtnText: { color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  debugPanel: {
    position: 'absolute',
    top: 64,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.78)',
    borderRadius: 10,
    padding: 10,
    minWidth: 190,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  dbgHead: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  dbgRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginVertical: 1.5,
  },
  dbgLabel: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 10,
    width: 76,
    fontVariant: ['tabular-nums'] as any,
  },
  dbgVal: {
    fontSize: 11,
    fontWeight: '700',
    width: 52,
    textAlign: 'right',
    fontVariant: ['tabular-nums'] as any,
  },
  dbgThresh: {
    color: 'rgba(255,255,255,0.25)',
    fontSize: 9,
    width: 36,
    textAlign: 'right',
  },
  dbgMeta: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 9,
    marginTop: 6,
    textAlign: 'right',
  },

  // Coaching prompt (real-time during recording)
  coachingPromptPanel: {
    width: '100%',
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  coachingPromptCard: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
  },
  coachingPromptText: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },

  // Results — full-screen video + swipeable drawer
  resultsSafe: { flex: 1, backgroundColor: '#1a0a2e' },
  // bottom is set inline as an Animated.Value so the video shrinks as the drawer grows
  resultsVideoLayer: { position: 'absolute', top: 0, left: 0, right: 0 },
  resultsDrawer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.22,
    shadowRadius: 20,
    elevation: 20,
  },
  drawerHandleArea: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 6,
    // Wider tap target so the pill is easy to grab
    paddingHorizontal: 60,
  },
  drawerContent: { flex: 1 },
  audioWarningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#fef3c7',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#fbbf24',
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  audioWarningIcon: { fontSize: 14, color: '#92400e', marginTop: 1 },
  audioWarningText: { flex: 1, fontSize: 13, color: '#92400e', lineHeight: 19 },
  drawerHandlePill: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d1d5db',
  },
  resultsDrawerActions: {
    padding: spacing.md,
    paddingBottom: 24,
  },

  // ── Recording HUD (minimal) ────────────────────────────────────────────────
  recWristAngle: {
    position: 'absolute',
    top: 14,
    right: 16,
    fontSize: 28,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.9)',
    fontVariant: ['tabular-nums'],
  },
  recStopCorner: {
    position: 'absolute',
    bottom: 14,
    left: 16,
  },

});
