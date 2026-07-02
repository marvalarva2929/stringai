import React, { useState, useRef, useCallback, useEffect } from 'react';
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
import Svg, { Path, Line } from 'react-native-svg';
import { Video, AVPlaybackStatus, ResizeMode, Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { analyzeMediaFileWithDebug, AudioDebugInfo } from '../src/services/audioEngine';
import { MetricScore, SeverityBand } from '../src/types/analysis';
import { colors, spacing, radius } from '../src/constants/theme';

interface RunResult {
  fileName: string;
  videoUri: string;
  scores: MetricScore[];
  debug: AudioDebugInfo;
  durationMs: number;
}

export default function DebugScreen() {
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
      setResult({ fileName, videoUri: asset.uri, scores, debug, durationMs: Date.now() - t0 });
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
