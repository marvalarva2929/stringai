import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  SafeAreaView,
  Modal,
  TouchableWithoutFeedback,
  Dimensions,
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
import { computeStreak } from '../../src/lib/streak';
import { useDailyPracticePlan } from '../../src/hooks/useDailyPracticePlan';
import { useActivationStore } from '../../src/store/useActivationStore';
import { useSpotlightTarget } from '../../src/components/activation/useSpotlightTarget';
import { useSpotlightStore } from '../../src/components/activation/spotlightStore';
import { useCoachmarks } from '../../src/components/activation/useCoachmarks';
import { SpotlightOverlay } from '../../src/components/activation/SpotlightOverlay';
import { HOME_COACHMARKS } from '../../src/constants/activationScript';
import { haptic } from '../../src/lib/haptics';
import { colors, spacing, radius } from '../../src/constants/theme';

const PLAN_DEPTH = 6;
const SCREEN_H = Dimensions.get('window').height;

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

  // Always present — a brand-new user sees zeroes rather than an empty row.
  const stats = useMemo(() => {
    if (sessionHistory.length === 0) return { avg: 0, streak: 0 };
    const scores = sessionHistory.map((s) => s.overallScore);
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    return { avg, streak: computeStreak(sessionHistory) };
  }, [sessionHistory]);

  // Plan card depth animation
  const planOffset = useSharedValue(0);
  const planSurfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: planOffset.value }],
  }));

  // Record button depth animation — same mechanic as the plan card above.
  const recordOffset = useSharedValue(0);
  const recordSurfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: recordOffset.value }],
  }));

  // ── Activation stage 1 ───────────────────────────────────────
  //
  // The first thing after onboarding: point at the real buttons, in the order a
  // player would use them — warm up, check where you stand, record.
  const activationStep = useActivationStore((st) => st.step);
  const planSpotlight = useSpotlightTarget('home.plan');
  const statsSpotlight = useSpotlightTarget('home.stats');
  const recordSpotlight = useSpotlightTarget('home.record');
  const coach = useCoachmarks(HOME_COACHMARKS, activationStep === 'home', () => {
    // The last step is the Practice button, so take them there rather than
    // leaving them to find it again on their own. Deliberately straight to the
    // capture screen and not through /practice/pick: a first-run user has no
    // pieces yet, so the picker would be an empty list with one button on it.
    useActivationStore.getState().advanceTo('capture');
    router.push('/(tabs)/analyze');
  });

  // Bring the highlighted element into view before spotlighting it. The record
  // button sits below the fold on shorter screens, and a cutout over something
  // scrolled off-screen is worse than no cutout at all.
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  const activeTargetId = coach.step?.targetId;
  // Subscribed rather than read once: on the first step the rect usually lands
  // after this effect would have run, and re-running on the measurement is what
  // makes the scroll reliable. It converges — once the target is inside the
  // band, delta is 0 and the effect stops moving anything.
  const activeRect = useSpotlightStore((st) => (activeTargetId ? st.rects[activeTargetId] : undefined));

  useEffect(() => {
    const rect = activeRect;
    if (!activeTargetId || !rect) return;

    const topBound = SCREEN_H * 0.16;
    const bottomBound = SCREEN_H * 0.55;
    let delta = 0;
    if (rect.y < topBound) delta = rect.y - topBound;
    else if (rect.y + rect.height > bottomBound) delta = rect.y + rect.height - bottomBound;
    if (delta === 0) return;

    scrollRef.current?.scrollTo({ y: Math.max(0, scrollYRef.current + delta), animated: true });
    // Scrolling doesn't fire onLayout, so the rects are stale until we ask — and
    // asking mid-animation is worse than not asking, since the element is still
    // moving. The scroll-end handlers do the real work; this is the backstop.
    const t = setTimeout(() => useSpotlightStore.getState().remeasure(), 900);
    return () => clearTimeout(t);
  }, [activeTargetId, activeRect]);

  return (
    <SafeAreaView style={s.safe}>
      <TunerModal visible={tunerOpen} onClose={() => setTunerOpen(false)} />

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(e) => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
        onScrollEndDrag={() => useSpotlightStore.getState().remeasure()}
        onMomentumScrollEnd={() => useSpotlightStore.getState().remeasure()}
      >
        {/* ── Welcome header ───────────────────────────── */}
        <Text style={s.welcome}>Welcome!</Text>

        {/* ── Streak / avg / tune pills ────────────────── */}
        <View style={s.pillRow}>
          <View style={s.pillGroup} {...statsSpotlight}>
            <Pressable style={s.pillLight} onPress={() => { haptic.light(); setInfoPopup('streak'); }}>
              <FontAwesome6 name="fire" size={16} color="#f97316" />
              <Text style={s.pillLightText}>{stats.streak}</Text>
            </Pressable>
            <Pressable style={s.pillLight} onPress={() => { haptic.light(); setInfoPopup('score'); }}>
              <Octicons name="star-fill" size={16} color="#f59e0b" />
              <Text style={s.pillLightText}>{stats.avg}</Text>
            </Pressable>
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
          {...planSpotlight}
        >
          <View style={s.planCardBase} />
          <Animated.View style={[s.planCardSurface, planSurfaceStyle]}>
            <View style={s.planCardRow}>
              <View style={s.planCardTextWrap}>
                <Text style={s.planCardTitle}>Daily Warm-Up</Text>
                <Text style={s.planCardSub}>{dailyPlan.primaryFocus}</Text>
              </View>
              <FontAwesome6 name="bullseye" size={40} color="rgba(255,255,255,0.9)" />
            </View>
            <View style={s.planCardMeta}>
              <Text style={s.planCardMetaText}>{dailyPlan.blocks.length} exercises  ·  ~{dailyPlan.durationMinutes} min</Text>
              <Text style={s.planCardStart}>Start →</Text>
            </View>
          </Animated.View>
        </Pressable>

        {/* ── Practice button ──────────────────────────── */}
        {/* One label, whether or not there is history: choosing what to play is
            the picker's job, not this button's. */}
        <Pressable
          onPressIn={() => { recordOffset.value = PLAN_DEPTH; haptic.medium(); }}
          onPressOut={() => { recordOffset.value = 0; }}
          onPress={() => router.push('/practice/pick')}
          style={s.recordButtonOuter}
          {...recordSpotlight}
        >
          <View style={s.recordButtonBase} />
          <Animated.View style={[s.recordButtonSurface, recordSurfaceStyle]}>
            <FontAwesome6 name="microphone" size={16} color="#fff" />
            <Text style={s.recordButtonText}>Practice</Text>
          </Animated.View>
        </Pressable>

        {/* ── Weekly goal card ─────────────────────────── */}
        <WeeklyGoalCard
          goalMinutes={goalMinutes}
          minutesThisWeek={minutesThisWeek}
          onPress={() => router.push('/goal')}
        />

      </ScrollView>

      <SpotlightOverlay
        steps={HOME_COACHMARKS}
        index={coach.index}
        onNext={coach.next}
        onSkip={coach.skip}
        blocking={activationStep === 'home'}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },

  // Welcome header — its own row, so it's free to be a full screen title.
  // Negative margin pulls the pill row up out of the scroll container's gap.
  welcome: {
    fontSize: 34,
    fontWeight: '900',
    color: colors.text.primary,
    textAlign: 'left',
    marginBottom: -spacing.md,
  },

  // Streak / avg / tune pill row (above plan card)
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pillGroup: {
    flexDirection: 'row',
    alignItems: 'center',
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
    // 1.5/3px borders make up the rest of the Tune pill's 8pt vertical
    // padding, so both pills land on the same height.
    paddingVertical: 6,
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

  // Pinned piece card — same bordered/pressed popout edge as WeeklyGoalCard
  // and the pillLight buttons above, so every card on this screen reads as
  // one consistent "button" language.
  pieceCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderBottomWidth: 4,
    borderBottomColor: '#d1d5db',
    padding: spacing.md,
    gap: 4,
  },
  pieceCardPressed: { backgroundColor: '#f9fafb' },
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

  // Record session button — same depth effect (base + animated surface) as
  // the plan card above, just sized for a single-row button.
  recordButtonOuter: {
    height: 56 + PLAN_DEPTH,
    borderRadius: 22,
    marginTop: -spacing.lg / 2,
  },
  recordButtonBase: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 56,
    borderRadius: 22,
    backgroundColor: colors.brand[800],
  },
  recordButtonSurface: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 56,
    borderRadius: 22,
    backgroundColor: colors.brand[600],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  recordButtonText: { fontSize: 15, fontWeight: '800', color: '#fff' },

  // Or label

  // Placeholder shown until the first session is recorded

});
