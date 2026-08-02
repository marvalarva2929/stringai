import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  Share,
  Alert,
  Dimensions,
} from 'react-native';
import Svg, { Path, Line, Rect, Circle, Text as SvgText } from 'react-native-svg';
import { Video, AVPlaybackStatus, ResizeMode, Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { analyzeMediaFileWithDebug, analyzeMediaFile, AudioDebugInfo } from '../src/services/audioEngine';
import { MetricScore, SeverityBand } from '../src/types/analysis';
import { colors, spacing, radius } from '../src/constants/theme';
import { extractVideoFrames, DetectionFrame } from '../src/services/videoAnalysis';
import { runSessionPipeline } from '../src/lib/sessionPipeline';
import { analyzeBowUsage } from '../src/lib/bowAnalysis';

// Compact view of a SessionPipelineOutput for on-screen display + raw-JSON share.
interface PipelineSummary {
  poseFrames: number;
  bowFrames: number;
  /** Fraction of bow contact-point samples that were non-null */
  bowCoverage: number;
  /** Contact-point distribution — robust range, thirds occupancy, camping */
  bowUsage: {
    robustRange: number;
    p05: number;
    p95: number;
    zoneShares: { lower: number; middle: number; upper: number };
    campedZone: string | null;
    campedShare: number;
  } | null;
  noteEvents: number;
  groups: { slur: number; detache: number; other: number };
  phrases: Array<{ start: number; end: number }>;
  findings: Array<{ testId: string; severity: string; summary: string }>;
  phraseFeatures: unknown[];
  videoMetrics: Record<string, { score: number; quality?: string }>;
}

interface RunResult {
  fileName: string;
  videoUri: string;
  scores: MetricScore[];
  debug: AudioDebugInfo;
  durationMs: number;
  pipeline?: PipelineSummary;
  detectionFrames?: DetectionFrame[];
}

// Internal dev tooling. Not gated by rendering conditionally inside this
// component (would break rules-of-hooks) — instead DebugScreen below refuses
// to mount it outside __DEV__, so the route stays a dead end in release
// builds even if someone deep-links to it directly.
function DebugScreenInner() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<Video>(null);
  const segEndMsRef = useRef<number | null>(null);

  useEffect(() => {
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true, allowsRecordingIOS: false });
  }, []);

  const pickAndRun = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo library access to pick a video.');
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'videos',
      allowsEditing: false,
      quality: 1,
    });
    if (picked.canceled || !picked.assets?.[0]) return;

    const asset = picked.assets[0];
    const durationSec = asset.duration ? Math.round(asset.duration / 1000) : 60;
    const fileName = asset.uri.split('/').pop() ?? asset.uri;

    setRunning(true);
    setResult(null);
    setError(null);
    segEndMsRef.current = null;

    const t0 = Date.now();
    try {
      const { scores, debug } = await analyzeMediaFileWithDebug(asset.uri, 'violin', durationSec);

      // Full L1–L9 pipeline dump (best-effort — needs the native module + audio)
      let pipeline: PipelineSummary | undefined;
      let detectionFrames: DetectionFrame[] | undefined;
      try {
        const [audioOutput, extracted] = await Promise.all([
          analyzeMediaFile(asset.uri, 'violin', durationSec),
          extractVideoFrames(asset.uri),
        ]);
        detectionFrames = extracted.detectionFrames;
        const out = runSessionPipeline({
          audioOutput,
          poseFrames: extracted.poseFrames,
          bowFrames: extracted.bowFrames,
          durationSeconds: durationSec,
          instrument: 'violin',
        });
        const cpPoints = out.signals.bowContactPoint.points;
        const uValues = cpPoints.map((p) => p.v).filter((v): v is number => v !== null);
        const usage = analyzeBowUsage(uValues);
        pipeline = {
          poseFrames: extracted.poseFrames.length,
          bowFrames: extracted.bowFrames.length,
          bowCoverage: cpPoints.length > 0
            ? cpPoints.filter((p) => p.v !== null).length / cpPoints.length
            : 0,
          bowUsage: usage
            ? {
                robustRange: usage.robustRange,
                p05: usage.p05,
                p95: usage.p95,
                zoneShares: usage.zoneShares,
                campedZone: usage.campedZone,
                campedShare: usage.campedShare,
              }
            : null,
          noteEvents: out.noteEvents.length,
          groups: {
            slur: out.noteGroups.filter((g) => g.type === 'slur').length,
            detache: out.noteGroups.filter((g) => g.type === 'detache').length,
            other: out.noteGroups.filter((g) => g.type === 'other').length,
          },
          phrases: out.phrases.map((p) => ({ start: p.start, end: p.end })),
          findings: out.findings.map((f) => ({ testId: f.testId, severity: f.severity, summary: f.summary })),
          phraseFeatures: out.phraseFeatures,
          videoMetrics: Object.fromEntries(
            out.videoMetrics.map((m) => [m.key, { score: m.score, quality: m.measurementQuality }]),
          ),
        };
      } catch {
        // Android / module unavailable — audio debug still shows
      }

      setResult({ fileName, videoUri: asset.uri, scores, debug, durationMs: Date.now() - t0, pipeline, detectionFrames });
    } catch (err: any) {
      setError(err?.message ?? 'Analysis failed');
    } finally {
      setRunning(false);
    }
  };

  const onPlaybackStatusUpdate = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded || !status.isPlaying) return;
    const endMs = segEndMsRef.current;
    if (endMs !== null && status.positionMillis >= endMs) {
      segEndMsRef.current = null;
      videoRef.current?.pauseAsync().catch(() => {});
    }
  }, []);

  const playSegment = useCallback(async (startS: number, endS: number) => {
    const video = videoRef.current;
    if (!video) return;
    segEndMsRef.current = endS * 1000;
    await video.setPositionAsync(startS * 1000, { toleranceMillisBefore: 0, toleranceMillisAfter: 100 }).catch(() => {});
    await video.playAsync().catch(() => {});
  }, []);

  const shareResult = async () => {
    if (!result) return;
    const payload = {
      file: result.fileName,
      scores: Object.fromEntries(result.scores.map((s) => [s.key, { score: s.score, severity: s.severity }])),
      debug: result.debug,
      pipeline: result.pipeline ?? null,
    };
    await Share.share({ message: JSON.stringify(payload, null, 2) });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Audio Analysis Debug</Text>
        <Text style={styles.subtitle}>Calibration tool — dev only</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Pressable style={styles.pickBtn} onPress={pickAndRun} disabled={running}>
          {running
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.pickBtnText}>Pick Video & Run Analysis</Text>
          }
        </Pressable>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {result && (
          <>
            <View style={styles.fileRow}>
              <Text style={styles.fileLabel} numberOfLines={1}>{result.fileName}</Text>
              <Text style={styles.timingLabel}>{result.durationMs}ms</Text>
            </View>

            <WavInfoBox info={result.debug.wavInfo} />

            <MetricDebugCard
              label="Pitch Accuracy"
              score={result.scores.find((s) => s.key === 'pitchAccuracy')}
              rows={[
                ['Detected frames', `${result.debug.pitchAccuracy.detectedFrames} / ${result.debug.pitchAccuracy.totalFrames}  (${pct(result.debug.pitchAccuracy.detectionRate)})`],
                ['Avg cents deviation', `${result.debug.pitchAccuracy.avgCentsDeviation.toFixed(1)}¢`],
                ['In-tune ratio', `${result.debug.pitchAccuracy.inTuneRatio.toFixed(3)}  (threshold ±${result.debug.pitchAccuracy.inTuneCentsThreshold}¢)`],
              ]}
            />

            <MetricDebugCard
              label="Intonation Stability"
              score={result.scores.find((s) => s.key === 'intonationStability')}
              rows={[
                ['Pitch std deviation', `${result.debug.intonationStability.stdCents.toFixed(2)}¢  (score = 100 − stdCents×3)`],
              ]}
            />

            <MetricDebugCard
              label="Tone Quality"
              score={result.scores.find((s) => s.key === 'toneQuality')}
              rows={[
                ['Avg fundamental ratio', result.debug.toneQuality.avgFundamentalRatio.toFixed(4)],
                ['Good frame ratio', `${result.debug.toneQuality.goodFrameRatio.toFixed(3)}  (in-range: ${result.debug.toneQuality.lowerBound}–${result.debug.toneQuality.upperBound})`],
                ['Silent frames', String(result.debug.toneQuality.silentFrameCount)],
              ]}
            />

            <MetricDebugCard
              label="Bow Smoothness"
              score={result.scores.find((s) => s.key === 'bowSmoothness')}
              rows={[
                ['Abrupt changes', `${result.debug.bowSmoothness.abruptChangeCount} / ${result.debug.bowSmoothness.rmsFrameCount} frames`],
                ['Abrupt ratio', `${result.debug.bowSmoothness.abruptRatio.toFixed(4)}  (change threshold: ${result.debug.bowSmoothness.changeThreshold})`],
              ]}
            />

            <MetricDebugCard
              label="Rhythm Accuracy"
              score={result.scores.find((s) => s.key === 'rhythmAccuracy')}
              rows={[
                ['Onsets detected', String(result.debug.rhythmAccuracy.onsetCount)],
                ['  ↳ spectral flux', String(result.debug.rhythmAccuracy.fluxOnsets)],
                ['  ↳ pitch change', String(result.debug.rhythmAccuracy.pitchOnsets)],
                ['Mean IOI', `${result.debug.rhythmAccuracy.meanIoi.toFixed(3)}s`],
                ['CV of IOI', `${result.debug.rhythmAccuracy.cvIoi.toFixed(3)}  (lower = more regular)`],
              ]}
            />

            <MetricDebugCard
              label="Dynamic Control"
              score={result.scores.find((s) => s.key === 'dynamicControl')}
              rows={[
                ['Fast fluctuation variance', `${result.debug.dynamicControl.fastVar.toFixed(6)}  (lower = better)`],
              ]}
            />

            <VibratoDebugCard
              score={result.scores.find((s) => s.key === 'vibrato')}
              vibrato={result.debug.vibrato}
              onSegmentPress={playSegment}
            />

            {result.pipeline && (
              <View style={styles.wavBox}>
                <Text style={styles.wavTitle}>L1–L9 Pipeline</Text>
                <Row label="Pose / bow frames" value={`${result.pipeline.poseFrames} / ${result.pipeline.bowFrames}`} />
                <Row label="Bow coverage" value={pct(result.pipeline.bowCoverage)} />
                {result.pipeline.bowUsage && (
                  <>
                    <Row label="Bow range (p5–p95)" value={`${pct(result.pipeline.bowUsage.robustRange)}  (${result.pipeline.bowUsage.p05.toFixed(2)}–${result.pipeline.bowUsage.p95.toFixed(2)})`} />
                    <Row label="Zones frog/mid/tip" value={`${pct(result.pipeline.bowUsage.zoneShares.lower)} / ${pct(result.pipeline.bowUsage.zoneShares.middle)} / ${pct(result.pipeline.bowUsage.zoneShares.upper)}`} />
                    <Row label="Camping" value={result.pipeline.bowUsage.campedZone
                      ? `${result.pipeline.bowUsage.campedZone} (${pct(result.pipeline.bowUsage.campedShare)})`
                      : 'none'} />
                  </>
                )}
                <Row label="Note events" value={String(result.pipeline.noteEvents)} />
                <Row label="Groups (slur/dét/other)" value={`${result.pipeline.groups.slur} / ${result.pipeline.groups.detache} / ${result.pipeline.groups.other}`} />
                <Row label="Phrases" value={String(result.pipeline.phrases.length)} />
                <Row label="Findings fired" value={result.pipeline.findings.length > 0
                  ? result.pipeline.findings.map((f) => f.testId).join(', ')
                  : 'none'} />
                {Object.entries(result.pipeline.videoMetrics).map(([key, m]) => (
                  <Row key={key} label={`  ${key}`} value={`${m.score} (${m.quality ?? 'high'})`} />
                ))}
              </View>
            )}

            {result.detectionFrames && result.detectionFrames.length > 0 && (
              <DetectionInspector videoUri={result.videoUri} frames={result.detectionFrames} />
            )}

            <Video
              ref={videoRef}
              source={{ uri: result.videoUri }}
              style={styles.videoPlayer}
              resizeMode={ResizeMode.CONTAIN}
              onPlaybackStatusUpdate={onPlaybackStatusUpdate}
              useNativeControls
            />

            <Pressable style={styles.shareBtn} onPress={shareResult}>
              <Text style={styles.shareBtnText}>Share Raw JSON</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Frame-by-frame viewer for the raw bow/violin detector boxes on an uploaded
 * video. Seeks the (paused) video to each detected frame and overlays the boxes
 * exactly as the CoreML model emitted them — the fastest way to eyeball whether
 * the violin is being detected and how tight the boxes are.
 */
function DetectionInspector({ videoUri, frames }: { videoUri: string; frames: DetectionFrame[] }) {
  const videoRef = useRef<Video>(null);
  const [idx, setIdx] = useState(0);
  const [aspect, setAspect] = useState(16 / 9); // width / height
  const [barW, setBarW] = useState(1);

  const width = Dimensions.get('window').width - spacing.lg * 2;
  const height = width / aspect;
  const frame = frames[Math.min(idx, frames.length - 1)];

  const violinCount = useMemo(() => frames.filter((f) => f.violin).length, [frames]);
  // The full bow was calibrated at least once iff some frame has a non-approx
  // bow position (approx = no full-bow length available yet).
  const fullBowSeen = useMemo(
    () => frames.some((f) => f.bowPosT != null && !f.bowPosApprox),
    [frames],
  );

  // Coalesced video seeking: keep at most ONE setPositionAsync in flight. Drag
  // moves update `idx` (and the overlay) instantly; the video image chases the
  // latest requested frame without a backlog of queued seeks, which is what made
  // scrubbing stutter. A looser tolerance also lets each seek resolve faster.
  const seekInFlight = useRef(false);
  const pendingIdx = useRef<number | null>(null);

  const runSeek = useCallback((i: number) => {
    const f = frames[i];
    if (!f || !videoRef.current) return;
    if (seekInFlight.current) { pendingIdx.current = i; return; }
    seekInFlight.current = true;
    videoRef.current
      .setPositionAsync(f.timestamp * 1000, { toleranceMillisBefore: 80, toleranceMillisAfter: 80 })
      .catch(() => {})
      .finally(() => {
        seekInFlight.current = false;
        const next = pendingIdx.current;
        pendingIdx.current = null;
        if (next != null && next !== i) runSeek(next);
      });
  }, [frames]);

  useEffect(() => { runSeek(idx); }, [idx, runSeek]);

  const step = (d: number) => setIdx((i) => Math.max(0, Math.min(frames.length - 1, i + d)));

  // Scrub track geometry, measured in window coords. We use absolute pageX (not
  // locationX) because locationX is reported relative to whichever child view is
  // under the finger — and the thumb tracks the finger, so locationX would snap
  // back and forth. pageX − trackLeft is stable regardless of what's hit.
  const trackRef = useRef<View>(null);
  const trackLeftRef = useRef(0);
  const measureTrack = useCallback(() => {
    trackRef.current?.measureInWindow((x, _y, w) => {
      trackLeftRef.current = x;
      if (w) setBarW(w);
    });
  }, []);

  const seekFromPageX = useCallback((pageX: number) => {
    const x = pageX - trackLeftRef.current;
    const i = Math.round((x / Math.max(barW, 1)) * (frames.length - 1));
    setIdx(Math.max(0, Math.min(frames.length - 1, i)));
  }, [barW, frames.length]);

  const toRect = (b: { x1: number; y1: number; x2: number; y2: number }) => ({
    x: b.x1 * width, y: b.y1 * height,
    w: (b.x2 - b.x1) * width, h: (b.y2 - b.y1) * height,
  });

  return (
    <View style={styles.wavBox}>
      <Text style={styles.wavTitle}>Detection Inspector</Text>
      <Text style={styles.inspectSummary}>
        violin detected in {violinCount}/{frames.length} frames ({pct(violinCount / frames.length)})
      </Text>
      {!fullBowSeen && (
        <Text style={styles.inspectWarn}>
          ⚠️ Full bow never visible in this clip — bow distribution can't be measured reliably.
        </Text>
      )}

      <View style={[styles.inspectStage, { width, height }]}>
        <Video
          ref={videoRef}
          source={{ uri: videoUri }}
          style={{ width, height }}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay={false}
          onReadyForDisplay={(e) => {
            const ns = (e as any).naturalSize;
            if (ns?.width && ns?.height) setAspect(ns.width / ns.height);
          }}
        />
        <Svg style={StyleSheet.absoluteFill} width={width} height={height} pointerEvents="none">
          {frame?.bow && (() => {
            const r = toRect(frame.bow);
            return (
              <React.Fragment>
                <Rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="#f59e0b" strokeWidth={2} rx={3} />
                <SvgText x={r.x + 3} y={Math.max(r.y - 4, 11)} fontSize={11} fontWeight="700" fill="#f59e0b">
                  {`bow ${Math.round(frame.bowConfidence * 100)}%`}
                </SvgText>
              </React.Fragment>
            );
          })()}
          {frame?.violin && (() => {
            const r = toRect(frame.violin);
            return (
              <React.Fragment>
                <Rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="#22d3ee" strokeWidth={2} rx={3} />
                <SvgText x={r.x + 3} y={Math.max(r.y - 4, 11)} fontSize={11} fontWeight="700" fill="#22d3ee">
                  {`violin ${Math.round(frame.violinConfidence * 100)}%`}
                </SvgText>
              </React.Fragment>
            );
          })()}
          {/* Bow diagonal (frog → tip) — the line the contact math runs along */}
          {frame?.frog && frame?.tip && (
            <Line
              x1={frame.frog.x * width} y1={frame.frog.y * height}
              x2={frame.tip.x * width} y2={frame.tip.y * height}
              stroke="#f59e0b" strokeWidth={2} strokeDasharray="6 4" strokeOpacity={0.9}
            />
          )}
          {/* String diagonal (fingerboard → bridge) */}
          {frame?.stringA && frame?.stringB && (
            <Line
              x1={frame.stringA.x * width} y1={frame.stringA.y * height}
              x2={frame.stringB.x * width} y2={frame.stringB.y * height}
              stroke="#22d3ee" strokeWidth={2} strokeDasharray="6 4" strokeOpacity={0.9}
            />
          )}
          {frame?.contact && (
            <React.Fragment>
              <Circle cx={frame.contact.x * width} cy={frame.contact.y * height} r={7} fill="none" stroke="#ef4444" strokeWidth={2} />
              <Circle cx={frame.contact.x * width} cy={frame.contact.y * height} r={2.5} fill="#ef4444" />
            </React.Fragment>
          )}
        </Svg>
      </View>

      {/* Bow-distribution: where along the bow (frog → tip) the string contacts */}
      <View style={styles.contactBox}>
        <View style={styles.contactHeader}>
          <Text style={styles.contactLabel}>
            Contact point on bow{frame?.bowPosApprox ? '  (approx — no full bow seen yet)' : ''}
          </Text>
          <Text style={[styles.contactValue, frame?.bowPosApprox && styles.contactValueApprox]}>
            {frame?.bowPosT != null ? frame.bowPosT.toFixed(2) : '—'}
          </Text>
        </View>
        <View style={styles.contactTrack}>
          {frame?.bowPosT != null && (
            <View style={[
              styles.contactMarker,
              frame?.bowPosApprox && styles.contactMarkerApprox,
              { left: `${Math.max(0, Math.min(1, frame.bowPosT)) * 100}%` },
            ]} />
          )}
        </View>
        <View style={styles.contactEnds}>
          <Text style={styles.contactEndText}>frog</Text>
          <Text style={styles.contactEndText}>tip</Text>
        </View>
      </View>

      {/* Draggable scrub bar — tap or drag to scrub through frames. Larger hit
          area (padding) makes the thumb easy to grab; children are non-
          interactive so touches always resolve against the track itself. */}
      <View
        ref={trackRef}
        style={styles.scrubHit}
        onLayout={measureTrack}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => seekFromPageX(e.nativeEvent.pageX)}
        onResponderMove={(e) => seekFromPageX(e.nativeEvent.pageX)}
      >
        <View style={styles.scrubTrack} pointerEvents="none">
          <View style={[styles.scrubFill, { width: `${(idx / Math.max(frames.length - 1, 1)) * 100}%` }]} />
          <View style={[styles.scrubThumb, { left: `${(idx / Math.max(frames.length - 1, 1)) * 100}%` }]} />
        </View>
      </View>

      <View style={styles.inspectRow}>
        <Pressable style={styles.stepBtn} onPress={() => step(-10)}><Text style={styles.stepBtnText}>«10</Text></Pressable>
        <Pressable style={styles.stepBtn} onPress={() => step(-1)}><Text style={styles.stepBtnText}>‹</Text></Pressable>
        <View style={styles.inspectMetaBox}>
          <Text style={styles.inspectMeta}>{`${idx + 1}/${frames.length}  ·  ${frame ? frame.timestamp.toFixed(2) : '0.00'}s`}</Text>
          <Text style={styles.inspectMetaSub}>
            {`bow ${frame ? Math.round(frame.bowConfidence * 100) : 0}%   violin ${frame?.violin ? Math.round(frame.violinConfidence * 100) + '%' : '—'}`}
          </Text>
        </View>
        <Pressable style={styles.stepBtn} onPress={() => step(1)}><Text style={styles.stepBtnText}>›</Text></Pressable>
        <Pressable style={styles.stepBtn} onPress={() => step(10)}><Text style={styles.stepBtnText}>10»</Text></Pressable>
      </View>
    </View>
  );
}

function WavInfoBox({ info }: { info: AudioDebugInfo['wavInfo'] }) {
  return (
    <View style={styles.wavBox}>
      <Text style={styles.wavTitle}>WAV Info</Text>
      <Row label="Sample rate" value={`${info.sampleRate} Hz`} />
      <Row label="Duration" value={`${info.duration.toFixed(2)}s`} />
      <Row label="Total samples" value={info.totalSamples.toLocaleString()} />
    </View>
  );
}

interface MetricDebugCardProps {
  label: string;
  score: MetricScore | undefined;
  rows: [string, string][];
}

function MetricDebugCard({ label, score, rows }: MetricDebugCardProps) {
  return (
    <View style={styles.metricCard}>
      <View style={styles.metricHeader}>
        <Text style={styles.metricLabel}>{label}</Text>
        {score && (
          <View style={[styles.scoreBadge, { backgroundColor: severityColor(score.severity) }]}>
            <Text style={styles.scoreBadgeText}>{score.score}  {score.severity}</Text>
          </View>
        )}
      </View>
      {rows.map(([k, v]) => <Row key={k} label={k} value={v} />)}
    </View>
  );
}

const GRAPH_W = Dimensions.get('window').width - 64;
const GRAPH_H = 130;
const GRAPH_RANGE = 50; // ±50 cents

function buildSegmentPath(cents: number[], w: number, h: number): string {
  if (cents.length < 2) return '';
  const PAD = 8;
  const mh = h - PAD * 2;
  let d = '';
  cents.forEach((c, i) => {
    const x = (i / Math.max(cents.length - 1, 1)) * w;
    const clamped = Math.max(-GRAPH_RANGE, Math.min(GRAPH_RANGE, c));
    const y = PAD + mh / 2 - (clamped / GRAPH_RANGE) * (mh / 2);
    d += i === 0 ? `M${x.toFixed(1)} ${y.toFixed(1)}` : ` L${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return d;
}

const IDEAL_RATE_HZ = 5.5;
const IDEAL_DEPTH_CENTS = 25;
const PITCH_HOP_HZ = 40; // classifyVibratoSegment uses hopHz=40

function SegmentPitchGraph({ cents }: { cents: number[] }) {
  const PAD = 8;
  const mh = GRAPH_H - PAD * 2;
  const cy = PAD + mh / 2;
  const yAt = (c: number) => PAD + mh / 2 - (c / GRAPH_RANGE) * (mh / 2);
  const path = buildSegmentPath(cents, GRAPH_W, GRAPH_H);

  // Ideal vibrato: sine wave at 5.5 Hz ±25¢, same frame count as actual
  const idealCents = Array.from({ length: cents.length }, (_, i) =>
    IDEAL_DEPTH_CENTS * Math.sin(2 * Math.PI * IDEAL_RATE_HZ * (i / PITCH_HOP_HZ)),
  );
  const idealPath = buildSegmentPath(idealCents, GRAPH_W, GRAPH_H);

  return (
    <View style={styles.segGraph}>
      <Svg width={GRAPH_W} height={GRAPH_H}>
        <Line x1={0} y1={yAt(40)}  x2={GRAPH_W} y2={yAt(40)}  stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        <Line x1={0} y1={yAt(20)}  x2={GRAPH_W} y2={yAt(20)}  stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
        <Line x1={0} y1={cy}       x2={GRAPH_W} y2={cy}        stroke="rgba(255,255,255,0.28)" strokeWidth={1} />
        <Line x1={0} y1={yAt(-20)} x2={GRAPH_W} y2={yAt(-20)} stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
        <Line x1={0} y1={yAt(-40)} x2={GRAPH_W} y2={yAt(-40)} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        {idealPath ? <Path d={idealPath} stroke="rgba(250,180,50,0.35)" strokeWidth={2} fill="none" strokeDasharray="6,4" strokeLinejoin="round" strokeLinecap="round" /> : null}
        {path ? <Path d={path} stroke="rgba(100,210,255,0.9)" strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" /> : null}
      </Svg>
      <View style={styles.segGraphLabels}>
        <Text style={styles.segGraphLabel}>+{GRAPH_RANGE}¢</Text>
        <Text style={styles.segGraphLabel}>0</Text>
        <Text style={styles.segGraphLabel}>−{GRAPH_RANGE}¢</Text>
      </View>
    </View>
  );
}

function VibratoDebugCard({ score, vibrato, onSegmentPress }: {
  score: MetricScore | undefined;
  vibrato: AudioDebugInfo['vibrato'];
  onSegmentPress?: (startS: number, endS: number) => void;
}) {
  const [selectedSeg, setSelectedSeg] = useState(0);
  const activeNote = vibrato.notes[selectedSeg];

  return (
    <View style={styles.metricCard}>
      <View style={styles.metricHeader}>
        <Text style={styles.metricLabel}>Vibrato</Text>
        {score && (
          <View style={[styles.scoreBadge, { backgroundColor: severityColor(score.severity) }]}>
            <Text style={styles.scoreBadgeText}>{score.score}  {score.severity}</Text>
          </View>
        )}
      </View>
      <Row label="Notes detected" value={String(vibrato.notes.length)} />
      <Row label="Eligible (≥0.5s)" value={String(vibrato.eligibleSegments)} />
      <Row label="Avg note score" value={String(vibrato.avgNoteScore)} />
      {vibrato.notes.length > 0 && (
        <View style={styles.segTable}>
          <View style={styles.segHeader}>
            <Text style={[styles.segCell, styles.segCellLabel]}>#</Text>
            <Text style={[styles.segCell, styles.segCellStart]}>@ s</Text>
            <Text style={[styles.segCell, styles.segCellDur]}>dur</Text>
            <Text style={[styles.segCell, styles.segCellRate]}>rate</Text>
            <Text style={[styles.segCell, styles.segCellDepth]}>depth</Text>
            <Text style={[styles.segCell, styles.segCellAC]}>AC</Text>
            <Text style={[styles.segCell, styles.segCellCons]}>cons</Text>
            <Text style={styles.segCellPass}>score</Text>
          </View>
          {vibrato.notes.map((note, i) => (
            <View key={i}>
              <Pressable
                onPress={() => { setSelectedSeg(i); onSegmentPress?.(note.startS, note.endS); }}
                style={[styles.segRow, i === selectedSeg && styles.segRowSelected, !note.eligible && styles.segRowIneligible]}
              >
                <Text style={[styles.segCell, styles.segCellLabel, i === selectedSeg && styles.segCellActive]}>{i + 1}</Text>
                <Text style={[styles.segCell, styles.segCellStart, i === selectedSeg && styles.segCellActive]}>{note.startS}s</Text>
                <Text style={[styles.segCell, styles.segCellDur, i === selectedSeg && styles.segCellActive]}>{note.durationS}s</Text>
                {note.eligible ? (
                  <>
                    <Text style={[styles.segCell, styles.segCellRate, i === selectedSeg && styles.segCellActive]}>{note.rateHz} Hz</Text>
                    <Text style={[styles.segCell, styles.segCellDepth, i === selectedSeg && styles.segCellActive]}>{note.depthCents}¢</Text>
                    <Text style={[styles.segCell, styles.segCellAC, i === selectedSeg && styles.segCellActive]}>{note.periodicityScore.toFixed(2)}</Text>
                    <Text style={[styles.segCell, styles.segCellCons, { color: note.consistencyOk ? '#4ade80' : '#f87171' }]}>
                      {note.consistencyOk ? '✓' : '✗'}
                    </Text>
                    <Text style={[styles.segCellPass, { color: note.noteScore >= 75 ? '#4ade80' : note.noteScore >= 40 ? '#fbbf24' : '#f87171' }]}>
                      {note.noteScore}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={[styles.segCell, styles.segCellRate, styles.segCellDim]}>—</Text>
                    <Text style={[styles.segCell, styles.segCellDepth, styles.segCellDim]}>—</Text>
                    <Text style={[styles.segCell, styles.segCellAC, styles.segCellDim]}>—</Text>
                    <Text style={[styles.segCell, styles.segCellCons, styles.segCellDim]}>—</Text>
                    <Text style={[styles.segCellPass, styles.segCellDim]}>short</Text>
                  </>
                )}
              </Pressable>
              {note.feedbackNotes.map((fb, fi) => (
                <Text key={fi} style={styles.segFeedbackNote}>{fb}</Text>
              ))}
            </View>
          ))}
        </View>
      )}
      {activeNote?.eligible && activeNote.cents.length > 1 && (
        <View style={{ marginTop: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text style={styles.segGraphTitle}>
              Note {selectedSeg + 1} — {activeNote.startS}s–{activeNote.endS}s — pitch (¢ from median)
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <View style={{ width: 14, height: 2, backgroundColor: 'rgba(100,210,255,0.9)' }} />
                <Text style={styles.segGraphLabel}>actual</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <View style={{ width: 14, height: 2, backgroundColor: 'rgba(250,180,50,0.6)' }} />
                <Text style={styles.segGraphLabel}>ideal</Text>
              </View>
            </View>
          </View>
          <SegmentPitchGraph cents={activeNote.cents} />
        </View>
      )}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function pct(ratio: number) {
  return `${(ratio * 100).toFixed(1)}%`;
}

function severityColor(s: SeverityBand): string {
  switch (s) {
    case 'excellent': return colors.score.excellent;
    case 'good': return colors.score.good;
    case 'needs_attention': return colors.score.needs_attention;
    case 'critical': return colors.score.critical;
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0f0c29' },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.md },
  backBtn: { marginBottom: spacing.xs },
  backText: { color: 'rgba(255,255,255,0.6)', fontSize: 14 },
  title: { fontSize: 20, fontWeight: '700', color: '#fff' },
  subtitle: { fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 2 },
  scroll: { flex: 1 },
  scrollContent: { padding: spacing.lg, gap: spacing.sm, paddingBottom: 40 },

  videoPlayer: {
    width: '100%',
    height: 220,
    backgroundColor: '#000',
    borderRadius: radius.md,
    overflow: 'hidden',
  },

  pickBtn: {
    backgroundColor: colors.brand[600],
    borderRadius: radius.lg,
    padding: 16,
    alignItems: 'center',
  },
  pickBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },

  errorBox: {
    backgroundColor: '#fee2e2',
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorText: { color: '#991b1b', fontSize: 13 },

  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  fileLabel: { fontSize: 12, color: 'rgba(255,255,255,0.5)', flex: 1, marginRight: spacing.sm },
  timingLabel: { fontSize: 12, color: 'rgba(255,255,255,0.3)' },

  wavBox: {
    backgroundColor: '#1e1b3a',
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  wavTitle: { fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },

  inspectSummary: { fontSize: 12, color: 'rgba(255,255,255,0.7)', marginBottom: spacing.xs },
  inspectWarn: { fontSize: 12, color: '#f59e0b', fontWeight: '600', marginBottom: spacing.xs },
  inspectStage: {
    alignSelf: 'center',
    backgroundColor: '#000',
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  // Full-width transparent touch target (taller than the visible bar) so the
  // thumb is easy to grab. No horizontal padding — its width must equal the
  // inner track's so pageX maps directly to the fill percentage.
  scrubHit: {
    marginTop: spacing.sm,
    paddingVertical: 12,
  },
  scrubTrack: {
    height: 20,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
  },
  scrubFill: { height: '100%', backgroundColor: colors.brand[500] },
  scrubThumb: {
    position: 'absolute',
    top: -3,
    width: 14,
    height: 26,
    marginLeft: -7,
    borderRadius: 7,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: colors.brand[500],
  },

  contactBox: { marginTop: spacing.md, gap: 4 },
  contactHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  contactLabel: { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.7)' },
  contactValue: { fontSize: 13, fontWeight: '700', color: '#ef4444', fontVariant: ['tabular-nums'] },
  contactValueApprox: { color: '#f59e0b' },
  contactTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
  },
  contactMarker: {
    position: 'absolute',
    width: 12,
    height: 12,
    marginLeft: -6,
    borderRadius: 6,
    backgroundColor: '#ef4444',
  },
  contactMarkerApprox: { backgroundColor: '#f59e0b' },
  contactEnds: { flexDirection: 'row', justifyContent: 'space-between' },
  contactEndText: { fontSize: 10, color: 'rgba(255,255,255,0.4)' },
  inspectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  stepBtn: {
    backgroundColor: colors.brand[600],
    borderRadius: radius.sm,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minWidth: 40,
    alignItems: 'center',
  },
  stepBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  inspectMetaBox: { flex: 1, alignItems: 'center' },
  inspectMeta: { color: '#fff', fontSize: 13, fontWeight: '700' },
  inspectMetaSub: { color: 'rgba(255,255,255,0.6)', fontSize: 11 },

  metricCard: {
    backgroundColor: '#1e1b3a',
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  metricHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  metricLabel: { fontSize: 13, fontWeight: '700', color: '#fff' },
  scoreBadge: { borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 },
  scoreBadgeText: { fontSize: 11, fontWeight: '700', color: '#fff' },

  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  rowLabel: { fontSize: 12, color: 'rgba(255,255,255,0.45)', flex: 1 },
  rowValue: { fontSize: 12, color: 'rgba(255,255,255,0.85)', fontVariant: ['tabular-nums'], textAlign: 'right', flexShrink: 0 },

  segTable: { marginTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', paddingTop: 6, gap: 3 },
  segHeader: { flexDirection: 'row', marginBottom: 2 },
  segRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: 4, borderRadius: 4 },
  segRowSelected: { backgroundColor: 'rgba(100,210,255,0.10)' },
  segRowIneligible: { opacity: 0.5 },
  segCellDim: { color: 'rgba(255,255,255,0.25)' },
  segCell: { fontSize: 11, fontVariant: ['tabular-nums'] },
  segCellActive: { color: 'rgba(100,210,255,0.95)' },
  segCellLabel: { width: 20, color: 'rgba(255,255,255,0.35)' },
  segCellStart: { width: 44, color: 'rgba(255,255,255,0.6)' },
  segCellDur: { width: 40, color: 'rgba(255,255,255,0.6)' },
  segCellRate: { width: 56, color: 'rgba(255,255,255,0.6)' },
  segCellDepth: { width: 40, color: 'rgba(255,255,255,0.6)' },
  segCellAC: { width: 36, color: 'rgba(255,255,255,0.6)' },
  segCellCons: { width: 20, fontWeight: '700' },
  segCellPass: { fontSize: 11, fontWeight: '700' },
  segFeedbackNote: { fontSize: 10, color: 'rgba(255,200,100,0.7)', fontStyle: 'italic', marginLeft: 24, marginBottom: 3 },
  segGraphTitle: { fontSize: 10, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  segGraph: { position: 'relative' },
  segGraphLabels: { position: 'absolute', right: -28, top: 0, bottom: 0, justifyContent: 'space-between', paddingVertical: 8 },
  segGraphLabel: { fontSize: 9, color: 'rgba(255,255,255,0.3)', fontVariant: ['tabular-nums'] },

  shareBtn: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: radius.md,
    padding: 14,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  shareBtnText: { color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: '600' },
});

export default function DebugScreen() {
  if (!__DEV__) return null;
  return <DebugScreenInner />;
}
