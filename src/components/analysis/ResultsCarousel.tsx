import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, TextInput,
  KeyboardAvoidingView, Platform, Modal,
  TouchableWithoutFeedback, Dimensions,
  Animated as RNAnimated, Easing,
} from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withSpring, interpolateColor,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, FontAwesome6 } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import Svg, { Circle, Line, Polygon, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useWindowDimensions } from 'react-native';
import { InlineVideoPlayer } from './InlineVideoPlayer';
import { colors, spacing, radius } from '../../constants/theme';
import { haptic } from '../../lib/haptics';
import {
  AnalysisResult, MetricScore, MetricKey, FlaggedTimestamp,
  IntonationAnalysis, VibratoAnalysis, PitchClassIssue, VibratoNoteResult,
  IntonationStabilityNoteResult,
  LLMCoachingItem, DynDebugInfo, RhythmAnalysis,
} from '../../types/analysis';
import { getReferenceNoteUri, pitchClassInfo } from '../../lib/referenceNote';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const { width: SCREEN_W } = Dimensions.get('window');
const GRAPH_H = 72;
const GRAPH_RANGE = 50;
const IDEAL_RATE_HZ = 5.5;
const IDEAL_DEPTH_CENTS = 25;
const PITCH_HOP_HZ = 40;

type CategoryId = 'intonation' | 'vibrato' | 'tone' | 'dynamics' | 'bow' | 'posture' | 'rhythm';
type PageId = 'celebration' | 'overview' | CategoryId | 'chat';

const CATEGORIES: { id: CategoryId; label: string; keys: MetricKey[] }[] = [
  { id: 'intonation', label: 'Intonation',   keys: ['pitchAccuracy', 'intonationStability'] },
  { id: 'vibrato',    label: 'Vibrato',       keys: ['vibrato'] },
  { id: 'tone',       label: 'Tone Quality',  keys: ['toneQuality'] },
  { id: 'dynamics',   label: 'Dynamics',      keys: ['dynamicControl'] },
  { id: 'bow',        label: 'Bow Technique', keys: ['bowSmoothness', 'bowPlacement', 'bowAngle', 'bowDistribution'] },
  { id: 'posture',    label: 'Posture',       keys: ['posture', 'leftHandWrist', 'bowArmLevel'] },
  { id: 'rhythm',     label: 'Rhythm',        keys: ['rhythmAccuracy'] },
];

// Categories hidden from the UI until their scoring is reliable enough to show.
// Remove a category from this set to re-enable it everywhere.
const HIDDEN_CATS = new Set<CategoryId>(['bow', 'posture']);

const VISIBLE_CATEGORIES = CATEGORIES.filter(c => !HIDDEN_CATS.has(c.id));

const PAGES: PageId[] = ['celebration', 'overview', ...VISIBLE_CATEGORIES.map(c => c.id as PageId), 'chat'];

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

function WristAngleGraph({ metric, duration, onTimestampPress }: {
  metric: MetricScore;
  duration: number;
  onTimestampPress?: (s: number) => void;
}) {
  const { width: screenW } = useWindowDimensions();
  const series = metric.timeSeries;
  if (!series || series.length < 2) return null;

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
      {metric.measurementQuality === 'low' && (
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
  if (!series || series.length < 2) return null;

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

function scoreColor(score: number) {
  if (score >= 85) return colors.score.excellent;
  if (score >= 70) return colors.score.good;
  if (score >= 50) return colors.score.needs_attention;
  return colors.score.critical;
}

function avgScore(metrics: MetricScore[], keys: MetricKey[]): number {
  const vals = keys.map(k => metrics.find(m => m.key === k)?.score).filter((v): v is number => v !== undefined);
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
  for (const m of metrics) mm[m.key] = m.score;
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

// ─────────────────────────────────────────────────────────────
// Tune-note hook + panel (from CoachingReport)
// ─────────────────────────────────────────────────────────────

function useTuneNote() {
  const [playingNote, setPlayingNote] = useState<string | null>(null);
  const playingRef = useRef<string | null>(null);
  const soundRef   = useRef<Audio.Sound | null>(null);
  useEffect(() => () => { soundRef.current?.unloadAsync().catch(() => {}); }, []);

  const stopAll = useCallback(async () => {
    const sound = soundRef.current;
    soundRef.current = null; playingRef.current = null; setPlayingNote(null);
    if (sound) { await sound.stopAsync().catch(() => {}); await sound.unloadAsync().catch(() => {}); }
  }, []);

  const toggle = useCallback(async (pitchClass: string, midi?: number) => {
    const prev = playingRef.current;
    const prevSound = soundRef.current;
    soundRef.current = null; playingRef.current = null; setPlayingNote(null);
    if (prevSound) { await prevSound.stopAsync().catch(() => {}); await prevSound.unloadAsync().catch(() => {}); }
    if (prev === pitchClass) return;
    playingRef.current = pitchClass; setPlayingNote(pitchClass);
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true, staysActiveInBackground: false, shouldDuckAndroid: false });
      const uri = await getReferenceNoteUri(pitchClass, midi);
      const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true, volume: 1.0 });
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) {
          if (playingRef.current === pitchClass) { playingRef.current = null; setPlayingNote(null); }
          sound.unloadAsync().catch(() => {});
          if (soundRef.current === sound) soundRef.current = null;
        }
      });
    } catch { playingRef.current = null; setPlayingNote(null); }
  }, []);

  return { playingNote, toggle, stopAll };
}

const PANEL_H = Math.round(Dimensions.get('window').height * 0.42);

function TunePracticePanel({ pitchClass, midiNote, isPlaying, onToggle, onClose }: {
  pitchClass: string; midiNote?: number; isPlaying: boolean; onToggle: () => void; onClose: () => void;
}) {
  const { freq, description } = pitchClassInfo(pitchClass, midiNote);
  return (
    <TouchableWithoutFeedback onPress={onClose}>
      <View style={ps.backdrop}>
        <TouchableWithoutFeedback>
          <View style={ps.sheet}>
            <View style={ps.pill} />
            <Text style={ps.noteName}>{pitchClass}</Text>
            <Text style={ps.noteDesc}>{description}</Text>
            <Text style={ps.noteFreq}>{freq} Hz</Text>
            <Text style={ps.instruction}>Play this note on your violin and adjust until the pitches match.</Text>
            <Pressable style={[ps.playBtn, isPlaying && ps.playBtnActive]} onPress={onToggle}>
              {isPlaying
                ? <View style={ps.pauseIcon}><View style={ps.pauseBar} /><View style={ps.pauseBar} /></View>
                : <Text style={ps.playBtnIcon}>▶</Text>}
              <Text style={[ps.playBtnText, isPlaying && ps.playBtnTextActive]}>
                {isPlaying ? 'Stop' : 'Play note'}
              </Text>
            </Pressable>
            <Pressable onPress={onClose} style={ps.doneBtn}>
              <Text style={ps.doneBtnText}>Done</Text>
            </Pressable>
          </View>
        </TouchableWithoutFeedback>
      </View>
    </TouchableWithoutFeedback>
  );
}

const ps = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { height: PANEL_H, backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, alignItems: 'center', paddingHorizontal: spacing.xl, paddingBottom: 32, gap: spacing.sm, shadowColor: '#000', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.18, shadowRadius: 20, elevation: 20 },
  pill: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#d1d5db', marginTop: 10, marginBottom: 4 },
  noteName: { fontSize: 52, fontWeight: '800', color: colors.brand[700], lineHeight: 60 },
  noteDesc: { fontSize: 14, color: colors.text.secondary, fontWeight: '500', textAlign: 'center' },
  noteFreq: { fontSize: 13, color: colors.text.muted, textAlign: 'center' },
  instruction: { fontSize: 13, color: colors.text.secondary, textAlign: 'center', lineHeight: 19, paddingHorizontal: spacing.md },
  playBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.brand[600], borderRadius: radius.full, paddingHorizontal: 28, paddingVertical: 14, marginTop: spacing.xs },
  playBtnActive: { backgroundColor: colors.score.critical },
  playBtnIcon: { fontSize: 18, color: '#fff' },
  pauseIcon: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  pauseBar: { width: 4, height: 17, backgroundColor: '#fff', borderRadius: 1.5 },
  playBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  playBtnTextActive: {},
  doneBtn: { marginTop: 4 },
  doneBtnText: { fontSize: 14, color: colors.text.muted, fontWeight: '500' },
});

// ─────────────────────────────────────────────────────────────
// Intonation cards
// ─────────────────────────────────────────────────────────────

function IntonationNoteCard({ issue, videoUri, onTimestampPress, onTune, isPlaying }: {
  issue: PitchClassIssue;
  videoUri?: string;
  onTimestampPress?: (s: number) => void;
  onTune?: (pitchClass: string, midi?: number) => void;
  isPlaying?: boolean;
}) {
  const tendColor = issue.tendency === 'flat' ? '#3b82f6' : issue.tendency === 'sharp' ? colors.score.needs_attention : colors.text.muted;
  const arrow = issue.tendency === 'flat' ? '↓' : issue.tendency === 'sharp' ? '↑' : '↕';
  const tendWord = issue.tendency === 'flat' ? 'flat' : issue.tendency === 'sharp' ? 'sharp' : 'off';
  const absAvg = Math.abs(issue.avgDeviationCents);
  const barWidth = Math.min(100, (absAvg / 50) * 100);
  return (
    <View style={s.noteCard}>
      <View style={s.noteCardHero}>
        <Text style={[s.noteCardArrow, { color: tendColor }]}>{arrow}</Text>
        <Text style={s.noteCardName}>{issue.pitchClass}</Text>
      </View>
      <Text style={[s.noteCardTend, { color: tendColor }]}>
        {tendWord} by ~{absAvg}¢ on average
      </Text>
      <Text style={s.noteCardStat}>
        Out of tune {issue.outOfTuneCount}× — {Math.round(issue.errorRate * 100)}% error rate
      </Text>
      <View style={s.devBarBg}>
        <View style={[s.devBarFill, { width: `${barWidth}%` as any, backgroundColor: tendColor }]} />
      </View>
      <View style={s.noteCardActions}>
        {videoUri && (issue.exampleTimestamps?.length ?? 0) > 0 && onTimestampPress && (
          <Pressable style={s.seekBtn} onPress={() => onTimestampPress(issue.exampleTimestamps![0].startSeconds)}>
            <Ionicons name="play" size={13} color="#38bdf8" />
            <Text style={s.seekBtnText}>Seek to example</Text>
          </Pressable>
        )}
        {onTune && (
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
// Vibrato cards
// ─────────────────────────────────────────────────────────────

function buildPath(cents: number[], w: number, h: number): string {
  if (cents.length < 2) return '';
  const PAD = 4;
  const mh = h - PAD * 2;
  return cents.map((c, i) => {
    const x = (i / Math.max(cents.length - 1, 1)) * w;
    const clamped = Math.max(-GRAPH_RANGE, Math.min(GRAPH_RANGE, c));
    const y = PAD + mh / 2 - (clamped / GRAPH_RANGE) * (mh / 2);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function VibratoNoteCard({ note, index, onTimestampPress }: {
  note: VibratoNoteResult; index: number; onTimestampPress?: (s: number) => void;
}) {
  const sc = scoreColor(note.noteScore);
  const graphW = SCREEN_W - 80;
  const actualPath = buildPath(note.cents, graphW, GRAPH_H);
  const idealCents = Array.from({ length: note.cents.length }, (_, i) =>
    IDEAL_DEPTH_CENTS * Math.sin(2 * Math.PI * IDEAL_RATE_HZ * (i / PITCH_HOP_HZ))
  );
  const idealPath = buildPath(idealCents, graphW, GRAPH_H);
  const cy = 4 + (GRAPH_H - 8) / 2;
  return (
    <View style={s.noteCard}>
      <View style={s.vibratoHeader}>
        <Text style={s.vibratoTime}>Note {index + 1} — {fmtSecs(note.startS)}–{fmtSecs(note.endS)}</Text>
        <View style={[s.vibratoBadge, { backgroundColor: sc }]}>
          <Text style={s.vibratoBadgeText}>{note.noteScore}</Text>
        </View>
      </View>
      <View style={s.vibratoStats}>
        <Text style={s.vibratoStat}>{note.rateHz} Hz</Text>
        <Text style={s.vibratoStatSep}>·</Text>
        <Text style={s.vibratoStat}>±{note.depthCents}¢</Text>
        <Text style={s.vibratoStatSep}>·</Text>
        <Text style={s.vibratoStat}>AC {note.periodicityScore.toFixed(2)}</Text>
      </View>
      {note.cents.length > 1 && (
        <View style={s.vibratoGraph}>
          <Svg width={graphW} height={GRAPH_H}>
            <Line x1={0} y1={cy} x2={graphW} y2={cy} stroke="rgba(0,0,0,0.1)" strokeWidth={1} />
            {idealPath ? <Path d={idealPath} stroke="rgba(250,180,50,0.5)" strokeWidth={1.5} fill="none" strokeDasharray="5,4" /> : null}
            {actualPath ? <Path d={actualPath} stroke={sc} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" /> : null}
          </Svg>
        </View>
      )}
      {note.feedbackNotes.length > 0 && (
        <View style={s.feedbackTags}>
          {note.feedbackNotes.map((fb, i) => (
            <View key={i} style={s.feedbackTag}><Text style={s.feedbackTagText}>{fb}</Text></View>
          ))}
        </View>
      )}
      {onTimestampPress && (
        <Pressable style={s.seekBtn} onPress={() => onTimestampPress(note.startS)}>
          <Ionicons name="play" size={13} color="#38bdf8" />
          <Text style={s.seekBtnText}>Seek to note</Text>
        </Pressable>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Vibrato issue grouping, drawer, and section
// ─────────────────────────────────────────────────────────────

type VibratoIssueType = 'shallow' | 'uneven_rhythm' | 'fades' | 'slow_rate' | 'fast_rate' | 'no_vibrato';

interface VibratoIssueGroup {
  type: VibratoIssueType;
  notes: Array<{ note: VibratoNoteResult; index: number }>;
}

const VIBRATO_ISSUE_META: Record<VibratoIssueType, { title: string; icon: string }> = {
  shallow:       { title: 'Shallow depth',  icon: 'trending-down'            },
  uneven_rhythm: { title: 'Uneven rhythm',  icon: 'pulse'                    },
  fades:         { title: 'Fades mid-bow',  icon: 'remove-outline'           },
  slow_rate:     { title: 'Slow rate',      icon: 'hourglass-outline'        },
  fast_rate:     { title: 'Fast / tense',   icon: 'flash-outline'            },
  no_vibrato:    { title: 'No vibrato',     icon: 'radio-button-off-outline' },
};

function classifyFeedbackNote(fb: string): VibratoIssueType | null {
  if (fb.includes('shallow'))    return 'shallow';
  if (fb.includes('uneven'))     return 'uneven_rhythm';
  if (fb.includes('fades'))      return 'fades';
  if (fb.includes('a bit slow')) return 'slow_rate';
  if (fb.includes('touch fast')) return 'fast_rate';
  if (fb.includes('no vibrato')) return 'no_vibrato';
  return null;
}

function groupVibratoIssues(notes: VibratoNoteResult[]): VibratoIssueGroup[] {
  const map = new Map<VibratoIssueType, VibratoIssueGroup>();
  notes.forEach((note, index) => {
    const seen = new Set<VibratoIssueType>();
    for (const fb of note.feedbackNotes) {
      const type = classifyFeedbackNote(fb);
      if (type && !seen.has(type)) {
        seen.add(type);
        if (!map.has(type)) map.set(type, { type, notes: [] });
        map.get(type)!.notes.push({ note, index });
      }
    }
  });
  return [...map.values()].sort((a, b) => b.notes.length - a.notes.length);
}

function buildVibratoDrawerMessage(issueType: VibratoIssueType, note: VibratoNoteResult): string {
  switch (issueType) {
    case 'shallow':
      return `Your depth was ±${note.depthCents}¢. The ideal range is 18–40¢ (shown in yellow) — aim for a wider, more relaxed arm swing.`;
    case 'slow_rate':
      return `Your rate was ${note.rateHz} Hz. The ideal is 5–7 Hz (shown in yellow) — try a slightly faster wrist impulse.`;
    case 'fast_rate':
      return `Your rate was ${note.rateHz} Hz. The ideal is 5–7 Hz (shown in yellow) — slow it down by broadening the arm motion.`;
    case 'uneven_rhythm':
      return `Your vibrato rhythm was irregular. The yellow line shows what a steady oscillation looks like — focus on an even wrist pulse.`;
    case 'fades':
      return `Your vibrato faded mid-stroke. Aim for the consistent depth shown in yellow throughout the whole bow stroke.`;
    case 'no_vibrato':
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
  issueType: VibratoIssueType;
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

function VibratoIssueCard({ group, onNotePress }: {
  group: VibratoIssueGroup;
  onNotePress: (note: VibratoNoteResult, noteIndex: number) => void;
}) {
  const meta = VIBRATO_ISSUE_META[group.type];
  return (
    <View style={s.noteCard}>
      <View style={s.vibratoIssueHeader}>
        <Ionicons name={meta.icon as any} size={20} color="#f59e0b" />
        <Text style={s.vibratoIssueTitle}>{meta.title}</Text>
        <View style={s.vibratoIssueBadge}>
          <Text style={s.vibratoIssueBadgeText}>{group.notes.length}×</Text>
        </View>
      </View>
      <View style={s.vibratoIssueNoteList}>
        {group.notes.map(({ note, index }) => (
          <Pressable
            key={index}
            style={s.vibratoIssueNoteRow}
            onPress={() => { haptic.light(); onNotePress(note, index); }}
          >
            <Text style={s.vibratoIssueNoteLabel}>
              Note {index + 1}  ·  {fmtSecs(note.startS)}–{fmtSecs(note.endS)}
            </Text>
            <Ionicons name="chevron-forward" size={15} color="rgba(255,255,255,0.3)" />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function VibratoSection({ analysis, onTimestampPress }: {
  analysis: VibratoAnalysis;
  onTimestampPress: (s: number) => void;
}) {
  const [drawer, setDrawer] = useState<{ note: VibratoNoteResult; noteIndex: number; issueType: VibratoIssueType } | null>(null);
  const issueGroups = groupVibratoIssues(analysis.notes);
  return (
    <>
      {issueGroups.length > 0 ? (
        <>
          <Text style={s.vibratoSectionLabel}>Issues to address</Text>
          {issueGroups.map(group => (
            <VibratoIssueCard
              key={group.type}
              group={group}
              onNotePress={(note, noteIndex) => setDrawer({ note, noteIndex, issueType: group.type })}
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
            issueType={drawer.issueType}
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

function CombinedIntonationCard({ issue, videoUri, onSegmentPress, onTune, isPlaying }: {
  issue: CombinedNoteIssue;
  videoUri?: string;
  onSegmentPress?: (start: number, end: number) => void;
  onTune?: (pitchClass: string, midi?: number) => void;
  isPlaying?: boolean;
}) {
  const { accuracy, stability } = issue;
  const exampleTs = accuracy?.exampleTimestamps?.[0] ?? (stability ? { startSeconds: stability.startS, endSeconds: stability.endS } : null);

  const tend = accuracy?.tendency ?? 'mixed';
  const tendColor = tend === 'flat' ? '#3b82f6' : tend === 'sharp' ? '#f97316' : TEXT_MUTED;
  const arrow = tend === 'flat' ? '↓' : tend === 'sharp' ? '↑' : '·';
  const absAvg = accuracy ? Math.abs(accuracy.avgDeviationCents) : 0;
  const deviationLabel = accuracy
    ? `${absAvg}¢ ${tend === 'flat' ? 'flat' : tend === 'sharp' ? 'sharp' : 'off pitch'}`
    : null;
  const driftSentence = combinedDriftSentence(accuracy, stability);

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

function OverviewPage({ result }: { result: AnalysisResult }) {
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
                <View style={[s.catMetricBarFill, { width: `${m.score}%`, backgroundColor: scoreColor(m.score) }]} />
              </View>
              <Text style={[s.catMetricScore, { color: scoreColor(m.score) }]}>{m.score}</Text>
            </View>
          ))}
        </View>

        {/* Tone quality: acoustic observation summary */}
        {catId === 'tone' && (() => {
          const tq = catMetrics.find(m => m.key === 'toneQuality');
          if (!tq?.observationSummary) return null;
          return (
            <View style={s.observationCard}>
              <Text style={s.observationText}>{tq.observationSummary}</Text>
            </View>
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

        {/* Intonation-specific: combined accuracy + stability note cards */}
        {catId === 'intonation' && result.intonationAnalysis && (() => {
          const combined = buildCombinedNoteIssues(
            result.intonationAnalysis.problemNotes,
            result.intonationStabilityAnalysis,
          );
          if (combined.length === 0) return null;
          return (
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

        {/* Generic timestamp chips (non-intonation/vibrato/rhythm) */}
        {catId !== 'intonation' && catId !== 'vibrato' && catId !== 'rhythm' && allTimestamps.length > 0 && (
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

interface ChatMessage { role: 'coach' | 'user'; text: string; }

function buildChatReply(userText: string, result: AnalysisResult): string {
  const t = userText.toLowerCase();
  const catScores = VISIBLE_CATEGORIES.map(c => ({ ...c, score: avgScore(result.metrics, c.keys) })).sort((a, b) => a.score - b.score);
  const worst = catScores[0], best = catScores[catScores.length - 1];
  const overall = result.overallScore;

  if (/score|overall|how did|how was|rating/.test(t)) {
    const feel = overall >= 80 ? 'strong' : overall >= 60 ? 'solid' : 'a work-in-progress';
    return `Your overall score was ${overall}/100 — a ${feel} session. Strongest: ${best.label} (${best.score}). Main area to work on: ${worst.label} (${worst.score}).`;
  }
  for (const cat of catScores) {
    if (t.includes(cat.label.toLowerCase()) || t.includes(cat.id)) {
      const catMetrics = cat.keys.map(k => result.metrics.find(m => m.key === k)).filter(Boolean) as MetricScore[];
      const obs = catMetrics.filter(m => m.occurrenceRate > 0.05).map(m => m.observationSummary).join(' ');
      const item = result.llmFeedback?.items.find(i => cat.keys.includes(i.metricKey));
      return `Your ${cat.label} score was ${cat.score}/100. ${obs} ${item?.feedback ?? ''}`.trim();
    }
  }
  if (/practice|work on|improve|fix|drill|exercise/.test(t)) {
    const item = result.llmFeedback?.items[0];
    const ex = item?.exercise ? `\n\nTry this: ${item.exercise}` : '';
    return `Focus on ${worst.label} first. ${item?.feedback ?? 'Short, focused repetitions will give you the fastest gains.'}${ex}`;
  }
  if (/progress|trend|last time|previous|better|worse/.test(t)) {
    if (result.overallDelta !== undefined) {
      const dir = result.overallDelta >= 0 ? 'up' : 'down';
      return `Your score went ${dir} ${Math.abs(result.overallDelta)} points from your last session. ${result.overallDelta >= 0 ? 'Keep building on that.' : "Focus on the fundamentals and it'll come back."}`;
    }
    return `No previous session to compare yet. Keep recording and I'll be able to show you trends.`;
  }
  if (/inton|pitch|note|tuning|flat|sharp/.test(t)) {
    const ia = result.intonationAnalysis;
    if (ia) return `You had ${ia.outOfTuneCount} out-of-tune events. Tendency: ${ia.overallTendency ?? 'mixed'}. ${ia.problemNotes[0] ? `Trickiest note: ${ia.problemNotes[0].pitchClass} (${ia.problemNotes[0].tendency}).` : ''}`;
  }
  if (/vibrato/.test(t)) {
    const va = result.vibratoAnalysis;
    if (va) {
      const feel = va.avgNoteScore >= 70 ? 'sounding consistent' : 'still developing';
      return `Vibrato detected on ${va.eligibleCount} eligible notes and is ${feel}. Average note score: ${Math.round(va.avgNoteScore)}.`;
    }
  }
  if (/how long|duration|minute|second/.test(t)) {
    const m = Math.floor(result.durationSeconds / 60), sec = Math.round(result.durationSeconds % 60);
    return `Your session was ${m}m ${sec}s long.${m < 5 ? ' Longer sessions give more data to work with.' : ''}`;
  }
  return `Based on your session, I'd focus on ${catScores.slice(0, 2).map(c => c.label).join(' and ')}. Ask me about any specific category, what to practise, or how you're progressing.`;
}

function ChatPage({ result }: { result: AnalysisResult }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'coach', text: `I've analysed your session — score ${result.overallScore}/100. Ask me anything about your playing, what to practise, or specific categories.` },
  ]);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  const send = () => {
    const text = draft.trim(); if (!text) return;
    const reply = buildChatReply(text, result);
    setMessages(prev => [...prev, { role: 'user', text }, { role: 'coach', text: reply }]);
    setDraft('');
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={{ flex: 1 }}>
        <ScrollView ref={scrollRef} style={s.chatScroll} contentContainerStyle={s.chatContent} showsVerticalScrollIndicator={false}>
          {messages.length === 1 && (
            <View style={s.chatSuggestions}>
              {['What should I practise?', 'How was my intonation?', 'How was my bow technique?', 'How am I progressing?'].map(q => (
                <Pressable key={q} style={s.chatChip} onPress={() => setDraft(q)}>
                  <Text style={s.chatChipText}>{q}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {messages.map((msg, i) => (
            <View key={i} style={[s.chatBubble, msg.role === 'user' ? s.chatBubbleUser : s.chatBubbleCoach]}>
              <Text style={[s.chatBubbleText, msg.role === 'user' ? s.chatBubbleTextUser : s.chatBubbleTextCoach]}>{msg.text}</Text>
            </View>
          ))}
        </ScrollView>
        <View style={s.chatInputRow}>
          <TextInput style={s.chatInput} value={draft} onChangeText={setDraft}
            placeholder="Ask about your session…" placeholderTextColor={colors.text.muted}
            onSubmitEditing={send} returnKeyType="send" />
          <Pressable style={[s.chatSendBtn, !draft.trim() && s.chatSendBtnOff]} onPress={send} disabled={!draft.trim()}>
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
function PageContent({ idx, result }: {
  idx: number; result: AnalysisResult;
}) {
  const { top } = useSafeAreaInsets();
  const pageId = PAGES[idx];
  const cat = CATEGORIES.find(c => c.id === pageId);
  const showVideo = !!result.videoUri && pageId !== 'celebration' && pageId !== 'chat';

  const pageTitle =
    pageId === 'celebration' ? 'Results' :
    pageId === 'overview'    ? 'Summary' :
    pageId === 'chat'        ? 'Ask Maestro' :
    (cat?.label ?? '');

  const pageScore: number | null =
    pageId === 'celebration' || pageId === 'chat' ? null :
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
          <Text style={[s.pageTitleScore, { color: scoreColor(pageScore) }]}>{pageScore}</Text>
        )}
      </View>
      {showVideo && (
        <View style={s.videoWrapper}>
          <InlineVideoPlayer
            uri={result.videoUri!}
            seekVersion={seekVersion}
            seekSeconds={seekSeconds}
            seekEndSeconds={seekEndSeconds}
            noteEvents={result.noteEvents}
            durationSeconds={result.durationSeconds}
            onMarkerPress={handleTimestampPress}
            onTimeUpdate={handleTimeUpdate}
          />
        </View>
      )}
      {pageId === 'celebration' && <CelebrationPage result={result} />}
      {pageId === 'overview' && <OverviewPage result={result} />}
      {cat && <CategoryPage catId={cat.id} result={result} onTimestampPress={handleTimestampPress} onSegmentPress={handleSegmentPress} playbackSeconds={playbackSeconds} />}
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
  onDone: () => void;
}

export function ResultsCarousel({ result, onDone }: ResultsCarouselProps) {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();

  const [pageIdx, setPageIdx] = useState(0);
  const pageIdxRef = useRef(0);
  const carouselScrollRef = useRef<ScrollView>(null);

  const updatePage = (page: number) => {
    if (page === pageIdxRef.current || page < 0 || page >= PAGES.length) return;
    setPageIdx(page);
    pageIdxRef.current = page;
  };

  const navigateTo = (newIdx: number) => {
    if (newIdx < 0 || newIdx >= PAGES.length || newIdx === pageIdxRef.current) return;
    haptic.light();
    carouselScrollRef.current?.scrollTo({ x: newIdx * screenW, animated: true });
    updatePage(newIdx);
  };

  return (
    <View style={s.root}>
      {/* Home button — absolutely overlaid top-right, same visual row as the title in each slide */}
      <Pressable
        style={[s.homeBtn, { position: 'absolute', top: insets.top + 8, right: spacing.lg, zIndex: 20 }]}
        onPress={() => { haptic.light(); onDone(); }}
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
          onScrollEndDrag={(e) => updatePage(Math.round(e.nativeEvent.contentOffset.x / screenW))}
          onMomentumScrollEnd={(e) => updatePage(Math.round(e.nativeEvent.contentOffset.x / screenW))}
        >
          {PAGES.map((_, i) => (
            <View key={i} style={{ width: screenW }}>
              <PageContent idx={i} result={result} />
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
        <View style={s.floatingDots}>
          {PAGES.map((_, i) => (
            <AnimatedDot key={i} active={i === pageIdx} onPress={() => navigateTo(i)} />
          ))}
        </View>
        <NavButton
          label="Next"
          variant="next"
          onPress={() => navigateTo(pageIdx + 1)}
          disabled={pageIdx === PAGES.length - 1}
        />
      </View>
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

  // Overview
  overviewContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, paddingTop: spacing.md, gap: spacing.md },
  overviewTitle: { fontSize: 26, fontWeight: '900', color: TEXT_PRIMARY, lineHeight: 32 },
  overviewChart: { alignItems: 'center', borderRadius: 20, paddingVertical: spacing.sm },
  overviewScore: { alignItems: 'center', gap: 4 },
  overviewScoreNum: { fontSize: 48, fontWeight: '900', color: TEXT_PRIMARY, lineHeight: 56 },
  overviewScoreLabel: { fontSize: 12, fontWeight: '600', color: TEXT_MUTED, textTransform: 'uppercase', letterSpacing: 1.2 },
  overviewTake: { backgroundColor: 'rgba(56,189,248,0.1)', borderRadius: 14, padding: spacing.md, borderLeftWidth: 3, borderLeftColor: '#38bdf8' },
  overviewTakeText: { fontSize: 14, color: TEXT_SECONDARY, lineHeight: 21 },
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
  noteCardCoaching: { fontSize: 14, color: TEXT_SECONDARY, lineHeight: 20 },
  devBarBg: { height: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' },
  devBarFill: { height: '100%', borderRadius: 3 },
  noteCardActions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },

  // Combined intonation card
  seekBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: CARD_BORDER },
  seekBtnText: { fontSize: 13, fontWeight: '600', color: TEXT_PRIMARY },
  tuneBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: CARD_BORDER },
  tuneBtnActive: { backgroundColor: colors.score.critical },
  tuneBtnText: { fontSize: 13, fontWeight: '600', color: TEXT_PRIMARY },
  tuneBtnTextActive: { color: '#fff' },

  // Vibrato section label
  vibratoSectionLabel: { fontSize: 22, fontWeight: '900', color: TEXT_PRIMARY, letterSpacing: -0.4 },

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

  // Vibrato note cards (kept for reference)
  vibratoHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  vibratoTime: { fontSize: 14, fontWeight: '700', color: TEXT_PRIMARY },
  vibratoBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  vibratoBadgeText: { fontSize: 13, fontWeight: '800', color: '#fff' },
  vibratoStats: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  vibratoStat: { fontSize: 13, fontWeight: '600', color: TEXT_SECONDARY },
  vibratoStatSep: { fontSize: 13, color: TEXT_MUTED },
  vibratoGraph: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 10, padding: 6, overflow: 'hidden' },
  feedbackTags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  feedbackTag: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  feedbackTagText: { fontSize: 11, color: TEXT_SECONDARY, fontWeight: '500' },

  // Chat
  chatScroll: { flex: 1 },
  chatContent: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  chatSuggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chatChip: { backgroundColor: CARD_BG, borderRadius: radius.full, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1.5, borderColor: CARD_BORDER },
  chatChipText: { fontSize: 13, fontWeight: '600', color: TEXT_SECONDARY },
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
