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
import { Button } from '../../src/components/ui/Button';
import { colors, spacing, radius } from '../../src/constants/theme';
import { PlayerCategory } from '../../src/types/analysis';

const { width } = Dimensions.get('window');

const INFO_SLIDES: SlideData[] = [
  {
    emoji: '🎻',
    title: 'Meet Your AI\nViolin Teacher',
    subtitle: 'Real feedback, anytime.',
    body: 'StringAI listens to your playing and shows you exactly what to improve — no lesson required.',
  },
  {
    emoji: '🔬',
    title: 'How It Works',
    subtitle: 'Record → Analyze → Improve',
    body: 'Record a 30–90 second clip of yourself playing. StringAI analyzes your intonation, tone, bow technique, rhythm, and posture.',
  },
  {
    emoji: '📊',
    title: 'What We Measure',
    subtitle: '13 metrics. Real science.',
    body: 'Pitch accuracy, tone quality, bow placement, bow angle, bow smoothness, vibrato, rhythm, dynamics, posture, and more.',
  },
  {
    emoji: '📈',
    title: 'Track Your Progress',
    subtitle: 'See yourself getting better.',
    body: 'Every session is scored. Watch your charts improve week over week and unlock milestones as you grow.',
  },
];

// Total slide count includes the goal-picker as the last slide
const TOTAL_SLIDES = INFO_SLIDES.length + 1;
const GOAL_SLIDE_INDEX = INFO_SLIDES.length;

const GOALS: Array<{
  category: PlayerCategory;
  emoji: string;
  title: string;
  description: string;
}> = [
  {
    category: 'foundation',
    emoji: '🎓',
    title: 'Learn the Fundamentals',
    description: "I'm building my technique from scratch. Help me develop correct posture, bow hold, and form.",
  },
  {
    category: 'refinement',
    emoji: '🎯',
    title: 'Improve My Playing',
    description: 'I know the basics and want to get better. Help me refine technique and learn new music.',
  },
];

export default function Onboarding() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedGoal, setSelectedGoal] = useState<PlayerCategory | null>(null);
  const flatListRef = useRef<FlatList<SlideData>>(null);
  const { setOnboardingComplete, setPlayerCategory } = useAuthStore();

  const isGoalSlide = currentIndex === GOAL_SLIDE_INDEX;
  const isLast = currentIndex === TOTAL_SLIDES - 1;
  const canAdvance = !isGoalSlide || selectedGoal !== null;

  const advance = async () => {
    if (isLast) {
      if (selectedGoal) await setPlayerCategory(selectedGoal);
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

  const skip = async () => {
    setOnboardingComplete();
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
      {/* Info slides (1–4) rendered in FlatList; goal slide rendered separately */}
      {!isGoalSlide ? (
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
      ) : (
        <GoalPickerSlide
          selectedGoal={selectedGoal}
          onSelect={setSelectedGoal}
        />
      )}

      <View style={styles.footer}>
        <View style={styles.dots}>
          {Array.from({ length: TOTAL_SLIDES }).map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i === currentIndex && styles.dotActive]}
            />
          ))}
        </View>

        <Button
          label={isLast ? 'Get Started' : 'Next'}
          onPress={advance}
          size="lg"
          fullWidth
          disabled={!canAdvance}
        />

        {!isLast && (
          <Pressable onPress={skip} style={styles.skipBtn}>
            <Text style={styles.skipText}>Skip</Text>
          </Pressable>
        )}
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
            onPress={() => onSelect(goal.category)}
          >
            <Text style={styles.goalEmoji}>{goal.emoji}</Text>
            <View style={styles.goalCardText}>
              <Text style={[styles.goalCardTitle, isSelected && styles.goalCardTitleSelected]}>
                {goal.title}
              </Text>
              <Text style={[styles.goalCardDesc, isSelected && styles.goalCardDescSelected]}>
                {goal.description}
              </Text>
            </View>
            {isSelected && <Text style={styles.goalCheckmark}>✓</Text>}
          </Pressable>
        );
      })}
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
  skipBtn: { marginTop: spacing.md, alignItems: 'center' },
  skipText: { color: 'rgba(255,255,255,0.65)', fontSize: 13 },

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
  goalEmoji: {
    fontSize: 36,
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
  goalCheckmark: {
    fontSize: 20,
    color: '#fff',
    fontWeight: '700',
  },
});
