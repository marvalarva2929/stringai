import React, { useState } from 'react';
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
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { analyzeMediaFileWithDebug, AudioDebugInfo } from '../src/services/audioEngine';
import { MetricScore, SeverityBand } from '../src/types/analysis';
import { colors, spacing, radius } from '../src/constants/theme';

interface RunResult {
  fileName: string;
  scores: MetricScore[];
  debug: AudioDebugInfo;
  durationMs: number;
}

export default function DebugScreen() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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

    const t0 = Date.now();
    try {
      const { scores, debug } = await analyzeMediaFileWithDebug(asset.uri, 'violin', durationSec);
      setResult({ fileName, scores, debug, durationMs: Date.now() - t0 });
    } catch (err: any) {
      setError(err?.message ?? 'Analysis failed');
    } finally {
      setRunning(false);
    }
  };

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

            <MetricDebugCard
              label="Vibrato"
              score={result.scores.find((s) => s.key === 'vibrato')}
              rows={[
                ['Zero crossings', String(result.debug.vibrato.zeroCrossings)],
                ['Expected (5 Hz)', String(result.debug.vibrato.expectedCrossings)],
                ['Vibrato ratio', `${result.debug.vibrato.vibratoRatio.toFixed(3)}  (score = ratio × 80)`],
              ]}
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
