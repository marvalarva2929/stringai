import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
  Alert,
  ActivityIndicator,
  Animated,
  Easing,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions,
  Modal,
} from 'react-native';
import RAnimated, { useSharedValue, useAnimatedStyle, withTiming, FadeInRight } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { router, useNavigation, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useUserStore } from '../../src/store/useUserStore';
import { useActivationStore } from '../../src/store/useActivationStore';
import { useSpotlightTarget } from '../../src/components/activation/useSpotlightTarget';
import { useCoachmarks } from '../../src/components/activation/useCoachmarks';
import { SpotlightOverlay } from '../../src/components/activation/SpotlightOverlay';
import { PIECE_COACHMARKS, CAPTURE_COACHMARKS } from '../../src/constants/activationScript';
import { loadDemoAnalysis } from '../../src/lib/activationDemo';
import { DiagnosticTake } from '../../src/components/onboarding/DiagnosticTake';
import { syncTrialRecap } from '../../src/services/trialRecapScheduler';
import { TunerModal } from '../../src/components/tuner/TunerModal';
import { runAudioAnalysis, mockVideoMetrics, computeOverallScore, activeScoreWeights, saveSession, sessionToSummary, sessionToMetricHistoryEntry, buildSessionFeedback, updateSessionLlmFeedback } from '../../src/services/analysis';
import { runSessionPipeline } from '../../src/lib/sessionPipeline';
import { useEntitlementStore } from '../../src/store/useEntitlementStore';
import { isPro } from '../../src/lib/entitlements';
import { isSupabaseConfigured } from '../../src/services/supabase';
import { buildCoachingInput, fetchCoachingFeedback } from '../../src/services/llmFeedback';
import { computePracticePlan } from '../../src/lib/practicePlan';
import { candidatesFromBlocks } from '../../src/lib/practiceCuration';
import { useCuratedPlanStore } from '../../src/store/useCuratedPlanStore';
import { AnalysisTimeline } from '../../src/components/analysis/AnalysisTimeline';
import { LiveCoachBanner } from '../../src/components/analysis/LiveCoachBanner';
import { MetronomeSetup } from '../../src/components/analysis/MetronomeSetup';
import { MetronomeBeatBar } from '../../src/components/analysis/MetronomeBeatBar';
import { createLiveCoach, COACH_WINDOW_S, type LiveCoach, type LiveCue } from '../../src/lib/liveCoach';
import { useMetronome } from '../../src/hooks/useMetronome';
import { useMetronomeStore } from '../../src/store/useMetronomeStore';
import { InlineVideoPlayer } from '../../src/components/analysis/InlineVideoPlayer';
import { ResultsCarousel } from '../../src/components/analysis/ResultsCarousel';
import { BowCalibrationFlow, type CaptureBowClip } from '../../src/components/practice/BowCalibrationFlow';
import { Button } from '../../src/components/ui/Button';
import { BigButton } from '../../src/components/ui/BigButton';
import { MaestroAvatar } from '../../src/components/ui/MaestroAvatar';
import { haptic } from '../../src/lib/haptics';
import { colors, spacing, radius } from '../../src/constants/theme';
import { AnalysisResult, MetricScore } from '../../src/types/analysis';
import { buildSessionAssessment } from '../../src/lib/sessionAssessment';
import { buildSessionEvidence, EVIDENCE_VERSION } from '../../src/lib/practiceEvidence';
import { Piece } from '../../src/types/piece';
import { TECHNIQUE_PIECE } from '../../src/constants/pieces';
import { INSTRUMENTS } from '../../src/constants/instruments';
import { PoseSkeleton, PoseJoint, PoseJoints, HandLandmarks, LEFT_HAND_COLOR, RIGHT_HAND_COLOR } from '../../src/components/analysis/PoseSkeleton';
import { startRecording as poseStartRecording, stopRecording as poseStopRecording, getPoseCameraView, setHomeIndicatorHidden } from 'pose-camera';
import { FrameKeypoints } from '../../src/lib/poseScoring';
import { createBowGeometryTracker, type NormPoint } from '../../src/lib/bowBoxGeometry';
import { convertPoseFrame, extractVideoFrames } from '../../src/services/videoAnalysis';
import { RawBowFrame } from '../../src/types/signals';
import { debugLogNoteEvents, deriveIntonationAnalysis } from '../../src/lib/noteFusion';
import { classifyVibratoSegment } from '../../src/services/pitchContour';
import Svg, { Circle, Line, G, Rect, Path, Polygon, Text as SvgText } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCalibrationStore } from '../../src/store/useCalibrationStore';
import { CALIBRATION_ENABLED } from '../../src/constants/featureFlags';
import { track } from '../../src/services/analytics';
import { breadcrumb, reportError } from '../../src/services/crashReporting';
import { AnalyticsEvent } from '../../src/constants/analyticsEvents';
import type {
  AnalysisDegradedReason,
  AnalysisFailureStage,
  AnalysisSource,
} from '../../src/constants/analyticsEvents';
import { errorReason } from '../../src/lib/analyticsUserProps';
import { createStopwatch } from '../../src/lib/analyticsTiming';
import { buildMusicalEvidence } from '../../src/lib/musicalEvidence';
import { startTrace } from '../../src/services/performance';

// Confidence floor for the debug metrics panel. The live coaching thresholds
// moved to src/lib/liveCoach.ts, which reads poseScoring's THRESHOLDS so the
// numbers behind a live tip and behind the report are the same numbers.
const JOINT_CONF_THRESHOLD = 0;

// Toggle if the skeleton appears mirrored or upside-down in the landscape view.
const LANDSCAPE_FLIP = true;
// Hides the wrist/vibrato HUD panels while analyzing bow+violin detection.
// Typed as boolean (not literal false) so TS still runs control-flow
// narrowing inside the hidden JSX — a literal `false &&` marks the branch
// unreachable and breaks the null guards within.
const SHOW_LIVE_HUD: boolean = false;

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
    wx: (prev.wx != null && next.wx != null) ? prev.wx * (1 - alpha) + next.wx * alpha : next.wx,
    wy: (prev.wy != null && next.wy != null) ? prev.wy * (1 - alpha) + next.wy * alpha : next.wy,
    wz: (prev.wz != null && next.wz != null) ? prev.wz * (1 - alpha) + next.wz * alpha : next.wz,
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

// Interior angle at the left wrist using Pose Landmarker world coords (body-global frame).
// All three landmarks — elbow, wrist, indexTip — come from the same coordinate frame so
// no palm gate is needed and the angle is camera-angle-independent.
// Falls back to 2D image-space projection when world coords are absent.
function liveWristAngle(
  joints: PoseJoints,
  _hand: HandLandmarks | null,
): number | null {
  return liveWristDebugData(joints).angle;
}

type WristDebug = {
  angle: number | null;
  mode: '3D' | '2D' | 'nodata';
  magF: number | null;   // forearm vector length (cm)
  magH: number | null;   // hand vector length (cm)
  cosA: number | null;   // dot/(|FA||H|) — cos of angle
  tx: number | null; ty: number | null; tz: number | null; // indexTip world (cm)
};

function liveWristDebugData(joints: PoseJoints): WristDebug {
  const none: WristDebug = { angle: null, mode: 'nodata', magF: null, magH: null, cosA: null, tx: null, ty: null, tz: null };
  const elbow    = joints.leftElbow;
  const wrist    = joints.leftWrist;
  const indexTip = joints.leftIndexTip;
  if (!elbow || !wrist || !indexTip) return none;

  if (elbow.wx != null && wrist.wx != null && indexTip.wx != null) {
    const fax = elbow.wx - wrist.wx, fay = (elbow.wy ?? 0) - (wrist.wy ?? 0), faz = (elbow.wz ?? 0) - (wrist.wz ?? 0);
    const hx = indexTip.wx - wrist.wx, hy = (indexTip.wy ?? 0) - (wrist.wy ?? 0), hz = (indexTip.wz ?? 0) - (wrist.wz ?? 0);
    const magF = Math.sqrt(fax * fax + fay * fay + faz * faz);
    const magH = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (magF < 0.0001 || magH < 0.0001) return none;
    const cosA = Math.max(-1, Math.min(1, (fax * hx + fay * hy + faz * hz) / (magF * magH)));
    return {
      angle: (Math.acos(cosA) * 180) / Math.PI,
      mode: '3D',
      magF: Math.round(magF * 100),  // m → cm
      magH: Math.round(magH * 100),
      cosA: Math.round(cosA * 100) / 100,
      tx: Math.round((indexTip.wx ?? 0) * 100),
      ty: Math.round((indexTip.wy ?? 0) * 100),
      tz: Math.round((indexTip.wz ?? 0) * 100),
    };
  }

  // 2D fallback: aspect-ratio-corrected image-space angle.
  const abx = (elbow.x - wrist.x) * FRAME_ASPECT_RATIO, aby = elbow.y - wrist.y;
  const cbx = (indexTip.x - wrist.x) * FRAME_ASPECT_RATIO, cby = indexTip.y - wrist.y;
  const mag = Math.sqrt((abx * abx + aby * aby) * (cbx * cbx + cby * cby));
  if (mag < 0.0001) return none;
  const cosA = Math.max(-1, Math.min(1, (abx * cbx + aby * cby) / mag));
  return {
    angle: (Math.acos(cosA) * 180) / Math.PI,
    mode: '2D',
    magF: null, magH: null,
    cosA: Math.round(cosA * 100) / 100,
    tx: null, ty: null, tz: null,
  };
}

// Live pose warnings used to be evaluated here, from raw joints, and never
// rendered. They now come from src/lib/liveCoach.ts, which reads the same
// FrameKeypoints/RawBowFrames the session report is scored from — see
// LiveCoachBanner for how a cue is shown.

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

// DRAWER_DEFAULT_H is computed inside the component from useWindowDimensions (see below)

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

const SESSIONS_DIR = new Directory(Paths.document, 'sessions');

function pruneOldVideos(): void {
  if (!SESSIONS_DIR.exists) return;
  const files = SESSIONS_DIR.list().filter((entry): entry is File => entry instanceof File);
  if (files.length <= 10) return;
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name)); // session_<timestamp>.* — lexicographic = chronological
  for (const stale of sorted.slice(0, sorted.length - 10)) {
    try { stale.delete(); } catch { /* already gone — nothing to reclaim */ }
  }
}

function persistVideo(tempUri: string): string {
  if (tempUri.startsWith('ph://')) return tempUri; // Photos library URI — directly playable
  const ext = tempUri.split('.').pop() ?? 'mp4';
  SESSIONS_DIR.create({ intermediates: true, idempotent: true });
  pruneOldVideos();
  const dest = new File(SESSIONS_DIR, `session_${Date.now()}.${ext}`);
  new File(tempUri).copy(dest);
  return dest.uri;
}

const PHASE_LABELS: Record<string, string> = {
  processing_audio: 'Analyzing pitch & tone',
  processing_video: 'Checking bow placement',
  uploading: 'Saving session',
};

const PROCESSING_PHASES = ['processing_audio', 'processing_video', 'uploading'] as const;
const PHASE_DURATIONS: Record<string, number> = {
  processing_audio: 15000,
  processing_video: 15000,
  uploading: 4000,
};

// ── Pitch graph helpers ──────────────────────────────────────────────────────

const GRAPH_W = 440;
const GRAPH_H = 110;
const GRAPH_CENTS_RANGE = 60;  // ± cents shown (one semitone)

function vibratoScoreFromPitchHistory(hz: number[]): number {
  if (hz.length < 12) return 0;

  // Segment on large pitch jumps (>100 cents) — same threshold as scoreVibrato in audioEngine
  const segments: number[][] = [];
  let cur: number[] = [hz[0]];
  for (let i = 1; i < hz.length; i++) {
    const jump = Math.abs(1200 * Math.log2(hz[i] / hz[i - 1]));
    if (jump > 100) { segments.push(cur); cur = [hz[i]]; }
    else cur.push(hz[i]);
  }
  segments.push(cur);

  // Eligible: ≥ 6 points = ≥ 300ms at 20Hz
  const eligible = segments.filter(s => s.length >= 6);
  if (eligible.length === 0) return 0;

  let vibratoCount = 0;
  for (const seg of eligible) {
    const sorted = [...seg].sort((a, b) => a - b);
    const medianFreq = sorted[Math.floor(sorted.length / 2)];
    const devs = seg.map(f => 1200 * Math.log2(f / medianFreq));
    if (classifyVibratoSegment(devs, 20).isVibrato) vibratoCount++;
  }

  const ratio = vibratoCount / eligible.length;
  return Math.round(ratio >= 0.6 ? 70 + ratio * 30 : ratio * 70);
}

function buildPitchPath(history: (number | null)[], w: number, h: number): string {
  const nonNull = history.filter(v => v !== null) as number[];
  if (nonNull.length < 3) return '';
  const sorted = [...nonNull].sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length / 2)];
  const PAD = 6;
  const mh = h - PAD * 2;
  const RANGE = GRAPH_CENTS_RANGE;
  let d = '';
  let pen = false;
  history.forEach((hz, i) => {
    const x = (i / Math.max(history.length - 1, 1)) * w;
    if (!hz) { pen = false; return; }
    const c = Math.max(-RANGE, Math.min(RANGE, 1200 * Math.log2(hz / base)));
    const y = PAD + mh / 2 - (c / RANGE) * (mh / 2);
    d += pen ? ` L${x.toFixed(1)} ${y.toFixed(1)}` : `M${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  });
  return d;
}

function PitchGraph({ history }: { history: (number | null)[] }) {
  const path = buildPitchPath(history, GRAPH_W, GRAPH_H);
  const cy = GRAPH_H / 2;
  const PAD = 6;
  const mh = GRAPH_H - PAD * 2;
  const y25 = PAD + mh / 2 - (25 / GRAPH_CENTS_RANGE) * (mh / 2);
  const yn25 = PAD + mh / 2 + (25 / GRAPH_CENTS_RANGE) * (mh / 2);
  return (
    <Svg width={GRAPH_W} height={GRAPH_H}>
      <Line x1={0} y1={y25}  x2={GRAPH_W} y2={y25}  stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
      <Line x1={0} y1={cy}   x2={GRAPH_W} y2={cy}   stroke="rgba(255,255,255,0.28)" strokeWidth={1} />
      <Line x1={0} y1={yn25} x2={GRAPH_W} y2={yn25} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
      {path ? <Path d={path} stroke="rgba(100,210,255,0.92)" strokeWidth={2.5} fill="none" strokeLinejoin="round" strokeLinecap="round" /> : null}
    </Svg>
  );
}

const METRIC_LABELS: Record<string, string> = {
  pitchAccuracy: 'Pitch Accuracy', intonationStability: 'Intonation Stability',
  toneQuality: 'Tone Quality', bowSmoothness: 'Bow Smoothness',
  vibrato: 'Vibrato', rhythmAccuracy: 'Rhythm', dynamicControl: 'Dynamics',
  bowPlacement: 'Bow Placement', bowAngle: 'Bow Angle',
  bowArmLevel: 'Bow Arm Level', bowDistribution: 'Bow Distribution',
  leftHandWrist: 'Left Hand Wrist', posture: 'Posture',
};

// ── Radar chart ─────────────────────────────────────────────────────────────

const RADAR_CATS = [
  { label: 'Intonation', keys: ['pitchAccuracy', 'intonationStability'] },
  { label: 'Bow',        keys: ['bowSmoothness', 'bowPlacement', 'bowAngle', 'bowDistribution'] },
  { label: 'Posture',    keys: ['posture', 'leftHandWrist', 'bowArmLevel'] },
  { label: 'Rhythm',     keys: ['rhythmAccuracy'] },
  { label: 'Tone',       keys: ['toneQuality', 'dynamicControl'] },
  { label: 'Vibrato',    keys: ['vibrato'] },
] as const;

function RadarChart({ metrics }: { metrics: import('../../src/types/analysis').MetricScore[] }) {
  const N = RADAR_CATS.length;
  const CX = 100, CY = 100, R = 74;
  const LABEL_R = R + 26;

  const metricsMap: Record<string, number> = {};
  for (const m of metrics) metricsMap[m.key] = m.score;

  const scores = RADAR_CATS.map(cat => {
    const vals = cat.keys.map(k => metricsMap[k]).filter((v): v is number => v !== undefined);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  });

  const angleAt = (i: number) => -Math.PI / 2 + (i / N) * 2 * Math.PI;

  const outerPt = (i: number) => ({
    x: CX + R * Math.cos(angleAt(i)),
    y: CY + R * Math.sin(angleAt(i)),
  });

  const scorePt = (i: number) => {
    const frac = Math.max(0.05, scores[i] / 100); // min sliver so shape is always visible
    return {
      x: CX + frac * R * Math.cos(angleAt(i)),
      y: CY + frac * R * Math.sin(angleAt(i)),
    };
  };

  const ringPoints = (frac: number) =>
    Array.from({ length: N }, (_, i) => {
      const a = angleAt(i);
      return `${CX + frac * R * Math.cos(a)},${CY + frac * R * Math.sin(a)}`;
    }).join(' ');

  const scorePoints = Array.from({ length: N }, (_, i) => {
    const p = scorePt(i);
    return `${p.x},${p.y}`;
  }).join(' ');

  const textAnchor = (i: number) => {
    const x = Math.cos(angleAt(i));
    return x > 0.3 ? 'start' : x < -0.3 ? 'end' : 'middle';
  };

  const labelDy = (i: number) => {
    const s = Math.sin(angleAt(i));
    return s < -0.4 ? '-0.2em' : s > 0.4 ? '1em' : '0.35em';
  };

  return (
    <Svg width={220} height={220} viewBox="-30 -30 260 260">
      {/* Web rings */}
      {[0.33, 0.66, 1].map(f => (
        <Polygon key={f} points={ringPoints(f)} fill="none"
          stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
      ))}

      {/* Radii */}
      {Array.from({ length: N }, (_, i) => {
        const p = outerPt(i);
        return <Line key={i} x1={CX} y1={CY} x2={p.x} y2={p.y}
          stroke="rgba(255,255,255,0.12)" strokeWidth={1} />;
      })}

      {/* Score polygon */}
      <Polygon points={scorePoints} fill="rgba(56,189,248,0.2)"
        stroke="#38bdf8" strokeWidth={2} strokeLinejoin="round" />

      {/* Outer ring dots */}
      {Array.from({ length: N }, (_, i) => {
        const p = outerPt(i);
        return <Circle key={i} cx={p.x} cy={p.y} r={3}
          fill="rgba(255,255,255,0.25)" />;
      })}

      {/* Score dots */}
      {Array.from({ length: N }, (_, i) => {
        const p = scorePt(i);
        return <Circle key={i} cx={p.x} cy={p.y} r={4.5}
          fill="#38bdf8" stroke="#fff" strokeWidth={1.5} />;
      })}

      {/* Labels */}
      {RADAR_CATS.map((cat, i) => {
        const a = angleAt(i);
        const lx = CX + LABEL_R * Math.cos(a);
        const ly = CY + LABEL_R * Math.sin(a);
        return (
          <SvgText key={cat.label} x={lx} y={ly} dy={labelDy(i)}
            fontSize={11} fontWeight="600"
            fill="rgba(255,255,255,0.75)"
            textAnchor={textAnchor(i)}>
            {cat.label}
          </SvgText>
        );
      })}
    </Svg>
  );
}

// Checklist, not prose: this is read at a glance while holding a violin.
const UPLOAD_TIPS = [
  'Whole violin in frame, scroll to tailpiece',
  'Left wrist visible throughout',
  'Bow in frame for most strokes',
  'Stay in one position',
  'Quiet room',
  'Violin clearly audible',
];

const METHOD_DEPTH = 5;
const METHOD_H = 80;

function MethodButton({
  onPress,
  iconName,
  iconBg,
  iconColor,
  title,
  subtitle,
}: {
  onPress: () => void;
  iconName: React.ComponentProps<typeof Ionicons>['name'];
  iconBg: string;
  iconColor: string;
  title: string;
  subtitle: string;
}) {
  const offset = useSharedValue(0);
  const surfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));
  return (
    <Pressable
      onPressIn={() => { offset.value = withTiming(METHOD_DEPTH, { duration: 60 }); }}
      onPressOut={() => { offset.value = withTiming(0, { duration: 100 }); }}
      onPress={onPress}
      style={styles.methodBtnOuter}
    >
      <View style={styles.methodBtnBase} />
      <RAnimated.View style={[styles.methodBtnSurface, surfaceStyle]}>
        <View style={[styles.methodBtnIconWrap, { backgroundColor: iconBg }]}>
          <Ionicons name={iconName} size={26} color={iconColor} />
        </View>
        <View style={styles.methodBtnText}>
          <Text style={styles.methodBtnTitle}>{title}</Text>
          <Text style={styles.methodBtnSub}>{subtitle}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.text.muted} />
      </RAnimated.View>
    </Pressable>
  );
}

export default function AnalyzeScreen() {
  const {
    phase, selectedPiece, currentResult, error, sessionHistory,
    metricHistory, sessionResultCache,
    setPhase, setSelectedPiece, setRecordingUri, setResult, setError, reset,
    addToHistory, addToMetricHistory, cacheSessionResult, continueWithPiece,
  } = useAnalysisStore();
  // 'pick' = arrived by tapping a piece card, 'new' = arrived via "New piece".
  // Absent when this tab was opened directly or by first-run activation.
  const { from: entryPoint } = useLocalSearchParams<{ from?: 'pick' | 'new' }>();
  const cameFromPicker = entryPoint === 'pick' || entryPoint === 'new';
  const { profile } = useUserStore();
  const { isAuthenticated, playerCategory, weeklyGoalMinutes } = useAuthStore();
  const { entitlement } = useEntitlementStore();
  const setCalibration = useCalibrationStore((s) => s.setCalibration);

  // Top of the capture funnel — every later step (piece, method, recording,
  // analysis) is measured against this denominator.
  useEffect(() => {
    track(AnalyticsEvent.ANALYSIS_FLOW_START, {
      in_activation: inCaptureStage,
      session_count: sessionHistory.length,
    });
    // Mount only: re-firing on activation changes would double-count.
  }, []);

  // ── Activation (first run) ───────────────────────────────────
  const activationStep = useActivationStore((st) => st.step);
  const inCaptureStage = activationStep === 'capture';

  const pieceSpotlight = useSpotlightTarget('piece.search');
  // One target per option — highlighting both buttons at once explained neither.
  const recordMethodSpotlight = useSpotlightTarget('capture.record');
  const uploadMethodSpotlight = useSpotlightTarget('capture.upload');

  // The walkthrough drives this screen rather than waiting on the user. Asking a
  // brand-new player to name a piece and record a take before they have seen a
  // single result is where the flow used to strand them — so each run of
  // coachmarks moves the screen on by itself.
  const pieceCoach = useCoachmarks(
    PIECE_COACHMARKS,
    inCaptureStage && phase === 'piece_input',
    () => setPhase('method_select'),
  );

  const captureCoach = useCoachmarks(
    CAPTURE_COACHMARKS,
    inCaptureStage && phase === 'method_select',
    () => {
      // Both capture buttons have been explained; now they actually play. This
      // used to jump straight to the hand-authored sample instead, which meant
      // nobody ever heard their own playing analysed before being asked to pay
      // — the one thing a screenshot of the app can't reproduce.
      //
      // The piece is set here rather than at hand-off because processMedia
      // closes over `selectedPiece`; setting it in the same tick as the call
      // would leave the closure reading the previous value. A scale isn't a
      // piece, but it still needs a home in history — the same bucket the
      // "not a piece" path uses.
      setSelectedPiece(TECHNIQUE_PIECE);
      setDiagnosticOpen(true);
    },
  );

  /** The first-run scale take. Owns the capture stage until it produces a result. */
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);

  const useSampleInstead = () => {
    setDiagnosticOpen(false);
    const activation = useActivationStore.getState();
    activation.markDemo();
    activation.advanceTo('carousel');
    loadDemoAnalysis();
  };

  /** True wherever activation owns this screen — keeps the scrim up between steps. */
  const captureBlocking =
    inCaptureStage && (phase === 'piece_input' || phase === 'method_select');

  // A real analysis landing during activation (rather than the sample) also
  // hands over to the carousel walkthrough — covers the live-record and upload
  // paths if a user reaches them mid-flow.
  useEffect(() => {
    if (inCaptureStage && phase === 'done' && currentResult) {
      useActivationStore.getState().advanceTo('carousel');
    }
  }, [inCaptureStage, phase, currentResult]);

  // Video seek state (for inline player in results)
  const [seekVersion, setSeekVersion] = useState(0);
  const [seekSeconds, setSeekSeconds] = useState(0);

  // Processing screen progress animation
  const processingProgress = useRef(new Animated.Value(0)).current;
  const processingAnimRef = useRef<Animated.CompositeAnimation | null>(null);


  useEffect(() => {
    const idx = PROCESSING_PHASES.indexOf(phase as typeof PROCESSING_PHASES[number]);
    if (idx < 0) { processingProgress.setValue(0); return; }
    const start = idx / PROCESSING_PHASES.length;
    const end = (idx + 1) / PROCESSING_PHASES.length;
    // Seed the first phase at 5% so the bar is immediately visible instead of
    // starting from a zero-width sliver that looks like nothing is happening.
    const seedValue = idx === 0 ? Math.max(0.05, start) : start;
    processingAnimRef.current?.stop();
    processingProgress.setValue(seedValue);
    processingAnimRef.current = Animated.timing(processingProgress, {
      toValue: end,
      duration: PHASE_DURATIONS[phase] ?? 15000,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    processingAnimRef.current.start();
    return () => processingAnimRef.current?.stop();
  }, [phase]);

  const handleTimestampPress = (s: number) => {
    // Seek 30ms past the chip's timestamp so integer-precision video seek never
    // undershoots into the gap before the note. 30ms < MIN_DURATION_S (50ms),
    // so this always lands inside the note regardless of its length.
    setSeekSeconds(s + 0.030);
    setSeekVersion((v) => v + 1);
  };

  // Tuner
  const [tunerOpen, setTunerOpen] = useState(false);

  // Upload tips drawer
  const [showUploadTips, setShowUploadTips] = useState(false);

  // Step 1 form state
  const [songName, setSongName] = useState('');
  // Optional, and deliberately secondary to the title: they are what let the
  // coach draw on real knowledge of the repertoire rather than guessing from a
  // bare string. Empty is fine — the coach falls back to the title alone.
  const [composerName, setComposerName] = useState('');
  const [movementName, setMovementName] = useState('');
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
  // Accumulated pose + bow frames for post-session scoring
  const poseFramesRef = useRef<FrameKeypoints[]>([]);
  const bowFramesRef  = useRef<RawBowFrame[]>([]);
  // Owns the once-and-kept bow/string diagonal locks. Reset per session (see
  // startRecording) so a new setup re-votes rather than inheriting stale corners.
  const bowGeometryRef = useRef(createBowGeometryTracker());
  const calibrationCaptureRef = useRef<{
    frames: RawBowFrame[];
    startedAt: number;
    timeout: ReturnType<typeof setTimeout>;
    resolve: (frames: RawBowFrame[]) => void;
  } | null>(null);
  // Live detector boxes for the debug overlay (joint-space coords from native;
  // null = no detection yet). Bow is amber, violin cyan — same as the ml tools.
  const [liveBoxes, setLiveBoxes] = useState<{
    bow: { x1: number; y1: number; x2: number; y2: number } | null;
    bowConf: number;
    violin: { x1: number; y1: number; x2: number; y2: number } | null;
    violinConf: number;
  } | null>(null);
  // Last-seen box + timestamp per class. Detection runs at ~10fps and each
  // class clears its threshold independently, so each box is held for a short
  // window to give a stable overlay instead of flickering per detector frame.
  const lastBowRef = useRef<{ box: { x1: number; y1: number; x2: number; y2: number }; conf: number; t: number } | null>(null);
  const lastViolinRef = useRef<{ box: { x1: number; y1: number; x2: number; y2: number }; conf: number; t: number } | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const coachIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The live coach's own state (cooldowns, running bow-angle baseline) lives
  // in the engine; this ref just holds the instance across renders. Built
  // lazily — this component re-renders at ~60fps while the skeleton animates,
  // and useRef(createLiveCoach()) would allocate a coach on every one of them.
  const coachRef = useRef<LiveCoach | null>(null);
  const getCoach = () => (coachRef.current ??= createLiveCoach());
  const [liveCue, setLiveCue] = useState<LiveCue | null>(null);
  const [liveVibratoScore, setLiveVibratoScore] = useState<number | null>(null);
  const pitchHistoryRef = useRef<(number | null)[]>([]);
  // Loudness + tonality rings, aligned sample-for-sample with pitchHistoryRef.
  const rmsHistoryRef = useRef<number[]>([]);
  const clarityHistoryRef = useRef<number[]>([]);
  const pitchTickRef = useRef(0);
  const [pitchGraphData, setPitchGraphData] = useState<(number | null)[]>([]);
  const [debugMetrics, setDebugMetrics] = useState<DebugMetrics | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const DRAWER_DEFAULT_H = Math.round(screenHeight * 0.55);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const PoseCameraView = getPoseCameraView();
  const usingPoseCamera = PoseCameraView != null;

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  // Metronome — configured on the camera-position screen, free-running for the
  // length of the take (the player decides when to stop, not a beat count).
  const metronomeSettings = useMetronomeStore();
  const metronome = useMetronome(
    metronomeSettings.bpm,
    Number.POSITIVE_INFINITY,
    undefined,
    { muted: !metronomeSettings.sound },
  );
  // Read through refs by the recording callbacks, which are memoized with empty
  // deps so they stay stable across the take.
  const metronomeRef = useRef(metronome);
  metronomeRef.current = metronome;
  const metronomeEnabledRef = useRef(metronomeSettings.enabled);
  metronomeEnabledRef.current = metronomeSettings.enabled;

  const instrument = 'violin';
  const instrumentConfig = INSTRUMENTS[instrument];

  // Hide the tab bar during recording, calibration, and results so it doesn't overlap the camera/results UI.
  useEffect(() => {
    const hide =
      phase === 'calibrating' ||
      phase === 'recording' ||
      phase === 'processing_audio' ||
      phase === 'processing_video' ||
      phase === 'uploading' ||
      phase === 'done';
    navigation.setOptions({
      tabBarStyle: hide
        ? { display: 'none' }
        : { borderTopColor: '#e5e7eb', backgroundColor: '#fff', elevation: 8,
            shadowColor: '#000', shadowOpacity: 0.06,
            shadowOffset: { width: 0, height: -2 }, shadowRadius: 8 },
    });
  }, [phase, navigation]);

  // Pre-write the recording metronome's click WAV while the player reads the
  // position tips, so the first beat of the take isn't delayed by file I/O.
  // preload() only writes the file — it does NOT reconfigure the audio session
  // (that would interrupt the live camera preview, and with it the pose/bow
  // stream calibration depends on); the session is set up lazily when the
  // metronome first plays, at recording start.
  const preloadMetronome = metronome.preload;
  useEffect(() => {
    if (phase === 'camera_tip' && metronomeSettings.enabled) void preloadMetronome();
  }, [phase, metronomeSettings.enabled, preloadMetronome]);

  // Reset camera-ready flag when we leave the camera phases so the next visit starts fresh.
  //
  // The diagonal locks are reset here too — on EXIT, not between phases. Calibration
  // and the recording that follows it are one camera setup, so they must share one
  // locked bow axis and string diagonal; re-voting at the start of recording could
  // land on the other diagonal and invalidate the calibration that was just captured.
  useEffect(() => {
    const inCameraPhase = phase === 'camera_tip' || phase === 'calibrating' || phase === 'recording';
    if (!inCameraPhase) {
      cameraReadyRef.current = false;
      pendingRecordingRef.current = false;
      bowGeometryRef.current.reset();
    }
  }, [phase]);

  // Live coaching: 4 Hz is fast enough that a cue lands while the player is
  // still doing the thing, and slow enough that re-deriving the bow window is
  // free next to the pose/detector work already running each frame.
  useEffect(() => {
    if (phase !== 'recording') {
      if (coachIntervalRef.current) {
        clearInterval(coachIntervalRef.current);
        coachIntervalRef.current = null;
      }
      setLiveCue(null);
      return;
    }
    coachIntervalRef.current = setInterval(() => {
      // Nothing to coach on until the take is actually recording frames.
      if (!recordingActiveRef.current || recordingStartTimeRef.current === 0) return;
      const t = (Date.now() - recordingStartTimeRef.current) / 1000;
      const cutoff = t - COACH_WINDOW_S;
      setLiveCue(
        getCoach().tick({
          t,
          poseFrames: poseFramesRef.current.filter((f) => f.timestamp >= cutoff),
          bowFrames: bowFramesRef.current.filter((f) => f.timestamp >= cutoff),
          pitchHz: pitchHistoryRef.current,
          rms: rmsHistoryRef.current,
          clarity: clarityHistoryRef.current,
        }),
      );
    }, 250);
    return () => {
      if (coachIntervalRef.current) {
        clearInterval(coachIntervalRef.current);
        coachIntervalRef.current = null;
      }
    };
  }, [phase]);

  // Clear pitch history when recording starts/stops. Also the backstop that
  // silences the metronome on any path out of recording — a cancelled take or
  // a navigation away never reaches onPoseRecordingFinished.
  useEffect(() => {
    if (phase !== 'recording') {
      pitchHistoryRef.current = [];
      rmsHistoryRef.current = [];
      clarityHistoryRef.current = [];
      setPitchGraphData([]);
      setLiveVibratoScore(null);
      metronomeRef.current.stop();
    }
  }, [phase]);

  // Animation loop: lerps displayed skeleton toward the 15-fps target at ~60 fps
  // so joints glide smoothly rather than teleporting on each pose event.
  useEffect(() => {
    if (phase !== 'camera_tip' && phase !== 'calibrating' && phase !== 'recording') {
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
      // Composer and movement are what let the coach bring real repertoire
      // knowledge — "in the Bach A minor first movement this phrase is a
      // sequence" — instead of guessing from a bare title.
      composer: composerName.trim() || undefined,
      movement: movementName.trim() || undefined,
      source: 'manual',
      pdfUri: sheetMusicUri ?? undefined,
    };
  };

  const handleNext = () => {
    const piece = buildPiece();
    // Guarded by the disabled Next button, but a stray call must not slip an
    // unnamed session through — per-piece progress depends on every take
    // belonging to something.
    if (!piece) return;
    track(AnalyticsEvent.PIECE_SELECTED, {
      has_piece: true,
      has_sheet_music: !!sheetMusicUri,
    });
    setSelectedPiece(piece);
    setPhase('method_select');
  };

  /** Scales and open-string work aren't a piece, but they still need a home. */
  const handleTechniqueSession = () => {
    haptic.light();
    track(AnalyticsEvent.PIECE_SELECTED, { has_piece: true, has_sheet_music: false });
    continueWithPiece(TECHNIQUE_PIECE);
  };

  // ── Step 2: Method select ──────────────────────────────────

  /**
   * "Back" has two correct destinations depending on how the screen was reached.
   *
   * Arriving from a piece card on /practice/pick, the naming form is not where
   * the user came from and not somewhere they asked to go — the picker is. But
   * arriving via "New piece" (or first-run activation, which routes here
   * directly), the naming form IS the previous step. `from` tells them apart.
   */
  const handleBackToInput = () => {
    if (entryPoint === 'pick') {
      router.back();
      return;
    }
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
    setHomeIndicatorHidden(true);
    // Started after the capture is running so the first click lands on a take
    // that is already recording. The click sound itself was loaded back on the
    // camera-position screen (MetronomeSetup), not here.
    if (metronomeEnabledRef.current) void metronomeRef.current.start();
  }, []);

  const captureBowClip = useCallback<CaptureBowClip>((durationMs) => {
    return new Promise((resolve) => {
      const existing = calibrationCaptureRef.current;
      if (existing) {
        clearTimeout(existing.timeout);
        existing.resolve(existing.frames);
      }

      const timeout = setTimeout(() => {
        const capture = calibrationCaptureRef.current;
        calibrationCaptureRef.current = null;
        resolve(capture?.frames ?? []);
      }, durationMs);

      calibrationCaptureRef.current = {
        frames: [],
        startedAt: Date.now(),
        timeout,
        resolve,
      };
    });
  }, []);

  useEffect(() => {
    return () => {
      const capture = calibrationCaptureRef.current;
      if (!capture) return;
      clearTimeout(capture.timeout);
      calibrationCaptureRef.current = null;
      capture.resolve(capture.frames);
    };
  }, []);

  const startRecording = async () => {
    if (!cameraPermission?.granted) {
      const { granted } = await requestCameraPermission();
      track(AnalyticsEvent.PERMISSION_RESULT, { permission: 'camera', granted, context: 'record' });
      if (!granted) { Alert.alert('Camera Permission', 'Camera access is needed to record video.'); return; }
    }
    if (!micPermission?.granted) {
      const { granted } = await requestMicPermission();
      track(AnalyticsEvent.PERMISSION_RESULT, { permission: 'microphone', granted, context: 'record' });
      if (!granted) { Alert.alert('Microphone Permission', 'Microphone access is needed to record audio.'); return; }
    }
    recordingStartedRef.current  = false;
    recordingActiveRef.current   = false;
    elapsedRef.current           = 0;
    setElapsed(0);
    // A new take is a new coaching session: cooldowns and the running bow-angle
    // baseline must not carry over from the previous one.
    getCoach().reset();
    setLiveCue(null);
    poseFramesRef.current         = [];
    bowFramesRef.current          = [];
    lastBowRef.current            = null;
    lastViolinRef.current         = null;
    setLiveBoxes(null);
    recordingStartTimeRef.current = 0;
    haptic.medium();
    track(AnalyticsEvent.RECORDING_STARTED, {
      engine: usingPoseCamera ? 'pose_camera' : 'expo_camera',
      has_metronome: metronomeSettings.enabled,
    });
    setPhase('recording');
    if (cameraReadyRef.current) {
      await beginRecording();
    } else {
      pendingRecordingRef.current = true;
    }
  };

  // Whether the camera-tip CTA leads into calibration rather than straight to
  // recording. The button label and the note under it both depend on it, so the
  // player is never told "start recording" by a button that starts bow holds.
  const willCalibrate = usingPoseCamera && CALIBRATION_ENABLED;

  const startCalibrationOrRecording = async () => {
    // Calibration is stubbed out (see CALIBRATION_ENABLED) — go straight to recording.
    if (!willCalibrate) {
      await startRecording();
      return;
    }
    if (!cameraPermission?.granted) {
      const { granted } = await requestCameraPermission();
      if (!granted) { Alert.alert('Camera Permission', 'Camera access is needed to calibrate bow placement.'); return; }
    }
    haptic.medium();
    setPhase('calibrating');
  };

  // Called when PoseCameraView signals the camera is ready.
  // May fire during camera_tip/calibrating (pre-warm) or during recording (cold start fallback).
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
    setHomeIndicatorHidden(false);
    metronomeRef.current.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    const { uri, error } = e.nativeEvent ?? e;
    if (error || !uri) {
      track(AnalyticsEvent.RECORDING_FAILED, {
        engine: 'pose_camera',
        reason: errorReason(error ?? 'no_uri'),
      });
      setError(error ?? 'Recording failed');
      return;
    }
    track(AnalyticsEvent.RECORDING_STOPPED, {
      engine: 'pose_camera',
      duration_sec: elapsedRef.current,
      pose_frames: poseFramesRef.current.length,
      bow_frames: bowFramesRef.current.length,
    });
    setRecordingUri(uri);
    await processMedia(uri, elapsedRef.current, true, 'record', poseFramesRef.current);
  }, []);

  const handleStopPoseRecording = useCallback(async () => {
    haptic.medium();
    // Stopped here as well as in onPoseRecordingFinished, so the clicking ends
    // the moment the player hits stop rather than when the file finishes writing.
    metronomeRef.current.stop();
    await poseStopRecording();
  }, []);

  const PITCH_HISTORY_SIZE = 80;  // 80 × 50ms = 4 seconds

  const onPitchEvent = useCallback((e: any) => {
    const ev = e.nativeEvent ?? e;
    const hz: number | null = ev?.frequency ?? null;
    const history = pitchHistoryRef.current;
    history.push(hz && hz > 60 && hz < 1600 ? hz : null);
    if (history.length > PITCH_HISTORY_SIZE) history.shift();

    // Loudness + tonality arrive alongside the pitch on builds that carry them.
    // Older native builds send neither, and the coach falls back to
    // frequency-only voicing (and skips the tone cues) rather than treating the
    // take as silent. Pushed together so the two rings stay aligned with pitch.
    if (typeof ev?.rms === 'number') {
      const rmsHistory = rmsHistoryRef.current;
      rmsHistory.push(ev.rms);
      if (rmsHistory.length > PITCH_HISTORY_SIZE) rmsHistory.shift();
    }
    if (typeof ev?.clarity === 'number') {
      const clarityHistory = clarityHistoryRef.current;
      clarityHistory.push(ev.clarity);
      if (clarityHistory.length > PITCH_HISTORY_SIZE) clarityHistory.shift();
    }

    // Update graph + vibrato score every 3 events (~150ms)
    pitchTickRef.current += 1;
    if (pitchTickRef.current % 3 === 0) {
      const snapshot = [...history];
      setPitchGraphData(snapshot);
      const detected = snapshot.filter(v => v !== null) as number[];
      if (detected.length >= 15) {
        setLiveVibratoScore(vibratoScoreFromPitchHistory(detected));
      }
    }
  }, []);

  // Fallback: expo-camera path (used when PoseCameraView native module is unavailable)
  const onCameraReady = async () => {
    if (recordingStartedRef.current) return;
    recordingStartedRef.current = true;
    timerRef.current = setInterval(() => { elapsedRef.current++; setElapsed((s) => s + 1); }, 1000);
    try {
      const recorded = await cameraRef.current!.recordAsync({ maxDuration: 120 });
      if (timerRef.current) clearInterval(timerRef.current);
      track(AnalyticsEvent.RECORDING_STOPPED, {
        engine: 'expo_camera',
        duration_sec: elapsedRef.current,
        pose_frames: 0,
        bow_frames: 0,
      });
      setRecordingUri(recorded!.uri);
      await processMedia(recorded!.uri, elapsedRef.current, true, 'record');
    } catch (err: any) {
      if (timerRef.current) clearInterval(timerRef.current);
      const msg: string = err?.message ?? '';
      if (!msg.toLowerCase().includes('stop') && !msg.toLowerCase().includes('abort') && !msg.toLowerCase().includes('cancel')) {
        track(AnalyticsEvent.RECORDING_FAILED, { engine: 'expo_camera', reason: errorReason(msg) });
        setError(msg || 'Recording failed');
      }
    }
  };

  const stopRecording = () => { haptic.medium(); cameraRef.current?.stopRecording(); };

  // ── Upload from camera roll ────────────────────────────────

  const uploadVideoFromLibrary = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      track(AnalyticsEvent.PERMISSION_RESULT, {
        permission: 'photo_library',
        granted: false,
        context: 'upload',
      });
      Alert.alert('Photos Permission', 'Photo library access is needed to upload a video.');
      return;
    }

    track(AnalyticsEvent.UPLOAD_PICKER_OPENED);
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'videos', allowsEditing: false, quality: 1 });
    if (result.canceled || !result.assets?.[0]) {
      // Backing out of the picker is a silent exit from the core funnel — it
      // looks identical to never having tapped upload without this.
      track(AnalyticsEvent.UPLOAD_PICKER_CANCELLED);
      return;
    }

    const asset = result.assets[0];
    const durationSec = asset.duration ? Math.round(asset.duration / 1000) : 60;
    setRecordingUri(asset.uri);
    await processMedia(asset.uri, durationSec, true, 'upload');
  };

  // ── Core analysis pipeline ─────────────────────────────────

  const processMedia = async (
    uri: string,
    durationSec: number,
    isVideo: boolean,
    source: AnalysisSource,
    poseFrames?: FrameKeypoints[],
  ) => {
    const watch = createStopwatch();
    // Set when a run produces a result from mock data instead of real analysis.
    // These paths are deliberately silent to the user, so without this the app
    // cannot tell a good analysis from a fabricated one.
    let degraded: AnalysisDegradedReason | undefined;

    track(AnalyticsEvent.ANALYSIS_STARTED, {
      source,
      duration_sec: Math.round(durationSec),
      instrument,
      has_piece: !!selectedPiece,
      is_pro: isPro(entitlement),
    });
    breadcrumb(`analysis started (${source}, ${Math.round(durationSec)}s)`);

    // The processing screen promises "about 30 seconds" while its progress bar
    // is a fixed timer animation, so the real distribution of pipeline durations
    // is unknown. Performance Monitoring gives it a percentile breakdown that
    // the ms_* event params can't, segmented by capture path and device.
    const perfTrace = startTrace('analysis_pipeline');
    perfTrace.attribute('source', source);
    perfTrace.metric('duration_sec', Math.round(durationSec));

    let videoUri: string | undefined;
    if (isVideo) {
      try {
        videoUri = persistVideo(uri);
      } catch {
        // Copy failed — fall back to original URI (valid for this session)
        videoUri = uri;
        degraded = 'persist_failed';
        track(AnalyticsEvent.ANALYSIS_DEGRADED, { reason: degraded, source });
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
          // A funnel exit with no error screen — the user just lands back at the
          // start, so this is the only record that the run ever happened.
          track(AnalyticsEvent.ANALYSIS_FAILED, {
            stage: 'audio',
            reason: 'no_audio_track',
            source,
            ms_elapsed: watch.elapsed(),
          });
          perfTrace.attribute('outcome', 'no_audio_track');
          perfTrace.stop();
          Alert.alert(
            'No audio found',
            'Could not extract audio from this video. Make sure the video has a recorded audio track, or use the Record button to capture directly.',
            [{ text: 'OK', onPress: reset }],
          );
          return;
        }
        throw err;
      }
      // runAudioAnalysis swallows NOT_WAV internally and returns mock metrics,
      // so the flag on the output is the only way to know this run is fiction.
      if (audioOutput?.usedMockMetrics) {
        degraded = 'not_wav';
        track(AnalyticsEvent.ANALYSIS_DEGRADED, { reason: degraded, source });
      }
      watch.split('audio');

      setPhase('processing_video');
      // Acquire pose + bow frames: the live path uses frames captured during
      // recording; the upload path extracts them from the saved video file.
      const isLivePose = !!poseFrames && poseFrames.length >= 5;
      let pipelinePoseFrames: FrameKeypoints[] = isLivePose ? poseFrames! : [];
      let pipelineBowFrames: RawBowFrame[] = isLivePose ? bowFramesRef.current : [];
      if (isVideo && !isLivePose) {
        try {
          const extracted = await extractVideoFrames(uri);
          pipelinePoseFrames = extracted.poseFrames;
          pipelineBowFrames = extracted.bowFrames;
        } catch {
          // module unavailable (Android) or video unreadable — mock fallback below
        }
      }

      // Use the user's stated goal from onboarding; fall back to video-computed classification
      const userCategory = profile?.playerCategory ?? playerCategory ?? undefined;

      // L1–L9 in one pure call. Raw (un-normalized) frames go in — fuseSignals
      // needs screen-space coords for getShoulderRaised; the pipeline owns
      // normalization for scoring and SessionSignals.
      const pipeline = audioOutput
        ? runSessionPipeline({
            audioOutput,
            poseFrames: pipelinePoseFrames,
            bowFrames: pipelineBowFrames,
            durationSeconds: durationSec,
            instrument,
            userCategory,
            calibration: useCalibrationStore.getState().calibration,
            keyHint: selectedPiece?.keySignature,
          })
        : null;

      const noteEvents = pipeline?.noteEvents ?? [];
      if (__DEV__) debugLogNoteEvents(noteEvents);

      let videoMetrics: MetricScore[] = pipeline?.videoMetrics ?? [];
      let sessionAssessment = pipeline?.sessionAssessment
        ?? buildSessionAssessment(videoMetrics, userCategory);
      if (isVideo && videoMetrics.length === 0) {
        // Android or Vision produced too few frames — placeholder scores.
        videoMetrics = await mockVideoMetrics();
        sessionAssessment = buildSessionAssessment(videoMetrics, userCategory);
        // Same silent-substitution problem as the audio path above.
        degraded = degraded ?? 'no_video_frames';
        track(AnalyticsEvent.ANALYSIS_DEGRADED, { reason: 'no_video_frames', source });
      }
      watch.split('video');

      // The only gate on a live take.
      //
      // Nothing is asked of the player before they record any more (bow
      // calibration is off — see CALIBRATION_ENABLED), so a take is never
      // stopped on the way in. On the way out it is offered a redo in exactly
      // one case: the take is completely empty — no notes heard, nobody in
      // frame, no bow found. A take with *any* signal in it goes straight
      // through and is scored on what it has, however thin.
      //
      // Even here the redo is an offer, not a wall: "see results anyway" is
      // always available, because a player who has just played is a poor
      // audience for the app insisting they didn't.
      const emptyTake =
        noteEvents.length === 0 &&
        pipelinePoseFrames.length === 0 &&
        pipelineBowFrames.length === 0;
      if (emptyTake && source === 'record') {
        const redo = await new Promise<boolean>((resolve) => {
          Alert.alert(
            'Nothing was picked up',
            "That take had no sound and nobody in frame. Check the phone can see you and hear the violin, then record again — or look at the results as they are.",
            [
              { text: 'See results anyway', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Record again', onPress: () => resolve(true) },
            ],
            { cancelable: false },
          );
        });
        if (redo) {
          track(AnalyticsEvent.ANALYSIS_FAILED, {
            stage: 'recording',
            reason: 'empty_take',
            source,
            ms_elapsed: watch.elapsed(),
          });
          perfTrace.attribute('outcome', 'empty_take');
          perfTrace.stop();
          setPhase('camera_tip');
          return;
        }
      }

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

      // The pipeline completes dynamicControl — audioEngine can't detect phrase
      // events because the L6 phrases don't exist when it runs.
      const audioMetricsWithDynamics = pipeline?.audioMetrics ?? audioMetrics;

      const audioMetricsFinal = audioMetricsWithDynamics.map(m => {
        if (noteEvents.length === 0) return m;
        if (m.key === 'pitchAccuracy') {
          const outOfTune = noteEvents
            .filter(n => !n.inTune)
            .slice(0, 6)
            .map(n => ({ startSeconds: n.startSeconds, endSeconds: n.endSeconds, note: n.noteName }));
          return { ...m, flaggedTimestamps: outOfTune };
        }
        // dynamicControl timestamps contain descriptive coaching text — don't snap to note boundaries
        if (m.key === 'dynamicControl') return m;
        return { ...m, flaggedTimestamps: m.flaggedTimestamps.map(ts => snapToNote(ts.startSeconds)) };
      });

      const skillLevel = profile?.skillLevel ?? 'beginner';
      const weights = instrumentConfig.skillWeights[skillLevel];
      const activeWeights = activeScoreWeights(weights);
      const overallScore = computeOverallScore(audioMetricsFinal, videoMetrics, activeWeights);

      // Rolling delta: new score vs. average of the 3 most recent sessions
      const recentScores = sessionHistory.slice(0, 3).map((s) => s.overallScore);
      const overallDelta = recentScores.length > 0
        ? Math.round(overallScore - recentScores.reduce((a, b) : number => a + b, 0) / recentScores.length)
        : undefined;

      setPhase('uploading');
      const sessionId = Math.random().toString(36).slice(2);
      const recordedAt = new Date().toISOString();
      const allMetrics = [...audioMetricsFinal, ...videoMetrics];

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
        intonationStabilityAnalysis: audioOutput?.intonationStabilityAnalysis,
        vibratoAnalysis: audioOutput?.vibratoAnalysis,
        rhythmAnalysis: audioOutput?.rhythmAnalysis,
        audioQualityWarning,
        metronomeBpm: metronomeSettings.enabled ? metronomeSettings.bpm : undefined,
        videoUri,
        noteEvents,
        patternFindings: pipeline?.findings,
        phraseFeatures: pipeline?.phraseFeatures,
        musicalContext: pipeline?.musicalContext,
        sessionSignals: pipeline?.signals,
      };

      // L9: freeze this session's practice evidence now, from the fully-assembled
      // analyses, so every downstream surface reads the same issues instead of
      // re-deriving them independently.
      result.sessionEvidence = buildSessionEvidence(result);
      // Stamped so a later analysis improvement knows this copy is stale rather
      // than serving it forever. See EVIDENCE_VERSION.
      result.evidenceVersion = EVIDENCE_VERSION;

      // The timestamped musical picture — phrases and their shapes, tempo
      // movement against the intended tempo, notable notes. Attached to the
      // result so chat can discuss this session immediately, before the
      // server-side musical_evidence write lands with the coaching upgrade.
      const musicalEvidence = pipeline
        ? buildMusicalEvidence({
            phraseFeatures: pipeline.phraseFeatures,
            noteEvents: pipeline.noteEvents,
            musicalContext: pipeline.musicalContext,
            rhythm: audioOutput?.rhythmAnalysis ?? null,
            metronomeBpm: metronomeSettings.enabled ? metronomeSettings.bpm : undefined,
          })
        : undefined;
      result.musicalEvidence = musicalEvidence;

      // Write wrist debug data to a file so it can be pulled via xcrun devicectl.
      // Dev-only — release builds shouldn't spend I/O on a debugging artifact.
      if (__DEV__) {
        const wristDbg = videoMetrics.find(m => m.key === 'leftHandWrist')?.debugSeries;
        if (wristDbg) {
          try {
            new File(Paths.document, 'wrist_debug.json').write(JSON.stringify(wristDbg));
          } catch { /* debug aid only — never fail the analysis over it */ }
        }
      }

      // Quota was already consumed at the top of processMedia.
      let savedRemote = false;
      if (isAuthenticated && profile?.id && isSupabaseConfigured) {
        // Previously a bare .catch(() => {}) — a failure here leaves the session
        // on-device only, and nothing anywhere recorded that it happened.
        savedRemote = await saveSession(result)
          .then(() => true)
          .catch((err) => {
            track(AnalyticsEvent.SESSION_SAVE_FAILED, { reason: errorReason(err) });
            reportError(err, 'analysis', { stage: 'save_session' });
            return false;
          });
      }
      watch.split('save');
      addToHistory(sessionToSummary(result));
      addToMetricHistory(sessionToMetricHistoryEntry(result));
      // The pre-conversion recap quotes session count and score movement, so it
      // is stale the moment a new session lands. Cheap to rewrite; no-op unless
      // a trial is running.
      void syncTrialRecap();

      // Set before the first render so the results screen shows a coaching
      // loading state immediately rather than flashing static→loading→real.
      const willFetchCoaching =
        isAuthenticated && !!profile?.id && isSupabaseConfigured && !!pipeline;
      result.coachingPending = willFetchCoaching;
      cacheSessionResult(result);

      setResult(result);

      const splits = watch.splits();
      track(AnalyticsEvent.ANALYSIS_COMPLETED, {
        source,
        ms_total: watch.elapsed(),
        ms_audio: splits.audio,
        ms_video: splits.video,
        ms_save: splits.save,
        duration_sec: Math.round(durationSec),
        overall_score: overallScore,
        overall_delta: overallDelta,
        note_count: noteEvents.length,
        degraded: degraded ?? 'none',
        will_fetch_coaching: willFetchCoaching,
        saved_remote: savedRemote,
      });

      perfTrace.attribute('outcome', 'completed');
      perfTrace.attribute('degraded', degraded ?? 'none');
      perfTrace.metric('note_count', noteEvents.length);
      perfTrace.stop();

      // L10: upgrade the static feedback with Claude coaching. Non-blocking —
      // the UI shows a coaching-loading state (coachingPending, set above) until
      // this resolves; on success the richer response is merged in and cached on
      // the session row so re-viewing never re-calls the LLM. Pro only: free
      // users keep the template feedback, and the Edge Function independently
      // rejects them with a 402.
      if (willFetchCoaching) {
        const coachingInput = buildCoachingInput(
          allMetrics,
          sessionAssessment.playerCategory,
          skillLevel,
          selectedPiece ?? undefined,
          pipeline.findings,
          pipeline.phraseFeatures,
          result.sessionEvidence,
          musicalEvidence,
        );
        // The deterministic session-scoped plan doubles as the fallback for
        // grounding Claude's blocks (Phase 3.6) and its `id` is the planId the
        // curated copy gets stored under — computed once here rather than left
        // to drift from whatever usePracticePlan computes later at render time.
        const sessionPlan = computePracticePlan({
          recentSessions: [result],
          metricHistory: [],
          playerCategory: profile?.playerCategory ?? sessionAssessment.playerCategory,
          weeklyGoalMinutes: profile?.weeklyGoalMinutes ?? weeklyGoalMinutes,
          skillLevel,
          sessionWindow: 1,
          scope: { kind: 'session', sessionId },
        });
        const fallbackBlocks = candidatesFromBlocks(sessionPlan.blocks);
        const coachingWatch = createStopwatch();
        track(AnalyticsEvent.COACHING_REQUESTED);
        fetchCoachingFeedback(coachingInput, result.sessionEvidence ?? [], fallbackBlocks)
          .then((claudeFeedback) => {
            track(AnalyticsEvent.COACHING_SUCCEEDED, {
              ms: coachingWatch.elapsed(),
              block_count: claudeFeedback.curatedBlocks?.length ?? 0,
            });
            if (claudeFeedback.curatedBlocks) {
              useCuratedPlanStore.getState().setCuratedBlocks(sessionPlan.id, claudeFeedback.curatedBlocks);
            }
            // curatedBlocks lives in useCuratedPlanStore, not on the persisted
            // llmFeedback — strip it so re-viewing this session doesn't read a
            // second, potentially stale copy from AnalysisResult.
            const { curatedBlocks, ...persistedFeedback } = claudeFeedback;
            const upgraded: AnalysisResult = { ...result, llmFeedback: persistedFeedback, coachingPending: false };
            cacheSessionResult(upgraded);
            // Only swap the visible result if the user is still on this session
            const { currentResult } = useAnalysisStore.getState();
            if (currentResult?.sessionId === result.sessionId) setResult(upgraded);
            // The plan the student actually sees: deterministic titles from
            // practiceBlocks.ts, with the LLM's rationale where curation
            // survived grounding. Storing the LLM's own titles (as this used
            // to) meant chat described drills that were never on screen.
            const curatedById = new Map((curatedBlocks ?? []).flatMap((c) =>
              c.issueIds.map((id) => [id, c.whyThisDrill] as const)));
            const renderedPlan = sessionPlan.blocks.map((b) => ({
              title: b.title,
              minutes: b.estimatedMinutes,
              whyThisDrill:
                b.evidenceRefs.map((r) => curatedById.get(r.evidenceId)).find(Boolean) ?? b.reason,
            }));
            updateSessionLlmFeedback(
              result.sessionId,
              persistedFeedback,
              renderedPlan,
              musicalEvidence,
            ).catch(() => {});
          })
          .catch((err) => {
            // Network/timeout/malformed — keep the static template, just stop
            // showing the coaching-loading state so it doesn't spin forever.
            // Silent to the user, so the reason only exists here.
            track(AnalyticsEvent.COACHING_FAILED, {
              ms: coachingWatch.elapsed(),
              reason: errorReason(err),
            });
            const cleared: AnalysisResult = { ...result, coachingPending: false };
            cacheSessionResult(cleared);
            const { currentResult } = useAnalysisStore.getState();
            if (currentResult?.sessionId === result.sessionId) setResult(cleared);
          });
      }
    } catch (err: any) {
      // The stage is inferred from which splits were recorded — the phase the
      // run died in is what makes this actionable.
      const done = watch.splits();
      const stage: AnalysisFailureStage = !done.audio
        ? 'audio'
        : !done.video
          ? 'video'
          : !done.save
            ? 'pipeline'
            : 'assemble';
      track(AnalyticsEvent.ANALYSIS_FAILED, {
        stage,
        reason: errorReason(err),
        source,
        ms_elapsed: watch.elapsed(),
      });
      reportError(err, 'analysis', { stage, source });
      perfTrace.attribute('outcome', `failed_${stage}`);
      perfTrace.stop();
      setError(err.message ?? 'Analysis failed');
    }
  };

  const formatElapsed = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  // ── First-run diagnostic ───────────────────────────────────
  //
  // Owns the screen outright while it runs. Checked ahead of every phase branch
  // because it starts from method_select and hands over to processMedia, which
  // drives the phase machine from processing_audio onward — once that begins,
  // this is unmounted and the normal processing screen takes over.
  if (diagnosticOpen) {
    return (
      <DiagnosticTake
        onUseDemo={useSampleInstead}
        onAnalyze={(uri, durationSeconds) => {
          setDiagnosticOpen(false);
          // Audio-only: no video to persist, no pose frames to score. The
          // effect at the top of this file moves activation on to the carousel
          // when the result lands, exactly as it does for a real recording.
          void processMedia(uri, durationSeconds, false, 'diagnostic');
        }}
      />
    );
  }

  // ── Step 1: Piece input ────────────────────────────────────
  if (phase === 'piece_input') {
    return (
      <RAnimated.View entering={FadeInRight.duration(220)} style={{ flex: 1 }}>
        <SafeAreaView style={styles.setupSafe}>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <View style={{ flex: 1 }}>
              <ScrollView
                style={styles.inputContent}
                contentContainerStyle={styles.setupContentInner}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {/* Reached from the picker, so it needs a way back to it. Absent
                    on first run, where this screen is the start of the flow. */}
                {cameFromPicker && (
                  <Pressable onPress={() => router.back()} hitSlop={12} style={styles.setupBack}>
                    <Ionicons name="chevron-back" size={26} color={colors.text.secondary} />
                  </Pressable>
                )}
                <Text style={styles.setupTitle}>New piece</Text>

                {/* Name field */}
                <View style={styles.searchBox} {...pieceSpotlight}>
                  <Ionicons name="musical-notes-outline" size={20} color={colors.text.muted} style={styles.searchIcon} />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Name the piece"
                    placeholderTextColor={colors.text.muted}
                    value={songName}
                    onChangeText={setSongName}
                    returnKeyType="next"
                    autoCorrect={false}
                    autoCapitalize="words"
                  />
                  {songName.length > 0 && (
                    <Pressable onPress={() => setSongName('')} hitSlop={8}>
                      <Ionicons name="close-circle" size={18} color={colors.text.muted} />
                    </Pressable>
                  )}
                </View>

                {/* Shown once a title exists, so the empty state stays a single
                    field and this never looks like a form to fill in. */}
                {songName.trim().length > 0 && (
                  <View style={styles.pieceDetailRow}>
                    <TextInput
                      style={styles.pieceDetailInput}
                      placeholder="Composer (optional)"
                      placeholderTextColor={colors.text.muted}
                      value={composerName}
                      onChangeText={setComposerName}
                      autoCorrect={false}
                      autoCapitalize="words"
                      returnKeyType="next"
                    />
                    <TextInput
                      style={styles.pieceDetailInput}
                      placeholder="Movement (optional)"
                      placeholderTextColor={colors.text.muted}
                      value={movementName}
                      onChangeText={setMovementName}
                      autoCorrect={false}
                      autoCapitalize="words"
                      returnKeyType="done"
                    />
                  </View>
                )}

                {/* Sheet music */}
                {sheetMusicUri ? (
                  <View style={styles.sheetMusicAttached}>
                    <Ionicons name="document-text" size={20} color="#166534" />
                    <Text style={styles.sheetMusicFilename} numberOfLines={1}>{sheetMusicName}</Text>
                    <Pressable onPress={handleRemoveSheetMusic} style={styles.sheetMusicRemove}>
                      <Ionicons name="close" size={16} color="#dc2626" />
                    </Pressable>
                  </View>
                ) : (
                  <Pressable style={styles.sheetMusicBtn} onPress={handleUploadSheetMusic}>
                    <Ionicons name="document-text-outline" size={22} color={colors.text.muted} />
                    <View>
                      <Text style={styles.sheetMusicBtnTitle}>Add sheet music</Text>
                      <Text style={styles.sheetMusicBtnSub}>Optional</Text>
                    </View>
                  </Pressable>
                )}

              </ScrollView>

              {/* Bottom: Next (needs a name) + the one non-piece bucket */}
              <View style={styles.setupBottom}>
                <BigButton label="Next →" onPress={handleNext} disabled={!songName.trim()} />
                <Pressable style={styles.techniqueBtn} onPress={handleTechniqueSession}>
                  <Ionicons name="barbell-outline" size={16} color={colors.text.secondary} />
                  <Text style={styles.techniqueLabel}>Scales &amp; technique</Text>
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>

          <SpotlightOverlay
            steps={PIECE_COACHMARKS}
            index={pieceCoach.index}
            onNext={pieceCoach.next}
            onSkip={pieceCoach.skip}
            blocking={captureBlocking}
          />
        </SafeAreaView>
      </RAnimated.View>
    );
  }

  // ── Step 2: Recording method ───────────────────────────────
  if (phase === 'method_select') {
    return (
      <RAnimated.View entering={FadeInRight.duration(220)} style={{ flex: 1 }}>
        <SafeAreaView style={styles.setupSafe}>
          <TunerModal visible={tunerOpen} onClose={() => setTunerOpen(false)} />

          {/* Upload tips drawer */}
          <Modal
            visible={showUploadTips}
            transparent
            animationType="slide"
            onRequestClose={() => setShowUploadTips(false)}
          >
            <Pressable style={styles.drawerOverlay} onPress={() => setShowUploadTips(false)}>
              <Pressable style={styles.tipsDrawer} onPress={() => {}}>
                <View style={styles.tipsDrawerHandle} />
                <Text style={styles.tipsDrawerTitle}>Before you upload</Text>
                {UPLOAD_TIPS.map((tip, i) => (
                  <View key={i} style={styles.tipRow}>
                    <View style={styles.tipBullet}>
                      <Text style={styles.tipBulletText}>{i + 1}</Text>
                    </View>
                    <Text style={styles.tipText}>{tip}</Text>
                  </View>
                ))}
                <BigButton
                  label="Continue — Select Video"
                  onPress={() => { setShowUploadTips(false); uploadVideoFromLibrary(); }}
                />
              </Pressable>
            </Pressable>
          </Modal>

          <View style={styles.methodOuter}>
            {/* Title + piece label */}
            <View style={styles.methodHeader}>
              <Text style={styles.setupTitle}>How do you{'\n'}want to record?</Text>
              {selectedPiece && (
                <View style={styles.methodPieceRow}>
                  <Ionicons name="musical-note" size={14} color={colors.brand[600]} />
                  <Text style={styles.methodPieceText} numberOfLines={1}>{selectedPiece.title}</Text>
                </View>
              )}
            </View>

            {/* Popout method buttons */}
            <View style={styles.methodCards}>
              <View {...recordMethodSpotlight}>
                <MethodButton
                  onPress={() => {
                    haptic.medium();
                    track(AnalyticsEvent.CAPTURE_METHOD_SELECTED, { method: 'record' });
                    setPhase('camera_tip');
                  }}
                  iconName="videocam"
                  iconBg={colors.brand[50]}
                  iconColor={colors.brand[600]}
                  title="Record In-App"
                  subtitle="Live camera with real-time feedback"
                />
              </View>

              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerLabel}>or</Text>
                <View style={styles.dividerLine} />
              </View>

              <View {...uploadMethodSpotlight}>
                <MethodButton
                  onPress={() => {
                    haptic.medium();
                    track(AnalyticsEvent.CAPTURE_METHOD_SELECTED, { method: 'upload' });
                    setShowUploadTips(true);
                  }}
                  iconName="film"
                  iconBg="#fef9c3"
                  iconColor="#a16207"
                  title="Upload a Video"
                  subtitle="Pick a recording from your camera roll"
                />
              </View>
            </View>

            {/* Bottom actions */}
            <View style={styles.methodBottom}>
              <Pressable style={styles.tuneLink} onPress={() => { haptic.light(); setTunerOpen(true); }}>
                <Ionicons name="musical-notes-outline" size={16} color={colors.brand[600]} />
                <Text style={styles.tuneLinkText}>Tune strings first</Text>
              </Pressable>
              <Pressable style={styles.backBtn} onPress={handleBackToInput}>
                <Text style={styles.backLabel}>← Back</Text>
              </Pressable>
            </View>
          </View>

          <SpotlightOverlay
            steps={CAPTURE_COACHMARKS}
            index={captureCoach.index}
            onNext={captureCoach.next}
            onSkip={captureCoach.skip}
            blocking={captureBlocking}
          />
        </SafeAreaView>
      </RAnimated.View>
    );
  }

  // ── Camera position guide + Calibrating + Recording (shared block so PoseCameraView stays mounted) ──
  if (phase === 'camera_tip' || phase === 'calibrating' || phase === 'recording') {
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

    // Joint-space normalized coords → screen px, identical to PoseSkeleton's
    // mapping so boxes and (when re-enabled) skeleton line up pixel-perfect.
    const jointToScreen = (x: number, y: number): { x: number; y: number } =>
      LANDSCAPE_FLIP
        ? { x: y * screenWidth, y: x * screenHeight }
        : { x: (1 - y) * screenWidth, y: (1 - x) * screenHeight };
    return (
      <View style={styles.recordingScreen}>

        {/* PoseCameraView is always mounted here — warms up during camera_tip so
            the skeleton appears immediately when recording starts. */}
        {usingPoseCamera && (
          <PoseCameraView
            style={StyleSheet.absoluteFillObject}
            useMpPose={true}
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

              // Bow + violin boxes — present only on ~10fps detector frames.
              // Coords arrive already in the joints' space (see PoseCameraView).
              //
              // One tracker call per frame produces the overlay lines AND the frame
              // that gets scored, with both diagonals locked once (see
              // createBowGeometryTracker) so the bow axis and string line can't flip
              // mid-session. It also holds the last violin box, since the detector
              // only clears threshold on a minority of frames.
              const bowBox = ev.bowBox ?? null;
              const geometry = bowBox
                ? bowGeometryRef.current.push({
                    timestamp: Date.now() / 1000,
                    bowBox,
                    bowConfidence: ev.bowConfidence ?? 0,
                    violinBox: ev.violinBox ?? null,
                    rightWrist: joints.rightWrist ?? null,
                    leftWrist: joints.leftWrist ?? null,
                  })
                : null;

              if (bowBox || ev.violinBox) {
                const HOLD_MS = 4000;
                const nowMs = Date.now();
                if (bowBox) {
                  lastBowRef.current = { box: bowBox, conf: ev.bowConfidence ?? 0, t: nowMs };
                }
                if (ev.violinBox) {
                  lastViolinRef.current = { box: ev.violinBox, conf: ev.violinConfidence ?? 0, t: nowMs };
                }
                const bowHeld = lastBowRef.current;
                const violinHeld = lastViolinRef.current;
                const bowFresh = bowHeld && nowMs - bowHeld.t < HOLD_MS;
                const violinFresh = violinHeld && nowMs - violinHeld.t < HOLD_MS;
                setLiveBoxes({
                  bow: bowFresh ? bowHeld!.box : null,
                  bowConf: bowFresh ? bowHeld!.conf : 0,
                  violin: violinFresh ? violinHeld!.box : null,
                  violinConf: violinFresh ? violinHeld!.conf : 0,
                });
              }

              const calibrationCapture = calibrationCaptureRef.current;
              if (calibrationCapture && geometry?.bowFrame) {
                const ts = (Date.now() - calibrationCapture.startedAt) / 1000;
                calibrationCapture.frames.push({ ...geometry.bowFrame, timestamp: ts });
              }

              if (recordingActiveRef.current) {
                const ts = recordingStartTimeRef.current > 0
                  ? (Date.now() - recordingStartTimeRef.current) / 1000
                  : elapsedRef.current;
                poseFramesRef.current.push(convertPoseFrame(joints, lh, rh, ts));
                if (geometry?.bowFrame) {
                  bowFramesRef.current.push({ ...geometry.bowFrame, timestamp: ts });
                }
              }
            }}
            onRecordingFinished={onPoseRecordingFinished}
            onPitch={onPitchEvent}
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
            <Text style={styles.landscapeCalloutBody}>It captures your full arm reach.</Text>
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

          {/* Last chance to set a tempo — once recording starts the phone is
              across the room and out of reach. */}
          <MetronomeSetup />

          <Button
            label={willCalibrate ? 'Next — Calibrate your bow' : 'Ready — Start Recording'}
            onPress={startCalibrationOrRecording}
            size="lg"
            fullWidth
          />
          {willCalibrate && (
            <Text style={styles.ctaNote}>Two quick bow positions first, then recording starts.</Text>
          )}

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

        {/* Detector overlay — bow (amber) + violin (cyan) boxes with confidence,
            shown during calibration and recording alike */}
        {(isRecording || phase === 'calibrating') && usingPoseCamera && liveBoxes && (() => {
          const toRect = (b: { x1: number; y1: number; x2: number; y2: number }) => {
            const c1 = jointToScreen(b.x1, b.y1);
            const c2 = jointToScreen(b.x2, b.y2);
            return {
              x: Math.min(c1.x, c2.x), y: Math.min(c1.y, c2.y),
              w: Math.abs(c1.x - c2.x), h: Math.abs(c1.y - c2.y),
            };
          };
          const entries = [
            liveBoxes.bow && {
              key: 'bow', r: toRect(liveBoxes.bow), color: '#f59e0b',
              label: `bow ${Math.round(liveBoxes.bowConf * 100)}%`,
            },
            liveBoxes.violin && {
              key: 'violin', r: toRect(liveBoxes.violin), color: '#22d3ee',
              label: `violin ${Math.round(liveBoxes.violinConf * 100)}%`,
            },
          ].filter(Boolean) as Array<{ key: string; r: { x: number; y: number; w: number; h: number }; color: string; label: string }>;
          return (
            // Wrapped in a pointerEvents="none" View — that reliably passes taps
            // through, whereas the same prop on <Svg> alone is not dependable.
            <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
              <Svg style={StyleSheet.absoluteFillObject} width={screenWidth} height={screenHeight}>
                {entries.map(({ key, r, color, label }) => (
                  <G key={key}>
                    <Rect x={r.x} y={r.y} width={r.w} height={r.h}
                      fill="none" stroke={color} strokeWidth={2.5} rx={4} />
                    <Rect x={r.x} y={Math.max(r.y - 18, 0)} width={label.length * 7 + 8} height={18}
                      fill="rgba(0,0,0,0.55)" rx={3} />
                    <SvgText x={r.x + 4} y={Math.max(r.y - 5, 13)} fontSize={11} fontWeight="700" fill={color}>
                      {label}
                    </SvgText>
                  </G>
                ))}
              </Svg>
            </View>
          );
        })()}

        {/* Calibration UI — rendered AFTER the detector overlay so it sits on
            top of it. The overlay is a full-screen <Svg>, and pointerEvents="none"
            is not reliably honored on react-native-svg's Svg (only on a View), so
            if the calibration panel were underneath it the Svg would swallow every
            tap and the "Calibrate" button would do nothing. The recording HUD's
            stop button works for the same reason — it too renders above the overlay. */}
        {phase === 'calibrating' && (
          <View style={lsContainer}>
            <BowCalibrationFlow
              captureBowClip={captureBowClip}
              completeLabel="Start recording"
              onCancel={() => setPhase('camera_tip')}
              onSkip={() => { void startRecording(); }}
              onComplete={(calibration) => {
                setCalibration(calibration);
                void startRecording();
              }}
            />
          </View>
        )}

        {/* Recording HUD — live coaching + metronome + stop button */}
        {isRecording && (
          <View style={lsContainer} pointerEvents="box-none">
            {/* Metronome beat: a bar across the very top edge, bright on the
                downbeat. Peripheral vision picks this up without the player
                having to look away from the bow. */}
            {metronomeSettings.enabled && (
              <MetronomeBeatBar beat={metronome.currentBeat} beatInBar={metronome.beatInBar} />
            )}

            {/* Status chip: elapsed time, plus the tempo when a metronome runs.
                Bottom corner opposite the stop button — the top strip belongs
                to the coach banner, and nothing may crowd that. */}
            <View style={[styles.recStatusChip, { bottom: insets.bottom + 14 }]} pointerEvents="none">
              <View style={styles.recStatusDot} />
              <Text style={styles.recStatusText}>
                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
              </Text>
              {metronomeSettings.enabled && (
                <Text style={styles.recStatusBpm}>{metronomeSettings.bpm} BPM</Text>
              )}
            </View>

            {/* The live coach — one cue at a time, top-centre. */}
            <LiveCoachBanner cue={liveCue} />

            {/* Pitch graph — temporarily hidden for bow detection testing */}
            {false && usingPoseCamera && (
              <View style={styles.recGraphOuter} pointerEvents="none">
                <View style={styles.recGraphBg}>
                  <PitchGraph history={pitchGraphData} />
                  <View style={styles.recGraphLabels}>
                    <Text style={styles.recGraphCentsLabel}>+{GRAPH_CENTS_RANGE}¢</Text>
                    <Text style={styles.recGraphCentsLabel}>0¢</Text>
                    <Text style={styles.recGraphCentsLabel}>−{GRAPH_CENTS_RANGE}¢</Text>
                  </View>
                </View>
              </View>
            )}
            {/* Wrist angle + debug panel — temporarily hidden for bow detection testing */}
            {SHOW_LIVE_HUD && usingPoseCamera && (() => {
              const dbg = liveWristDebugData(poseJoints);
              return (
                <View style={styles.wristDebugBlock} pointerEvents="none">
                  <Text style={styles.recWristAngle}>
                    {dbg.angle !== null ? `${Math.round(dbg.angle)}°` : ''}
                  </Text>
                  <View style={styles.wristDebugPanel}>
                    <Text style={styles.wristDbgRow}>mode  <Text style={styles.wristDbgVal}>{dbg.mode}</Text></Text>
                    <Text style={styles.wristDbgRow}>cos   <Text style={[styles.wristDbgVal, dbg.cosA !== null && Math.abs(dbg.cosA) < 0.2 ? styles.wristDbgWarn : null]}>{dbg.cosA ?? '—'}</Text></Text>
                    {dbg.mode === '3D' && <>
                      <Text style={styles.wristDbgRow}>|FA|  <Text style={styles.wristDbgVal}>{dbg.magF}cm</Text></Text>
                      <Text style={styles.wristDbgRow}>|H|   <Text style={[styles.wristDbgVal, dbg.magH !== null && dbg.magH < 3 ? styles.wristDbgWarn : null]}>{dbg.magH}cm</Text></Text>
                      <Text style={styles.wristDbgRow}>tip.x <Text style={styles.wristDbgVal}>{dbg.tx}cm</Text></Text>
                      <Text style={styles.wristDbgRow}>tip.y <Text style={styles.wristDbgVal}>{dbg.ty}cm</Text></Text>
                      <Text style={styles.wristDbgRow}>tip.z <Text style={styles.wristDbgVal}>{dbg.tz}cm</Text></Text>
                    </>}
                  </View>
                </View>
              );
            })()}
            {/* Vibrato score — temporarily hidden for bow detection testing */}
            {SHOW_LIVE_HUD && usingPoseCamera && liveVibratoScore !== null && (
              <View style={styles.recVibratoBadge} pointerEvents="none">
                <Text style={styles.recVibratoLabel}>VIB</Text>
                <Text style={styles.recVibratoScore}>{liveVibratoScore}</Text>
              </View>
            )}
            <View style={[styles.recStopCorner, { bottom: insets.bottom + 14 }]} pointerEvents="box-none">
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
    const currentIdx = PROCESSING_PHASES.indexOf(phase as typeof PROCESSING_PHASES[number]);
    const barWidth = processingProgress.interpolate({
      inputRange: [0, 1],
      outputRange: ['0%', '100%'],
    });

    return (
      <LinearGradient
        colors={[colors.brand[900], colors.brand[800]]}
        style={styles.processingScreen}
      >
        <View style={styles.processingContent}>
          <Text style={styles.processingPhaseLabel}>
            {PHASE_LABELS[phase]}
          </Text>

          {/* Progress bar */}
          <View style={styles.processingBarTrack}>
            <Animated.View style={[styles.processingBarFill, { width: barWidth }]} />
          </View>

          <Text style={styles.processingTimeHint}>This usually takes about 30 seconds</Text>

          {/* Step list */}
          <View style={styles.processingSteps}>
            {PROCESSING_PHASES.map((p, i) => {
              const done = i < currentIdx;
              const active = i === currentIdx;
              return (
                <View key={p} style={styles.processingStep}>
                  <View style={[
                    styles.processingDot,
                    done && styles.processingDotDone,
                    active && styles.processingDotActive,
                  ]}>
                    <Text style={[
                      styles.processingDotText,
                      active && styles.processingDotTextActive,
                    ]}>
                      {done ? '✓' : String(i + 1)}
                    </Text>
                  </View>
                  <Text style={[
                    styles.processingStepLabel,
                    active && styles.processingStepLabelActive,
                  ]}>
                    {PHASE_LABELS[p]}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      </LinearGradient>
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

  // ── Results carousel ───────────────────────────────────────
  if (phase === 'done' && currentResult) {
    return (
      <ResultsCarousel
        result={currentResult}
        onDone={() => {
          // Post-session loop: hand the student straight into exercises scoped to
          // the take they just recorded (Phase 3.5 / the submit→drill→resubmit flow).
          const sessionId = currentResult.sessionId;
          const wasDemo = !!currentResult.isDemo;
          reset();
          if (wasDemo) {
            // The sample session isn't in sessionHistory (deliberately — see
            // activationDemo.ts), so a session-scoped plan would come back
            // empty. Send them to the free daily warm-up instead, whose
            // cold-start copy already says exactly the right thing.
            router.push('/(tabs)/train');
            return;
          }
          router.push({ pathname: '/practice/plan', params: { sessionId } });
        }}
        onHome={() => {
          reset();
          router.replace('/(tabs)/home');
        }}
      />
    );
  }

  return null;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  setupSafe: { flex: 1, backgroundColor: '#fff' },
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

  // Step 1 — piece input (setup)
  inputContent: { flex: 1 },
  setupContentInner: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  setupTitle: {
    fontSize: 38,
    fontWeight: '900',
    color: colors.text.primary,
    lineHeight: 44,
    marginBottom: spacing.xs,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    gap: spacing.sm,
  },
  searchIcon: { flexShrink: 0 },
  pieceDetailRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  pieceDetailInput: {
    flex: 1,
    backgroundColor: '#f3f4f6',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text.primary,
  },
  searchInput: {
    flex: 1,
    fontSize: 18,
    color: colors.text.primary,
  },
  setupBottom: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
    backgroundColor: '#fff',
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
  sheetMusicFilename: { flex: 1, fontSize: 13, fontWeight: '600', color: '#166534' },
  sheetMusicRemove: { padding: 4 },
  techniqueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs + 2,
    paddingVertical: spacing.sm,
  },
  techniqueLabel: { fontSize: 14, fontWeight: '600', color: colors.text.secondary },

  // Step 2 — method select
  methodOuter: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.lg },
  methodHeader: { gap: spacing.xs },
  methodPieceRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  methodPieceText: { fontSize: 13, fontWeight: '600', color: colors.brand[600] },
  methodCards: { gap: spacing.md },
  methodBottom: { flex: 1, justifyContent: 'flex-end', paddingBottom: spacing.lg, gap: spacing.sm },
  methodContent: { flex: 1, padding: spacing.lg, justifyContent: 'center', gap: spacing.md },
  // Popout method buttons
  methodBtnOuter: {
    height: METHOD_H + METHOD_DEPTH,
    borderRadius: 16,
    overflow: 'hidden',
  },
  methodBtnBase: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    height: METHOD_H,
    borderRadius: 16,
    backgroundColor: '#c7cad1',
  },
  methodBtnSurface: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: METHOD_H,
    borderRadius: 16,
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.md,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
  },
  methodBtnIconWrap: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  methodBtnText: { flex: 1 },
  methodBtnTitle: { fontSize: 16, fontWeight: '700', color: colors.text.primary },
  methodBtnSub: { fontSize: 12, color: colors.text.muted, marginTop: 2, lineHeight: 17 },
  methodProPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.brand[600],
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  methodProPillText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  methodQuotaHint: {
    fontSize: 12,
    color: colors.text.muted,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#e5e7eb' },
  dividerLabel: { fontSize: 13, color: colors.text.muted, fontWeight: '500' },
  tuneLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: spacing.sm },
  tuneLinkText: { fontSize: 14, color: colors.brand[600], fontWeight: '600' },
  setupBack: { alignSelf: 'flex-start', marginBottom: spacing.xs, marginLeft: -spacing.xs },
  backBtn: { alignItems: 'center', paddingVertical: spacing.sm },
  backLabel: { fontSize: 14, color: colors.text.muted, fontWeight: '500' },
  // Upload tips drawer
  drawerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  tipsDrawer: {
    backgroundColor: colors.brand[700],
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: 40,
    gap: spacing.md,
  },
  tipsDrawerHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignSelf: 'center',
    marginBottom: spacing.xs,
  },
  tipsDrawerTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#fff',
  },
  tipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  tipBullet: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  },
  tipBulletText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  tipText: { flex: 1, fontSize: 14, color: 'rgba(255,255,255,0.9)', lineHeight: 20 },
  // Grouped sessions (piece_input)

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
  // Sets expectations for the calibration step that sits between this screen
  // and the take, so the bow holds aren't a surprise.
  ctaNote: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.text.muted,
    textAlign: 'center',
    marginTop: spacing.sm,
  },

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
  processingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  processingContent: { width: '82%', alignItems: 'center', gap: spacing.xl },
  processingPhaseLabel: {
    fontSize: 26, fontWeight: '700', color: '#fff', textAlign: 'center', lineHeight: 34,
  },
  processingBarTrack: {
    width: '100%', height: 6, borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden',
  },
  processingBarFill: {
    height: '100%', borderRadius: 3, backgroundColor: colors.brand[400],
  },
  processingTimeHint: {
    fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 4,
  },
  processingSteps: { width: '100%', gap: spacing.md },
  processingStep: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  processingDot: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  processingDotDone: { backgroundColor: 'rgba(255,255,255,0.25)' },
  processingDotActive: { backgroundColor: colors.brand[400] },
  processingDotText: { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.5)' },
  processingDotTextActive: { color: '#fff' },
  processingStepLabel: { fontSize: 14, color: 'rgba(255,255,255,0.4)', fontWeight: '500' },
  processingStepLabelActive: { color: '#fff', fontWeight: '700' },

  // Celebration
  celebrationInner: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  celebrationTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#fff',
    marginBottom: spacing.sm,
  },
  celebrationCenter: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  celebrationScore: { alignItems: 'center', gap: 4 },
  celebrationScoreNum: {
    fontSize: 56, fontWeight: '800', color: '#fff', lineHeight: 64,
  },
  celebrationScoreLabel: {
    fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.55)',
    letterSpacing: 1.5, textTransform: 'uppercase',
  },
  celebrationIssues: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  celebrationIssuesLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.5)',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 2,
  },
  celebrationIssueCard: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  celebrationIssueTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 3,
  },
  celebrationIssueBody: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.65)',
    lineHeight: 17,
  },
  celebrationFooter: {
    marginTop: spacing.md,
  },

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
  resultsSafe: { flex: 1, backgroundColor: colors.brand[900] },
  resultsVideoLayer: { position: 'absolute', top: 0, left: 0, right: 0 },
  resultsDrawer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 16,
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
  },
  actionLink: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  actionLinkText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text.muted,
  },
  actionLinkPrimary: {
    color: colors.brand[600],
  },

  // ── Recording HUD (minimal) ────────────────────────────────────────────────
  wristDebugBlock: {
    position: 'absolute',
    top: 14,
    right: 16,
    alignItems: 'flex-end',
  },
  recWristAngle: {
    fontSize: 28,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.9)',
    fontVariant: ['tabular-nums'] as any,
  },
  wristDebugPanel: {
    marginTop: 4,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 5,
    minWidth: 130,
  },
  wristDbgRow: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 14,
    fontVariant: ['tabular-nums'] as any,
    fontFamily: 'monospace',
    lineHeight: 22,
  },
  wristDbgVal: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  wristDbgWarn: {
    color: '#f87171',
  },
  recVibratoBadge: {
    position: 'absolute',
    top: 14,
    left: 16,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  recVibratoLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.6)',
    letterSpacing: 1,
  },
  recVibratoScore: {
    fontSize: 26,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.95)',
    fontVariant: ['tabular-nums'],
    lineHeight: 30,
  },
  recGraphOuter: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recGraphBg: {
    backgroundColor: 'rgba(0,0,0,0.52)',
    borderRadius: 10,
    padding: 6,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 4,
  },
  recGraphLabels: {
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  recGraphCentsLabel: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.4)',
    fontVariant: ['tabular-nums'],
  },
  recStopCorner: {
    position: 'absolute',
    bottom: 0,
    left: 16,
  },

  // ── Live coaching HUD ──────────────────────────────────────────────────────
  // The banner itself lives in LiveCoachBanner; these are the two small
  // persistent pieces that sit alongside it without competing for attention.
  recStatusChip: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  recStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.score.critical,
  },
  recStatusText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  recStatusBpm: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    fontWeight: '600',
  },

  bowBtnRow: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    gap: 10,
  },

  bowRotateBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bowRotateBtnText: {
    fontSize: 30,
    color: '#fff',
    lineHeight: 36,
  },

});
