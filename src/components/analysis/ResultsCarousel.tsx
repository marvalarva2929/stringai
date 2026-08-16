import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  ActivityIndicator,
  Animated as RNAnimated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withSpring, interpolateColor,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, FontAwesome6 } from '@expo/vector-icons';
import Svg, { Circle, Line, Polygon, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useWindowDimensions } from 'react-native';
import { InlineVideoPlayer } from './InlineVideoPlayer';
import { DemoVideoPlaceholder } from './DemoVideoPlaceholder';
import { colors, spacing, radius } from '../../constants/theme';
import { haptic } from '../../lib/haptics';
import { useActivationStore } from '../../store/useActivationStore';
import { useSpotlightTarget } from '../activation/useSpotlightTarget';
import { useSpotlightStore } from '../activation/spotlightStore';
import { useCoachmarks } from '../activation/useCoachmarks';
import { SpotlightOverlay } from '../activation/SpotlightOverlay';
import { CAROUSEL_COACHMARKS, OVERVIEW_PAGE_INDEX } from '../../constants/activationScript';
import {
  AnalysisResult, MetricScore, MetricKey, FlaggedTimestamp, TechniqueEvent, ToneFault,
  IntonationAnalysis, VibratoAnalysis, PitchClassIssue, VibratoNoteResult,
  IntonationStabilityNoteResult,
  LLMCoachingItem, DynDebugInfo, RhythmAnalysis,
} from '../../types/analysis';
import { useTuneNote } from '../../hooks/useTuneNote';
import { TunePracticePanel } from '../practice/TuneNotePanel';
import {
  classifyVibratoFaults, hasVibrato, VIBRATO_DISPLAY, VibratoFault,
} from '../../services/pitchContour';
import { FAULT_MESSAGE as TONE_FAULT_COPY } from '../../services/toneAnalysis';
import { CATEGORIES, type CategoryId } from '../../constants/categories';
import { AnalyticsEvent } from '../../constants/analyticsEvents';
import { track } from '../../services/analytics';
import { fetchChatReply } from '../../services/sessionChat';
import { EntitlementRequiredError } from '../../services/llmFeedback';
import { errorReason } from '../../lib/analyticsUserProps';
import { useCoachContext } from '../../hooks/useCoachContext';
import { MarkdownText } from '../ui/MarkdownText';
import { ProblemSpotsPage } from './ProblemSpotsPage';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const { width: SCREEN_W } = Dimensions.get('window');
const GRAPH_RANGE = 50;
const IDEAL_RATE_HZ = 5.5;
const IDEAL_DEPTH_CENTS = 25;
const PITCH_HOP_HZ = 40;

type PageId = 'celebration' | 'overview' | CategoryId | 'moments' | 'chat';

// CATEGORIES now lives in src/constants/categories.ts so the Progress screen and
// piece detail speak the same vocabulary as this carousel.

// Categories hidden from the UI until their scoring is reliable enough to show.
// Remove a category from this set to re-enable it everywhere.
// Bow + posture pages are visible now that the detector pipeline produces real
// scores — cards carry their measurementQuality badge; these metrics still stay
// out of the OVERALL score via HIDDEN_SCORE_KEYS in analyze.tsx until calibrated.
const HIDDEN_CATS = new Set<CategoryId>([]);

const VISIBLE_CATEGORIES = CATEGORIES.filter(c => !HIDDEN_CATS.has(c.id));

// 'moments' sits immediately before the Practice handoff on purpose: the last
// thing seen before the plan should be the specific passages the plan answers.
const PAGES: PageId[] = [
  'celebration',
  'overview',
  ...VISIBLE_CATEGORIES.map(c => c.id as PageId),
  'moments',
  'chat',
];

const METRIC_LABELS: Record<string, string> = {
  pitchAccuracy: 'Pitch Accuracy', intonationStability: 'Intonation Stability',
  toneQuality: 'Tone Quality', bowSmoothness: 'Bow Changes',
  vibrato: 'Vibrato', rhythmAccuracy: 'Rhythm', dynamicControl: 'Dynamics',
  bowPlacement: 'Bow Placement', bowAngle: 'Bow Angle',
  bowArmLevel: 'Bow Arm Height', bowDistribution: 'Bow Usage',
  leftHandWrist: 'Left Wrist', posture: 'Posture',
};

function fmtSecs(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

const WRIST_THRESHOLD = 160;
const V_MIN = 85, V_MAX = 185;

// Split in two so the "no usable series" guard runs before any hook does —
// a metric can gain or lose its time series between renders, and bailing out
// after the hooks would change the hook count and blow up the results screen.
function WristAngleGraph({ metric, duration, onTimestampPress }: {
  metric: MetricScore;
  duration: number;
  onTimestampPress?: (s: number) => void;
}) {
  const series = metric.timeSeries;
  if (!series || series.length < 2) return null;
  return <WristAngleGraphBody metric={metric} series={series} onTimestampPress={onTimestampPress} />;
}

function WristAngleGraphBody({ metric, series, onTimestampPress }: {
  metric: MetricScore;
  series: NonNullable<MetricScore['timeSeries']>;
  onTimestampPress?: (s: number) => void;
}) {
  const { width: screenW } = useWindowDimensions();

  const W = screenW - 48;
  const H = 148;
  const PAD_L = 34, PAD_R = 8, PAD_T = 10, PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const tMin = series[0].t;
  const tMax = Math.max(series[series.length - 1].t, tMin + 1);

  const tx = (t: number) => PAD_L + ((t - tMin) / (tMax - tMin)) * plotW;
  const ty = (v: number) => PAD_T + (1 - (Math.min(Math.max(v, V_MIN), V_MAX) - V_MIN) / (V_MAX - V_MIN)) * plotH;

  const [scrub, setScrub] = useState<{ x: number; t: number; v: number } | null>(null);
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTap = useCallback((locationX: number) => {
    const rawX = locationX - PAD_L;
    const t = Math.max(tMin, Math.min(tMax, tMin + (rawX / plotW) * (tMax - tMin)));
    const svgX = PAD_L + ((t - tMin) / (tMax - tMin)) * plotW;
    let nearest = series[0];
    let minDist = Infinity;
    for (const p of series) {
      const d = Math.abs(p.t - t);
      if (d < minDist) { minDist = d; nearest = p; }
    }
    setScrub({ x: svgX, t, v: nearest.v });
    onTimestampPress?.(t);
    if (scrubTimer.current) clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => setScrub(null), 2500);
  }, [series, tMin, tMax, plotW, onTimestampPress]);

  const d = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${tx(p.t).toFixed(1)},${ty(p.v).toFixed(1)}`).join(' ');
  const gridVals = [100, 120, 140, 160, 180];
  const totalSecs = tMax - tMin;
  const xStep = totalSecs <= 30 ? 10 : totalSecs <= 90 ? 20 : totalSecs <= 180 ? 30 : totalSecs <= 360 ? 60 : 120;
  const xLabels: number[] = [];
  for (let t = Math.ceil((tMin + 1) / xStep) * xStep; t <= tMax - 1; t += xStep) xLabels.push(t);

  const tooltipLeft = scrub !== null && scrub.x > W / 2;

  return (
    <View style={{ marginTop: 16 }}>
      <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 }}>
        WRIST ANGLE OVER TIME
      </Text>
      <Pressable onPress={(e) => handleTap(e.nativeEvent.locationX)}>
        <Svg width={W} height={H}>
          {/* Grid lines */}
          {gridVals.map(v => (
            <React.Fragment key={v}>
              <Line
                x1={PAD_L} y1={ty(v)} x2={W - PAD_R} y2={ty(v)}
                stroke={v === WRIST_THRESHOLD ? '#f59e0b' : '#1e293b'}
                strokeWidth={v === WRIST_THRESHOLD ? 1 : 0.75}
                strokeDasharray={v === WRIST_THRESHOLD ? '5,3' : undefined}
              />
              <SvgText x={PAD_L - 4} y={ty(v) + 3.5} fontSize={8} fill={v === WRIST_THRESHOLD ? '#f59e0b' : '#475569'} textAnchor="end">
                {v}°
              </SvgText>
            </React.Fragment>
          ))}
          {/* Data line */}
          <Path d={d} stroke="#38bdf8" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          {/* Scrubber */}
          {scrub && (
            <React.Fragment>
              <Line x1={scrub.x} y1={PAD_T} x2={scrub.x} y2={H - PAD_B} stroke="#fff" strokeWidth={1} opacity={0.6} />
              <Circle cx={scrub.x} cy={ty(scrub.v)} r={4} fill="#fff" />
              <SvgText
                x={tooltipLeft ? scrub.x - 7 : scrub.x + 7}
                y={PAD_T + 11}
                fontSize={10}
                fontWeight="700"
                fill="#fff"
                textAnchor={tooltipLeft ? 'end' : 'start'}
              >
                {fmtSecs(scrub.t)} · {Math.round(scrub.v)}°
              </SvgText>
            </React.Fragment>
          )}
          {/* X axis labels */}
          {xLabels.map(t => (
            <SvgText key={t} x={tx(t)} y={H - 5} fontSize={8} fill="#475569" textAnchor="middle">
              {fmtSecs(t)}
            </SvgText>
          ))}
        </Svg>
      </Pressable>
      {__DEV__ && metric.measurementQuality === 'low' && (
        <Text style={{ color: '#475569', fontSize: 10, marginTop: 4 }}>
          2D estimate — 3D measurement requires pose_landmarker_full.task
        </Text>
      )}
    </View>
  );
}

function WristDebugGraphs({ metric }: { metric: MetricScore }) {
  const { width: screenW } = useWindowDimensions();
  const series = metric.debugSeries;
  if (!__DEV__ || !series || series.length < 2) return null;

  const W = screenW - 48;
  const H = 60;
  const PAD_L = 34, PAD_R = 8, PAD_T = 8, PAD_B = 4;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const tMin = series[0].t;
  const tMax = Math.max(series[series.length - 1].t, tMin + 1);
  const tx = (t: number) => PAD_L + ((t - tMin) / (tMax - tMin)) * plotW;

  // cos graph: range -0.2 to 1.0, red zone below 0.2
  const COS_MIN = -0.2, COS_MAX = 1.0;
  const tyCos = (v: number) => PAD_T + (1 - (Math.min(Math.max(v, COS_MIN), COS_MAX) - COS_MIN) / (COS_MAX - COS_MIN)) * plotH;
  const cosPoints = series.filter(p => p.cos !== null);
  const dCos = cosPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${tx(p.t).toFixed(1)},${tyCos(p.cos!).toFixed(1)}`).join(' ');
  const y02 = tyCos(0.2); // threshold line

  // |H| graph: range 0 to 20cm
  const H_MIN = 0, H_MAX = 20;
  const tyH = (v: number) => PAD_T + (1 - (Math.min(Math.max(v, H_MIN), H_MAX) - H_MIN) / (H_MAX - H_MIN)) * plotH;
  const hPoints = series.filter(p => p.magH !== null);
  const dH = hPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${tx(p.t).toFixed(1)},${tyH(p.magH!).toFixed(1)}`).join(' ');
  const y3 = tyH(3); // < 3cm = tip collapsed

  return (
    <View style={{ marginTop: 10 }}>
      <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 4 }}>
        DEBUG: cos θ  (near 0 = 90° error)
      </Text>
      <Svg width={W} height={H}>
        <Line x1={PAD_L} y1={y02} x2={W - PAD_R} y2={y02} stroke="#f87171" strokeWidth={0.75} strokeDasharray="4,3" />
        <SvgText x={PAD_L - 4} y={y02 + 3.5} fontSize={8} fill="#f87171" textAnchor="end">0.2</SvgText>
        <Line x1={PAD_L} y1={tyCos(0)} x2={W - PAD_R} y2={tyCos(0)} stroke="#475569" strokeWidth={0.5} />
        <SvgText x={PAD_L - 4} y={tyCos(0) + 3.5} fontSize={8} fill="#475569" textAnchor="end">0</SvgText>
        <SvgText x={PAD_L - 4} y={tyCos(1) + 3.5} fontSize={8} fill="#475569" textAnchor="end">1</SvgText>
        {cosPoints.length > 1 && <Path d={dCos} stroke="#a78bfa" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      </Svg>

      <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 4, marginTop: 8 }}>
        DEBUG: |H| cm  (hand vector, red if &lt; 3cm = tip lost)
      </Text>
      <Svg width={W} height={H}>
        <Line x1={PAD_L} y1={y3} x2={W - PAD_R} y2={y3} stroke="#f87171" strokeWidth={0.75} strokeDasharray="4,3" />
        <SvgText x={PAD_L - 4} y={y3 + 3.5} fontSize={8} fill="#f87171" textAnchor="end">3</SvgText>
        <SvgText x={PAD_L - 4} y={tyH(10) + 3.5} fontSize={8} fill="#475569" textAnchor="end">10</SvgText>
        <SvgText x={PAD_L - 4} y={tyH(20) + 3.5} fontSize={8} fill="#475569" textAnchor="end">20</SvgText>
        {hPoints.length > 1 && <Path d={dH} stroke="#34d399" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      </Svg>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Bow position graph — contact point u (0=frog, 1=tip) over time
// ─────────────────────────────────────────────────────────────

function BowPositionGraph({ metric, onTimestampPress }: {
  metric: MetricScore;
  onTimestampPress?: (s: number) => void;
}) {
  const { width: screenW } = useWindowDimensions();
  const series = metric.timeSeries;
  const [scrub, setScrub] = useState<{ x: number; t: number; v: number } | null>(null);
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!series || series.length < 2) return null;

  const W = screenW - 48;
  const H = 148;
  const PAD_L = 34, PAD_R = 8, PAD_T = 10, PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const tMin = series[0].t;
  const tMax = Math.max(series[series.length - 1].t, tMin + 1);
  const tx = (t: number) => PAD_L + ((t - tMin) / (tMax - tMin)) * plotW;
  // v=1 (tip) at the top, v=0 (frog) at the bottom
  const ty = (v: number) => PAD_T + (1 - Math.min(Math.max(v, 0), 1)) * plotH;

  const handleTap = (locationX: number) => {
    const rawX = locationX - PAD_L;
    const t = Math.max(tMin, Math.min(tMax, tMin + (rawX / plotW) * (tMax - tMin)));
    const svgX = tx(t);
    let nearest = series[0];
    let minDist = Infinity;
    for (const p of series) {
      const d = Math.abs(p.t - t);
      if (d < minDist) { minDist = d; nearest = p; }
    }
    setScrub({ x: svgX, t, v: nearest.v });
    onTimestampPress?.(t);
    if (scrubTimer.current) clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => setScrub(null), 2500);
  };

  const d = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${tx(p.t).toFixed(1)},${ty(p.v).toFixed(1)}`).join(' ');
  const totalSecs = tMax - tMin;
  const xStep = totalSecs <= 30 ? 10 : totalSecs <= 90 ? 20 : totalSecs <= 180 ? 30 : totalSecs <= 360 ? 60 : 120;
  const xLabels: number[] = [];
  for (let t = Math.ceil((tMin + 1) / xStep) * xStep; t <= tMax - 1; t += xStep) xLabels.push(t);
  const tooltipLeft = scrub !== null && scrub.x > W / 2;

  return (
    <View style={{ marginTop: 16 }}>
      <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 }}>
        BOW POSITION OVER TIME
      </Text>
      <Pressable onPress={(e) => handleTap(e.nativeEvent.locationX)}>
        <Svg width={W} height={H}>
          {/* Zone bands: upper (tip) / middle / lower (frog) thirds */}
          <Rect x={PAD_L} y={ty(1)} width={plotW} height={plotH / 3} fill="rgba(56,189,248,0.06)" />
          <Rect x={PAD_L} y={ty(1 / 3)} width={plotW} height={plotH / 3} fill="rgba(56,189,248,0.06)" />
          {[1 / 3, 2 / 3].map(v => (
            <Line key={v} x1={PAD_L} y1={ty(v)} x2={W - PAD_R} y2={ty(v)} stroke="#1e293b" strokeWidth={0.75} strokeDasharray="4,3" />
          ))}
          {/* Y labels */}
          <SvgText x={PAD_L - 4} y={ty(1) + 8} fontSize={8} fill="#64748b" textAnchor="end">tip</SvgText>
          <SvgText x={PAD_L - 4} y={ty(0.5) + 3} fontSize={8} fill="#475569" textAnchor="end">mid</SvgText>
          <SvgText x={PAD_L - 4} y={ty(0) - 1} fontSize={8} fill="#64748b" textAnchor="end">frog</SvgText>
          {/* Data line */}
          <Path d={d} stroke="#38bdf8" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          {/* Scrubber */}
          {scrub && (
            <React.Fragment>
              <Line x1={scrub.x} y1={PAD_T} x2={scrub.x} y2={H - PAD_B} stroke="#fff" strokeWidth={1} opacity={0.6} />
              <Circle cx={scrub.x} cy={ty(scrub.v)} r={4} fill="#fff" />
              <SvgText
                x={tooltipLeft ? scrub.x - 7 : scrub.x + 7}
                y={PAD_T + 11}
                fontSize={10}
                fontWeight="700"
                fill="#fff"
                textAnchor={tooltipLeft ? 'end' : 'start'}
              >
                {fmtSecs(scrub.t)} · {Math.round(scrub.v * 100)}% toward tip
              </SvgText>
            </React.Fragment>
          )}
          {/* X axis labels */}
          {xLabels.map(t => (
            <SvgText key={t} x={tx(t)} y={H - 5} fontSize={8} fill="#475569" textAnchor="middle">
              {fmtSecs(t)}
            </SvgText>
          ))}
        </Svg>
      </Pressable>
      <Text style={{ color: '#475569', fontSize: 10, marginTop: 4 }}>
        Where the bow contacts the string — tap to jump the video there
      </Text>
    </View>
  );
}

function scoreColor(score: number) {
  if (score >= 85) return colors.score.excellent;
  if (score >= 70) return colors.score.good;
  if (score >= 50) return colors.score.needs_attention;
  return colors.score.critical;
}

function avgScore(metrics: MetricScore[], keys: MetricKey[]): number {
  // Unavailable metrics carry score 0 — averaging them in would tank the
  // category bar for sessions where a signal simply wasn't measurable.
  const vals = keys
    .map(k => metrics.find(m => m.key === k))
    .filter((m): m is MetricScore => m !== undefined && m.measurementQuality !== 'unavailable')
    .map(m => m.score);
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
}

// ─────────────────────────────────────────────────────────────
// Category icon
// ─────────────────────────────────────────────────────────────

function CatIcon({ id, size = 28, color = '#fff' }: { id: string; size?: number; color?: string }) {
  switch (id) {
    case 'intonation': return <Ionicons name="musical-note"  size={size} color={color} />;
    case 'vibrato':    return <Ionicons name="pulse"         size={size} color={color} />;
    case 'tone':       return <Ionicons name="volume-high"   size={size} color={color} />;
    case 'bow':        return <Ionicons name="musical-notes" size={size} color={color} />;
    case 'posture':    return <Ionicons name="person"        size={size} color={color} />;
    case 'rhythm':     return <FontAwesome6 name="drum"      size={size} color={color} />;
    default:           return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Radar chart
// ─────────────────────────────────────────────────────────────

function RadarChart({ metrics }: { metrics: MetricScore[] }) {
  const radarCats = VISIBLE_CATEGORIES;
  const N = radarCats.length;
  const CX = 100, CY = 100, R = 72, LABEL_R = R + 26;
  const mm: Record<string, number> = {};
  for (const m of metrics) {
    if (m.measurementQuality !== 'unavailable') mm[m.key] = m.score;
  }
  const scores = radarCats.map(cat => {
    const vals = cat.keys.map(k => mm[k]).filter((v): v is number => v !== undefined);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  });
  const ang = (i: number) => -Math.PI / 2 + (i / N) * 2 * Math.PI;
  const outer = (i: number) => ({ x: CX + R * Math.cos(ang(i)), y: CY + R * Math.sin(ang(i)) });
  const score = (i: number) => {
    const f = Math.max(0.05, scores[i] / 100);
    return { x: CX + f * R * Math.cos(ang(i)), y: CY + f * R * Math.sin(ang(i)) };
  };
  const ring = (f: number) => Array.from({ length: N }, (_, i) => {
    const a = ang(i); return `${CX + f * R * Math.cos(a)},${CY + f * R * Math.sin(a)}`;
  }).join(' ');
  const scorePts = Array.from({ length: N }, (_, i) => { const p = score(i); return `${p.x},${p.y}`; }).join(' ');
  const anchor = (i: number) => { const x = Math.cos(ang(i)); return x > 0.3 ? 'start' : x < -0.3 ? 'end' : 'middle'; };
  const dy = (i: number) => { const s = Math.sin(ang(i)); return s < -0.4 ? '-0.2em' : s > 0.4 ? '1em' : '0.35em'; };
  return (
    <Svg width={220} height={220} viewBox="-30 -30 260 260">
      {[0.33, 0.66, 1].map(f => <Polygon key={f} points={ring(f)} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1} />)}
      {Array.from({ length: N }, (_, i) => { const p = outer(i); return <Line key={i} x1={CX} y1={CY} x2={p.x} y2={p.y} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />; })}
      <Polygon points={scorePts} fill="rgba(56,189,248,0.2)" stroke="#38bdf8" strokeWidth={2} strokeLinejoin="round" />
      {Array.from({ length: N }, (_, i) => { const p = outer(i); return <Circle key={i} cx={p.x} cy={p.y} r={3} fill="rgba(255,255,255,0.25)" />; })}
      {Array.from({ length: N }, (_, i) => { const p = score(i); return <Circle key={i} cx={p.x} cy={p.y} r={4.5} fill="#38bdf8" stroke="#fff" strokeWidth={1.5} />; })}
      {radarCats.map((cat, i) => (
        <SvgText key={cat.label} x={CX + LABEL_R * Math.cos(ang(i))} y={CY + LABEL_R * Math.sin(ang(i))}
          dy={dy(i)} fontSize={11} fontWeight="600" fill="rgba(255,255,255,0.75)" textAnchor={anchor(i)}>
          {cat.label}
        </SvgText>
      ))}
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────
// Celebration page (first slide)
// ─────────────────────────────────────────────────────────────

// Leads the results screen: the LLM's overall take (and, once grounded, its
// top root cause) is the first text on screen, above the score reveal — while
// it's still in flight this shows a loading state instead of silently swapping
// static→real text later.
function CoachLeadSection({ result }: { result: AnalysisResult }) {
  if (result.coachingPending) {
    return (
      <View style={s.coachLeadCard}>
        <Text style={s.coachLeadBadge}>AI COACH</Text>
        <View style={s.coachLeadShimmerLine} />
        <View style={[s.coachLeadShimmerLine, { width: '65%' }]} />
        <Text style={s.coachLeadPendingText}>Reviewing your playing…</Text>
      </View>
    );
  }

  const take = result.llmFeedback?.source === 'claude' ? result.llmFeedback.overallTake : undefined;
  if (!take) return null;
  const topCause = result.llmFeedback?.rootCauses?.[0];

  return (
    <View style={s.coachLeadCard}>
      <Text style={s.coachLeadBadge}>AI COACH</Text>
      <Text style={s.coachLeadTake}>{take}</Text>
      {topCause && (
        <View style={s.coachLeadCause}>
          <Text style={s.coachLeadCauseLabel}>{topCause.label}</Text>
          <Text style={s.coachLeadCauseBody}>{topCause.explanation}</Text>
        </View>
      )}
    </View>
  );
}

function CelebrationPage({ result }: { result: AnalysisResult }) {
  const { scrollRef, showHint, onLayout, onContentSizeChange, onScroll, scrollToEnd } = useScrollHint();
  const [celebScore, setCelebScore] = useState(0);
  const cardAnims = useRef(
    [0, 1, 2].map(() => ({ opacity: new RNAnimated.Value(0), ty: new RNAnimated.Value(28) }))
  ).current;

  useEffect(() => {
    const targetScore = result.overallScore;
    const startMs = Date.now();
    const countUp = () => {
      const t = Math.min((Date.now() - startMs) / 900, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setCelebScore(Math.round(eased * targetScore));
      if (t < 1) requestAnimationFrame(countUp);
    };
    requestAnimationFrame(countUp);

    cardAnims.forEach(a => { a.opacity.setValue(0); a.ty.setValue(28); });
    RNAnimated.sequence([
      RNAnimated.delay(500),
      RNAnimated.stagger(130, cardAnims.map(a =>
        RNAnimated.parallel([
          RNAnimated.timing(a.opacity, { toValue: 1, duration: 380, useNativeDriver: true }),
          RNAnimated.timing(a.ty, { toValue: 0, duration: 380, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ])
      )),
    ]).start();
  }, []);

  const issueItems = (() => {
    if (result.llmFeedback?.items?.length) {
      return result.llmFeedback.items.slice(0, 3).map(item => ({
        key: item.metricKey,
        title: METRIC_LABELS[item.metricKey] ?? item.metricKey,
        body: item.feedback,
      }));
    }
    const hiddenKeys = new Set(CATEGORIES.filter(c => HIDDEN_CATS.has(c.id)).flatMap(c => c.keys));
    return [...result.metrics]
      .filter(m => m.score < 85 && !hiddenKeys.has(m.key))
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map(m => ({
        key: m.key,
        title: METRIC_LABELS[m.key] ?? m.key,
        body: m.observationSummary,
      }));
  })();

  return (
    <View style={{ flex: 1 }}>
    <ScrollView
      ref={scrollRef}
      style={s.pageScroll}
      contentContainerStyle={s.celebContent}
      showsVerticalScrollIndicator={false}
      onLayout={onLayout}
      onContentSizeChange={onContentSizeChange}
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      <CoachLeadSection result={result} />
      <View style={s.celebChartArea}>
        <RadarChart metrics={result.metrics} />
      </View>
      <View style={s.celebScoreArea}>
        <Text style={s.celebScoreNum}>{celebScore}</Text>
        <Text style={s.celebScoreLabel}>Overall Score</Text>
      </View>
      {issueItems.length > 0 && (
        <View style={s.celebIssues}>
          <Text style={s.celebIssuesLabel}>Most important to fix</Text>
          {issueItems.map((item, i) => (
            <RNAnimated.View
              key={item.key}
              style={[s.celebIssueCard, {
                opacity: cardAnims[i]?.opacity ?? 1,
                transform: [{ translateY: cardAnims[i]?.ty ?? 0 }],
              }]}
            >
              <Text style={s.celebIssueTitle}>{item.title}</Text>
              <Text style={s.celebIssueBody} numberOfLines={2}>{item.body}</Text>
            </RNAnimated.View>
          ))}
        </View>
      )}
      <Text style={s.celebSwipeHint}>Swipe right to see details →</Text>
    </ScrollView>
    {showHint && <ScrollHintButton onPress={scrollToEnd} />}
    </View>
  );
}

// Bottom-sheet chrome shared by VibratoNoteDrawer below (the tune-note panel
// has its own copy in TuneNotePanel.tsx — this one styles a different drawer).
const PANEL_H = Math.round(Dimensions.get('window').height * 0.42);
const ps = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { height: PANEL_H, backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, alignItems: 'center', paddingHorizontal: spacing.xl, paddingBottom: 32, gap: spacing.sm, shadowColor: '#000', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.18, shadowRadius: 20, elevation: 20 },
  pill: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#d1d5db', marginTop: 10, marginBottom: 4 },
  playBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.brand[600], borderRadius: radius.full, paddingHorizontal: 28, paddingVertical: 14, marginTop: spacing.xs },
  playBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  doneBtn: { marginTop: 4 },
  doneBtnText: { fontSize: 14, color: colors.text.muted, fontWeight: '500' },
});

// ─────────────────────────────────────────────────────────────
// Vibrato cards
// ─────────────────────────────────────────────────────────────

function buildPath(cents: number[], w: number, h: number, range: number = GRAPH_RANGE): string {
  if (cents.length < 2) return '';
  const PAD = 4;
  const mh = h - PAD * 2;
  return cents.map((c, i) => {
    const x = (i / Math.max(cents.length - 1, 1)) * w;
    const clamped = Math.max(-range, Math.min(range, c));
    const y = PAD + mh / 2 - (clamped / range) * (mh / 2);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

/** Stride-samples a series down to at most maxPoints (cents arrays can be hundreds long). */
function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const stride = values.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => values[Math.floor(i * stride)]);
}

const SPARK_W = 64;
const SPARK_H = 24;

// ─────────────────────────────────────────────────────────────
// Vibrato issue grouping, drawer, and section
// ─────────────────────────────────────────────────────────────

interface VibratoFaultGroup {
  fault: VibratoFault;
  notes: Array<{ note: VibratoNoteResult; index: number }>; // worst first (noteScore asc)
  severity: number; // Σ (100 − noteScore) — combines count and badness for ranking
}

const VIBRATO_FAULT_META: Record<VibratoFault, { title: string; icon: string; tip: string }> = {
  none:    { title: 'No vibrato',    icon: 'radio-button-off-outline',
             tip: 'Start with a slow, measured wrist rock — two pulses per beat on a long note — then gradually speed up.' },
  shallow: { title: 'Shallow depth', icon: 'trending-down',
             tip: 'Let the fingertip roll further back — practice exaggerated, slow swings, then rein them in.' },
  wide:    { title: 'Too wide',      icon: 'resize-outline',
             tip: 'Rein in the swing — keep the roll well inside a semitone and re-center with slow metronome pulses.' },
  slow:    { title: 'Slow rate',     icon: 'hourglass-outline',
             tip: 'With a metronome at 60, play 4 pulses per click, then 5, then 6 — building toward 5–6 per second.' },
  fast:    { title: 'Fast / tense',  icon: 'flash-outline',
             tip: 'Relax the hand and broaden the motion — a narrow, rapid shake usually means tension.' },
  uneven:  { title: 'Uneven rhythm', icon: 'pulse',
             tip: 'Practice rhythmic vibrato: lock the pulse to a subdivision until it feels metronomic, then free it.' },
  fades:   { title: 'Fades mid-bow', icon: 'remove-outline',
             tip: 'Keep the wrist moving through the whole bow stroke — especially into and out of bow changes.' },
};

// Each note joins exactly ONE group — its primary fault — so headline counts
// ("6 of 9 notes") stay honest. Healthy notes join nothing.
function buildVibratoFaultGroups(notes: VibratoNoteResult[]): VibratoFaultGroup[] {
  const map = new Map<VibratoFault, VibratoFaultGroup>();
  notes.forEach((note, index) => {
    const fault = classifyVibratoFaults(note)[0];
    if (!fault) return;
    if (!map.has(fault)) map.set(fault, { fault, notes: [], severity: 0 });
    const group = map.get(fault)!;
    group.notes.push({ note, index });
    group.severity += 100 - note.noteScore;
  });
  for (const group of map.values()) group.notes.sort((a, b) => a.note.noteScore - b.note.noteScore);
  return [...map.values()].sort((a, b) => b.severity - a.severity);
}

function vibratoHeadline(fault: VibratoFault, count: number, total: number): string {
  const D = VIBRATO_DISPLAY;
  switch (fault) {
    case 'none':    return `Main issue: no vibrato — ${count} of ${total} long notes had none`;
    case 'shallow': return `Main issue: too shallow — ${count} of ${total} notes under ${D.DEPTH_TARGET_LO}¢ depth`;
    case 'wide':    return `Main issue: too wide — ${count} of ${total} notes over ${D.DEPTH_TARGET_HI}¢ depth`;
    case 'slow':    return `Main issue: too slow — ${count} of ${total} notes under ${D.RATE_TARGET_LO} Hz`;
    case 'fast':    return `Main issue: too fast — ${count} of ${total} notes over ${D.RATE_TARGET_HI} Hz`;
    case 'uneven':  return `Main issue: uneven rhythm — irregular oscillation on ${count} of ${total} notes`;
    case 'fades':   return `Main issue: fades mid-note — depth didn't hold on ${count} of ${total} notes`;
  }
}

function buildVibratoDrawerMessage(fault: VibratoFault, note: VibratoNoteResult): string {
  switch (fault) {
    case 'shallow':
      return `Your depth was ±${note.depthCents}¢. The ideal range is 18–40¢ (shown in yellow) — aim for a wider, more relaxed arm swing.`;
    case 'wide':
      return `Your depth was ±${note.depthCents}¢ — wider than the 18–40¢ ideal. Keep the roll compact and centered on the pitch.`;
    case 'slow':
      return `Your rate was ${note.rateHz} Hz. The ideal is 5–7 Hz (shown in yellow) — try a slightly faster wrist impulse.`;
    case 'fast':
      return `Your rate was ${note.rateHz} Hz. The ideal is 5–7 Hz (shown in yellow) — slow it down by broadening the arm motion.`;
    case 'uneven':
      return `Your vibrato rhythm was irregular. The yellow line shows what a steady oscillation looks like — focus on an even wrist pulse.`;
    case 'fades':
      return `Your vibrato faded mid-stroke. Aim for the consistent depth shown in yellow throughout the whole bow stroke.`;
    case 'none':
      return `No vibrato was detected here. The yellow line shows what a gentle vibrato looks like — try adding a wrist motion on longer notes.`;
    default:
      return '';
  }
}

const VIBRATO_DRAWER_H = Math.round(Dimensions.get('window').height * 0.56);
const DRAWER_GRAPH_H = 108;

function VibratoNoteDrawer({ note, noteIndex, issueType, onClose, onSeek }: {
  note: VibratoNoteResult;
  noteIndex: number;
  issueType: VibratoFault;
  onClose: () => void;
  onSeek?: (s: number) => void;
}) {
  const { width: screenW } = useWindowDimensions();
  const graphW = screenW - 64;
  const sc = scoreColor(note.noteScore);

  const actualPath = buildPath(note.cents, graphW, DRAWER_GRAPH_H);
  const idealCents = Array.from({ length: note.cents.length }, (_, i) =>
    IDEAL_DEPTH_CENTS * Math.sin(2 * Math.PI * IDEAL_RATE_HZ * (i / PITCH_HOP_HZ))
  );
  const idealPath = buildPath(idealCents, graphW, DRAWER_GRAPH_H);
  const cy = 4 + (DRAWER_GRAPH_H - 8) / 2;

  return (
    <TouchableWithoutFeedback onPress={onClose}>
      <View style={ps.backdrop}>
        <TouchableWithoutFeedback>
          <View style={[ps.sheet, { height: VIBRATO_DRAWER_H }]}>
            <View style={ps.pill} />
            <Text style={s.vibratoDrawerNoteLabel}>
              Note {noteIndex + 1}  ·  {fmtSecs(note.startS)}–{fmtSecs(note.endS)}
            </Text>

            {note.cents.length > 1 && (
              <View style={s.vibratoDrawerGraph}>
                <Svg width={graphW} height={DRAWER_GRAPH_H}>
                  <Line x1={0} y1={cy} x2={graphW} y2={cy} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
                  {idealPath ? <Path d={idealPath} stroke="#facc15" strokeWidth={2} fill="none" strokeDasharray="5,4" /> : null}
                  {actualPath ? <Path d={actualPath} stroke={sc} strokeWidth={2.5} fill="none" strokeLinejoin="round" strokeLinecap="round" /> : null}
                </Svg>
                <View style={s.vibratoDrawerLegend}>
                  <View style={s.vibratoLegendItem}>
                    <View style={[s.vibratoLegendDash, { backgroundColor: '#facc15' }]} />
                    <Text style={s.vibratoLegendText}>Ideal vibrato</Text>
                  </View>
                  <View style={s.vibratoLegendItem}>
                    <View style={[s.vibratoLegendDash, { backgroundColor: sc }]} />
                    <Text style={s.vibratoLegendText}>Your vibrato</Text>
                  </View>
                </View>
              </View>
            )}

            <View style={s.vibratoDrawerStats}>
              <View style={s.vibratoDrawerStat}>
                <Text style={s.vibratoDrawerStatVal}>{note.rateHz > 0 ? `${note.rateHz} Hz` : '—'}</Text>
                <Text style={s.vibratoDrawerStatLbl}>Rate</Text>
              </View>
              <View style={s.vibratoDrawerStat}>
                <Text style={s.vibratoDrawerStatVal}>{note.depthCents > 0 ? `±${note.depthCents}¢` : '—'}</Text>
                <Text style={s.vibratoDrawerStatLbl}>Depth</Text>
              </View>
              <View style={s.vibratoDrawerStat}>
                <Text style={[s.vibratoDrawerStatVal, { color: sc }]}>{note.noteScore}</Text>
                <Text style={s.vibratoDrawerStatLbl}>Score</Text>
              </View>
            </View>

            <Text style={s.vibratoDrawerMessage}>{buildVibratoDrawerMessage(issueType, note)}</Text>

            <View style={s.vibratoDrawerActions}>
              {onSeek && (
                <Pressable style={ps.playBtn} onPress={() => { onClose(); onSeek(note.startS); }}>
                  <Ionicons name="play" size={16} color="#fff" />
                  <Text style={ps.playBtnText}>Jump to note in video</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose} style={ps.doneBtn}>
                <Text style={ps.doneBtnText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </View>
    </TouchableWithoutFeedback>
  );
}

// Horizontal "you vs target" axis: shaded target band + a dot at the session average.
function TargetStrip({ label, unit, axisMin, axisMax, axisMaxLabel, bandLo, bandHi, value }: {
  label: string; unit: string;
  axisMin: number; axisMax: number; axisMaxLabel?: string;
  bandLo: number; bandHi: number; value: number;
}) {
  const pct = (v: number) => ((Math.min(Math.max(v, axisMin), axisMax) - axisMin) / (axisMax - axisMin)) * 100;
  const inBand = value >= bandLo && value <= bandHi;
  const dotColor = inBand ? colors.score.excellent : colors.score.needs_attention;
  const fmt = (v: number) => (Number.isInteger(v) ? `${v}` : v.toFixed(1));
  return (
    <View style={s.stripRow}>
      <View style={s.stripLabelRow}>
        <Text style={s.stripLabel}>{label}</Text>
        <Text style={[s.stripValue, { color: dotColor }]}>{fmt(value)} {unit}</Text>
      </View>
      <View style={s.stripTrack}>
        <View style={[s.stripBand, { left: `${pct(bandLo)}%`, width: `${pct(bandHi) - pct(bandLo)}%` }]} />
        <View style={[s.stripDot, { left: `${pct(value)}%`, backgroundColor: dotColor }]} />
      </View>
      <View style={s.stripTicks}>
        <Text style={s.stripTick}>{fmt(axisMin)}</Text>
        <Text style={s.stripTick}>target {fmt(bandLo)}–{fmt(bandHi)} {unit}</Text>
        <Text style={s.stripTick}>{axisMaxLabel ?? fmt(axisMax)}</Text>
      </View>
    </View>
  );
}

const FIX_SHOW_COUNT = 2;

function VibratoFixGroupCard({ group, onNotePress }: {
  group: VibratoFaultGroup;
  onNotePress: (note: VibratoNoteResult, noteIndex: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const meta = VIBRATO_FAULT_META[group.fault];
  const avg = Math.round(group.notes.reduce((a, n) => a + n.note.noteScore, 0) / group.notes.length);
  const accent = scoreColor(avg);
  const visible = showAll ? group.notes : group.notes.slice(0, FIX_SHOW_COUNT);
  const hiddenCount = group.notes.length - FIX_SHOW_COUNT;
  return (
    <View style={[s.noteCard, { borderLeftWidth: 3, borderLeftColor: accent }]}>
      <View style={s.vibratoIssueHeader}>
        <Ionicons name={meta.icon as any} size={20} color="#f59e0b" />
        <Text style={s.vibratoIssueTitle}>{meta.title}</Text>
        <View style={s.vibratoIssueBadge}>
          <Text style={s.vibratoIssueBadgeText}>{group.notes.length}×</Text>
        </View>
      </View>
      <Text style={s.rhythmFixTip}>{meta.tip}</Text>
      <View style={s.vibratoIssueNoteList}>
        {visible.map(({ note, index }) => (
          <Pressable
            key={index}
            style={s.vibratoIssueNoteRow}
            onPress={() => { haptic.light(); onNotePress(note, index); }}
          >
            {note.cents && note.cents.length > 1 && (
              <Svg width={SPARK_W} height={SPARK_H} style={{ marginRight: spacing.sm }}>
                <Path
                  d={buildPath(downsample(note.cents, 48), SPARK_W, SPARK_H)}
                  stroke={scoreColor(note.noteScore)} strokeWidth={1.5} fill="none"
                  strokeLinejoin="round" strokeLinecap="round"
                />
              </Svg>
            )}
            <Text style={s.vibratoIssueNoteLabel}>
              Note {index + 1}  ·  {fmtSecs(note.startS)}–{fmtSecs(note.endS)}
            </Text>
            <View style={[s.vibratoBadge, { backgroundColor: scoreColor(note.noteScore) }]}>
              <Text style={s.vibratoBadgeText}>{note.noteScore}</Text>
            </View>
            <Ionicons name="chevron-forward" size={15} color="rgba(255,255,255,0.3)" style={{ marginLeft: 4 }} />
          </Pressable>
        ))}
      </View>
      {!showAll && hiddenCount > 0 && (
        <Pressable onPress={() => { haptic.light(); setShowAll(true); }} style={s.rhythmShowMoreBtn}>
          <Text style={s.rhythmShowMoreText}>Show {hiddenCount} more</Text>
        </Pressable>
      )}
    </View>
  );
}

function VibratoSection({ analysis, onTimestampPress }: {
  analysis: VibratoAnalysis;
  onTimestampPress: (s: number) => void;
}) {
  const [drawer, setDrawer] = useState<{ note: VibratoNoteResult; noteIndex: number; fault: VibratoFault } | null>(null);
  const groups = React.useMemo(() => buildVibratoFaultGroups(analysis.notes), [analysis.notes]);
  const withVibrato = React.useMemo(() => analysis.notes.filter(hasVibrato), [analysis.notes]);
  const avgRate = withVibrato.length > 0 ? withVibrato.reduce((a, n) => a + n.rateHz, 0) / withVibrato.length : 0;
  const avgDepth = withVibrato.length > 0 ? withVibrato.reduce((a, n) => a + n.depthCents, 0) / withVibrato.length : 0;
  const top = groups[0];
  const D = VIBRATO_DISPLAY;
  return (
    <>
      {groups.length > 0 ? (
        <>
          <View style={s.vibratoDiagnosisCard}>
            <Text style={s.vibratoHeadline}>{vibratoHeadline(top.fault, top.notes.length, analysis.notes.length)}</Text>
            {withVibrato.length > 0 && (
              <View style={s.stripsBlock}>
                <TargetStrip
                  label="RATE" unit="Hz"
                  axisMin={D.RATE_AXIS_MIN} axisMax={D.RATE_AXIS_MAX}
                  bandLo={D.RATE_TARGET_LO} bandHi={D.RATE_TARGET_HI} value={avgRate}
                />
                <TargetStrip
                  label="DEPTH" unit="¢"
                  axisMin={D.DEPTH_MIN} axisMax={D.DEPTH_TARGET_HI + 8} axisMaxLabel={`${D.DEPTH_TARGET_HI + 8}+`}
                  bandLo={D.DEPTH_TARGET_LO} bandHi={D.DEPTH_TARGET_HI} value={avgDepth}
                />
                <View style={s.stripLegend}>
                  <View style={s.stripLegendDot} />
                  <Text style={s.stripLegendText}>you</Text>
                  <View style={s.stripLegendBand} />
                  <Text style={s.stripLegendText}>target zone</Text>
                </View>
              </View>
            )}
          </View>
          <Text style={s.sectionLabel}>Fix these first</Text>
          {groups.map(group => (
            <VibratoFixGroupCard
              key={group.fault}
              group={group}
              onNotePress={(note, noteIndex) => setDrawer({ note, noteIndex, fault: group.fault })}
            />
          ))}
        </>
      ) : analysis.notes.length > 0 ? (
        <View style={s.observationCard}>
          <Text style={s.observationText}>Vibrato is looking consistent — no significant issues detected.</Text>
        </View>
      ) : null}

      <Modal visible={drawer !== null} transparent animationType="slide" onRequestClose={() => setDrawer(null)}>
        {drawer && (
          <VibratoNoteDrawer
            note={drawer.note}
            noteIndex={drawer.noteIndex}
            issueType={drawer.fault}
            onClose={() => setDrawer(null)}
            onSeek={onTimestampPress}
          />
        )}
      </Modal>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Combined intonation card (accuracy + stability merged per note)
// ─────────────────────────────────────────────────────────────

const STABILITY_FAULT_LABEL: Record<IntonationStabilityNoteResult['faultType'], string> = {
  drift_sharp: 'drifted sharp',
  drift_flat:  'drifted flat',
  scoop:       'scooped in',
  waver:       'wavered',
};

interface CombinedNoteIssue {
  pitchClass: string;
  representativeNoteName: string;
  representativeMidi?: number;
  accuracy?: PitchClassIssue;
  stability?: IntonationStabilityNoteResult;
}

function buildCombinedNoteIssues(
  problemNotes: PitchClassIssue[],
  stabilityAnalysis?: { worstNotes: IntonationStabilityNoteResult[] },
): CombinedNoteIssue[] {
  // Group stability notes by pitch class, keeping the worst (highest drift)
  const stabilityByPC = new Map<string, IntonationStabilityNoteResult>();
  for (const note of stabilityAnalysis?.worstNotes ?? []) {
    const pc = note.noteName.replace(/\d+$/, '');
    const existing = stabilityByPC.get(pc);
    if (!existing || note.driftCents > existing.driftCents) stabilityByPC.set(pc, note);
  }
  const seen = new Set<string>();
  const combined: CombinedNoteIssue[] = [];
  for (const acc of problemNotes) {
    seen.add(acc.pitchClass);
    const nameWithOctave = acc.representativeMidi != null
      ? `${acc.pitchClass.replace(/\d+$/, '')}${Math.floor(acc.representativeMidi / 12) - 1}`
      : acc.pitchClass;
    combined.push({
      pitchClass: acc.pitchClass,
      representativeNoteName: nameWithOctave,
      representativeMidi: acc.representativeMidi,
      accuracy: acc,
      stability: stabilityByPC.get(acc.pitchClass),
    });
  }
  // Stability-only notes not already covered by an accuracy issue
  for (const [pc, stabNote] of stabilityByPC.entries()) {
    if (!seen.has(pc)) combined.push({ pitchClass: pc, representativeNoteName: stabNote.noteName, stability: stabNote });
  }
  return combined.slice(0, 5);
}

function combinedDriftSentence(
  accuracy: PitchClassIssue | undefined,
  stability: IntonationStabilityNoteResult | undefined,
): string | null {
  if (!stability) return null;
  const { faultType } = stability;
  const tend = accuracy?.tendency;

  if (faultType === 'waver') {
    return tend === 'flat' ? 'Averaged flat with unsteady pitch'
         : tend === 'sharp' ? 'Averaged sharp with unsteady pitch'
         : 'Pitch was unsteady within notes';
  }
  if (faultType === 'scoop') {
    return tend === 'flat' ? 'Averaged flat and scooped on entry'
         : tend === 'sharp' ? 'Averaged sharp and scooped on entry'
         : 'Notes scooped up at the start';
  }
  const driftDir = faultType === 'drift_sharp' ? 'sharp' : 'flat';
  if (!tend || tend === 'mixed') {
    return `Note was in tune on average, but drifted ${driftDir}`;
  }
  if (tend === driftDir) {
    return `Averaged ${tend} and drifted ${tend === 'flat' ? 'flatter' : 'sharper'}`;
  }
  return `Averaged ${tend}, but drifted ${driftDir}`;
}

// Compact session-level intonation stats shown above the per-note cards.
function IntonationSummaryHeader({ analysis }: { analysis: IntonationAnalysis }) {
  if (analysis.totalNoteEvents === 0) return null;
  const pctInTune = Math.round(analysis.inTuneRate * 100);
  const tend = analysis.overallTendency;
  const badgeColor = tend === 'neutral' ? 'rgba(255,255,255,0.15)' : tend === 'sharp' ? '#f97316' : '#3b82f6';
  const badgeLabel = tend === 'neutral' ? 'Centered' : `${Math.abs(Math.round(analysis.tendencyCents))}¢ ${tend} overall`;
  return (
    <View style={s.intoSummaryRow}>
      <View style={s.rhythmStat}>
        <Text style={s.rhythmStatValue}>{pctInTune}%</Text>
        <Text style={s.rhythmStatLabel}>in tune</Text>
      </View>
      <View style={[s.tendencyBadge, { backgroundColor: badgeColor }]}>
        <Text style={s.tendencyBadgeText}>{badgeLabel}</Text>
      </View>
      <View style={s.rhythmStat}>
        <Text style={s.rhythmStatValue}>
          {analysis.inTuneCount}
          <Text style={{ fontSize: 14, fontWeight: '600', color: TEXT_MUTED }}>/{analysis.totalNoteEvents}</Text>
        </Text>
        <Text style={s.rhythmStatLabel}>notes</Text>
      </View>
    </View>
  );
}

const INTO_CHART_H = 48;

function CombinedIntonationCard({ issue, videoUri, onSegmentPress, onTune, isPlaying }: {
  issue: CombinedNoteIssue;
  videoUri?: string;
  onSegmentPress?: (start: number, end: number) => void;
  onTune?: (pitchClass: string, midi?: number) => void;
  isPlaying?: boolean;
}) {
  const { accuracy, stability } = issue;
  const { width: screenW } = useWindowDimensions();
  const exampleTs = accuracy?.exampleTimestamps?.[0] ?? (stability ? { startSeconds: stability.startS, endSeconds: stability.endS } : null);

  const tend = accuracy?.tendency ?? 'mixed';
  const tendColor = tend === 'flat' ? '#3b82f6' : tend === 'sharp' ? '#f97316' : TEXT_MUTED;
  const arrow = tend === 'flat' ? '↓' : tend === 'sharp' ? '↑' : '·';
  const absAvg = accuracy ? Math.abs(accuracy.avgDeviationCents) : 0;
  const deviationLabel = accuracy
    ? `${absAvg}¢ ${tend === 'flat' ? 'flat' : tend === 'sharp' ? 'sharp' : 'off pitch'}`
    : null;
  const driftSentence = combinedDriftSentence(accuracy, stability);

  // Mini drift chart: the vibrato-removed center line shows the drift shape.
  // Range adapts to the data — the fixed ±50¢ vibrato range would flatten
  // the 9–17¢ drifts that trigger stability flags.
  const centerCents = stability?.centerCents;
  const hasChart = (centerCents?.length ?? 0) > 1;
  const chartW = screenW - 2 * spacing.lg - 2 * spacing.md - 12;
  let chartEls: React.ReactNode = null;
  if (hasChart && centerCents) {
    const range = Math.max(15, Math.max(...centerCents.map(Math.abs)) * 1.2);
    const centerPath = buildPath(centerCents, chartW, INTO_CHART_H, range);
    const rawPath = (stability!.cents?.length ?? 0) > 1
      ? buildPath(downsample(stability!.cents, Math.floor(chartW / 2)), chartW, INTO_CHART_H, range)
      : '';
    const cy = 4 + (INTO_CHART_H - 8) / 2;
    const lineColor = tend === 'mixed' ? colors.score.needs_attention : tendColor;
    chartEls = (
      <View style={s.intoChartWrap}>
        <Svg width={chartW} height={INTO_CHART_H}>
          <Line x1={0} y1={cy} x2={chartW - 18} y2={cy} stroke="rgba(255,255,255,0.12)" strokeWidth={1} strokeDasharray="4,3" />
          <SvgText x={chartW - 2} y={cy + 3} fontSize={8} fill="rgba(255,255,255,0.45)" textAnchor="end">0¢</SvgText>
          {rawPath ? <Path d={rawPath} stroke="rgba(255,255,255,0.18)" strokeWidth={1} fill="none" /> : null}
          {centerPath ? <Path d={centerPath} stroke={lineColor} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" /> : null}
        </Svg>
      </View>
    );
  }

  return (
    <View style={s.noteCard}>
      <View style={s.noteCardHero}>
        <Text style={[s.noteCardArrow, { color: tendColor }]}>{arrow}</Text>
        <Text style={s.noteCardName}>{issue.representativeNoteName}</Text>
      </View>
      {deviationLabel && (
        <Text style={[s.noteCardTend, { color: tendColor }]}>{deviationLabel}</Text>
      )}
      {driftSentence && (
        <Text style={s.noteCardStat}>{driftSentence}</Text>
      )}
      {chartEls}
      <View style={s.noteCardActions}>
        {videoUri && exampleTs && onSegmentPress && (
          <Pressable style={s.seekBtn} onPress={() => { haptic.light(); onSegmentPress(exampleTs.startSeconds, exampleTs.endSeconds ?? exampleTs.startSeconds + 4); }}>
            <Ionicons name="play" size={13} color="#38bdf8" />
            <Text style={s.seekBtnText}>Play note</Text>
          </Pressable>
        )}
        {onTune && accuracy && (
          <Pressable style={[s.tuneBtn, isPlaying && s.tuneBtnActive]} onPress={() => onTune(issue.pitchClass, issue.representativeMidi)}>
            <Ionicons name="musical-note" size={13} color={isPlaying ? '#fff' : '#38bdf8'} />
            <Text style={[s.tuneBtnText, isPlaying && s.tuneBtnTextActive]}>
              {isPlaying ? 'Stop' : 'Tune this note'}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Tone quality card — rendered on the Tone category page
// ─────────────────────────────────────────────────────────────

const TONE_FAULT_META: Record<Exclude<ToneFault, 'clean'>, { title: string; icon: string }> = {
  scratch:        { title: 'Scratchy / pressed',      icon: 'alert-circle-outline' },
  rasp:           { title: 'Grainy / rough',          icon: 'reorder-three-outline' },
  thin:           { title: 'Thin / airy',             icon: 'cloud-outline' },
  ponticello:     { title: 'Glassy — near bridge',    icon: 'locate-outline' },
  tasto:          { title: 'Dull — near fingerboard', icon: 'locate-outline' },
  whistle:        { title: 'Whistles / squeaks',      icon: 'musical-notes-outline' },
  onset_scratch:  { title: 'Scratchy starts',         icon: 'play-skip-forward-outline' },
  delayed_speech: { title: 'Late-speaking notes',     icon: 'hourglass-outline' },
  decay:          { title: 'Fades at note ends',      icon: 'trending-down-outline' },
  flicker:        { title: 'Uneven pressure',         icon: 'pulse-outline' },
};

// Graph shading: red = pressure/noise faults, amber = contact-point/airy, slate = temporal.
const TONE_EVENT_FILL: Record<string, string> = {
  scratch: 'rgba(239,68,68,0.16)', rasp: 'rgba(239,68,68,0.16)', whistle: 'rgba(239,68,68,0.16)',
  thin: 'rgba(245,158,11,0.16)', ponticello: 'rgba(245,158,11,0.16)', tasto: 'rgba(245,158,11,0.16)',
  onset_scratch: 'rgba(148,163,184,0.14)', delayed_speech: 'rgba(148,163,184,0.14)',
  decay: 'rgba(148,163,184,0.14)', flicker: 'rgba(148,163,184,0.14)',
};

interface ToneFaultGroup {
  fault: Exclude<ToneFault, 'clean'>;
  spans: { startSeconds: number; endSeconds: number }[]; // chronological
  coveredSecs: number;
}

function buildToneFaultGroups(events: TechniqueEvent[]): ToneFaultGroup[] {
  const map = new Map<string, ToneFaultGroup>();
  for (const e of events) {
    const fault = e.type as Exclude<ToneFault, 'clean'>;
    if (!TONE_FAULT_META[fault]) continue;
    if (!map.has(fault)) map.set(fault, { fault, spans: [], coveredSecs: 0 });
    const group = map.get(fault)!;
    group.spans.push({ startSeconds: e.startSeconds, endSeconds: e.endSeconds });
    group.coveredSecs += Math.max(0, e.endSeconds - e.startSeconds);
  }
  for (const group of map.values()) group.spans.sort((a, b) => a.startSeconds - b.startSeconds);
  return [...map.values()].sort((a, b) => b.coveredSecs - a.coveredSecs);
}

const TONE_SPAN_SHOW_COUNT = 2;

function ToneFaultGroupCard({ group, onTimestampPress }: {
  group: ToneFaultGroup;
  onTimestampPress?: (s: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const meta = TONE_FAULT_META[group.fault];
  const copy = TONE_FAULT_COPY[group.fault];
  const tip = copy.cause.charAt(0).toUpperCase() + copy.cause.slice(1);
  const visible = showAll ? group.spans : group.spans.slice(0, TONE_SPAN_SHOW_COUNT);
  const hiddenCount = group.spans.length - TONE_SPAN_SHOW_COUNT;
  return (
    <View style={[s.noteCard, { borderLeftWidth: 3, borderLeftColor: colors.score.needs_attention }]}>
      <View style={s.vibratoIssueHeader}>
        <Ionicons name={meta.icon as any} size={20} color="#f59e0b" />
        <Text style={s.vibratoIssueTitle}>{meta.title}</Text>
        <View style={s.vibratoIssueBadge}>
          <Text style={s.vibratoIssueBadgeText}>{group.spans.length}×</Text>
        </View>
      </View>
      <Text style={s.rhythmFixTip}>{tip}.</Text>
      <View style={s.vibratoIssueNoteList}>
        {visible.map((span, i) => (
          <Pressable
            key={i}
            style={s.vibratoIssueNoteRow}
            onPress={() => { haptic.light(); onTimestampPress?.(span.startSeconds); }}
          >
            <Ionicons name="play" size={13} color="#38bdf8" style={{ marginRight: spacing.sm }} />
            <Text style={s.vibratoIssueNoteLabel}>
              {fmtSecs(span.startSeconds)}–{fmtSecs(span.endSeconds)}
            </Text>
            <Ionicons name="chevron-forward" size={15} color="rgba(255,255,255,0.3)" />
          </Pressable>
        ))}
      </View>
      {!showAll && hiddenCount > 0 && (
        <Pressable onPress={() => { haptic.light(); setShowAll(true); }} style={s.rhythmShowMoreBtn}>
          <Text style={s.rhythmShowMoreText}>Show {hiddenCount} more</Text>
        </Pressable>
      )}
    </View>
  );
}

function ToneCard({ metric, onTimestampPress }: {
  metric: MetricScore;
  onTimestampPress?: (s: number) => void;
}) {
  const { width: screenW } = useWindowDimensions();
  const groups = React.useMemo(() => buildToneFaultGroups(metric.events), [metric.events]);

  // History sessions restore only score + flaggedTimestamps (events/summary are
  // runtime-only) — fall back to the ranked labeled stretches, which do persist.
  if (metric.observationSummary === '') {
    if (metric.flaggedTimestamps.length === 0) return null;
    return (
      <View style={{ gap: spacing.sm }}>
        <Text style={s.sectionLabel}>Stretches to review</Text>
        {metric.flaggedTimestamps.map((ts, i) => (
          <Pressable
            key={i}
            style={[s.rhythmFixCard, { borderLeftColor: colors.score.needs_attention }]}
            onPress={() => { haptic.light(); onTimestampPress?.(ts.startSeconds); }}
          >
            <View style={s.rhythmFixHeader}>
              <Ionicons name="play-circle" size={15} color={colors.score.needs_attention} />
              <Text style={[s.rhythmFixTimestamp, { color: colors.score.needs_attention }]}>
                {fmtSecs(ts.startSeconds)}–{fmtSecs(ts.endSeconds)}
              </Text>
            </View>
            {ts.note ? <Text style={s.rhythmFixTip}>{ts.note}</Text> : null}
          </Pressable>
        ))}
      </View>
    );
  }

  const cleanPct = Math.max(0, 100 - Math.round(metric.occurrenceRate * 100));
  const dominant = groups[0];
  const badgeColor = dominant ? colors.score.needs_attention : colors.score.excellent;
  const badgeLabel = dominant ? TONE_FAULT_META[dominant.fault].title : 'Clean';
  const stretchCount = metric.flaggedTimestamps.length;

  const series = metric.timeSeries;
  const showGraph = (series?.length ?? 0) >= 2;
  const W = screenW - 2 * spacing.lg - 2 * spacing.md;

  return (
    <View style={s.toneCard}>
      <View style={s.rhythmStatsRow}>
        <View style={s.rhythmStat}>
          <Text style={s.rhythmStatValue}>{cleanPct}%</Text>
          <Text style={s.rhythmStatLabel}>clean tone</Text>
        </View>
        <View style={[s.tendencyBadge, { backgroundColor: badgeColor }]}>
          <Text style={s.tendencyBadgeText}>{badgeLabel}</Text>
        </View>
        <View style={s.rhythmStat}>
          <Text style={s.rhythmStatValue}>{stretchCount}</Text>
          <Text style={s.rhythmStatLabel}>{stretchCount === 1 ? 'stretch' : 'stretches'}</Text>
        </View>
      </View>

      {metric.observationSummary ? <Text style={s.rhythmSummary}>{metric.observationSummary}</Text> : null}

      {groups.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <Text style={s.sectionLabel}>Fix these first</Text>
          {groups.map(group => (
            <ToneFaultGroupCard key={group.fault} group={group} onTimestampPress={onTimestampPress} />
          ))}
        </View>
      )}

      {showGraph && (() => {
        const GH = 120;
        const PAD_L = 30, PAD_R = 8, PAD_T = 10, PAD_B = 22;
        const plotW = W - PAD_L - PAD_R;
        const plotH = GH - PAD_T - PAD_B;
        const tMin = series![0].t;
        const tMax = Math.max(series![series!.length - 1].t, tMin + 1);
        const tx = (t: number) => PAD_L + ((t - tMin) / (tMax - tMin)) * plotW;
        const ty = (v: number) => PAD_T + (1 - Math.min(Math.max(v, 0), 100) / 100) * plotH;
        const path = series!
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${tx(p.t).toFixed(1)},${ty(p.v).toFixed(1)}`)
          .join(' ');
        const totalSecs = tMax - tMin;
        const xStep = totalSecs <= 30 ? 10 : totalSecs <= 90 ? 20 : totalSecs <= 180 ? 30 : 60;
        const xLabels: number[] = [];
        for (let t = Math.ceil((tMin + 1) / xStep) * xStep; t <= tMax - 1; t += xStep) xLabels.push(t);
        return (
          <View style={{ marginTop: 8 }}>
            <Text style={{ color: TEXT_MUTED, fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 }}>
              TONE OVER SESSION
            </Text>
            <Svg width={W} height={GH}>
              {[50, 75].map(v => (
                <React.Fragment key={v}>
                  <Line x1={PAD_L} y1={ty(v)} x2={W - PAD_R} y2={ty(v)} stroke="#1e293b" strokeWidth={0.75} />
                  <SvgText x={PAD_L - 4} y={ty(v) + 3.5} fontSize={8} fill="#475569" textAnchor="end">{v}</SvgText>
                </React.Fragment>
              ))}
              {metric.events.map((e, i) => {
                const x0 = tx(Math.max(e.startSeconds, tMin));
                const x1 = tx(Math.min(e.endSeconds, tMax));
                if (x1 <= x0) return null;
                return (
                  <Rect key={i} x={x0} y={PAD_T} width={Math.max(2, x1 - x0)} height={plotH}
                    fill={TONE_EVENT_FILL[e.type] ?? 'rgba(148,163,184,0.12)'} />
                );
              })}
              {xLabels.map(t => (
                <SvgText key={t} x={tx(t)} y={GH - 4} fontSize={8} fill="#475569" textAnchor="middle">
                  {fmtSecs(t)}
                </SvgText>
              ))}
              <Path d={path} stroke={colors.brand[300]} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </View>
        );
      })()}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Volume (dynamics) card — rendered on the Tone category page
// ─────────────────────────────────────────────────────────────

const DYN_EVENT_COLORS: Record<string, { fill: string; stroke: string }> = {
  dyn_narrow_range:    { fill: 'rgba(239,68,68,0.15)',   stroke: 'rgba(239,68,68,0.5)' },
  dyn_inverted_phrase: { fill: 'rgba(239,68,68,0.15)',   stroke: 'rgba(239,68,68,0.5)' },
  dyn_flat_phrase:     { fill: 'rgba(245,158,11,0.15)',  stroke: 'rgba(245,158,11,0.5)' },
  dyn_flat_phrases:    { fill: 'rgba(245,158,11,0.15)',  stroke: 'rgba(245,158,11,0.5)' },
  dyn_peak_early:      { fill: 'rgba(251,191,36,0.15)',  stroke: 'rgba(251,191,36,0.5)' },
  dyn_peak_late:       { fill: 'rgba(251,191,36,0.15)',  stroke: 'rgba(251,191,36,0.5)' },
  dyn_fade_over_session:{ fill: 'rgba(148,163,184,0.12)', stroke: 'rgba(148,163,184,0.4)' },
};

function VolumeCard({ metric, duration, playbackSeconds, onTimestampPress }: {
  metric: MetricScore;
  duration: number;
  playbackSeconds?: number;
  onTimestampPress?: (s: number) => void;
}) {
  const { width: screenW } = useWindowDimensions();
  const WAVEFORM_H = 72;
  // card fills catContent horizontal padding; subtract card's own padding
  const W = screenW - 2 * spacing.lg - 2 * spacing.md;

  const series = metric.timeSeries ?? [];
  const events = metric.events ?? [];
  const timestamps = metric.flaggedTimestamps ?? [];

  // Downsample timeSeries to 1 point per pixel for rendering
  let path = '';
  let idealPath = '';
  if (series.length >= 2) {
    const step = series.length / W;
    const pts: string[] = [];
    for (let i = 0; i < W; i++) {
      const pt = series[Math.min(Math.round(i * step), series.length - 1)];
      if (!pt) continue;
      const y = WAVEFORM_H - 4 - pt.v * (WAVEFORM_H - 10);
      pts.push(`${i === 0 ? 'M' : 'L'}${i.toFixed(1)} ${y.toFixed(1)}`);
    }
    path = pts.join(' ');

    // Build shape-aware ideal overlay using per-phrase classifications from _dynDebug.
    // Each phrase renders a curve matching its detected shape:
    //   arch           → sin(π·t)^0.7 dome
    //   rising         → linear ramp up
    //   falling        → linear ramp down
    //   plateau        → flat line (suggestion at 0.75 of peak)
    //   unclassified   → domed suggestion (drawn at lower opacity)
    //   melodic_contour → no overlay (valid, nothing to suggest)
    const seriesDuration = series.length > 0 ? series[series.length - 1].t : duration;
    const idealVals: number[] = new Array(series.length).fill(0);
    const debugPhrases = metric._dynDebug?.phrases ?? [];

    if (debugPhrases.length > 0) {
      // Use classified phrases from the engine
      for (const p of debugPhrases) {
        if (p.shape === 'melodic_contour') continue; // valid — no suggestion needed
        const iStart = Math.round((p.startSec / seriesDuration) * (series.length - 1));
        const iEnd   = Math.round((p.endSec   / seriesDuration) * (series.length - 1));
        const len = iEnd - iStart;
        if (len < 4) continue;
        let peak = 0;
        for (let j = iStart; j <= iEnd; j++) peak = Math.max(peak, series[j]?.v ?? 0);
        const scale = Math.max(peak, 0.35);
        for (let j = iStart; j <= iEnd; j++) {
          const t = (j - iStart) / Math.max(len, 1);
          switch (p.shape) {
            case 'arch':
            case 'unclassified': idealVals[j] = scale * Math.pow(Math.sin(Math.PI * t), 0.7); break;
            case 'rising':       idealVals[j] = scale * t; break;
            case 'falling':      idealVals[j] = scale * (1 - t); break;
            case 'plateau':      idealVals[j] = scale * 0.75; break;
          }
        }
      }
    } else {
      // Fallback: silence-gate phrase detection → always dome
      const SILENCE = 0.05;
      let phraseStart: number | null = null;
      const fillDome = (from: number, to: number) => {
        const len = to - from;
        if (len < 8) return;
        let peak = 0;
        for (let j = from; j < to; j++) peak = Math.max(peak, series[j]?.v ?? 0);
        const scale = Math.max(peak, 0.35);
        for (let j = from; j < to; j++) {
          const t = (j - from) / Math.max(len - 1, 1);
          idealVals[j] = scale * Math.pow(Math.sin(Math.PI * t), 0.7);
        }
      };
      for (let i = 0; i <= series.length; i++) {
        const v = i < series.length ? series[i].v : 0;
        if (v > SILENCE && phraseStart === null) phraseStart = i;
        else if (v <= SILENCE && phraseStart !== null) { fillDome(phraseStart, i); phraseStart = null; }
      }
      if (phraseStart !== null) fillDome(phraseStart, series.length);
    }

    const idealPts: string[] = [];
    let inIdealPath = false;
    for (let i = 0; i < W; i++) {
      const si = Math.min(Math.round(i * step), idealVals.length - 1);
      const v = idealVals[si];
      if (v <= 0.01) { inIdealPath = false; continue; }
      const y = WAVEFORM_H - 4 - v * (WAVEFORM_H - 10);
      idealPts.push(`${!inIdealPath ? 'M' : 'L'}${i.toFixed(1)} ${y.toFixed(1)}`);
      inIdealPath = true;
    }
    idealPath = idealPts.join(' ');
  }

  const playheadX = duration > 0 && playbackSeconds !== undefined
    ? (Math.min(playbackSeconds, duration) / duration) * W
    : null;

  const isSessionWide = (ts: FlaggedTimestamp) => ts.endSeconds - ts.startSeconds > duration * 0.85;

  return (
    <View style={s.volumeCard}>
      <View style={s.volumeCardHeader}>
        <Text style={s.volumeCardTitle}>Dynamics</Text>
        <View style={[s.volumeScoreBadge, { backgroundColor: scoreColor(metric.score) + '28' }]}>
          <Text style={[s.volumeScoreText, { color: scoreColor(metric.score) }]}>{metric.score}</Text>
        </View>
      </View>

      {series.length >= 2 && (
        <View style={{ marginBottom: spacing.sm }}>
          <Svg width={W} height={WAVEFORM_H}>
            {/* Flagged zones as overlaid rectangles */}
            {events.map((ev, i) => {
              const ts = timestamps[i];
              if (!ts || isSessionWide(ts)) return null;
              const x1 = (ts.startSeconds / duration) * W;
              const x2 = (ts.endSeconds / duration) * W;
              const col = DYN_EVENT_COLORS[ev.type] ?? { fill: 'rgba(100,116,139,0.12)', stroke: 'rgba(100,116,139,0.4)' };
              return (
                <Rect key={i} x={x1} y={0} width={Math.max(3, x2 - x1)} height={WAVEFORM_H}
                  fill={col.fill} stroke={col.stroke} strokeWidth={1} />
              );
            })}
            {/* Ideal phrase-arch overlay */}
            {idealPath.length > 0 && (
              <Path d={idealPath} stroke="rgba(250,204,21,0.5)" strokeWidth={1.5} fill="none" strokeDasharray="6,4" />
            )}
            {/* RMS waveform path */}
            {path.length > 0 && (
              <Path d={path} stroke={colors.brand[300]} strokeWidth={1.5} fill="none" strokeLinecap="round" />
            )}
            {/* Playhead */}
            {playheadX !== null && (
              <Line x1={playheadX} y1={0} x2={playheadX} y2={WAVEFORM_H} stroke="rgba(255,255,255,0.8)" strokeWidth={1.5} />
            )}
          </Svg>
        </View>
      )}

      {timestamps.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          {timestamps.map((ts, i) => {
            const ev = events[i];
            const isWide = isSessionWide(ts);
            return (
              <View key={i} style={s.volumeIssueRow}>
                <Ionicons
                  name={ev?.type === 'dyn_narrow_range' ? 'analytics-outline' : 'volume-medium-outline'}
                  size={14} color="rgba(255,255,255,0.45)"
                />
                <Text style={s.volumeIssueText} numberOfLines={3}>{ts.note}</Text>
                {!isWide && onTimestampPress && (
                  <Pressable style={s.seekBtn} onPress={() => { haptic.light(); onTimestampPress(ts.startSeconds); }}>
                    <Ionicons name="play" size={11} color="#38bdf8" />
                    <Text style={s.seekBtnText}>{fmtSecs(ts.startSeconds)}</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
      ) : (
        <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 19 }}>{metric.observationSummary}</Text>
      )}

      {/* Dev-only debug panel */}
      {__DEV__ && metric._dynDebug && <DynDebugPanel debug={metric._dynDebug} />}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Dynamics debug panel (DEV only)
// ─────────────────────────────────────────────────────────────

function DynDebugPanel({ debug }: { debug: DynDebugInfo }) {
  const [open, setOpen] = useState(false);
  const fmtN = (n: number, d = 3) => n.toFixed(d);
  const fmtS = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return (
    <View style={s.debugPanel}>
      <Pressable style={s.debugPanelHeader} onPress={() => setOpen(o => !o)}>
        <Text style={s.debugPanelTitle}>DEV  dynamics debug</Text>
        <Text style={s.debugPanelChevron}>{open ? '▲' : '▼'}</Text>
      </Pressable>
      {open && (
        <View style={s.debugPanelBody}>
          {/* Session stats row */}
          <Text style={s.debugMono}>
            {`ratio=${fmtN(debug.dynamicRatio, 2)}×  max=${fmtN(debug.maxSlow)}  min=${fmtN(debug.minSlow)}\njitter=${debug.jitterScore}  range=${debug.rangeScore}  shape=${debug.shapeScore}  → ${debug.score}`}
          </Text>
          {/* Phrase table */}
          <Text style={[s.debugMono, { marginTop: 8, color: 'rgba(148,163,184,0.8)' }]}>
            {`FLAT_CV²<0.008  INV_SLOPE<-0.25  PEAK_E<0.28  PEAK_L>0.82`}
          </Text>
          <Text style={[s.debugMono, { marginTop: 6, color: '#94a3b8' }]}>
            {`#   start   end    dur   cv²     slope   peak@  shape             issue`}
          </Text>
          {debug.phrases.map((p, i) => (
            <Text key={i} style={[s.debugMono, { color: p.issue ? '#fbbf24' : p.shape === 'melodic_contour' ? '#a78bfa' : '#6ee7b7' }]}>
              {`${String(i + 1).padStart(2)}  ${fmtS(p.startSec)}  ${fmtS(p.endSec)}  ${fmtN(p.durS, 1)}s  ${fmtN(p.cv2)}  ${fmtN(p.slopeNorm)}  ${fmtN(p.peakPos)}  ${(p.shape ?? '?').padEnd(16)}  ${p.issue ? `${p.issue.replace('dyn_', '')} (${fmtN(p.confidence ?? 0, 2)})` : 'ok'}`}
            </Text>
          ))}
          {debug.phrases.length === 0 && (
            <Text style={[s.debugMono, { color: '#ef4444' }]}>no phrases detected (&lt;3s or all silent)</Text>
          )}
          {/* All issues before filter */}
          {debug.allIssues.length > 0 && (
            <>
              <Text style={[s.debugMono, { marginTop: 8, color: '#94a3b8' }]}>all issues (pre-filter):</Text>
              {debug.allIssues.map((e, i) => (
                <Text key={i} style={[s.debugMono, { color: e.confidence >= 0.3 ? '#f9a8d4' : '#475569' }]}>
                  {`  ${e.type.replace('dyn_', '')}  ${fmtS(e.startSec)}  conf=${fmtN(e.confidence, 2)}${e.confidence < 0.3 ? ' (filtered)' : ''}`}
                </Text>
              ))}
            </>
          )}
          <Text style={[s.debugMono, { marginTop: 6, color: '#38bdf8' }]}>
            {`ranked output (${debug.ranked.length}): ${debug.ranked.map(r => r.type.replace('dyn_', '')).join(', ') || 'none'}`}
          </Text>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Overview page
// ─────────────────────────────────────────────────────────────

function OverviewPage({ result, onTimestampPress }: {
  result: AnalysisResult;
  onTimestampPress?: (s: number) => void;
}) {
  const { scrollRef, showHint, onLayout, onContentSizeChange, onScroll, scrollToEnd } = useScrollHint();
  const catScores = VISIBLE_CATEGORIES.map(c => ({ ...c, score: avgScore(result.metrics, c.keys) }))
    .sort((a, b) => a.score - b.score);
  return (
    <View style={{ flex: 1 }}>
    <ScrollView
      ref={scrollRef}
      style={s.pageScroll}
      contentContainerStyle={s.overviewContent}
      showsVerticalScrollIndicator={false}
      onLayout={onLayout}
      onContentSizeChange={onContentSizeChange}
      onScroll={onScroll}
      scrollEventThrottle={16}
    >
      <View style={s.overviewChart}>
        <RadarChart metrics={result.metrics} />
      </View>
      <View style={s.overviewScore}>
        <Text style={s.overviewScoreNum}>{result.overallScore}</Text>
        <Text style={s.overviewScoreLabel}>Overall Score</Text>
      </View>
      {result.llmFeedback?.overallTake && (
        <View style={s.overviewTake}>
          <Text style={s.overviewTakeText}>{result.llmFeedback.overallTake}</Text>
        </View>
      )}

      {/* Cross-referenced "big picture" — several measured issues tied to one
          underlying cause, grounded against this session's real issue set. */}
      {result.llmFeedback?.rootCauses && result.llmFeedback.rootCauses.length > 0 && (
        <View style={s.rootCausesSection}>
          <Text style={s.findingsTitle}>WHY THIS IS HAPPENING</Text>
          {result.llmFeedback.rootCauses.map(cause => (
            <View key={cause.id} style={s.rootCauseCard}>
              <Text style={s.rootCauseTitle}>{cause.label}</Text>
              <Text style={s.rootCauseBody}>{cause.explanation}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={s.overviewCatList}>
        {catScores.map(cat => (
          <View key={cat.id} style={s.overviewCatRow}>
            <View style={s.overviewCatIcon}><CatIcon id={cat.id} size={18} color={colors.brand[300]} /></View>
            <Text style={s.overviewCatLabel}>{cat.label}</Text>
            <View style={s.overviewBarTrack}>
              <View style={[s.overviewBarFill, { width: `${cat.score}%`, backgroundColor: scoreColor(cat.score) }]} />
            </View>
            <Text style={[s.overviewCatScore, { color: scoreColor(cat.score) }]}>{cat.score}</Text>
          </View>
        ))}
      </View>

      {/* L8: statistical patterns detected across the whole session */}
      {result.patternFindings && result.patternFindings.length > 0 && (
        <View style={s.findingsSection}>
          <Text style={s.findingsTitle}>PATTERNS DETECTED</Text>
          {result.patternFindings.map(f => (
            <View key={f.testId} style={s.findingRow}>
              <View
                style={[
                  s.findingDot,
                  {
                    backgroundColor:
                      f.severity === 'significant' ? colors.score.critical
                      : f.severity === 'moderate' ? colors.score.needs_attention
                      : colors.score.good,
                  },
                ]}
              />
              <Text style={s.findingText}>{f.summary}</Text>
            </View>
          ))}
        </View>
      )}

      {/* L7, grounded — per-phrase musical notes; tap seeks the video to that phrase. */}
      {result.llmFeedback?.phraseFeedback && result.llmFeedback.phraseFeedback.length > 0 && (
        <View style={s.phraseFeedbackSection}>
          <Text style={s.findingsTitle}>PHRASE NOTES</Text>
          {result.llmFeedback.phraseFeedback.map(pf => {
            // Prefer the phrase we still hold; fall back to the time the model
            // echoed back, so a session re-opened from history (which has no
            // phraseFeatures) still seeks correctly.
            const phrase = result.phraseFeatures?.find(p => p.id === pf.phraseId);
            const seekTo = phrase?.start_t ?? pf.start_t;
            return (
              <Pressable
                key={pf.phraseId}
                style={s.phraseFeedbackRow}
                onPress={seekTo !== undefined ? () => onTimestampPress?.(seekTo) : undefined}
              >
                <Text style={s.phraseFeedbackObs}>{pf.observation}</Text>
                <Text style={s.phraseFeedbackTip}>{pf.tip}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
    {showHint && <ScrollHintButton onPress={scrollToEnd} />}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Rhythm card
// ─────────────────────────────────────────────────────────────

const RUSH_COLOR = '#ef4444';
const DRAG_COLOR = '#3b82f6';
const GRID_COLOR = '#22c55e';

function RhythmCard({ analysis, onTimestampPress }: {
  analysis: RhythmAnalysis;
  onTimestampPress?: (s: number) => void;
}) {
  const { width: screenW } = useWindowDimensions();
  const W = screenW - 2 * spacing.lg - 2 * spacing.md;
  const [showAllFixes, setShowAllFixes] = useState(false);

  const tendencyLabel = analysis.tendency === 'rushing' ? 'Rushing' : analysis.tendency === 'dragging' ? 'Dragging' : 'Steady';
  const tendencyColor = analysis.tendency === 'rushing' ? RUSH_COLOR : analysis.tendency === 'dragging' ? DRAG_COLOR : GRID_COLOR;

  const showGraph = analysis.localBeatPeriods.length >= 3 && !analysis.isRubato;
  const periods = analysis.localBeatPeriods;
  const timestamps = analysis.localBeatTimestamps;
  const bpms = periods.map(p => 60 / Math.max(p, 0.001));
  const refBpm = analysis.bpmEst;
  const yMin = Math.floor(refBpm * 0.75);
  const yMax = Math.ceil(refBpm * 1.25);

  const GH = 120;
  const PAD_L = 34, PAD_R = 8, PAD_T = 10, PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = GH - PAD_T - PAD_B;
  const tMin = timestamps[0] ?? 0;
  const tMax = Math.max(timestamps[timestamps.length - 1] ?? 1, tMin + 1);
  const tx = (t: number) => PAD_L + ((t - tMin) / (tMax - tMin)) * plotW;
  const ty = (bpm: number) => PAD_T + (1 - (Math.min(Math.max(bpm, yMin), yMax) - yMin) / (yMax - yMin)) * plotH;

  const driftPath = showGraph
    ? bpms.map((bpm, i) => `${i === 0 ? 'M' : 'L'}${tx(timestamps[i]).toFixed(1)},${ty(bpm).toFixed(1)}`).join(' ')
    : '';

  const totalSecs = tMax - tMin;
  const xStep = totalSecs <= 30 ? 10 : totalSecs <= 90 ? 20 : totalSecs <= 180 ? 30 : 60;
  const xLabels: number[] = [];
  for (let t = Math.ceil((tMin + 1) / xStep) * xStep; t <= tMax - 1; t += xStep) xLabels.push(t);
  const yGridBpms = Array.from(new Set([yMin, refBpm, yMax]));

  // Detect sustained ritardandos / accelerandos from the drift curve
  type TempoTrend = { kind: 'rit' | 'accel'; startSec: number; endSec: number };
  const trends: TempoTrend[] = [];
  if (showGraph && periods.length >= 3) {
    let runDir: 'rit' | 'accel' | null = null;
    let runStart = 0;
    const flush = (endIdx: number) => {
      if (runDir && endIdx - runStart >= 3) {
        trends.push({ kind: runDir, startSec: timestamps[runStart], endSec: timestamps[endIdx - 1] });
      }
    };
    for (let i = 1; i < periods.length; i++) {
      const dir: 'rit' | 'accel' | null = periods[i] > periods[i - 1] * 1.025 ? 'rit' : periods[i] < periods[i - 1] * 0.975 ? 'accel' : null;
      if (dir !== runDir) { flush(i); runDir = dir; runStart = i - 1; }
    }
    flush(periods.length);
  }

  // Natural-language summary of where problems cluster
  const totalFlagged = analysis.flaggedRegions.length;
  let summaryText = '';
  if (!analysis.isRubato) {
    let clusterText = '';
    if (totalFlagged >= 2 && timestamps.length >= 2) {
      const mid = (tMin + tMax) / 2;
      const inFirst = analysis.flaggedRegions.filter(r => r.startSeconds < mid).length;
      const inSecond = totalFlagged - inFirst;
      if (inFirst > inSecond * 1.5) clusterText = ' — mostly in the first half';
      else if (inSecond > inFirst * 1.5) clusterText = ' — getting worse toward the end';
    }
    const { tendency, rushCount, dragCount } = analysis;
    if (tendency === 'rushing') {
      summaryText = `You rushed the beat ${rushCount} time${rushCount !== 1 ? 's' : ''}${clusterText}.`;
    } else if (tendency === 'dragging') {
      summaryText = `You dragged the beat ${dragCount} time${dragCount !== 1 ? 's' : ''}${clusterText}.`;
    } else if (totalFlagged > 0) {
      summaryText = `Your timing had ${totalFlagged} unsteady moment${totalFlagged !== 1 ? 's' : ''}${clusterText}.`;
    } else {
      summaryText = 'Your timing was steady throughout — no significant issues detected.';
    }
  }

  // Fix cards sorted by severity (worst first)
  const sortedFixes = [...analysis.flaggedRegions].sort((a, b) => b.deviationPct - a.deviationPct);
  const SHOW_COUNT = 3;
  const visibleFixes = showAllFixes ? sortedFixes : sortedFixes.slice(0, SHOW_COUNT);
  const hiddenCount = sortedFixes.length - SHOW_COUNT;

  return (
    <View style={s.rhythmCard}>
      {/* Stats row: only shown when we have real beat data */}
      {!analysis.isRubato && (
        <View style={s.rhythmStatsRow}>
          <View style={s.rhythmStat}>
            <Text style={s.rhythmStatValue}>{analysis.bpmEst > 0 ? analysis.bpmEst : '–'}</Text>
            <Text style={s.rhythmStatLabel}>BPM</Text>
          </View>
          <View style={[s.tendencyBadge, { backgroundColor: tendencyColor }]}>
            <Text style={s.tendencyBadgeText}>{tendencyLabel}</Text>
          </View>
          <View style={s.rhythmStat}>
            <Text style={s.rhythmStatValue}>
              {analysis.onGridCount}
              <Text style={{ fontSize: 14, fontWeight: '600', color: TEXT_MUTED }}>/{analysis.totalNotes}</Text>
            </Text>
            <Text style={s.rhythmStatLabel}>on beat</Text>
          </View>
        </View>
      )}

      {/* Plain-language summary */}
      {summaryText ? <Text style={s.rhythmSummary}>{summaryText}</Text> : null}

      {/* Unsteady tempo explanation — plain language, no jargon */}
      {analysis.isRubato && (
        <View style={s.rubatoCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Ionicons name="pulse-outline" size={18} color={TEXT_MUTED} />
            <Text style={s.rubatoTitle}>Tempo too unsteady to measure</Text>
          </View>
          <Text style={s.rubatoText}>
            Your note timing was too inconsistent for us to lock onto a steady beat. Try playing with a more even pulse — keeping your bow strokes consistent in length and speed helps a lot.
          </Text>
        </View>
      )}

      {/* Ranked fix cards */}
      {sortedFixes.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <Text style={s.sectionLabel}>Fix these first</Text>
          {visibleFixes.map((r, i) => {
            const accentColor = r.direction === 'rushed' ? RUSH_COLOR : DRAG_COLOR;
            const severityLabel = r.direction === 'rushed'
              ? `Rushed ${Math.round(r.deviationPct)}% too fast`
              : `Dragged ${Math.round(r.deviationPct)}% too slow`;
            let tip: string;
            if (r.direction === 'rushed') {
              tip = r.deviationPct > 25
                ? 'Major rush — count carefully and practice this spot with a metronome.'
                : r.deviationPct > 15
                ? 'Significant rush — subdivide the beat mentally before this note.'
                : 'Slight rush — stay connected to the underlying pulse here.';
            } else {
              tip = r.deviationPct > 25
                ? 'Major slowdown — practice this passage up to tempo with a metronome.'
                : r.deviationPct > 15
                ? 'Noticeable drag — actively count eighth notes through this beat.'
                : 'Slight drag — keep the bow moving forward with intention.';
            }
            return (
              <Pressable
                key={i}
                style={[s.rhythmFixCard, { borderLeftColor: accentColor }]}
                onPress={() => { haptic.light(); onTimestampPress?.(r.startSeconds); }}
              >
                <View style={s.rhythmFixHeader}>
                  <Ionicons name="play-circle" size={15} color={accentColor} />
                  <Text style={[s.rhythmFixTimestamp, { color: accentColor }]}>{fmtSecs(r.startSeconds)}</Text>
                  <Text style={s.rhythmFixSeverity}>{severityLabel}</Text>
                </View>
                <Text style={s.rhythmFixTip}>{tip}</Text>
              </Pressable>
            );
          })}
          {!showAllFixes && hiddenCount > 0 && (
            <Pressable onPress={() => { haptic.light(); setShowAllFixes(true); }} style={s.rhythmShowMoreBtn}>
              <Text style={s.rhythmShowMoreText}>Show {hiddenCount} more</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Tempo drift graph */}
      {showGraph && (
        <View style={{ marginTop: 8 }}>
          <Text style={{ color: TEXT_MUTED, fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8 }}>
            TEMPO OVER SESSION
          </Text>
          <Svg width={W} height={GH}>
            {yGridBpms.map(bpm => (
              <React.Fragment key={bpm}>
                <Line
                  x1={PAD_L} y1={ty(bpm)} x2={W - PAD_R} y2={ty(bpm)}
                  stroke={bpm === refBpm ? 'rgba(100,220,150,0.4)' : '#1e293b'}
                  strokeWidth={bpm === refBpm ? 1 : 0.75}
                  strokeDasharray={bpm === refBpm ? '4,3' : undefined}
                />
                <SvgText x={PAD_L - 4} y={ty(bpm) + 3.5} fontSize={8} fill={bpm === refBpm ? 'rgba(100,220,150,0.8)' : '#475569'} textAnchor="end">
                  {bpm}
                </SvgText>
              </React.Fragment>
            ))}
            {xLabels.map(t => (
              <SvgText key={t} x={tx(t)} y={GH - 4} fontSize={8} fill="#475569" textAnchor="middle">
                {fmtSecs(t)}
              </SvgText>
            ))}
            <Path d={driftPath} stroke={colors.brand[300]} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            {trends.map((tr, i) => (
              <SvgText
                key={i}
                x={(tx(tr.startSec) + tx(tr.endSec)) / 2}
                y={tr.kind === 'rit' ? PAD_T + 10 : GH - PAD_B - 4}
                fontSize={8}
                fill="#94a3b8"
                textAnchor="middle"
              >
                {tr.kind === 'rit' ? 'rit.?' : 'accel.?'}
              </SvgText>
            ))}
          </Svg>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Category page
// ─────────────────────────────────────────────────────────────

function CategoryPage({
  catId, result, onTimestampPress, onSegmentPress, playbackSeconds,
}: {
  catId: CategoryId; result: AnalysisResult; onTimestampPress: (s: number) => void; onSegmentPress?: (start: number, end: number) => void; playbackSeconds?: number;
}) {
  const cat = CATEGORIES.find(c => c.id === catId)!;
  const catMetrics = cat.keys.map(k => result.metrics.find(m => m.key === k)).filter(Boolean) as MetricScore[];
  const score = avgScore(result.metrics, cat.keys);
const { scrollRef, showHint, onLayout, onContentSizeChange, onScroll, scrollToEnd } = useScrollHint();
  const { playingNote, toggle, stopAll } = useTuneNote();
  const [tunePanelNote, setTunePanelNote] = useState<string | null>(null);
  const [tunePanelMidi, setTunePanelMidi] = useState<number | undefined>(undefined);

  useEffect(() => () => { stopAll(); }, []);

  const openTune = (pitchClass: string, midi?: number) => {
    setTunePanelNote(pitchClass); setTunePanelMidi(midi); toggle(pitchClass, midi);
  };
  const closeTune = () => { stopAll(); setTunePanelNote(null); setTunePanelMidi(undefined); };

  // Exclude dynamicControl from the generic timestamp chips on the tone page —
  // VolumeCard renders those with richer context.
  const allTimestamps: (FlaggedTimestamp & { metricKey: string })[] = catMetrics
    .filter(m => !(catId === 'dynamics' && m.key === 'dynamicControl'))
    .flatMap(m => m.flaggedTimestamps.map(t => ({ ...t, metricKey: m.key })))
    .sort((a, b) => a.startSeconds - b.startSeconds).slice(0, 12);

  // Pre-find dynamicControl metric for the tone page VolumeCard
  const dynControlMetric = catId === 'dynamics' ? catMetrics.find(m => m.key === 'dynamicControl') : undefined;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={scrollRef}
        style={s.pageScroll}
        contentContainerStyle={s.catContent}
        showsVerticalScrollIndicator={false}
        onLayout={onLayout}
        onContentSizeChange={onContentSizeChange}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/* Metric bars */}
        <View style={s.catMetricList}>
          {catMetrics.map(m => (
            <View key={m.key} style={s.catMetricRow}>
              <Text style={s.catMetricLabel}>{METRIC_LABELS[m.key] ?? m.key}</Text>
              <View style={s.catMetricBarTrack}>
                {m.measurementQuality !== 'unavailable' && (
                  <View style={[s.catMetricBarFill, { width: `${m.score}%`, backgroundColor: scoreColor(m.score) }]} />
                )}
              </View>
              {m.measurementQuality === 'unavailable' ? (
                <Text style={[s.catMetricScore, { color: TEXT_SECONDARY }]}>–</Text>
              ) : (
                <Text style={[s.catMetricScore, { color: scoreColor(m.score) }]}>{m.score}</Text>
              )}
            </View>
          ))}
        </View>

        {/* Tone quality: diagnosis card (stats + fault groups + tone-over-time graph) */}
        {catId === 'tone' && (() => {
          const tq = catMetrics.find(m => m.key === 'toneQuality');
          if (!tq) return null;
          return <ToneCard metric={tq} onTimestampPress={onTimestampPress} />;
        })()}

        {/* Bow technique: detector-derived observations + position graph */}
        {catId === 'bow' && (() => {
          const lines = catMetrics
            .filter(m => m.measurementQuality !== 'unavailable' && m.observationSummary && m.key !== 'bowSmoothness')
            .map(m => m.observationSummary);
          const bowDist = catMetrics.find(m => m.key === 'bowDistribution');
          return (
            <>
              {lines.length > 0 && (
                <View style={s.observationCard}>
                  {lines.map((line, i) => (
                    <Text key={i} style={[s.observationText, i > 0 && { marginTop: 6 }]}>{line}</Text>
                  ))}
                </View>
              )}
              {bowDist?.timeSeries && (
                <BowPositionGraph metric={bowDist} onTimestampPress={onTimestampPress} />
              )}
            </>
          );
        })()}

        {/* Posture-specific: wrist angle graph + debug graphs */}
        {catId === 'posture' && (() => {
          const wristMetric = catMetrics.find(m => m.key === 'leftHandWrist');
          if (!wristMetric?.timeSeries) return null;
          return (
            <>
              <WristAngleGraph metric={wristMetric} duration={result.durationSeconds} onTimestampPress={onTimestampPress} />
              <WristDebugGraphs metric={wristMetric} />
            </>
          );
        })()}

        {/* Intonation-specific: session summary + combined accuracy/stability note cards */}
        {catId === 'intonation' && result.intonationAnalysis && (() => {
          const combined = buildCombinedNoteIssues(
            result.intonationAnalysis.problemNotes,
            result.intonationStabilityAnalysis,
          );
          return (
            <>
              <IntonationSummaryHeader analysis={result.intonationAnalysis} />
              {combined.length > 0 && (
                <>
                  <Text style={s.vibratoSectionLabel}>Notes to work on</Text>
                  {combined.map(issue => (
                    <CombinedIntonationCard
                      key={issue.pitchClass}
                      issue={issue}
                      videoUri={result.videoUri}
                      onSegmentPress={onSegmentPress}
                      onTune={openTune}
                      isPlaying={playingNote === issue.pitchClass}
                    />
                  ))}
                </>
              )}
            </>
          );
        })()}

        {/* Vibrato-specific: issue cards with per-note drawer */}
        {catId === 'vibrato' && result.vibratoAnalysis && (
          <VibratoSection analysis={result.vibratoAnalysis} onTimestampPress={onTimestampPress} />
        )}

        {/* Dynamics page: volume card */}
        {dynControlMetric && (
          <VolumeCard metric={dynControlMetric} duration={result.durationSeconds} playbackSeconds={playbackSeconds} onTimestampPress={onTimestampPress} />
        )}

        {/* Rhythm page: rich rhythm card */}
        {catId === 'rhythm' && result.rhythmAnalysis && (
          <RhythmCard analysis={result.rhythmAnalysis} onTimestampPress={onTimestampPress} />
        )}

        {/* Generic timestamp chips (categories without a dedicated rich card) */}
        {catId !== 'intonation' && catId !== 'vibrato' && catId !== 'rhythm' && catId !== 'tone' && allTimestamps.length > 0 && (
          <View style={s.timestampSection}>
            <Text style={s.vibratoSectionLabel}>Moments to review</Text>
            <View style={s.timestampChips}>
              {allTimestamps.map((ts, i) => (
                <Pressable key={i} style={s.timestampChip}
                  onPress={() => { haptic.light(); onTimestampPress(ts.startSeconds); }}>
                  <Ionicons name="play" size={11} color="#38bdf8" />
                  <Text style={s.timestampChipText}>{fmtSecs(ts.startSeconds)}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {showHint && <ScrollHintButton onPress={scrollToEnd} />}

      {/* Tune panel modal */}
      <Modal visible={tunePanelNote !== null} transparent animationType="slide" onRequestClose={closeTune}>
        {tunePanelNote !== null && (
          <TunePracticePanel
            pitchClass={tunePanelNote} midiNote={tunePanelMidi}
            isPlaying={playingNote === tunePanelNote}
            onToggle={() => toggle(tunePanelNote, tunePanelMidi)}
            onClose={closeTune}
          />
        )}
      </Modal>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Chat page
// ─────────────────────────────────────────────────────────────

/**
 * The carousel's chat used to be `buildChatReply` — a regex rule engine that
 * never called the model, while the locked-state copy on this very page sold it
 * as "personalised coaching from Claude". It also had a different view of the
 * student than the standalone chat screen.
 *
 * Both now call the same Edge Function with the same CoachContext, so there is
 * one coach with one memory regardless of where the student opens it.
 */
interface ChatMessage { role: 'coach' | 'user'; text: string; }

function ChatPage({ result }: { result: AnalysisResult }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'coach', text: `I've analyzed your session — score ${result.overallScore}/100. Ask me anything about your playing, what to practice, or specific categories.` },
  ]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const coachContext = useCoachContext();

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;

    const next: ChatMessage[] = [...messages, { role: 'user', text }];
    setMessages(next);
    setDraft('');
    setSending(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    track(AnalyticsEvent.CHAT_MESSAGE_SENT, {
      surface: 'results_carousel',
      turn_index: next.filter((m) => m.role === 'user').length,
    });

    try {
      // Drop the opening greeting — it's UI copy, not conversation.
      const history = next.slice(1).map((m) => ({
        role: m.role === 'coach' ? ('assistant' as const) : ('user' as const),
        content: m.text,
      }));
      const reply = await fetchChatReply(history, coachContext, result.sessionId);
      setMessages((prev) => [...prev, { role: 'coach', text: reply }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'coach',
          text:
            err instanceof EntitlementRequiredError
              ? 'Chat coaching is a Pro feature — upgrade to keep talking through your sessions.'
              : 'Something went wrong reaching your coach. Give it another try.',
        },
      ]);
      if (!(err instanceof EntitlementRequiredError)) {
        track(AnalyticsEvent.APP_ERROR, { domain: 'chat', reason: errorReason(err) });
      }
    } finally {
      setSending(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={{ flex: 1 }}>
        <ScrollView ref={scrollRef} style={s.chatScroll} contentContainerStyle={s.chatContent} showsVerticalScrollIndicator={false}>
          {messages.length === 1 && (
            <View style={s.chatSuggestions}>
              {['What should I practice?', 'How was my intonation?', 'How was my bow technique?', 'How am I progressing?'].map(q => (
                <Pressable key={q} style={s.chatChip} onPress={() => setDraft(q)}>
                  <Text style={s.chatChipText}>{q}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {messages.map((msg, i) => (
            <View key={i} style={[s.chatBubble, msg.role === 'user' ? s.chatBubbleUser : s.chatBubbleCoach]}>
              {msg.role === 'user' ? (
                <Text style={[s.chatBubbleText, s.chatBubbleTextUser]}>{msg.text}</Text>
              ) : (
                <MarkdownText style={[s.chatBubbleText, s.chatBubbleTextCoach]}>{msg.text}</MarkdownText>
              )}
            </View>
          ))}
        </ScrollView>
        {sending && (
          <View style={s.chatBubble}>
            <ActivityIndicator size="small" color={colors.brand[300]} />
          </View>
        )}
        <View style={s.chatInputRow}>
          <TextInput style={s.chatInput} value={draft} onChangeText={setDraft}
            placeholder="Ask about your session…" placeholderTextColor={colors.text.muted}
            editable={!sending}
            onSubmitEditing={send} returnKeyType="send" />
          <Pressable
            style={[s.chatSendBtn, (!draft.trim() || sending) && s.chatSendBtnOff]}
            onPress={send}
            disabled={!draft.trim() || sending}
          >
            <Ionicons name="send" size={18} color={draft.trim() ? '#fff' : 'rgba(255,255,255,0.4)'} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────────
// Page renderer — title strip lives here so it slides with content
// ─────────────────────────────────────────────────────────────

// PageContent owns the title, video player, and seek state so everything
// slides naturally with the page.
function PageContent({ idx, result, isActive }: {
  idx: number; result: AnalysisResult; isActive: boolean;
}) {
  const { top } = useSafeAreaInsets();
  const pageId = PAGES[idx];
  const cat = CATEGORIES.find(c => c.id === pageId);
  const hasVideoSlot = pageId !== 'celebration' && pageId !== 'chat';
  const showVideo = !!result.videoUri && hasVideoSlot;
  // The activation sample analysis has no recording behind it. Rather than
  // silently dropping the player (and quietly reflowing every card), show what
  // the user is missing at the exact moment they can see what it would buy them.
  const showVideoPlaceholder = !result.videoUri && !!result.isDemo && hasVideoSlot;
  // All ten pages are mounted at once, so only the page the coachmark points at
  // may claim the id — otherwise an off-screen copy overwrites the rect.
  const videoSpotlight = useSpotlightTarget(idx === OVERVIEW_PAGE_INDEX ? 'carousel.video' : null);
  const scoreSpotlight = useSpotlightTarget(idx === OVERVIEW_PAGE_INDEX ? 'carousel.score' : null);

  const pageTitle =
    pageId === 'celebration' ? 'Results' :
    pageId === 'overview'    ? 'Summary' :
    pageId === 'chat'        ? 'Ask Maestro' :
    pageId === 'moments'     ? 'Problem spots' :
    (cat?.label ?? '');

  const pageScore: number | null =
    // Problem spots is a list of places, not a graded category — a score in the
    // header would invite reading it as "how bad were the bad bits".
    pageId === 'celebration' || pageId === 'chat' || pageId === 'moments' ? null :
    pageId === 'overview' ? result.overallScore :
    cat ? avgScore(result.metrics, cat.keys) : null;

  const [seekVersion, setSeekVersion] = useState(0);
  const [seekSeconds, setSeekSeconds] = useState(0);
  const [seekEndSeconds, setSeekEndSeconds] = useState<number | undefined>(undefined);
  const [playbackSeconds, setPlaybackSeconds] = useState(0);
  const handleTimestampPress = useCallback((s: number) => {
    setSeekEndSeconds(undefined);
    setSeekSeconds(s + 0.03);
    setSeekVersion(v => v + 1);
  }, []);
  const handleSegmentPress = useCallback((start: number, end: number) => {
    setSeekEndSeconds(end);
    setSeekSeconds(start);
    setSeekVersion(v => v + 1);
  }, []);
  const handleTimeUpdate = useCallback((s: number) => setPlaybackSeconds(s), []);

  return (
    <View style={{ flex: 1 }}>
      {/* Title strip — slides with this page; paddingTop aligns with the absolute home button */}
      <View style={[s.slideTitleRow, { paddingTop: top + 8 }]}>
        <Text style={s.pageTitle}>{pageTitle}</Text>
        {pageScore !== null && (
          <View {...scoreSpotlight}>
            <Text style={[s.pageTitleScore, { color: scoreColor(pageScore) }]}>{pageScore}</Text>
          </View>
        )}
      </View>
      {showVideoPlaceholder && (
        <View style={s.videoWrapper} {...videoSpotlight}>
          <DemoVideoPlaceholder />
        </View>
      )}
      {showVideo && (
        <View style={s.videoWrapper} {...videoSpotlight}>
          <InlineVideoPlayer
            uri={result.videoUri!}
            seekVersion={seekVersion}
            seekSeconds={seekSeconds}
            seekEndSeconds={seekEndSeconds}
            noteEvents={result.noteEvents}
            durationSeconds={result.durationSeconds}
            onMarkerPress={handleTimestampPress}
            onTimeUpdate={handleTimeUpdate}
            active={isActive}
          />
        </View>
      )}
      {pageId === 'celebration' && <CelebrationPage result={result} />}
      {pageId === 'overview' && <OverviewPage result={result} onTimestampPress={handleTimestampPress} />}
      {cat && <CategoryPage catId={cat.id} result={result} onTimestampPress={handleTimestampPress} onSegmentPress={handleSegmentPress} playbackSeconds={playbackSeconds} />}
      {pageId === 'moments' && <ProblemSpotsPage result={result} onSegmentPress={handleSegmentPress} />}
      {pageId === 'chat' && <ChatPage result={result} />}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Animated dot indicator
// ─────────────────────────────────────────────────────────────

function AnimatedDot({ active, onPress }: { active: boolean; onPress: () => void }) {
  const progress = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(active ? 1 : 0, { duration: 150 });
  }, [active]);

  const animStyle = useAnimatedStyle(() => ({
    width: 6 + progress.value * 12,
    backgroundColor: interpolateColor(progress.value, [0, 1], ['rgba(255,255,255,0.25)', '#ffffff']),
  }));

  return (
    <Pressable onPress={onPress} hitSlop={10}>
      <Animated.View style={[s.dot, animStyle]} />
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────
// Nav button with press animation
// ─────────────────────────────────────────────────────────────

const NAV_BTN_H = 38;
const NAV_DEPTH = 4;
const SCROLL_HINT_SIZE = 54;
const SCROLL_HINT_DEPTH = 4;

function NavButton({ label, onPress, disabled, variant }: {
  label: string; onPress: () => void; disabled: boolean; variant: 'back' | 'next';
}) {
  const offset = useSharedValue(0);
  const surfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  return (
    <Pressable
      onPressIn={() => { offset.value = withTiming(NAV_DEPTH, { duration: 60 }); haptic.light(); }}
      onPressOut={() => { offset.value = withTiming(0, { duration: 100 }); }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={12}
      style={[s.navBtnOuter, disabled && s.navBtnDisabled]}
    >
      <View style={[s.navBtnBase, variant === 'next' ? s.navBtnBaseNext : s.navBtnBaseBack]} />
      <Animated.View style={[s.navBtnSurface, variant === 'next' ? s.navBtnSurfaceNext : s.navBtnSurfaceBack, surfaceStyle]}>
        <Text style={[s.navBtnText, variant === 'next' ? s.navBtnTextNext : s.navBtnTextBack]}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────
// Scroll hint button + hook
// ─────────────────────────────────────────────────────────────

function ScrollHintButton({ onPress }: { onPress: () => void }) {
  const offset = useSharedValue(0);
  const surfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));
  return (
    <Pressable
      style={s.scrollHintOuter}
      onPressIn={() => { offset.value = withTiming(SCROLL_HINT_DEPTH, { duration: 60 }); haptic.light(); }}
      onPressOut={() => { offset.value = withTiming(0, { duration: 100 }); }}
      onPress={onPress}
      hitSlop={10}
    >
      <View style={s.scrollHintBase} />
      <Animated.View style={[s.scrollHintSurface, surfaceStyle]}>
        <Ionicons name="chevron-down" size={22} color="#fff" />
      </Animated.View>
    </Pressable>
  );
}

function useScrollHint() {
  const scrollRef = useRef<ScrollView>(null);
  const [showHint, setShowHint] = useState(false);
  const containerHeightRef = useRef(0);

  const onLayout = useCallback((e: any) => {
    containerHeightRef.current = e.nativeEvent.layout.height;
  }, []);

  const onContentSizeChange = useCallback((_: number, h: number) => {
    setShowHint(h > containerHeightRef.current + 30);
  }, []);

  const onScroll = useCallback((e: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 60) {
      setShowHint(false);
    }
  }, []);

  const scrollToEnd = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  return { scrollRef, showHint, onLayout, onContentSizeChange, onScroll, scrollToEnd };
}

// ─────────────────────────────────────────────────────────────
// Main carousel
// ─────────────────────────────────────────────────────────────

export interface ResultsCarouselProps {
  result: AnalysisResult;
  /** Forward action — opens the post-session curated exercises. */
  onDone: () => void;
  /** Exit action — leaves the results and returns to the home tab. */
  onHome: () => void;
}

export function ResultsCarousel({ result, onDone, onHome }: ResultsCarouselProps) {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();

  const [pageIdx, setPageIdx] = useState(0);
  const pageIdxRef = useRef(0);
  const carouselScrollRef = useRef<ScrollView>(null);
  // How far into the results someone actually got, and how long they stayed.
  // Depth is the engagement signal here — a score glanced at and dismissed is a
  // very different session from one where every category page was read.
  const maxPageRef = useRef(0);
  const openedAtRef = useRef(Date.now());

  useEffect(() => {
    openedAtRef.current = Date.now();
    track(AnalyticsEvent.RESULTS_VIEWED, {
      is_demo: !!result.isDemo,
      overall_score: result.overallScore,
      has_coaching: !!result.llmFeedback,
    });
  }, [result.sessionId]);

  const exitResults = (via: 'done' | 'home') => {
    track(AnalyticsEvent.RESULTS_EXIT, {
      via,
      max_page_reached: maxPageRef.current,
      page_count: PAGES.length,
      ms_on_results: Date.now() - openedAtRef.current,
      is_demo: !!result.isDemo,
    });
  };

  // Activation stage 4: walk the user through this screen with coachmarks.
  const activationStep = useActivationStore((st) => st.step);
  const coachmarksActive = activationStep === 'carousel';
  const coach = useCoachmarks(CAROUSEL_COACHMARKS, coachmarksActive, () => {
    // Take them into the exercises rather than closing the overlay and hoping
    // they find the Practice button — that hand-off is exactly where a guided
    // flow loses people.
    useActivationStore.getState().advanceTo('practice');
    exitResults('done');
    onDone();
  });
  const dotsSpotlight = useSpotlightTarget('carousel.dots');
  const nextSpotlight = useSpotlightTarget('carousel.next');

  const updatePage = (page: number) => {
    if (page === pageIdxRef.current || page < 0 || page >= PAGES.length) return;
    setPageIdx(page);
    pageIdxRef.current = page;
    if (page > maxPageRef.current) maxPageRef.current = page;
    track(AnalyticsEvent.RESULTS_PAGE_VIEW, { page_index: page, page_name: PAGES[page] });
  };

  const navigateTo = (newIdx: number) => {
    if (newIdx < 0 || newIdx >= PAGES.length || newIdx === pageIdxRef.current) return;
    haptic.light();
    carouselScrollRef.current?.scrollTo({ x: newIdx * screenW, animated: true });
    updatePage(newIdx);
  };

  // Coachmark steps declare the page they belong on, so the walkthrough moves
  // the carousel itself rather than depending on the user finding the right
  // swipe — the overlay sits on top and would swallow it anyway.
  const coachPage = coach.step?.page;
  useEffect(() => {
    if (coachPage === undefined || coachPage === pageIdxRef.current) return;
    carouselScrollRef.current?.scrollTo({ x: coachPage * screenW, animated: true });
    updatePage(coachPage);
    // Targets on a page are re-measured when the scroll settles (see the
    // scroll-end handlers below) — measuring mid-animation is what put the
    // cutouts to the right of the elements they were meant to be hugging.
    // This is only a backstop for platforms that skip momentum events on a
    // programmatic scroll.
    const t = setTimeout(() => useSpotlightStore.getState().remeasure(), 900);
    return () => clearTimeout(t);
  }, [coachPage, screenW]);

  const settled = (x: number) => {
    updatePage(Math.round(x / screenW));
    useSpotlightStore.getState().remeasure();
  };

  return (
    <View style={s.root}>
      {/* Home button — absolutely overlaid top-right, exits to the home tab */}
      <Pressable
        style={[s.homeBtn, { position: 'absolute', top: insets.top + 8, right: spacing.lg, zIndex: 20 }]}
        onPress={() => { haptic.light(); exitResults('home'); onHome(); }}
      >
        <Ionicons name="home" size={14} color="#fff" />
        <Text style={s.homeBtnText}>Home</Text>
      </Pressable>

      {/* Paging scroll view — video lives inside each PageContent so it slides naturally */}
      <View style={s.pageArea}>
        <ScrollView
          ref={carouselScrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          style={{ flex: 1 }}
          contentContainerStyle={{ height: '100%' }}
          scrollEventThrottle={16}
          onScrollEndDrag={(e) => settled(e.nativeEvent.contentOffset.x)}
          onMomentumScrollEnd={(e) => settled(e.nativeEvent.contentOffset.x)}
        >
          {PAGES.map((_, i) => (
            <View key={i} style={{ width: screenW }}>
              <PageContent idx={i} result={result} isActive={i === pageIdx} />
            </View>
          ))}
        </ScrollView>
      </View>

      {/* Bottom nav row: prev · dots · next */}
      <View style={[s.bottomNav, { paddingBottom: insets.bottom + 10 }]}>
        <NavButton
          label="Back"
          variant="back"
          onPress={() => navigateTo(pageIdx - 1)}
          disabled={pageIdx === 0}
        />
        <View style={s.floatingDots} {...dotsSpotlight}>
          {PAGES.map((_, i) => (
            <AnimatedDot key={i} active={i === pageIdx} onPress={() => navigateTo(i)} />
          ))}
        </View>
        <View {...nextSpotlight}>
          <NavButton
            label={pageIdx === PAGES.length - 1 ? 'Practice' : 'Next'}
            variant="next"
            onPress={() => {
              if (pageIdx === PAGES.length - 1) { exitResults('done'); onDone(); }
              else navigateTo(pageIdx + 1);
            }}
            disabled={false}
          />
        </View>
      </View>

      <SpotlightOverlay
        steps={CAROUSEL_COACHMARKS}
        index={coach.index}
        onNext={coach.next}
        onSkip={coach.skip}
        blocking={coachmarksActive}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────

const DARK_BG = colors.brand[900];
const CARD_BG = 'rgba(255,255,255,0.08)';
const CARD_BORDER = 'rgba(255,255,255,0.12)';
const TEXT_PRIMARY = '#ffffff';
const TEXT_SECONDARY = 'rgba(255,255,255,0.75)';
const TEXT_MUTED = 'rgba(255,255,255,0.45)';

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: DARK_BG },
  pageArea: { flex: 1, overflow: 'hidden' },
  pageScroll: { flex: 1 },

  homeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  homeBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },

  // Slide title strip (inside each page, slides with the carousel)
  slideTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: 4,
  },
  pageTitle: {
    fontSize: 28,
    fontWeight: '900',
    color: TEXT_PRIMARY,
    letterSpacing: -0.5,
  },
  pageTitleScore: {
    fontSize: 26,
    fontWeight: '900',
    lineHeight: 32,
  },

  // Scroll hint button (popout squircle, bottom-right aligned with Next button)
  scrollHintOuter: {
    position: 'absolute',
    bottom: 10,
    right: spacing.lg,
    width: SCROLL_HINT_SIZE,
    height: SCROLL_HINT_SIZE + SCROLL_HINT_DEPTH,
    zIndex: 10,
  },
  scrollHintBase: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: SCROLL_HINT_SIZE,
    borderRadius: 14,
    backgroundColor: colors.brand[700],
  },
  scrollHintSurface: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: SCROLL_HINT_SIZE,
    borderRadius: 14,
    backgroundColor: colors.brand[500],
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Video wrapper — matches card horizontal margins, rounded corners, top padding
  videoWrapper: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: 4,
    borderRadius: 16,
    overflow: 'hidden',
  },

  // Celebration page
  celebContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    paddingTop: spacing.md,
    gap: spacing.md,
    alignItems: 'center',
  },
  celebChartArea: { alignItems: 'center' },
  celebScoreArea: { alignItems: 'center', gap: 4 },
  celebScoreNum: { fontSize: 56, fontWeight: '900', color: TEXT_PRIMARY, lineHeight: 64 },
  celebScoreLabel: { fontSize: 12, fontWeight: '600', color: TEXT_MUTED, textTransform: 'uppercase', letterSpacing: 1.5 },
  celebIssues: { width: '100%', gap: spacing.sm },
  celebIssuesLabel: { fontSize: 11, fontWeight: '700', color: TEXT_MUTED, textTransform: 'uppercase', letterSpacing: 1 },
  celebIssueCard: {
    backgroundColor: CARD_BG,
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: CARD_BORDER,
  },
  celebIssueTitle: { fontSize: 13, fontWeight: '700', color: TEXT_PRIMARY, marginBottom: 3 },
  celebIssueBody: { fontSize: 12, color: TEXT_SECONDARY, lineHeight: 17 },
  celebSwipeHint: { fontSize: 13, color: TEXT_MUTED, marginTop: spacing.sm },

  // Coach lead (first thing a Pro user reads — see CoachLeadSection)
  coachLeadCard: {
    width: '100%',
    backgroundColor: 'rgba(56,189,248,0.12)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(56,189,248,0.28)',
    padding: spacing.lg,
    gap: 8,
  },
  coachLeadBadge: {
    fontSize: 10,
    fontWeight: '900',
    color: '#38bdf8',
    letterSpacing: 1.2,
  },
  coachLeadTake: { fontSize: 16, fontWeight: '600', color: TEXT_PRIMARY, lineHeight: 23 },
  coachLeadCause: {
    marginTop: 4,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.15)',
    gap: 3,
  },
  coachLeadCauseLabel: { fontSize: 13, fontWeight: '800', color: TEXT_PRIMARY },
  coachLeadCauseBody: { fontSize: 13, color: TEXT_SECONDARY, lineHeight: 19 },
  coachLeadShimmerLine: {
    width: '90%',
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  coachLeadPendingText: { fontSize: 12, color: TEXT_MUTED, marginTop: 2 },
  // Overview
  overviewContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, paddingTop: spacing.md, gap: spacing.md },
  overviewTitle: { fontSize: 26, fontWeight: '900', color: TEXT_PRIMARY, lineHeight: 32 },
  overviewChart: { alignItems: 'center', borderRadius: 20, paddingVertical: spacing.sm },
  overviewScore: { alignItems: 'center', gap: 4 },
  overviewScoreNum: { fontSize: 48, fontWeight: '900', color: TEXT_PRIMARY, lineHeight: 56 },
  overviewScoreLabel: { fontSize: 12, fontWeight: '600', color: TEXT_MUTED, textTransform: 'uppercase', letterSpacing: 1.2 },
  overviewTake: { backgroundColor: 'rgba(56,189,248,0.1)', borderRadius: 14, padding: spacing.md, borderLeftWidth: 3, borderLeftColor: '#38bdf8' },
  overviewTakeText: { fontSize: 14, color: TEXT_SECONDARY, lineHeight: 21 },
  findingsSection: { marginTop: spacing.md, backgroundColor: CARD_BG, borderRadius: 12, padding: spacing.md, borderWidth: 1, borderColor: CARD_BORDER, gap: 10 },
  findingsTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: TEXT_SECONDARY },
  findingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  findingDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  findingText: { flex: 1, fontSize: 14, color: TEXT_SECONDARY, lineHeight: 21 },

  // Root causes — the "big picture" cross-referenced narrative, distinct from
  // the raw L8 findings list above (technical detail stays secondary).
  rootCausesSection: { gap: 10 },
  rootCauseCard: {
    backgroundColor: CARD_BG,
    borderRadius: 14,
    borderLeftWidth: 3,
    borderLeftColor: '#38bdf8',
    borderWidth: 1,
    borderColor: CARD_BORDER,
    padding: spacing.md,
    gap: 4,
  },
  rootCauseTitle: { fontSize: 14, fontWeight: '800', color: TEXT_PRIMARY },
  rootCauseBody: { fontSize: 13, color: TEXT_SECONDARY, lineHeight: 19 },

  // Phrase feedback (L7, grounded — one row per phrase Claude commented on)
  phraseFeedbackSection: { gap: 10 },
  phraseFeedbackRow: {
    backgroundColor: CARD_BG,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: CARD_BORDER,
    padding: spacing.md,
    gap: 3,
  },
  phraseFeedbackObs: { fontSize: 13, fontWeight: '700', color: TEXT_PRIMARY },
  phraseFeedbackTip: { fontSize: 13, color: TEXT_SECONDARY, lineHeight: 19 },
  overviewCatList: { gap: spacing.sm },
  overviewCatRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  overviewCatIcon: { width: 28, alignItems: 'center' },
  overviewCatLabel: { width: 80, fontSize: 13, fontWeight: '600', color: TEXT_PRIMARY },
  overviewBarTrack: { flex: 1, height: 8, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden' },
  overviewBarFill: { height: '100%', borderRadius: 4 },
  overviewCatScore: { width: 32, fontSize: 13, fontWeight: '800', textAlign: 'right' },

  // Category page
  catContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, paddingTop: spacing.md, gap: spacing.md },
  catMetricList: { gap: spacing.xs },
  catMetricRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  catMetricLabel: { width: 110, fontSize: 12, fontWeight: '600', color: TEXT_SECONDARY },
  catMetricBarTrack: { flex: 1, height: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' },
  catMetricBarFill: { height: '100%', borderRadius: 3 },
  catMetricScore: { width: 28, fontSize: 12, fontWeight: '800', textAlign: 'right' },
  observationCard: { backgroundColor: CARD_BG, borderRadius: 12, padding: spacing.md, borderWidth: 1, borderColor: CARD_BORDER },
  observationText: { fontSize: 14, color: TEXT_SECONDARY, lineHeight: 21 },

  sectionLabel: { fontSize: 11, fontWeight: '700', color: TEXT_MUTED, textTransform: 'uppercase', letterSpacing: 0.8 },
  timestampSection: { gap: spacing.sm },
  timestampChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  timestampChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: CARD_BORDER },
  timestampChipText: { fontSize: 12, fontWeight: '700', color: TEXT_PRIMARY },

  // Rhythm card
  rhythmCard: { backgroundColor: 'rgba(100,220,150,0.06)', borderRadius: 14, padding: spacing.md, borderWidth: 1, borderColor: 'rgba(100,220,150,0.2)', gap: spacing.md },
  rhythmStatsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  rhythmStat: { alignItems: 'center', gap: 2 },
  rhythmStatValue: { fontSize: 22, fontWeight: '900', color: TEXT_PRIMARY },
  rhythmStatLabel: { fontSize: 10, fontWeight: '600', color: TEXT_MUTED, textTransform: 'uppercase', letterSpacing: 0.6 },
  tendencyBadge: { borderRadius: radius.full, paddingHorizontal: 14, paddingVertical: 5 },
  tendencyBadgeText: { fontSize: 13, fontWeight: '800', color: '#fff' },
  rhythmSummary: { fontSize: 15, fontWeight: '600', color: TEXT_PRIMARY, lineHeight: 22 },
  rhythmFixCard: { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 10, padding: spacing.md, borderLeftWidth: 3, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', gap: 6 },
  rhythmFixHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rhythmFixTimestamp: { fontSize: 13, fontWeight: '800' },
  rhythmFixSeverity: { fontSize: 12, fontWeight: '600', color: TEXT_MUTED, flex: 1 },
  rhythmFixTip: { fontSize: 13, color: TEXT_SECONDARY, lineHeight: 19 },
  rhythmShowMoreBtn: { alignItems: 'center', paddingVertical: 8 },
  rhythmShowMoreText: { fontSize: 13, fontWeight: '600', color: TEXT_MUTED },
  rubatoCard: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 10, padding: spacing.md, borderWidth: 1, borderColor: CARD_BORDER },
  rubatoTitle: { fontSize: 13, fontWeight: '700', color: TEXT_PRIMARY, marginBottom: 4 },
  rubatoText: { fontSize: 12, color: TEXT_SECONDARY, lineHeight: 18 },

  // Tone quality card
  toneCard: { backgroundColor: 'rgba(56,189,248,0.06)', borderRadius: 14, padding: spacing.md, borderWidth: 1, borderColor: 'rgba(56,189,248,0.2)', gap: spacing.md },

  // Volume (dynamics) card
  volumeCard: { backgroundColor: 'rgba(245,158,11,0.06)', borderRadius: 14, padding: spacing.md, borderWidth: 1, borderColor: 'rgba(245,158,11,0.25)', gap: spacing.sm },
  volumeCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  volumeCardTitle: { fontSize: 13, fontWeight: '700', color: TEXT_MUTED, textTransform: 'uppercase', letterSpacing: 0.8 },
  volumeScoreBadge: { borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 3 },
  volumeScoreText: { fontSize: 13, fontWeight: '800' },
  volumeIssueRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  volumeIssueText: { flex: 1, fontSize: 13, color: TEXT_SECONDARY, lineHeight: 19 },

  // Dev debug panel
  debugPanel: { backgroundColor: '#0f172a', borderRadius: 10, borderWidth: 1, borderColor: '#1e293b', overflow: 'hidden', marginTop: spacing.sm },
  debugPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8 },
  debugPanelTitle: { fontSize: 10, fontWeight: '700', color: '#475569', letterSpacing: 1, textTransform: 'uppercase' },
  debugPanelChevron: { fontSize: 10, color: '#475569' },
  debugPanelBody: { padding: 12, gap: 2 },
  debugMono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 10, color: '#cbd5e1', lineHeight: 15 },

  // Intonation note cards
  noteCard: { backgroundColor: CARD_BG, borderRadius: 14, padding: spacing.md, borderWidth: 1.5, borderColor: CARD_BORDER, gap: spacing.sm },
  noteCardHero: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  noteCardArrow: { fontSize: 36, fontWeight: '700', lineHeight: 40 },
  noteCardName: { fontSize: 40, fontWeight: '900', color: TEXT_PRIMARY, lineHeight: 46 },
  noteCardTend: { fontSize: 15, fontWeight: '700' },
  noteCardStat: { fontSize: 13, color: TEXT_MUTED },
  noteCardActions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  intoSummaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', backgroundColor: CARD_BG, borderRadius: 12, padding: spacing.md, borderWidth: 1, borderColor: CARD_BORDER },
  intoChartWrap: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 10, padding: 6, overflow: 'hidden' },

  // Combined intonation card
  seekBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: CARD_BORDER },
  seekBtnText: { fontSize: 13, fontWeight: '600', color: TEXT_PRIMARY },
  tuneBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: CARD_BORDER },
  tuneBtnActive: { backgroundColor: colors.score.critical },
  tuneBtnText: { fontSize: 13, fontWeight: '600', color: TEXT_PRIMARY },
  tuneBtnTextActive: { color: '#fff' },

  // Vibrato section label (shared big header — also used on the intonation page)
  vibratoSectionLabel: { fontSize: 22, fontWeight: '900', color: TEXT_PRIMARY, letterSpacing: -0.4 },

  // Vibrato diagnosis card + target strips
  vibratoDiagnosisCard: { backgroundColor: CARD_BG, borderRadius: 12, padding: spacing.md, borderWidth: 1, borderColor: CARD_BORDER, gap: spacing.md },
  vibratoHeadline: { fontSize: 15, fontWeight: '600', color: TEXT_PRIMARY, lineHeight: 22 },
  stripsBlock: { gap: spacing.sm },
  stripRow: { gap: 4 },
  stripLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stripLabel: { fontSize: 10, fontWeight: '700', color: TEXT_MUTED, letterSpacing: 0.8 },
  stripValue: { fontSize: 13, fontWeight: '800' },
  stripTrack: { height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.1)' },
  stripBand: { position: 'absolute', top: 0, bottom: 0, borderRadius: 5, backgroundColor: 'rgba(34,197,94,0.25)' },
  stripDot: { position: 'absolute', top: -1, width: 12, height: 12, borderRadius: 6, marginLeft: -6, borderWidth: 2, borderColor: DARK_BG },
  stripTicks: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stripTick: { fontSize: 9, color: TEXT_MUTED, fontWeight: '600' },
  stripLegend: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', marginTop: 2 },
  stripLegendDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.score.excellent },
  stripLegendBand: { width: 14, height: 8, borderRadius: 3, backgroundColor: 'rgba(34,197,94,0.25)', marginLeft: spacing.sm },
  stripLegendText: { fontSize: 11, color: TEXT_MUTED, fontWeight: '600' },

  // Vibrato issue cards
  vibratoIssueHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  vibratoIssueTitle: { flex: 1, fontSize: 20, fontWeight: '800', color: TEXT_PRIMARY },
  vibratoIssueBadge: { backgroundColor: 'rgba(245,158,11,0.2)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  vibratoIssueBadgeText: { fontSize: 12, fontWeight: '700', color: '#f59e0b' },
  vibratoIssueNoteList: { gap: 0 },
  vibratoIssueNoteRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.07)' },
  vibratoIssueNoteLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: TEXT_PRIMARY },

  // Vibrato note drawer
  vibratoDrawerNoteLabel: { fontSize: 15, fontWeight: '700', color: colors.text.secondary, textAlign: 'center' },
  vibratoDrawerGraph: { backgroundColor: '#0f172a', borderRadius: 12, padding: 10, overflow: 'hidden', width: '100%' },
  vibratoDrawerLegend: { flexDirection: 'row', gap: spacing.lg, justifyContent: 'center', marginTop: 8 },
  vibratoLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  vibratoLegendDash: { width: 18, height: 3, borderRadius: 1.5 },
  vibratoLegendText: { fontSize: 11, color: colors.text.muted, fontWeight: '600' },
  vibratoDrawerStats: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', paddingVertical: 4 },
  vibratoDrawerStat: { alignItems: 'center', gap: 2 },
  vibratoDrawerStatVal: { fontSize: 22, fontWeight: '900', color: colors.brand[700] },
  vibratoDrawerStatLbl: { fontSize: 10, fontWeight: '600', color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.6 },
  vibratoDrawerMessage: { fontSize: 14, color: colors.text.secondary, lineHeight: 21, textAlign: 'center', paddingHorizontal: spacing.sm },
  vibratoDrawerActions: { gap: spacing.sm, alignItems: 'center', width: '100%' },

  // Per-note score badge (fix-card rows)
  vibratoBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  vibratoBadgeText: { fontSize: 13, fontWeight: '800', color: '#fff' },

  // Chat
  chatScroll: { flex: 1 },
  chatContent: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  chatSuggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chatChip: { backgroundColor: CARD_BG, borderRadius: radius.full, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1.5, borderColor: CARD_BORDER },
  chatChipText: { fontSize: 13, fontWeight: '600', color: TEXT_SECONDARY },
  // Locked chat (free tier)
  chatBubble: { maxWidth: '85%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  chatBubbleCoach: { alignSelf: 'flex-start', backgroundColor: CARD_BG, borderWidth: 1, borderColor: CARD_BORDER },
  chatBubbleUser: { alignSelf: 'flex-end', backgroundColor: colors.brand[600] },
  chatBubbleText: { fontSize: 14, lineHeight: 21 },
  chatBubbleTextCoach: { color: TEXT_PRIMARY },
  chatBubbleTextUser: { color: '#fff' },
  chatInputRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: DARK_BG, borderTopWidth: 1, borderTopColor: CARD_BORDER },
  chatInput: { flex: 1, backgroundColor: CARD_BG, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: TEXT_PRIMARY },
  chatSendBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.brand[600], alignItems: 'center', justifyContent: 'center' },
  chatSendBtnOff: { backgroundColor: 'rgba(255,255,255,0.15)' },

  // Bottom nav row (prev · dots · next)
  bottomNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: 10,
    backgroundColor: DARK_BG,
    borderTopWidth: 1,
    borderTopColor: CARD_BORDER,
  },
  navBtnOuter: { height: NAV_BTN_H + NAV_DEPTH, width: 80 },
  navBtnBase: { position: 'absolute', bottom: 0, left: 0, right: 0, height: NAV_BTN_H, borderRadius: 10 },
  navBtnBaseBack: { backgroundColor: 'rgba(255,255,255,0.08)' },
  navBtnBaseNext: { backgroundColor: colors.brand[700] },
  navBtnSurface: {
    position: 'absolute', top: 0, left: 0, right: 0,
    height: NAV_BTN_H, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
  },
  navBtnSurfaceBack: { backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: CARD_BORDER },
  navBtnSurfaceNext: { backgroundColor: colors.brand[500] },
  navBtnDisabled: { opacity: 0.25 },
  navBtnText: { fontSize: 14, fontWeight: '700' },
  navBtnTextBack: { color: TEXT_PRIMARY },
  navBtnTextNext: { color: '#fff' },
  floatingDots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  dotActive: { backgroundColor: '#fff', width: 18 },
});
