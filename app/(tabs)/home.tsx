import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  SafeAreaView,
} from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { Ionicons, FontAwesome6, Octicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useUserStore } from '../../src/store/useUserStore';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { TunerModal } from '../../src/components/tuner/TunerModal';
import { haptic } from '../../src/lib/haptics';
import { colors, spacing, radius } from '../../src/constants/theme';

const PLAN_DEPTH = 5;
const FAB_SIZE = 60;
const FAB_DEPTH = 5;

const PRACTICE_CATEGORIES: Array<{
  id: string;
  iconName: React.ComponentProps<typeof Ionicons>['name'] | string;
  iconLib: 'Ionicons' | 'FontAwesome6';
  label: string;
  count: number;
}> = [
  { id: 'bow',        iconLib: 'Ionicons',     iconName: 'musical-notes', label: 'Bow Technique',   count: 8 },
  { id: 'intonation', iconLib: 'Ionicons',     iconName: 'ear',           label: 'Intonation',      count: 6 },
  { id: 'tone',       iconLib: 'Ionicons',     iconName: 'volume-high',   label: 'Tone Quality',    count: 5 },
  { id: 'rhythm',     iconLib: 'FontAwesome6', iconName: 'drum',          label: 'Rhythm & Timing', count: 7 },
  { id: 'posture',    iconLib: 'Ionicons',     iconName: 'person',        label: 'Posture & Form',  count: 4 },
];

function CatIcon({ lib, name, size, color }: { lib: string; name: string; size: number; color: string }) {
  if (lib === 'FontAwesome6') return <FontAwesome6 name={name as any} size={size} color={color} />;
  return <Ionicons name={name as any} size={size} color={color} />;
}

export default function HomeScreen() {
  const [tunerOpen, setTunerOpen] = useState(false);

  const { profile } = useUserStore();
  const { isAuthenticated, guestAnalysesUsed, canAnalyzeAsGuest } = useAuthStore();
  const { reset, sessionHistory } = useAnalysisStore();

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

  const isSubscribed =
    profile?.subscriptionTier === 'monthly' || profile?.subscriptionTier === 'annual';
  const freeUsed = isAuthenticated ? (profile?.freeAnalysesUsed ?? 0) : guestAnalysesUsed;
  const canAnalyze =
    isSubscribed ||
    (!isAuthenticated && canAnalyzeAsGuest()) ||
    (isAuthenticated && (profile?.freeAnalysesUsed ?? 0) < 2);

  const handleNewAnalysis = () => {
    if (!canAnalyze) { router.push('/paywall'); return; }
    reset();
    router.push('/(tabs)/analyze');
  };

  // Plan card depth animation
  const planOffset = useSharedValue(0);
  const planSurfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: planOffset.value }],
  }));

  // FAB depth animation
  const fabOffset = useSharedValue(0);
  const fabSurfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: fabOffset.value }],
  }));

  const fabBottom = spacing.lg;

  return (
    <SafeAreaView style={s.safe}>
      <TunerModal visible={tunerOpen} onClose={() => setTunerOpen(false)} />


      <ScrollView
        contentContainerStyle={[s.scroll, { paddingBottom: fabBottom + FAB_SIZE + FAB_DEPTH + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Daily Practice Plan card ─────────────────── */}
        <Pressable
          onPressIn={() => { planOffset.value = PLAN_DEPTH; haptic.medium(); }}
          onPressOut={() => { planOffset.value = 0; }}
          onPress={() => router.push('/tips')}
          style={s.planCardOuter}
        >
          <View style={s.planCardBase} />
          <Animated.View style={[s.planCardSurface, planSurfaceStyle]}>
            <View style={s.planCardRow}>
              <View style={s.planCardTextWrap}>
                <Text style={s.planCardTitle}>Daily Practice Plan</Text>
                <Text style={s.planCardSub}>Personalized mix of exercises</Text>
              </View>
              <FontAwesome6 name="bullseye" size={30} color="rgba(255,255,255,0.9)" />
            </View>
            <View style={s.planCardMeta}>
              <Text style={s.planCardMetaText}>30 exercises  ·  ~25 min</Text>
              <Text style={s.planCardStart}>Start →</Text>
            </View>
          </Animated.View>
        </Pressable>

        {/* ── Stats + Tune row ─────────────────────────── */}
        <View style={s.subRow}>
          <View style={s.statCards}>
            {stats && (
              <>
                <Pressable style={s.statCard}>
                  <FontAwesome6 name="fire" size={28} color="#f97316" />
                  <Text style={s.statCardNum}>{stats.streak}</Text>
                </Pressable>
                <Pressable style={s.statCard}>
                  <Octicons name="star-fill" size={28} color="#f59e0b" />
                  <Text style={s.statCardNum}>{stats.avg}</Text>
                </Pressable>
              </>
            )}
          </View>
          <Pressable style={s.tunerBtn} onPress={() => setTunerOpen(true)}>
            <Text style={s.tunerBtnText}>♩ Tune</Text>
          </Pressable>
        </View>

        {/* ── Divider label ────────────────────────────── */}
        <Text style={s.orLabel}>Or, choose what to work on yourself</Text>

        {/* ── Category list ────────────────────────────── */}
        <View style={s.categoryBlock}>
          {PRACTICE_CATEGORIES.map((cat, i) => (
            <View key={cat.id}>
              {i > 0 && <View style={s.divider} />}
              <Pressable
                style={({ pressed }) => [s.categoryRow, pressed && s.categoryRowPressed]}
                onPress={() => { haptic.light(); router.push('/tips'); }}
              >
                <View style={s.categoryIconWrap}>
                  <CatIcon lib={cat.iconLib} name={cat.iconName} size={20} color={colors.brand[600]} />
                </View>
                <View style={s.categoryText}>
                  <Text style={s.categoryLabel}>{cat.label}</Text>
                  <Text style={s.categorySub}>{cat.count} exercises recommended</Text>
                </View>
                <Text style={s.categoryArrow}>›</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* ── FAB ──────────────────────────────────────────── */}
      <View style={[s.fabRow, { bottom: fabBottom }]} pointerEvents="box-none">
        <Text style={s.fabLabel}>Record new Session</Text>
        <View style={s.fabContainer}>
          <View style={s.fabBase} />
          <Pressable
            onPressIn={() => { fabOffset.value = FAB_DEPTH; haptic.medium(); }}
            onPressOut={() => { fabOffset.value = 0; }}
            onPress={handleNewAnalysis}
          >
            <Animated.View style={[s.fabSurface, fabSurfaceStyle]}>
              <Text style={s.fabPlus}>+</Text>
            </Animated.View>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },

  // Stats + Tune row (below plan card)
  subRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  statCards: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  statCard: {
    width: 76,
    height: 76,
    backgroundColor: '#fff',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderBottomWidth: 4,
    borderBottomColor: '#d1d5db',
  },
  statCardNum: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text.primary,
  },
  // Tune button
  tunerBtn: {
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
  tunerBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },

  // Scroll
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.lg,
  },

  // Plan card (depth effect: base + animated surface)
  planCardOuter: {
    height: 120 + PLAN_DEPTH,
    borderRadius: 18,
  },
  planCardBase: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 120,
    borderRadius: 18,
    backgroundColor: colors.brand[800],
  },
  planCardSurface: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 120,
    borderRadius: 18,
    backgroundColor: colors.brand[600],
    padding: spacing.md,
    justifyContent: 'space-between',
  },
  planCardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  planCardTextWrap: { flex: 1 },
  planCardTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#fff',
    marginBottom: 4,
  },
  planCardSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.75)',
    fontWeight: '500',
  },
  planCardEmoji: { fontSize: 36 },
  planCardMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  planCardMetaText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.65)',
    fontWeight: '600',
  },
  planCardStart: {
    fontSize: 14,
    fontWeight: '800',
    color: '#fff',
  },

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

  // FAB
  fabRow: {
    position: 'absolute',
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  fabLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.primary,
  },
  fabContainer: {
    width: FAB_SIZE,
    height: FAB_SIZE + FAB_DEPTH,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 10,
  },
  fabBase: {
    position: 'absolute',
    bottom: 0,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    backgroundColor: colors.brand[800],
  },
  fabSurface: {
    position: 'absolute',
    top: 0,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    backgroundColor: colors.brand[600],
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabPlus: {
    fontSize: 32,
    fontWeight: '300',
    color: '#fff',
    lineHeight: 36,
    marginTop: -2,
  },
});
