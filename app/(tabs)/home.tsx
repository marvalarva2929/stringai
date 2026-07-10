import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  SafeAreaView,
  Modal,
  TouchableWithoutFeedback,
} from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { FontAwesome6, Octicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useUserStore } from '../../src/store/useUserStore';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { TunerModal } from '../../src/components/tuner/TunerModal';
import { WeeklyGoalCard } from '../../src/components/home/WeeklyGoalCard';
import { minutesPracticedThisWeek } from '../../src/lib/weeklyGoal';
import { useDailyPracticePlan } from '../../src/hooks/useDailyPracticePlan';
import { metricLabel, metricIcon } from '../../src/lib/practicePlan';
import { haptic } from '../../src/lib/haptics';
import { colors, spacing, radius } from '../../src/constants/theme';

const PLAN_DEPTH = 6;

const PILL_INFO: Record<'streak' | 'score', { icon: React.ReactNode; title: string; body: string }> = {
  streak: {
    icon: <FontAwesome6 name="fire" size={28} color="#f97316" />,
    title: 'Practice Streak',
    body: 'The number of days in a row you’ve completed a session. Practice today to keep it going — miss a day and it resets to zero.',
  },
  score: {
    icon: <Octicons name="star-fill" size={28} color="#f59e0b" />,
    title: 'Average Score',
    body: 'Your overall score averaged across every session you’ve recorded. It updates automatically as you practice more.',
  },
};

export default function HomeScreen() {
  const [tunerOpen, setTunerOpen] = useState(false);
  const [infoPopup, setInfoPopup] = useState<'streak' | 'score' | null>(null);

  const { profile } = useUserStore();
  const { weeklyGoalMinutes } = useAuthStore();
  const { sessionHistory } = useAnalysisStore();
  const dailyPlan = useDailyPracticePlan();
  const currentPiece = profile?.currentPiece;

  const goalMinutes = profile?.weeklyGoalMinutes ?? weeklyGoalMinutes;
  const minutesThisWeek = useMemo(
    () => minutesPracticedThisWeek(sessionHistory),
    [sessionHistory],
  );

  // Real "focus areas" derived from analysis — replaces the old hardcoded list.
  const focusAreas = useMemo(
    () => dailyPlan.weakAreas.map((w) => ({
      metricKey: w.metricKey,
      label: metricLabel(w.metricKey),
      icon: metricIcon(w.metricKey),
      count: w.exercises.length,
      avgScore: Math.round(w.avgScore),
    })),
    [dailyPlan.weakAreas],
  );

  const stats = useMemo(() => {
    if (sessionHistory.length === 0) return null;
    const scores = sessionHistory.map((s) => s.overallScore);
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    const DAY = 86_400_000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dates = new Set(sessionHistory.map((s) => {
      const d = new Date(s.recordedAt); d.setHours(0, 0, 0, 0); return d.getTime();
    }));
    let check = today.getTime();
    if (!dates.has(check)) { check -= DAY; if (!dates.has(check)) return { avg, streak: 0 }; }
    let streak = 0;
    while (dates.has(check)) { streak++; check -= DAY; }
    return { avg, streak };
  }, [sessionHistory]);

  // Plan card depth animation
  const planOffset = useSharedValue(0);
  const planSurfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: planOffset.value }],
  }));

  return (
    <SafeAreaView style={s.safe}>
      <TunerModal visible={tunerOpen} onClose={() => setTunerOpen(false)} />

      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Streak / avg / tune pills ────────────────── */}
        <View style={s.pillRow}>
          <View style={s.pillGroup}>
            {stats && (
              <>
                <Pressable style={s.pillLight} onPress={() => { haptic.light(); setInfoPopup('streak'); }}>
                  <FontAwesome6 name="fire" size={16} color="#f97316" />
                  <Text style={s.pillLightText}>{stats.streak}</Text>
                </Pressable>
                <Pressable style={s.pillLight} onPress={() => { haptic.light(); setInfoPopup('score'); }}>
                  <Octicons name="star-fill" size={16} color="#f59e0b" />
                  <Text style={s.pillLightText}>{stats.avg}</Text>
                </Pressable>
              </>
            )}
          </View>
          <Pressable style={s.pill} onPress={() => setTunerOpen(true)}>
            <Text style={s.pillText}>♩ Tune</Text>
          </Pressable>
        </View>

        {/* ── Streak / score info popup ─────────────────── */}
        <Modal visible={infoPopup !== null} transparent animationType="fade" onRequestClose={() => setInfoPopup(null)}>
          <TouchableWithoutFeedback onPress={() => setInfoPopup(null)}>
            <View style={s.popupBackdrop}>
              <TouchableWithoutFeedback>
                <View style={s.popupCard}>
                  {infoPopup && (
                    <>
                      {PILL_INFO[infoPopup].icon}
                      <Text style={s.popupTitle}>{PILL_INFO[infoPopup].title}</Text>
                      <Text style={s.popupBody}>{PILL_INFO[infoPopup].body}</Text>
                    </>
                  )}
                  <Pressable style={s.popupCloseBtn} onPress={() => setInfoPopup(null)}>
                    <Text style={s.popupCloseText}>Got it</Text>
                  </Pressable>
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>

        {/* ── Pinned piece card ────────────────────────── */}
        {currentPiece && (
          <Pressable
            style={({ pressed }) => [s.pieceCard, pressed && s.pieceCardPressed]}
            onPress={() => { haptic.medium(); router.push({ pathname: '/practice/plan', params: { pieceId: currentPiece.pieceId } }); }}
          >
            <View style={s.pieceCardTop}>
              <View style={s.pieceBadge}>
                <FontAwesome6 name="music" size={13} color={colors.brand[700]} />
                <Text style={s.pieceBadgeText}>Currently practicing</Text>
              </View>
              <FontAwesome6 name="chevron-right" size={13} color={colors.text.muted} />
            </View>
            <Text style={s.pieceTitle} numberOfLines={1}>{currentPiece.title}</Text>
            {currentPiece.composer ? <Text style={s.pieceComposer}>{currentPiece.composer}</Text> : null}
            {currentPiece.goals ? <Text style={s.pieceGoals} numberOfLines={2}>“{currentPiece.goals}”</Text> : null}
            <Text style={s.pieceCta}>Warm up before you play →</Text>
          </Pressable>
        )}

        {/* ── Daily Practice Plan card — the main focus ──── */}
        <Pressable
          onPressIn={() => { planOffset.value = PLAN_DEPTH; haptic.medium(); }}
          onPressOut={() => { planOffset.value = 0; }}
          onPress={() => router.push('/(tabs)/train')}
          style={s.planCardOuter}
        >
          <View style={s.planCardBase} />
          <Animated.View style={[s.planCardSurface, planSurfaceStyle]}>
            <View style={s.planCardRow}>
              <View style={s.planCardTextWrap}>
                <Text style={s.planCardTitle}>Daily Practice Plan</Text>
                <Text style={s.planCardSub}>{dailyPlan.primaryFocus}</Text>
              </View>
              <FontAwesome6 name="bullseye" size={40} color="rgba(255,255,255,0.9)" />
            </View>
            <View style={s.planCardMeta}>
              <Text style={s.planCardMetaText}>{dailyPlan.blocks.length} blocks  ·  ~{dailyPlan.durationMinutes} min</Text>
              <Text style={s.planCardStart}>Start →</Text>
            </View>
          </Animated.View>
        </Pressable>

        {/* ── Weekly goal card ─────────────────────────── */}
        <WeeklyGoalCard
          goalMinutes={goalMinutes}
          minutesThisWeek={minutesThisWeek}
          onPress={() => router.push('/goal')}
        />

        {/* ── Focus areas (real, from analysis) ────────── */}
        {focusAreas.length > 0 && (
          <>
            <Text style={s.orLabel}>Focus areas from your recent sessions</Text>
            <View style={s.categoryBlock}>
              {focusAreas.map((area, i) => (
                <View key={area.metricKey}>
                  {i > 0 && <View style={s.divider} />}
                  <Pressable
                    style={({ pressed }) => [s.categoryRow, pressed && s.categoryRowPressed]}
                    onPress={() => { haptic.light(); router.push('/(tabs)/train'); }}
                  >
                    <View style={s.categoryIconWrap}>
                      <Text style={s.categoryEmoji}>{area.icon}</Text>
                    </View>
                    <View style={s.categoryText}>
                      <Text style={s.categoryLabel}>{area.label}</Text>
                      <Text style={s.categorySub}>{area.count} drills · scoring {area.avgScore}</Text>
                    </View>
                    <Text style={s.categoryArrow}>›</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },

  // Streak / avg / tune pill row (above plan card)
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pillGroup: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.brand[600],
    borderRadius: radius.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: colors.brand[800],
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 4,
  },
  pillText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
  pillLight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    borderRadius: radius.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderBottomWidth: 3,
    borderBottomColor: '#d1d5db',
  },
  pillLightText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
  },

  // Streak/score info popup
  popupBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  popupCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: radius.xl,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  popupTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text.primary,
    marginTop: 4,
  },
  popupBody: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  popupCloseBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.brand[600],
    borderRadius: radius.full,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  popupCloseText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },

  // Scroll
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },

  // Plan card (depth effect: base + animated surface) — the home screen's
  // main focus, so it's sized well above every other card.
  planCardOuter: {
    height: 210 + PLAN_DEPTH,
    borderRadius: 22,
  },
  planCardBase: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 210,
    borderRadius: 22,
    backgroundColor: colors.brand[800],
  },
  planCardSurface: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 210,
    borderRadius: 22,
    backgroundColor: colors.brand[600],
    padding: spacing.lg,
    justifyContent: 'space-between',
  },
  planCardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  planCardTextWrap: { flex: 1 },
  planCardTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#fff',
    marginBottom: 6,
  },
  planCardSub: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.8)',
    fontWeight: '500',
  },
  planCardEmoji: { fontSize: 36 },
  planCardMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  planCardMetaText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.65)',
    fontWeight: '600',
  },
  planCardStart: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fff',
  },

  // Pinned piece card
  pieceCard: {
    backgroundColor: colors.brand[50],
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderColor: colors.brand[100],
    padding: spacing.md,
    gap: 4,
  },
  pieceCardPressed: { opacity: 0.85 },
  pieceCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pieceBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pieceBadgeText: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.brand[700],
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  pieceTitle: { fontSize: 22, fontWeight: '900', color: colors.text.primary, marginTop: 4 },
  pieceComposer: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
  pieceGoals: { fontSize: 13, fontStyle: 'italic', color: colors.text.secondary, marginTop: 6 },
  pieceCta: { fontSize: 14, fontWeight: '800', color: colors.brand[700], marginTop: spacing.sm },

  // Or label
  orLabel: {
    fontSize: 13,
    color: colors.text.muted,
    fontWeight: '500',
    textAlign: 'center',
    marginVertical: -spacing.sm,
  },

  // Category list
  categoryBlock: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e5e7eb',
    marginLeft: 56,
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  categoryRowPressed: {
    backgroundColor: '#f9fafb',
  },
  categoryIconWrap: { width: 32, alignItems: 'center' },
  categoryEmoji: { fontSize: 20 },
  categoryText: { flex: 1 },
  categoryLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: 2,
  },
  categorySub: {
    fontSize: 12,
    color: colors.text.muted,
  },
  categoryArrow: {
    fontSize: 20,
    color: colors.text.muted,
    fontWeight: '300',
  },
});
