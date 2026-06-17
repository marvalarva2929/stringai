import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  SafeAreaView,
  Animated,
  PanResponder,
  Dimensions,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { AnalysisTimeline } from '../../src/components/analysis/AnalysisTimeline';
import { CoachingReport } from '../../src/components/analysis/CoachingReport';
import { InlineVideoPlayer } from '../../src/components/analysis/InlineVideoPlayer';
import { MetricCard } from '../../src/components/analysis/MetricCard';
import { colors, spacing } from '../../src/constants/theme';

const _SCREEN_H = Dimensions.get('window').height;
const DRAWER_DEFAULT_H = Math.round(_SCREEN_H * 0.55);
const DRAWER_MAX_H    = Math.round(_SCREEN_H * 0.85);
const DRAWER_MIN_H    = Math.round(_SCREEN_H * 0.25);

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionResultCache = useAnalysisStore((s) => s.sessionResultCache);
  const result = sessionResultCache[id];

  const [seekVersion, setSeekVersion] = useState(0);
  const [seekSeconds, setSeekSeconds] = useState(0);

  // Drawer state — mirrors the analyze.tsx results phase
  const drawerHeightRef = useRef(DRAWER_DEFAULT_H);
  const gestureStartHRef = useRef(DRAWER_DEFAULT_H);
  const drawerAnim = useRef(new Animated.Value(DRAWER_DEFAULT_H)).current;
  const cardScrollAtTopRef = useRef(true);
  const cardScrollAtBottomRef = useRef(false);
  const [cardsScrollEnabled, setCardsScrollEnabled] = useState(true);

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

  const handlePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => drawerGestureRef.current.onGrant(),
      onPanResponderMove: (_, gs) => drawerGestureRef.current.onMove(gs.dy),
      onPanResponderRelease: (_, gs) => drawerGestureRef.current.onRelease(gs.dy, gs.vy),
    })
  ).current;

  const contentShouldClaim = (gs: { dy: number; dx: number }) => {
    if (Math.abs(gs.dy) < 2) return false;
    if (Math.abs(gs.dx) >= Math.abs(gs.dy)) return false;
    if (gs.dy > 0 && cardScrollAtTopRef.current) return true;
    if (gs.dy < 0 && drawerHeightRef.current <= DRAWER_MIN_H + 10) return true;
    if (gs.dy < 0 && cardScrollAtBottomRef.current &&
        drawerHeightRef.current < DRAWER_MAX_H - 10) return true;
    return false;
  };

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

  const handleTimestampPress = (s: number) => {
    setSeekSeconds(s + 0.030);
    setSeekVersion((v) => v + 1);
    drawerHeightRef.current = DRAWER_MIN_H;
    setCardsScrollEnabled(false);
    Animated.spring(drawerAnim, { toValue: DRAWER_MIN_H, useNativeDriver: false, bounciness: 0 }).start();
  };

  if (!result) {
    return (
      <SafeAreaView style={styles.safe}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>Session not available</Text>
          <Text style={styles.emptyBody}>
            Full session data is only kept while the app is open. Once Supabase is connected, all sessions will be available here.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const dateLabel = new Date(result.recordedAt).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  const timeLabel = new Date(result.recordedAt).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
  });

  return (
    <SafeAreaView style={styles.resultsSafe}>
      {/* Back button floating over the video */}
      <Pressable style={styles.floatingBack} onPress={() => router.back()}>
        <Text style={styles.floatingBackText}>← Back</Text>
      </Pressable>

      {/* Video occupies the visible area above the drawer */}
      <Animated.View style={[styles.videoLayer, { bottom: drawerAnim }]}>
        {result.videoUri ? (
          <InlineVideoPlayer
            uri={result.videoUri}
            seekVersion={seekVersion}
            seekSeconds={seekSeconds}
            fullScreen
            noteEvents={result.noteEvents}
            durationSeconds={result.durationSeconds}
            onMarkerPress={handleTimestampPress}
          />
        ) : null}
      </Animated.View>

      {/* Swipeable bottom drawer */}
      <Animated.View style={[styles.drawer, { height: drawerAnim }]}>
        {/* Drag handle + session info */}
        <View style={styles.drawerHandleArea} {...handlePanResponder.panHandlers}>
          <View style={styles.drawerHandlePill} />
          <Text style={styles.drawerDate}>{dateLabel} · {timeLabel}</Text>
          {result.piece && (
            <Text style={styles.drawerPiece} numberOfLines={1}>
              🎵 {result.piece.title}{result.piece.composer ? ` · ${result.piece.composer}` : ''}
            </Text>
          )}
        </View>

        {/* Card carousel or fallback metric list */}
        <View style={styles.drawerContent} {...contentPanResponder.panHandlers}>
          {result.llmFeedback ? (
            <CoachingReport
              llmFeedback={result.llmFeedback}
              assessment={result.sessionAssessment}
              intonationAnalysis={result.intonationAnalysis}
              videoUri={result.videoUri}
              metrics={result.metrics}
              durationSeconds={result.durationSeconds}
              onTimestampPress={handleTimestampPress}
              cardScrollEnabled={cardsScrollEnabled}
              onCardScrollPosition={(atTop, atBottom) => {
                cardScrollAtTopRef.current = atTop;
                cardScrollAtBottomRef.current = atBottom;
              }}
            />
          ) : (
            <ScrollView
              style={styles.fallbackScroll}
              contentContainerStyle={styles.fallbackContent}
              showsVerticalScrollIndicator={false}
            >
              <AnalysisTimeline
                durationSeconds={result.durationSeconds}
                metrics={result.metrics}
                videoUri={result.videoUri}
                onSegmentPress={handleTimestampPress}
              />
              <Text style={styles.breakdownHeading}>Breakdown</Text>
              {result.metrics.map((metric) => (
                <MetricCard key={metric.key} metric={metric} sessionId={result.sessionId} />
              ))}
              <View style={{ height: spacing.xl }} />
            </ScrollView>
          )}
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  resultsSafe: { flex: 1, backgroundColor: '#1a0a2e' },

  floatingBack: {
    position: 'absolute',
    top: 12,
    left: spacing.xl,
    zIndex: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  floatingBackText: { color: '#fff', fontSize: 14, fontWeight: '500' },

  videoLayer: { position: 'absolute', top: 0, left: 0, right: 0 },

  drawer: {
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
    paddingBottom: 8,
    paddingHorizontal: 60,
  },
  drawerHandlePill: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d1d5db',
    marginBottom: 6,
  },
  drawerDate: { fontSize: 12, color: colors.text.muted, fontWeight: '500' },
  drawerPiece: {
    fontSize: 12,
    color: colors.text.secondary,
    fontStyle: 'italic',
    marginTop: 2,
  },
  drawerContent: { flex: 1 },

  // Empty-state back button (used only when result is missing)
  backBtn: { paddingVertical: 6, paddingHorizontal: spacing.xl },
  backText: { color: colors.brand[600], fontSize: 14, fontWeight: '500' },

  fallbackScroll: { flex: 1 },
  fallbackContent: { padding: spacing.lg, gap: spacing.md },
  breakdownHeading: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.sm,
  },

  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.text.primary },
  emptyBody: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 21,
  },
});
