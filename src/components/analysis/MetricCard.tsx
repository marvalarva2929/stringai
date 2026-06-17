import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, LayoutAnimation } from 'react-native';
import { router } from 'expo-router';
import { Card } from '../ui/Card';
import { ScoreGauge } from '../ui/ScoreGauge';
import { colors, spacing } from '../../constants/theme';
import { MetricScore } from '../../types/analysis';
import { METRIC_META } from '../../constants/metricMeta';

interface MetricCardProps {
  metric: MetricScore;
  sessionId?: string;
}

export function MetricCard({ metric, sessionId }: MetricCardProps) {
  const [expanded, setExpanded] = useState(false);
  const meta = METRIC_META[metric.key];
  const unavailable = metric.measurementQuality === 'unavailable';
  const lowVisibility = metric.measurementQuality === 'low';

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => !prev);
  };

  const deltaColor =
    metric.delta == null ? colors.text.muted
    : metric.delta > 0 ? colors.score.excellent
    : metric.delta < 0 ? colors.score.critical
    : colors.text.muted;

  const deltaLabel =
    metric.delta == null ? ''
    : metric.delta > 0 ? `▲ +${metric.delta}%`
    : metric.delta < 0 ? `▼ ${metric.delta}%`
    : '—';

  return (
    <Pressable onPress={toggle} style={styles.wrapper}>
      <Card>
        <View style={styles.row}>
          <View style={styles.info}>
            <Text style={styles.icon}>{meta.icon}</Text>
            <View style={styles.textBlock}>
              <Text style={styles.title}>{meta.label}</Text>
              {unavailable ? (
                <Text style={styles.unavailableLabel}>Not available yet</Text>
              ) : lowVisibility ? (
                <Text style={styles.lowVisibilityLabel}>Limited arm visibility</Text>
              ) : (
                <Text style={[styles.delta, { color: deltaColor }]}>{deltaLabel}</Text>
              )}
            </View>
          </View>
          {unavailable ? (
            <View style={styles.unavailableBadge}>
              <Text style={styles.unavailableBadgeText}>—</Text>
            </View>
          ) : (
            <ScoreGauge score={metric.score} severity={metric.severity} size="sm" />
          )}
        </View>

        {expanded && (
          <View style={styles.expanded}>
            <View style={styles.divider} />
            {unavailable ? (
              <Text style={styles.unavailableSummary}>{metric.observationSummary}</Text>
            ) : (
              <>
                {lowVisibility && (
                  <View style={styles.lowVisibilityBanner}>
                    <Text style={styles.lowVisibilityBannerText}>
                      Arms were partly out of frame — results may be less accurate. Try stepping back so both elbows are visible.
                    </Text>
                  </View>
                )}
                <Text style={styles.tip}>{meta.tips[metric.severity]}</Text>
              </>
            )}
            {!unavailable && metric.flaggedTimestamps.slice(0, 2).map((ts, i) => (
              <View key={i} style={styles.timestamp}>
                <Text style={styles.timestampTime}>
                  {formatTime(ts.startSeconds)}–{formatTime(ts.endSeconds)}
                </Text>
                <Text style={styles.timestampNote}>{ts.note}</Text>
              </View>
            ))}
            {!unavailable && (
            <Pressable
              style={styles.detailLink}
              onPress={() => router.push({
                pathname: '/metric/[key]',
                params: { key: metric.key, ...(sessionId ? { sessionId } : {}) },
              })}
            >
              <Text style={styles.detailLinkText}>Full breakdown →</Text>
            </Pressable>
            )}
          </View>
        )}
      </Card>
    </Pressable>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  wrapper: { marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  info: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: spacing.sm },
  icon: { fontSize: 22, marginRight: spacing.sm },
  textBlock: { flex: 1 },
  title: { fontSize: 15, fontWeight: '600', color: colors.text.primary },
  delta: { fontSize: 12, fontWeight: '500', marginTop: 2 },
  unavailableLabel: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
  lowVisibilityLabel: { fontSize: 12, color: '#b45309', marginTop: 2 },
  lowVisibilityBanner: {
    backgroundColor: '#fef3c7',
    borderRadius: 6,
    padding: 8,
    marginBottom: spacing.sm,
  },
  lowVisibilityBannerText: { fontSize: 12, color: '#92400e', lineHeight: 17 },
  unavailableBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#f0eeff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  unavailableBadgeText: { fontSize: 18, color: colors.text.muted, fontWeight: '600' },
  unavailableSummary: { fontSize: 13, color: colors.text.secondary, lineHeight: 19 },
  expanded: { marginTop: spacing.sm },
  divider: { height: 1, backgroundColor: '#f0eeff', marginBottom: spacing.sm },
  tip: { fontSize: 13, color: colors.text.secondary, lineHeight: 19 },
  detailLink: { marginTop: spacing.sm, alignSelf: 'flex-end' },
  detailLinkText: { fontSize: 13, fontWeight: '600', color: colors.brand[600] },
  timestamp: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xs,
    backgroundColor: '#f8f7ff',
    borderRadius: 6,
    padding: 8,
  },
  timestampTime: { fontSize: 12, fontWeight: '600', color: colors.brand[600], marginRight: spacing.sm, width: 72 },
  timestampNote: { fontSize: 12, color: colors.text.secondary, flex: 1 },
});
