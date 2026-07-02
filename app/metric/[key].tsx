import React from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { MetricKey, severityFromScore } from '../../src/types/analysis';
import { METRIC_META } from '../../src/constants/metricMeta';
import { ScoreGauge } from '../../src/components/ui/ScoreGauge';
import { AnalysisTimeline } from '../../src/components/analysis/AnalysisTimeline';
import { MetricSparkline } from '../../src/components/analysis/MetricSparkline';
import { colors, spacing, radius } from '../../src/constants/theme';

export default function MetricDetailScreen() {
  const { key, sessionId } = useLocalSearchParams<{ key: string; sessionId?: string }>();
  const metricKey = key as MetricKey;

  const currentResult = useAnalysisStore((s) => s.currentResult);
  const sessionResultCache = useAnalysisStore((s) => s.sessionResultCache);
  const metricHistory = useAnalysisStore((s) => s.metricHistory);

  const result = sessionId ? (sessionResultCache[sessionId] ?? currentResult) : currentResult;
  const metric = result?.metrics.find((m) => m.key === metricKey);
  const meta = METRIC_META[metricKey];

  // Last 5 sessions for sparkline, oldest-first so the chart reads left→right
  const sparklineData = metricHistory
    .slice(0, 5)
    .map((h) => ({
      score: h.scores.find((s) => s.key === metricKey)?.score ?? 0,
      recordedAt: h.recordedAt,
    }))
    .reverse();

  if (!result || !metric || !meta) {
    return (
      <SafeAreaView style={styles.safe}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>No session data. Complete an analysis first.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const deltaColor =
    metric.delta == null ? colors.text.muted
    : metric.delta > 0 ? colors.score.excellent
    : metric.delta < 0 ? colors.score.critical
    : colors.text.muted;

  const deltaLabel =
    metric.delta == null ? null
    : metric.delta > 0 ? `▲ +${metric.delta}%`
    : metric.delta < 0 ? `▼ ${metric.delta}%`
    : null;

  const severityLabel: Record<string, string> = {
    excellent: 'Excellent',
    good: 'Good',
    needs_attention: 'Needs Attention',
    critical: 'Critical',
  };

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient colors={[colors.brand[900], colors.brand[800]]} style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <View style={styles.headerBody}>
          <View style={styles.titleRow}>
            <Text style={styles.icon}>{meta.icon}</Text>
            <Text style={styles.title}>{meta.label}</Text>
          </View>
          <View style={styles.scoreRow}>
            <ScoreGauge score={metric.score} severity={metric.severity} size="lg" />
            <View style={styles.scoreLabels}>
              <View style={[styles.severityBadge, { backgroundColor: colors.score[metric.severity] }]}>
                <Text style={styles.severityText}>{severityLabel[metric.severity]}</Text>
              </View>
              {deltaLabel && (
                <Text style={[styles.deltaText, { color: deltaColor }]}>{deltaLabel} vs prev</Text>
              )}
            </View>
          </View>
          <Text style={styles.tipText}>{meta.tips[metric.severity]}</Text>
        </View>
      </LinearGradient>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Timeline — filtered to this metric only */}
        <SectionHeader label="This Session" />
        <AnalysisTimeline
          durationSeconds={result.durationSeconds}
          metrics={[metric]}
        />

        {/* Flagged timestamps */}
        {metric.flaggedTimestamps.length > 0 ? (
          <View style={styles.timestampList}>
            {metric.flaggedTimestamps.map((ts, i) => (
              <View key={i} style={styles.timestampRow}>
                <Text style={styles.timestampTime}>
                  {formatTime(ts.startSeconds)}–{formatTime(ts.endSeconds)}
                </Text>
                <Text style={styles.timestampNote}>{ts.note}</Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.noIssues}>
            <Text style={styles.noIssuesText}>No issues flagged in this session.</Text>
          </View>
        )}

        {/* Sparkline — shown once there are at least 2 past sessions */}
        {sparklineData.length >= 2 && (
          <>
            <SectionHeader label={`Progress — last ${sparklineData.length} sessions`} />
            <View style={styles.sparklineCard}>
              <MetricSparkline data={sparklineData} />
            </View>
          </>
        )}

        {/* How to fix drill */}
        <SectionHeader label="How to Fix" />
        <View style={styles.drillCard}>
          <Text style={styles.drillText}>{meta.drill}</Text>
          <Pressable
            onPress={() => router.push({ pathname: '/tips', params: { focusMetric: metricKey } })}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <Text style={styles.drillCTA}>Browse exercises for {meta.label} →</Text>
          </Pressable>
        </View>

        <View style={styles.bottomPad} />
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <Text style={styles.sectionHeader}>{label}</Text>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },

  header: {
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.xl,
  },
  backBtn: { paddingTop: spacing.md, paddingBottom: spacing.sm },
  backText: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: '500' },
  headerBody: { gap: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  icon: { fontSize: 24 },
  title: { fontSize: 22, fontWeight: '700', color: '#fff' },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  scoreLabels: { gap: spacing.xs },
  severityBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  severityText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  deltaText: { fontSize: 13, fontWeight: '600' },
  tipText: { fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 19 },

  scroll: { flex: 1 },
  scrollContent: { padding: spacing.lg },

  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },

  timestampList: { gap: spacing.xs },
  timestampRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#f8f7ff',
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  timestampTime: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.brand[600],
    width: 78,
    flexShrink: 0,
  },
  timestampNote: { fontSize: 13, color: colors.text.secondary, flex: 1, lineHeight: 18 },

  noIssues: {
    backgroundColor: '#f0fdf4',
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: '#86efac',
  },
  noIssuesText: { fontSize: 13, color: '#166534', fontWeight: '500' },

  sparklineCard: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },

  drillCard: {
    backgroundColor: colors.brand[50],
    borderRadius: radius.lg,
    padding: spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.brand[400],
  },
  drillText: { fontSize: 14, color: colors.brand[900], lineHeight: 21 },
  drillCTA: { fontSize: 13, fontWeight: '600', color: colors.brand[600], marginTop: spacing.sm },

  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { fontSize: 15, color: colors.text.secondary, textAlign: 'center' },

  bottomPad: { height: spacing.xl },
});
