import React, { useState } from 'react';
import { View, Pressable, StyleSheet, Text, Alert } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { MetricScore } from '../../types/analysis';
import { colors, spacing } from '../../constants/theme';
import { VideoReplayModal } from './VideoReplayModal';

interface Segment {
  startSeconds: number;
  endSeconds: number;
  issueCount: number;
}

interface AnalysisTimelineProps {
  durationSeconds: number;
  metrics: MetricScore[];
  videoUri?: string;
  onSegmentPress?: (startSeconds: number) => void;
}

export function AnalysisTimeline({ durationSeconds, metrics, videoUri, onSegmentPress }: AnalysisTimelineProps) {
  const segments = buildSegments(durationSeconds, metrics);
  const [replaySeek, setReplaySeek] = useState<number | null>(null);

  const handleSegmentPress = async (startSeconds: number, issueCount: number) => {
    if (issueCount === 0) return;
    const seekTo = Math.max(0, startSeconds - 0.4);
    if (onSegmentPress) {
      // Carousel mode: parent controls the inline player — no modal needed
      onSegmentPress(seekTo);
      return;
    }
    // Standalone mode: open internal VideoReplayModal
    if (!videoUri) return;
    if (!videoUri.startsWith('ph://')) {
      const info = await FileSystem.getInfoAsync(videoUri);
      if (!info.exists) {
        Alert.alert('Video unavailable', 'The recording file is no longer on this device.');
        return;
      }
    }
    setReplaySeek(seekTo);
  };

  const hasIssues = segments.some((s) => s.issueCount > 0);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>Session Timeline</Text>
        {videoUri && hasIssues && (
          <Text style={styles.replayHint}>▶ Tap a segment to replay</Text>
        )}
      </View>
      <View style={styles.bar}>
        {segments.map((seg, i) => (
          <Pressable
            key={i}
            style={[
              styles.segment,
              { flex: (seg.endSeconds - seg.startSeconds) / durationSeconds },
              { backgroundColor: segmentColor(seg.issueCount) },
              videoUri && seg.issueCount > 0 ? styles.segmentTappable : undefined,
            ]}
            onPress={() => handleSegmentPress(seg.startSeconds, seg.issueCount)}
          />
        ))}
      </View>
      <View style={styles.legend}>
        {LEGEND_ITEMS.map((item) => (
          <View key={item.label} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: item.color }]} />
            <Text style={styles.legendText}>{item.label}</Text>
          </View>
        ))}
      </View>

      {videoUri && (
        <VideoReplayModal
          visible={replaySeek !== null}
          videoUri={videoUri}
          seekToSeconds={replaySeek ?? 0}
          label="Session replay"
          onClose={() => setReplaySeek(null)}
        />
      )}
    </View>
  );
}

function buildSegments(duration: number, metrics: MetricScore[]): Segment[] {
  const SEGMENT_SIZE = 5;
  const count = Math.ceil(duration / SEGMENT_SIZE);
  const segments: Segment[] = Array.from({ length: count }, (_, i) => ({
    startSeconds: i * SEGMENT_SIZE,
    endSeconds: Math.min((i + 1) * SEGMENT_SIZE, duration),
    issueCount: 0,
  }));

  for (const metric of metrics) {
    for (const ts of metric.flaggedTimestamps) {
      for (const seg of segments) {
        if (ts.startSeconds < seg.endSeconds && ts.endSeconds > seg.startSeconds) {
          seg.issueCount++;
        }
      }
    }
  }

  return segments;
}

function segmentColor(issueCount: number): string {
  if (issueCount === 0) return colors.score.excellent;
  if (issueCount === 1) return colors.score.good;
  if (issueCount === 2) return colors.score.needs_attention;
  return colors.score.critical;
}

const LEGEND_ITEMS = [
  { label: 'Great', color: colors.score.excellent },
  { label: 'Minor', color: colors.score.good },
  { label: 'Issue', color: colors.score.needs_attention },
  { label: 'Critical', color: colors.score.critical },
];

const styles = StyleSheet.create({
  container: { marginVertical: spacing.md },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  label: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
  replayHint: { fontSize: 11, color: colors.brand[600], fontWeight: '500' },
  bar: { flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', gap: 1 },
  segment: { height: '100%' },
  segmentTappable: { opacity: 0.92 },
  legend: { flexDirection: 'row', marginTop: spacing.xs, gap: spacing.md },
  legendItem: { flexDirection: 'row', alignItems: 'center' },
  legendDot: { width: 8, height: 8, borderRadius: 4, marginRight: 4 },
  legendText: { fontSize: 11, color: colors.text.muted },
});
