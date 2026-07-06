import React, { useRef, useState } from 'react';
import {
  View,
  FlatList,
  Pressable,
  Text,
  StyleSheet,
  Dimensions,
  ListRenderItem,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/store/useAuthStore';
import { OnboardingSlide, SlideData } from '../../src/components/onboarding/OnboardingSlide';
import { Ionicons, FontAwesome6, MaterialCommunityIcons } from '@expo/vector-icons';
import { BigButton } from '../../src/components/ui/BigButton';
import { MaestroAvatar } from '../../src/components/ui/MaestroAvatar';
import { haptic } from '../../src/lib/haptics';
import { colors, spacing, radius } from '../../src/constants/theme';
import { PlayerCategory } from '../../src/types/analysis';
import { CommitmentPicker } from '../../src/components/onboarding/CommitmentPicker';
import { GoalTier } from '../../src/lib/weeklyGoal';

const { width } = Dimensions.get('window');

const INFO_SLIDES: SlideData[] = [
  {
    icon: <Ionicons name="musical-notes" size={72} color="rgba(255,255,255,0.9)" />,
    title: 'Meet Your AI\nViolin Teacher',
    subtitle: 'Real feedback, anytime.',
    body: 'StringAI listens to your playing and shows you exactly what to improve — no lesson required.',
  },
  {
    icon: <Ionicons name="search" size={72} color="rgba(255,255,255,0.9)" />,
    title: 'How It Works',
    subtitle: 'Record → Analyze → Improve',
    body: 'Record a 30–90 second clip of yourself playing. StringAI analyzes your intonation, tone, bow technique, rhythm, and posture.',
  },
  {
    icon: <Ionicons name="trending-up" size={72} color="rgba(255,255,255,0.9)" />,
    title: 'Track Your Progress',
    subtitle: 'See yourself getting better.',
    body: 'Every session is scored. Watch your charts improve week over week and unlock milestones as you grow.',
  },
];

const SLIDE_MESSAGES = [
  "Hi! I'm Maestro, your AI violin coach",
  "I'll watch your technique frame by frame.",
  "Every session, you'll see yourself improve!",
  "What's your main goal right now?",
  'How much will you practice with me each week?',
];

// Info slides, then the goal picker, then the weekly commitment picker
const TOTAL_SLIDES = INFO_SLIDES.length + 2;
const GOAL_SLIDE_INDEX = INFO_SLIDES.length;
const COMMITMENT_SLIDE_INDEX = INFO_SLIDES.length + 1;

const GOALS: Array<{
  category: PlayerCategory;
  icon: React.ReactNode;
  title: string;
  description: string;
}> = [
  {
    category: 'foundation',
    icon: <Ionicons name="school" size={36} color="rgba(255,255,255,0.85)" />,
    title: 'Learn the Fundamentals',
    description: "I'm building my technique from scratch. Help me develop correct posture, bow hold, and form.",
  },
  {
    category: 'refinement',
    icon: <FontAwesome6 name="bullseye" size={36} color="rgba(255,255,255,0.85)" />,
    title: 'Improve My Playing',
    description: 'I know the basics and want to get better. Help me refine technique and learn new music.',
  },
];

export default function Onboarding() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedGoal, setSelectedGoal] = useState<PlayerCategory | null>(null);
  const [selectedTier, setSelectedTier] = useState<GoalTier | null>(null);
  const flatListRef = useRef<FlatList<SlideData>>(null);
  const { setOnboardingComplete, setPlayerCategory, setWeeklyGoal } = useAuthStore();

  const isGoalSlide = currentIndex === GOAL_SLIDE_INDEX;
  const isCommitmentSlide = currentIndex === COMMITMENT_SLIDE_INDEX;
  const isLast = currentIndex === TOTAL_SLIDES - 1;
  const canAdvance =
    (!isGoalSlide || selectedGoal !== null) &&
    (!isCommitmentSlide || selectedTier !== null);

  // On the commitment slide, a selection swaps Maestro's bubble to
  // tier-specific reinforcement copy (the key change re-runs the animation).
  const maestroMessage =
    isCommitmentSlide && selectedTier
      ? selectedTier.reinforcement
      : SLIDE_MESSAGES[currentIndex];

  const advance = async () => {
    haptic.light();
    if (isLast) {
      if (selectedGoal) await setPlayerCategory(selectedGoal);
      if (selectedTier) await setWeeklyGoal(selectedTier.minutes);
      setOnboardingComplete();
      router.replace('/(tabs)/home');
    } else {
      const next = currentIndex + 1;
      if (next < INFO_SLIDES.length) {
        flatListRef.current?.scrollToIndex({ index: next, animated: true });
      }
      setCurrentIndex(next);
    }
  };

  // Dev-only escape hatch. Doesn't persist completion, so onboarding
  // still shows on the next cold start — it can't get "stuck off" again.
  const debugSkip = () => {
    router.replace('/(tabs)/home');
  };

  const renderItem: ListRenderItem<SlideData> = ({ item }) => (
    <View style={{ width }}>
      <OnboardingSlide slide={item} />
    </View>
  );

  return (
    <LinearGradient
      colors={[colors.brand[900], colors.brand[700], colors.brand[500]]}
      style={styles.container}
    >
      {/* Debug skip — dev builds only; production users complete the full flow */}
      {__DEV__ && (
        <Pressable onPress={debugSkip} style={styles.skipBtnFixed}>
          <Text style={styles.skipText}>Skip (dev)</Text>
        </Pressable>
      )}

      {/* Info slides rendered in FlatList; picker slides rendered separately */}
      {currentIndex < INFO_SLIDES.length ? (
        <FlatList
          ref={flatListRef}
          data={INFO_SLIDES}
          renderItem={renderItem}
          keyExtractor={(_, i) => String(i)}
          horizontal
          pagingEnabled
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
          style={styles.list}
        />
      ) : isGoalSlide ? (
        <GoalPickerSlide
          selectedGoal={selectedGoal}
          onSelect={setSelectedGoal}
        />
      ) : (
        <CommitmentSlide
          selectedTier={selectedTier}
          onSelect={setSelectedTier}
        />
      )}

      <View style={styles.footer}>
        <MaestroAvatar
          key={`${currentIndex}-${selectedTier?.id ?? ''}`}
          size="sm"
          message={maestroMessage}
          bounce={currentIndex === 0}
          bubblePosition="above"
        />
        <View style={styles.dots}>
          {Array.from({ length: TOTAL_SLIDES }).map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i === currentIndex && styles.dotActive]}
            />
          ))}
        </View>
        <Text style={styles.dotCounter}>{currentIndex + 1} of {TOTAL_SLIDES}</Text>

        <BigButton
          label={isLast ? "I'm In — Let's Go!" : 'Continue'}
          onPress={advance}
          disabled={!canAdvance}
        />
      </View>
    </LinearGradient>
  );
}

// ─────────────────────────────────────────────────────────────
// Goal picker slide
// ─────────────────────────────────────────────────────────────

function GoalPickerSlide({
  selectedGoal,
  onSelect,
}: {
  selectedGoal: PlayerCategory | null;
  onSelect: (cat: PlayerCategory) => void;
}) {
  return (
    <View style={styles.goalSlide}>
      <Text style={styles.goalTitle}>What's Your Goal?</Text>
      <Text style={styles.goalSub}>
        This shapes your feedback so it's always relevant to where you are right now.
      </Text>

      {GOALS.map((goal) => {
        const isSelected = selectedGoal === goal.category;
        return (
          <Pressable
            key={goal.category}
            style={[styles.goalCard, isSelected && styles.goalCardSelected]}
            onPress={() => { haptic.medium(); onSelect(goal.category); }}
          >
            <View style={styles.goalIconWrap}>{goal.icon}</View>
            <View style={styles.goalCardText}>
              <Text style={[styles.goalCardTitle, isSelected && styles.goalCardTitleSelected]}>
                {goal.title}
              </Text>
              <Text style={[styles.goalCardDesc, isSelected && styles.goalCardDescSelected]}>
                {goal.description}
              </Text>
            </View>
            {isSelected && (
              <View style={styles.goalCheckCircle}>
                <Text style={styles.goalCheckmark}>✓</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Weekly commitment slide
// ─────────────────────────────────────────────────────────────

function CommitmentSlide({
  selectedTier,
  onSelect,
}: {
  selectedTier: GoalTier | null;
  onSelect: (tier: GoalTier) => void;
}) {
  return (
    <View style={styles.goalSlide}>
      <Text style={styles.goalTitle}>Commit to Your Practice</Text>
      <Text style={styles.goalSub}>
        Students who set a weekly goal improve twice as fast. How much time can you give?
      </Text>
      <CommitmentPicker selectedTierId={selectedTier?.id ?? null} onSelect={onSelect} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { flex: 1 },
  footer: {
    paddingHorizontal: spacing.xl,
    paddingBottom: 48,
    paddingTop: spacing.md,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: spacing.lg,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  dotActive: {
    width: 24,
    backgroundColor: '#fff',
  },
  skipBtnFixed: { position: 'absolute', top: 56, right: 20, zIndex: 10, padding: 8 },
  skipText: { color: 'rgba(255,255,255,0.65)', fontSize: 13 },
  dotCounter: { textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: -spacing.sm, marginBottom: spacing.lg },

  // Goal picker
  goalSlide: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
    gap: spacing.md,
  },
  goalTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 4,
  },
  goalSub: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  goalCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.15)',
    padding: spacing.md,
    gap: spacing.md,
  },
  goalCardSelected: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderColor: '#fff',
  },
  goalIconWrap: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goalCardText: {
    flex: 1,
  },
  goalCardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.85)',
    marginBottom: 4,
  },
  goalCardTitleSelected: {
    color: '#fff',
  },
  goalCardDesc: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
    lineHeight: 18,
  },
  goalCardDescSelected: {
    color: 'rgba(255,255,255,0.8)',
  },
  goalCheckCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  goalCheckmark: {
    fontSize: 13,
    color: colors.brand[600],
    fontWeight: '800',
  },
});
